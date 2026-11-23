const WEBSITE_SCENE = 'Karaoke Website';
const WEBSITE_BROWSER = 'Website Browser';
const WEBSITE_AUDIO = 'Website Audio';
const WEBSITE_CAMERA = 'Website Camera & Voice';
const KARAOKE_STAGE = 'Karaoke Stage';
const CHROME_PREFIX = '[Google Chrome] ';
const SCREEN_CAPTURE = 'screen_capture';

const captureSettings = { type: 1, show_cursor: false, show_empty_names: false, show_hidden_windows: true };
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

function assertCompatibleInputs(inputs) {
  const expected = new Map([
    [WEBSITE_BROWSER, SCREEN_CAPTURE],
    [WEBSITE_AUDIO, 'sck_audio_capture'],
    [WEBSITE_CAMERA, SCREEN_CAPTURE]
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

async function sourceInScene(obs, sourceName) {
  const scenes = (await obs.request('GetSceneList')).scenes || [];
  for (const scene of scenes) {
    const items = (await obs.request('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems || [];
    const item = items.find(entry => entry.sourceName === sourceName);
    if (item) return { sceneName: scene.sceneName, item };
  }
  return null;
}

async function readCaptureDimensions(obs, sceneName, sceneItemId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const transform = (await obs.request('GetSceneItemTransform', { sceneName, sceneItemId })).sceneItemTransform || {};
    if (finitePositive(transform.sourceWidth) && finitePositive(transform.sourceHeight)) return transform;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Website capture is not ready. Keep the Karaoke Stage visible and retry.');
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

async function assertNoUnexpectedEnabledItems(obs) {
  const items = (await obs.request('GetSceneItemList', { sceneName: WEBSITE_SCENE })).sceneItems || [];
  const owned = new Set([WEBSITE_BROWSER, WEBSITE_AUDIO, WEBSITE_CAMERA]);
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

async function websiteWindowItems(obs) {
  const existing = await inputList(obs);
  let inputName = KARAOKE_STAGE;
  if (!existing.some(input => input.inputName === KARAOKE_STAGE)) {
    await assertIdle(obs);
    await ensureScene(obs);
    inputName = WEBSITE_BROWSER;
    await ensureInput(obs, WEBSITE_BROWSER, SCREEN_CAPTURE, captureSettings, false);
  } else if (inputKind(existing.find(input => input.inputName === KARAOKE_STAGE)) !== SCREEN_CAPTURE) {
    throw Error(`The OBS source “${KARAOKE_STAGE}” has a different type. Set up the Karaoke Stage capture first.`);
  }
  const result = await obs.request('GetInputPropertiesListPropertyItems', { inputName, propertyName: 'window' });
  return (result.propertyItems || []).filter(item => item.itemEnabled !== false && String(item.itemName || '').startsWith(CHROME_PREFIX));
}

function numericWindowId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function listWebsiteWindows(obs) {
  const items = await websiteWindowItems(obs);
  return items.flatMap(item => {
    const id = numericWindowId(item.itemValue);
    return id === null ? [] : [{ id, title: String(item.itemName).slice(CHROME_PREFIX.length) }];
  });
}

async function setupWebsiteScene(obs, { windowId, layout } = {}) {
  await assertIdle(obs);
  await assertGlobalsMuted(obs);
  assertCompatibleInputs(await inputList(obs));
  const normalizedLayout = validateLayout(layout);
  const windows = await websiteWindowItems(obs);
  const requestedId = numericWindowId(windowId);
  const chosen = windows.find(item => numericWindowId(item.itemValue) === requestedId);
  if (!chosen) throw Error('Choose an open Google Chrome window from the website list before setup.');

  const inputs = await inputList(obs);
  const stageInput = inputs.some(input => input.inputName === KARAOKE_STAGE)
    ? await obs.request('GetInputSettings', { inputName: KARAOKE_STAGE })
    : { inputKind: SCREEN_CAPTURE, inputSettings: captureSettings };
  if (stageInput.inputKind !== SCREEN_CAPTURE) throw Error('Set up the Karaoke Stage window capture first.');
  const output = await obs.request('GetVideoSettings');

  await ensureScene(obs);
  await assertNoUnexpectedEnabledItems(obs);
  const browserId = await ensureInput(obs, WEBSITE_BROWSER, SCREEN_CAPTURE, captureSettings, false);
  const audioId = await ensureInput(obs, WEBSITE_AUDIO, 'sck_audio_capture', { type: 1, application: 'com.google.Chrome' }, false);
  const cameraId = await ensureInput(obs, WEBSITE_CAMERA, SCREEN_CAPTURE, stageInput.inputSettings, false);

  // Query the current property list immediately before rebinding the owned browser source.
  const refreshed = await obs.request('GetInputPropertiesListPropertyItems', { inputName: WEBSITE_BROWSER, propertyName: 'window' });
  const refreshedChoice = (refreshed.propertyItems || []).find(item => item.itemEnabled !== false && String(item.itemName || '').startsWith(CHROME_PREFIX) && numericWindowId(item.itemValue) === requestedId);
  if (!refreshedChoice) throw Error('OBS no longer sees the selected Google Chrome window. Refresh the list and retry.');
  const browserSettings = { ...captureSettings, window: refreshedChoice.itemValue };
  await obs.request('SetInputSettings', { inputName: WEBSITE_BROWSER, inputSettings: browserSettings, overlay: true });
  await obs.request('SetInputSettings', { inputName: WEBSITE_AUDIO, inputSettings: { type: 1, application: 'com.google.Chrome' }, overlay: true });
  // Rebind the owned stage capture from its current window list. The old Stage
  // source can retain a stale numeric window ID after Karaoke Live restarts.
  const cameraWindows = await obs.request('GetInputPropertiesListPropertyItems', { inputName: WEBSITE_CAMERA, propertyName: 'window' });
  const cameraChoice = (cameraWindows.propertyItems || []).find(item => item.itemEnabled !== false && String(item.itemName || '').includes('Karaoke Live — Stage'));
  if (!cameraChoice) throw Error('OBS cannot see the current Karaoke Live Stage window. Keep Stage open and retry.');
  await obs.request('SetInputSettings', { inputName: WEBSITE_CAMERA, inputSettings: { ...captureSettings, ...clone(stageInput.inputSettings), window: cameraChoice.itemValue }, overlay: true });
  for (const [inputName, muted, tracks] of [[WEBSITE_BROWSER, true, mutedTracks], [WEBSITE_AUDIO, false, stereoTrack], [WEBSITE_CAMERA, false, stereoTrack]]) {
    await obs.request('SetInputMute', { inputName, inputMuted: muted });
    await obs.request('SetInputAudioTracks', { inputName, inputAudioTracks: tracks });
    await obs.request('SetInputAudioMonitorType', { inputName, monitorType: 'OBS_MONITORING_TYPE_NONE' });
  }
  for (const sceneItemId of [browserId, audioId, cameraId]) await obs.request('SetSceneItemEnabled', { sceneName: WEBSITE_SCENE, sceneItemId, sceneItemEnabled: true });

  const browserReadback = await obs.request('GetInputSettings', { inputName: WEBSITE_BROWSER });
  if (String(browserReadback.inputSettings?.window) !== String(refreshedChoice.itemValue)) throw Error('OBS did not confirm the selected Google Chrome window.');
  const cameraReadback = await obs.request('GetInputSettings', { inputName: WEBSITE_CAMERA });
  if (String(cameraReadback.inputSettings?.window) !== String(cameraChoice.itemValue)) throw Error('OBS did not confirm the current Karaoke Live Stage window.');

  const browserTransform = await readCaptureDimensions(obs, WEBSITE_SCENE, browserId);
  const cameraTransform = await readCaptureDimensions(obs, WEBSITE_SCENE, cameraId);
  const transforms = websiteTransforms(normalizedLayout, cameraTransform, output, browserTransform);
  await obs.request('SetSceneItemTransform', { sceneName: WEBSITE_SCENE, sceneItemId: browserId, sceneItemTransform: transforms.browser });
  await obs.request('SetSceneItemTransform', { sceneName: WEBSITE_SCENE, sceneItemId: cameraId, sceneItemTransform: transforms.face });
  await verifyAudioSource(obs, WEBSITE_BROWSER, true, mutedTracks);
  await verifyAudioSource(obs, WEBSITE_AUDIO, false, stereoTrack);
  await verifyAudioSource(obs, WEBSITE_CAMERA, false, stereoTrack);

  const items = (await obs.request('GetSceneItemList', { sceneName: WEBSITE_SCENE })).sceneItems || [];
  const browserItem = items.find(item => item.sourceName === WEBSITE_BROWSER);
  const cameraItem = items.find(item => item.sourceName === WEBSITE_CAMERA);
  if (!browserItem?.sceneItemEnabled || !cameraItem?.sceneItemEnabled) throw Error('OBS did not enable the website capture sources.');
  return {
    sceneName: WEBSITE_SCENE,
    window: { id: numericWindowId(refreshedChoice.itemValue), title: String(refreshedChoice.itemName).slice(CHROME_PREFIX.length) },
    transforms,
    sources: { browser: WEBSITE_BROWSER, audio: WEBSITE_AUDIO, camera: WEBSITE_CAMERA },
    message: 'Website capture is ready. Select Karaoke Website in OBS before recording.'
  };
}

module.exports = {
  WEBSITE_SCENE,
  WEBSITE_BROWSER,
  WEBSITE_AUDIO,
  WEBSITE_CAMERA,
  listWebsiteWindows,
  setupWebsiteScene,
  websiteTransforms
};
