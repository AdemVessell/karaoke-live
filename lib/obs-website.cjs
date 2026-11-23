const { captureForPlatform } = require('./obs-platform.cjs');

const WEBSITE_SCENE = 'Karaoke Website';
const WEBSITE_BROWSER = 'Website Browser';
const WEBSITE_AUDIO = 'Website Audio';
const WEBSITE_CAMERA = 'Website Camera & Voice';
const WEBSITE_VOICE = 'Website Voice';
const KARAOKE_STAGE = 'Karaoke Stage';
const mutedTracks = { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false };
const stereoTrack = { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false };

function clone(value) {
  return value && typeof value === 'object' ? structuredClone(value) : value;
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function validateLayout(layout) {
  const { width, height, splitX } = layout || {};
  if (![width, height, splitX].every(finitePositive) || Number(splitX) >= Number(width)) {
    throw Error('Website capture layout is not ready. Keep the Karaoke Stage visible and retry.');
  }
  return { width: Number(width), height: Number(height), splitX: Number(splitX) };
}

async function assertIdle(obs) {
  const [stream, record] = await Promise.all([obs.request('GetStreamStatus'), obs.request('GetRecordStatus')]);
  if (stream.outputActive || record.outputActive) throw Error('Stop recording and streaming before setting up website capture.');
}

async function assertGlobalsMuted(obs) {
  const globals = await obs.request('GetSpecialInputs');
  for (const name of Object.values(globals).filter(Boolean)) {
    const mute = await obs.request('GetInputMute', { inputName: name });
    if (!mute.inputMuted) throw Error(`OBS global audio “${name}” is active. Mute it before website capture.`);
  }
}

function inputKind(input) {
  return input?.unversionedInputKind || input?.inputKind;
}

async function inputList(obs) {
  return (await obs.request('GetInputList')).inputs || [];
}

function assertCompatibleInputs(inputs, contract) {
  const processKind = contract.processAudioKind || 'sck_audio_capture';
  const expected = new Map([
    [WEBSITE_BROWSER, contract.windowKind],
    [WEBSITE_AUDIO, processKind],
    [WEBSITE_CAMERA, contract.windowKind],
    [WEBSITE_VOICE, contract.processAudioKind]
  ]);
  for (const input of inputs) {
    const kind = expected.get(input.inputName);
    if (kind && inputKind(input) !== kind) throw Error(`The OBS source “${input.inputName}” has a different type. Rename it before setup.`);
  }
}

async function ensureScene(obs) {
  const scenes = await obs.request('GetSceneList');
  if (!scenes.scenes.some(scene => scene.sceneName === WEBSITE_SCENE)) await obs.request('CreateScene', { sceneName: WEBSITE_SCENE });
}

async function ensureInput(obs, inputName, expectedKind, settings, sceneItemEnabled = false) {
  const inputs = await inputList(obs);
  const existing = inputs.find(input => input.inputName === inputName);
  if (existing && inputKind(existing) !== expectedKind) throw Error(`The OBS source “${inputName}” has a different type. Rename it before setup.`);
  if (!existing) {
    await obs.request('CreateInput', { sceneName: WEBSITE_SCENE, inputName, inputKind: expectedKind, inputSettings: clone(settings), sceneItemEnabled });
  } else {
    const items = (await obs.request('GetSceneItemList', { sceneName: WEBSITE_SCENE })).sceneItems || [];
    if (!items.some(item => item.sourceName === inputName)) {
      await obs.request('CreateSceneItem', { sceneName: WEBSITE_SCENE, sourceName: inputName, sceneItemEnabled });
    }
  }
  const item = (await obs.request('GetSceneItemId', { sceneName: WEBSITE_SCENE, sourceName: inputName })).sceneItemId;
  if (!Number.isFinite(Number(item))) throw Error(`OBS could not create the “${inputName}” scene item.`);
  return Number(item);
}

async function pollCaptureDimensions(obs, sceneName, sceneItemId) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const transform = (await obs.request('GetSceneItemTransform', { sceneName, sceneItemId })).sceneItemTransform || {};
    if (finitePositive(transform.sourceWidth) && finitePositive(transform.sourceHeight)) return transform;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Website capture is not ready. Keep the Karaoke Stage visible and retry.');
}

