const { SCENE, STAGE, readyCapture } = require('./obs-sync.cjs');
const { captureForPlatform, WINDOWS_STAGE_AUDIO } = require('./obs-platform.cjs');

const LEGACY_AUDIO = 'Karaoke App Audio';
const PEAK_FILTER = 'Karaoke peak safety';
const RECORD_TRACKS = { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false };

async function ensureInput(obs, inputs, inputName, inputKind, inputSettings) {
  const existing = inputs.find(input => input.inputName === inputName);
  if (!existing) {
    const { sceneItemId } = await obs.request('CreateInput', { sceneName: SCENE, inputName, inputKind, inputSettings, sceneItemEnabled: true });
    return sceneItemId;
  }
  if ((existing.unversionedInputKind || existing.inputKind) !== inputKind) {
    throw Error(`The OBS source “${inputName}” has a different type. Rename it or use a separate scene collection.`);
  }
  const { sceneItems } = await obs.request('GetSceneItemList', { sceneName: SCENE });
  const item = sceneItems.find(item => item.sourceName === inputName);
  if (!item) {
    const { sceneItemId } = await obs.request('CreateSceneItem', { sceneName: SCENE, sourceName: inputName, sceneItemEnabled: true });
    return sceneItemId;
  }
  if (!item.sceneItemEnabled) await obs.request('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
  return item.sceneItemId;
}

async function configureStageAudio(obs, inputName) {
  await obs.request('SetInputMute', { inputName, inputMuted: false });
  await obs.request('SetInputVolume', { inputName, inputVolumeDb: 0 });
  await obs.request('SetInputAudioMonitorType', { inputName, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  await obs.request('SetInputAudioTracks', { inputName, inputAudioTracks: RECORD_TRACKS });
  const { filters } = await obs.request('GetSourceFilterList', { sourceName: inputName });
  if (!filters.some(filter => filter.filterName === PEAK_FILTER)) {
    await obs.request('CreateSourceFilter', {
      sourceName: inputName, filterName: PEAK_FILTER, filterKind: 'limiter_filter',
      filterSettings: { threshold: -1, release_time: 60 }
    });
  }
}

async function setupKaraokeCapture(obs, platform = process.platform) {
  const capture = captureForPlatform(platform);
  const globals = await obs.request('GetSpecialInputs');
  for (const inputName of Object.values(globals).filter(Boolean)) {
    if (!(await obs.request('GetInputMute', { inputName })).inputMuted) {
      throw Error(`OBS global audio “${inputName}” is active. Mute it to avoid recording doubled sound.`);
    }
  }
  const { scenes } = await obs.request('GetSceneList');
  if (!scenes.some(scene => scene.sceneName === SCENE)) await obs.request('CreateScene', { sceneName: SCENE });
  const { inputs } = await obs.request('GetInputList');
  const sceneItemId = await ensureInput(obs, inputs, STAGE, capture.windowKind, capture.initialWindowSettings);
  const { propertyItems } = await obs.request('GetInputPropertiesListPropertyItems', { inputName: STAGE, propertyName: 'window' });
  const window = propertyItems.find(capture.isStageWindow)?.itemValue;
  if (window === undefined) {
    throw Error(platform === 'win32'
      ? 'OBS cannot see the Karaoke Stage window. Keep Stage open and unminimized, then retry.'
      : 'OBS cannot see the Karaoke Stage window. Keep Stage open and allow OBS Screen Recording access, then retry.');
  }
  await obs.request('SetInputSettings', { inputName: STAGE, inputSettings: capture.windowSettings(window), overlay: true });

  const audioInput = capture.processAudioKind ? WINDOWS_STAGE_AUDIO : STAGE;
  if (capture.processAudioKind) {
    const audioSettings = capture.processAudioSettings(window);
    await ensureInput(obs, inputs, audioInput, capture.processAudioKind, audioSettings);
    await obs.request('SetInputSettings', { inputName: audioInput, inputSettings: audioSettings, overlay: true });
    const [picture, audio] = await Promise.all([
      obs.request('GetInputSettings', { inputName: STAGE }),
      obs.request('GetInputSettings', { inputName: audioInput })
    ]);
    if (picture.inputSettings.window !== window || picture.inputSettings.capture_audio !== false || audio.inputSettings.window !== window) {
      throw Error('OBS did not confirm the Windows Stage picture and application audio sources.');
    }
  }
  await configureStageAudio(obs, audioInput);
  if (inputs.some(input => input.inputName === LEGACY_AUDIO)) {
    await obs.request('SetInputMute', { inputName: LEGACY_AUDIO, inputMuted: true });
  }

  const video = await obs.request('GetVideoSettings');
  await obs.request('SetSceneItemTransform', { sceneName: SCENE, sceneItemId, sceneItemTransform: {
    positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER',
    boundsWidth: video.baseWidth, boundsHeight: video.baseHeight, boundsAlignment: 0, alignment: 5
  } });
  const previous = capture.processAudioKind ? await obs.request('GetCurrentProgramScene') : null;
  await obs.request('SetCurrentProgramScene', { sceneName: SCENE });
  if (capture.processAudioKind) {
    try {
      // Windows Graphics Capture starts providing frames only after the source is shown.
      await readyCapture(obs, sceneItemId);
    } catch (error) {
      if (previous?.currentProgramSceneName && previous.currentProgramSceneName !== SCENE) {
        await obs.request('SetCurrentProgramScene', { sceneName: previous.currentProgramSceneName });
      }
      throw error;
    }
  }
}

module.exports = { setupKaraokeCapture };