async function readWebsiteDimensions(obs, browserId, cameraId, windows) {
  const read = () => Promise.all([browserId, cameraId].map(id => pollCaptureDimensions(obs, WEBSITE_SCENE, id)));
  if (!windows) return read();
  const { currentProgramSceneName } = await obs.request('GetCurrentProgramScene');
  if (currentProgramSceneName === WEBSITE_SCENE) return read();
  // Windows Graphics Capture initializes after its scene is shown in OBS.
  await obs.request('SetCurrentProgramScene', { sceneName: WEBSITE_SCENE });
  try { return await read(); }
  finally { await obs.request('SetCurrentProgramScene', { sceneName: currentProgramSceneName }); }
}

function websiteTransforms(layout, stage, output, browser) {
  const { width, splitX } = validateLayout(layout);
  const sourceWidth = Number(stage.sourceWidth);
  const sourceHeight = Number(stage.sourceHeight);
  if (![sourceWidth, sourceHeight, output.baseWidth, output.baseHeight, browser.sourceWidth, browser.sourceHeight].every(finitePositive)) {
    throw Error('Website capture dimensions are not ready.');
  }
  const faceWidth = Math.round(sourceWidth * splitX / width);
  if (faceWidth <= 0 || faceWidth >= sourceWidth) throw Error('The Karaoke Stage camera panel has invalid bounds.');
  const browserWidth = Math.round(output.baseWidth * 0.73);
  const faceSlotWidth = output.baseWidth - browserWidth;
  const faceScale = Math.min(faceSlotWidth / faceWidth, output.baseHeight / sourceHeight);
  const topLeft = 5;
  return {
    face: {
      positionX: (faceSlotWidth - faceWidth * faceScale) / 2,
      positionY: (output.baseHeight - sourceHeight * faceScale) / 2,
      rotation: 0, scaleX: faceScale, scaleY: faceScale, alignment: topLeft, boundsType: 'OBS_BOUNDS_NONE',
      cropLeft: 0, cropTop: 0, cropBottom: 0, cropRight: sourceWidth - faceWidth
    },
    browser: {
      positionX: faceSlotWidth, positionY: 0, rotation: 0,
      scaleX: 1, scaleY: 1, alignment: topLeft, boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: browserWidth, boundsHeight: output.baseHeight, boundsAlignment: 0,
      cropLeft: 0, cropTop: 0, cropBottom: 0, cropRight: 0
    },
    faceWidth, browserWidth, faceSlotWidth
  };
}

async function assertNoUnexpectedEnabledItems(obs, windows) {
  const items = (await obs.request('GetSceneItemList', { sceneName: WEBSITE_SCENE })).sceneItems || [];
  const owned = new Set([WEBSITE_BROWSER, WEBSITE_AUDIO, WEBSITE_CAMERA]);
  if (windows) owned.add(WEBSITE_VOICE);
  const unexpected = items.find(item => item.sceneItemEnabled && !owned.has(item.sourceName));
  if (unexpected) throw Error(`The ${WEBSITE_SCENE} scene contains an enabled source “${unexpected.sourceName}”. Disable or remove it before setup.`);
}

async function verifyAudioSource(obs, inputName, muted, tracks) {
  const [mute, currentTracks, monitor] = await Promise.all([
    obs.request('GetInputMute', { inputName }),
    obs.request('GetInputAudioTracks', { inputName }),
    obs.request('GetInputAudioMonitorType', { inputName })
  ]);
  if (Boolean(mute.inputMuted) !== muted || monitor.monitorType !== 'OBS_MONITORING_TYPE_NONE') throw Error(`OBS did not confirm the audio isolation for “${inputName}”.`);
  for (const [track, expected] of Object.entries(tracks)) if (Boolean(currentTracks.inputAudioTracks?.[track]) !== expected) throw Error(`OBS did not confirm the track routing for “${inputName}”.`);
}

async function websiteWindowItems(obs, contract) {
  const existing = await inputList(obs);
  let inputName = KARAOKE_STAGE;
  if (!existing.some(input => input.inputName === KARAOKE_STAGE)) {
    await assertIdle(obs);
    await ensureScene(obs);
    inputName = WEBSITE_BROWSER;
    await ensureInput(obs, WEBSITE_BROWSER, contract.windowKind, contract.initialWindowSettings, false);
  } else if (inputKind(existing.find(input => input.inputName === KARAOKE_STAGE)) !== contract.windowKind) {
    throw Error(`The OBS source “${KARAOKE_STAGE}” has a different type. Set up the Karaoke Stage capture first.`);
  }
  const result = await obs.request('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'window' });
  return (result.propertyItems || []).filter(item => item.itemEnabled !== false && contract.chromeWindow(item));
}

async function listWebsiteWindows(obs, platform = process.platform) {
  const contract = captureForPlatform(platform);
  const items = await websiteWindowItems(obs, contract);
  return items.flatMap(item => {
    const descriptor = contract.chromeWindow(item);
    return descriptor ? [{ id: descriptor.id, title: descriptor.title }] : [];
  });
}

function sameToken(contract, left, right) {
  const a = contract.windowToken(left);
  const b = contract.windowToken(right);
  return a !== null && b !== null && String(a) === String(b);
}

async function setupWebsiteScene(obs, { windowId, layout, platform = process.platform } = {}) {
  const contract = captureForPlatform(platform);
  const separateVoice = Boolean(contract.processAudioKind);
  await assertIdle(obs);
  await assertGlobalsMuted(obs);
  assertCompatibleInputs(await inputList(obs), contract);
  const normalizedLayout = validateLayout(layout);
  const windows = await websiteWindowItems(obs, contract);
  const requestedId = contract.windowToken(windowId);
  const chosen = windows.find(item => sameToken(contract, item.itemValue, requestedId));
  if (!chosen) throw Error('Choose an open Google Chrome window from the website list before setup.');

  const output = await obs.request('GetVideoSettings');

  await ensureScene(obs);
  await assertNoUnexpectedEnabledItems(obs, separateVoice);
  const browserId = await ensureInput(obs, WEBSITE_BROWSER, contract.windowKind, contract.initialWindowSettings, false);
  const processKind = contract.processAudioKind || 'sck_audio_capture';
  const processSettings = value => contract.processAudioSettings ? contract.processAudioSettings(value) : { type: 1, application: 'com.google.Chrome' };
  const audioId = await ensureInput(obs, WEBSITE_AUDIO, processKind, processSettings(chosen.itemValue), false);
  const cameraId = await ensureInput(obs, WEBSITE_CAMERA, contract.windowKind, contract.initialWindowSettings, false);
  const voiceId = separateVoice
    ? await ensureInput(obs, WEBSITE_VOICE, processKind, processSettings(''), false)
    : null;

  // Query the current property list immediately before rebinding the owned browser source.
  const refreshed = await obs.request('GetInputPropertiesListPropertyItems', { inputName: WEBSITE_BROWSER, propertyName: 'window' });
  const refreshedChoice = (refreshed.propertyItems || []).find(item => item.itemEnabled !== false && contract.chromeWindow(item) && sameToken(contract, item.itemValue, requestedId));
  if (!refreshedChoice) throw Error('OBS no longer sees the selected Google Chrome window. Refresh the list and retry.');
  const browserSettings = contract.windowSettings(refreshedChoice.itemValue);
  await obs.request('SetInputSettings', { inputName: WEBSITE_BROWSER, inputSettings: browserSettings, overlay: true });
  await obs.request('SetInputSettings', { inputName: WEBSITE_AUDIO, inputSettings: processSettings(refreshedChoice.itemValue), overlay: true });
  // Rebind the owned stage capture from its current window list. The old Stage
  // source can retain a stale numeric window ID after Karaoke Live restarts.
  const cameraWindows = await obs.request('GetInputPropertiesListPropertyItems', { inputName: WEBSITE_CAMERA, propertyName: 'window' });
  const cameraChoice = (cameraWindows.propertyItems || []).find(item => item.itemEnabled !== false && contract.isStageWindow(item));
  if (!cameraChoice) throw Error('OBS cannot see the current Karaoke Live Stage window. Keep Stage open and retry.');
  await obs.request('SetInputSettings', { inputName: WEBSITE_CAMERA, inputSettings: contract.windowSettings(cameraChoice.itemValue), overlay: true });
  if (voiceId !== null) await obs.request('SetInputSettings', { inputName: WEBSITE_VOICE, inputSettings: processSettings(cameraChoice.itemValue), overlay: true });
  const audioSources = separateVoice
    ? [[WEBSITE_AUDIO, false, stereoTrack], [WEBSITE_VOICE, false, stereoTrack]]
    : [[WEBSITE_BROWSER, true, mutedTracks], [WEBSITE_AUDIO, false, stereoTrack], [WEBSITE_CAMERA, false, stereoTrack]];
  for (const [inputName, muted, tracks] of audioSources) {
    await obs.request('SetInputMute', { inputName, inputMuted: muted });
    await obs.request('SetInputAudioTracks', { inputName, inputAudioTracks: tracks });
    await obs.request('SetInputAudioMonitorType', { inputName, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  }
  for (const sceneItemId of [browserId, audioId, cameraId, voiceId].filter(id => id !== null)) await obs.request('SetSceneItemEnabled', { sceneName: WEBSITE_SCENE, sceneItemId, sceneItemEnabled: true });

  const browserReadback = await obs.request('GetInputSettings', { inputName: WEBSITE_BROWSER });
  if (!sameToken(contract, browserReadback.inputSettings?.window, refreshedChoice.itemValue)) throw Error('OBS did not confirm the selected Google Chrome window.');
  const cameraReadback = await obs.request('GetInputSettings', { inputName: WEBSITE_CAMERA });
  if (!sameToken(contract, cameraReadback.inputSettings?.window, cameraChoice.itemValue)) throw Error('OBS did not confirm the current Karaoke Live Stage window.');

  if (separateVoice) {
    const [browserAudio, voiceAudio] = await Promise.all([WEBSITE_AUDIO, WEBSITE_VOICE].map(inputName => obs.request('GetInputSettings', { inputName })));
    if (browserReadback.inputSettings.capture_audio !== false || cameraReadback.inputSettings.capture_audio !== false ||
        !sameToken(contract, browserAudio.inputSettings.window, refreshedChoice.itemValue) ||
        !sameToken(contract, voiceAudio.inputSettings.window, cameraChoice.itemValue)) {
      throw Error('OBS did not confirm the separate Website audio sources.');
    }
  }
  const [browserTransform, cameraTransform] = await readWebsiteDimensions(obs, browserId, cameraId, separateVoice);
  const transforms = websiteTransforms(normalizedLayout, cameraTransform, output, browserTransform);
  await obs.request('SetSceneItemTransform', { sceneName: WEBSITE_SCENE, sceneItemId: browserId, sceneItemTransform: transforms.browser });
  await obs.request('SetSceneItemTransform', { sceneName: WEBSITE_SCENE, sceneItemId: cameraId, sceneItemTransform: transforms.face });
  for (const [inputName, muted, tracks] of audioSources) await verifyAudioSource(obs, inputName, muted, tracks);

  const items = (await obs.request('GetSceneItemList', { sceneName: WEBSITE_SCENE })).sceneItems || [];
  const browserItem = items.find(item => item.sourceName === WEBSITE_BROWSER);
  const cameraItem = items.find(item => item.sourceName === WEBSITE_CAMERA);
  if (!browserItem?.sceneItemEnabled || !cameraItem?.sceneItemEnabled || (voiceId !== null && !items.some(item => item.sourceName === WEBSITE_VOICE && item.sceneItemEnabled))) throw Error('OBS did not enable the website capture sources.');
  return {
    sceneName: WEBSITE_SCENE,
    window: { id: contract.chromeWindow(refreshedChoice).id, title: contract.chromeWindow(refreshedChoice).title },
    transforms,
    sources: { browser: WEBSITE_BROWSER, audio: WEBSITE_AUDIO, camera: WEBSITE_CAMERA, voice: voiceId === null ? null : WEBSITE_VOICE },
    message: 'Website capture is ready. Select Karaoke Website in OBS before recording.'
  };
}

module.exports = {
  WEBSITE_SCENE,
  WEBSITE_BROWSER,
  WEBSITE_AUDIO,
  WEBSITE_CAMERA,
  WEBSITE_VOICE,
  listWebsiteWindows,
  setupWebsiteScene,
  websiteTransforms
};
