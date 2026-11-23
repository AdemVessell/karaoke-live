// Broadcast-only lip sync. The browser's microphone/monitor graph is never changed.
const { captureForPlatform, WINDOWS_STAGE_AUDIO } = require('./obs-platform.cjs');
const SCENE = 'Karaoke Live';
const STAGE = 'Karaoke Stage';
const CAMERA = 'Karaoke Camera Sync';
const COVER = 'Karaoke Camera Cover';
const FILTER = 'Karaoke lip sync';

function syncPlan(offsetMs) {
  if (!Number.isInteger(offsetMs) || Math.abs(offsetMs) > 500) throw Error('Choose a sync adjustment between -500 and 500 ms.');
  return { offsetMs, cameraDelayMs: Math.max(0, offsetMs), programDelayMs: Math.max(0, -offsetMs) };
}

function geometry(layout, source, output) {
  const { width, height, splitX } = layout || {};
  const sw = source.sourceWidth, sh = source.sourceHeight;
  if (![width, height, splitX, sw, sh, output.baseWidth, output.baseHeight].every(v => Number.isFinite(v) && v > 0) || splitX >= width) throw Error('Stage capture is not ready. Keep Stage visible and try Set up OBS again.');
  // Include the opaque padding and half the gutter so no undelayed camera edge leaks.
  const leftWidth = Math.round(sw * splitX / width);
  const scale = Math.min(output.baseWidth / sw, output.baseHeight / sh);
  return { leftWidth, sourceWidth: sw, sourceHeight: sh, scale,
    x: (output.baseWidth - sw * scale) / 2, y: (output.baseHeight - sh * scale) / 2 };
}

async function assertIdle(obs) {
  const [stream, record] = await Promise.all([obs.request('GetStreamStatus'), obs.request('GetRecordStatus')]);
  if (stream.outputActive || record.outputActive) throw Error('Stop recording and streaming before adjusting lip sync.');
}

async function source(obs, name, kind, settings) {
  const inputs = (await obs.request('GetInputList')).inputs;
  const existing = inputs.find(i => i.inputName === name);
  if (existing && (existing.unversionedInputKind || existing.inputKind) !== kind && existing.inputKind !== kind) throw Error(`The OBS source “${name}” has a different type. Rename it before setup.`);
  if (!existing) await obs.request('CreateInput', { sceneName: SCENE, inputName: name, inputKind: kind, inputSettings: settings, sceneItemEnabled: false });
  else {
    await obs.request('SetInputSettings', { inputName: name, inputSettings: settings, overlay: true });
    const items = (await obs.request('GetSceneItemList', { sceneName: SCENE })).sceneItems;
    if (!items.some(i => i.sourceName === name)) await obs.request('CreateSceneItem', { sceneName: SCENE, sourceName: name, sceneItemEnabled: false });
  }
  return (await obs.request('GetSceneItemId', { sceneName: SCENE, sourceName: name })).sceneItemId;
}

async function delay(obs, name, ms) {
  const filters = (await obs.request('GetSourceFilterList', { sourceName: name })).filters;
  const current = filters.find(f => f.filterName === FILTER);
  if (current && current.filterKind !== 'gpu_delay') throw Error(`The OBS filter “${FILTER}” has a different type.`);
  if (!current && ms === 0) return;
  if (!current) await obs.request('CreateSourceFilter', { sourceName: name, filterName: FILTER, filterKind: 'gpu_delay', filterSettings: { delay_ms: ms } });
  else await obs.request('SetSourceFilterSettings', { sourceName: name, filterName: FILTER, filterSettings: { delay_ms: ms }, overlay: true });
  await obs.request('SetSourceFilterEnabled', { sourceName: name, filterName: FILTER, filterEnabled: ms > 0 });
}

async function hideLayers(obs) {
  const items = (await obs.request('GetSceneItemList', { sceneName: SCENE })).sceneItems;
  for (const name of [CAMERA, COVER]) {
    const item = items.find(i => i.sourceName === name);
    if (item) await obs.request('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: item.sceneItemId, sceneItemEnabled: false });
  }
  if (items.some(i => i.sourceName === CAMERA)) await delay(obs, CAMERA, 0);
}

async function readyCapture(obs, sceneItemId) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const transform = (await obs.request('GetSceneItemTransform', { sceneName: SCENE, sceneItemId })).sceneItemTransform;
    if (transform.sourceWidth > 0 && transform.sourceHeight > 0) return transform;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Stage capture is not ready. Keep Stage visible and try Set up OBS again.');
}

async function applySync(obs, offsetMs, layout, platform = process.platform) {
  const plan = syncPlan(offsetMs);
  await assertIdle(obs);
  const capture = captureForPlatform(platform);
  const audioInput = capture.processAudioKind ? WINDOWS_STAGE_AUDIO : STAGE;
  const stageInput = await obs.request('GetInputSettings', { inputName: STAGE });
  if (stageInput.inputKind !== capture.windowKind) throw Error('Set up the Karaoke Stage window capture first.');
  if (offsetMs === 0) {
    await delay(obs, STAGE, 0);
    await obs.request('SetInputAudioSyncOffset', { inputName: audioInput, inputAudioSyncOffset: 0 });
    await hideLayers(obs);
    const output = await obs.request('GetVideoSettings');
    const baseId = (await obs.request('GetSceneItemId', { sceneName: SCENE, sourceName: STAGE })).sceneItemId;
    await obs.request('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: baseId, sceneItemTransform: { positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: output.baseWidth, boundsHeight: output.baseHeight, boundsAlignment: 0, cropLeft: 0, cropTop: 0, cropBottom: 0, cropRight: 0 } });
  } else {
    const baseId = (await obs.request('GetSceneItemId', { sceneName: SCENE, sourceName: STAGE })).sceneItemId;
    const base = await readyCapture(obs, baseId);
    const g = geometry(layout, base, await obs.request('GetVideoSettings'));
    const overlaySettings = capture.processAudioKind ? capture.windowSettings(stageInput.inputSettings.window) : stageInput.inputSettings;
    const cameraId = await source(obs, CAMERA, capture.windowKind, {
      ...overlaySettings, window: capture.processAudioKind ? '' : 0
    });
    // ScreenCaptureKit refreshes its available-window cache per capture source.
    // Copying the first source's numeric window ID alone can leave the second blank.
    const windows = await obs.request('GetInputPropertiesListPropertyItems', { inputName: CAMERA, propertyName: 'window' });
    const match = windows.propertyItems.find(item => item.itemEnabled !== false && item.itemValue === stageInput.inputSettings.window);
    if (!match) throw Error('OBS cannot see the camera overlay window. Keep Stage visible and retry setup.');
    await obs.request('SetInputSettings', { inputName: CAMERA, inputSettings: overlaySettings, overlay: true });
    // This second capture supplies picture only, even if macOS also offers its audio.
    if (!capture.processAudioKind) {
      await obs.request('SetInputMute', { inputName: CAMERA, inputMuted: true });
      await obs.request('SetInputAudioTracks', { inputName: CAMERA, inputAudioTracks: { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false } });
      await obs.request('SetInputAudioMonitorType', { inputName: CAMERA, monitorType: 'OBS_MONITORING_TYPE_NONE' });
    }
    const coverId = await source(obs, COVER, 'color_source_v3', { color: 0xff100d0c, width: g.leftWidth, height: g.sourceHeight });
    const transform = { positionX: g.x, positionY: g.y, rotation: 0, scaleX: g.scale, scaleY: g.scale, alignment: 5, boundsType: 'OBS_BOUNDS_NONE', cropLeft: 0, cropTop: 0, cropBottom: 0, cropRight: 0 };
    await obs.request('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: baseId, sceneItemTransform: transform });
    await obs.request('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: coverId, sceneItemTransform: transform });
    await obs.request('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: cameraId, sceneItemTransform: { ...transform, cropRight: g.sourceWidth - g.leftWidth } });
    await delay(obs, CAMERA, plan.cameraDelayMs);
    await delay(obs, STAGE, plan.programDelayMs);
    // Render Delay changes picture only. Match it with an explicit audio offset for the
    // whole program so the YouTube picture and backing track retain their relationship.
    await obs.request('SetInputAudioSyncOffset', { inputName: audioInput, inputAudioSyncOffset: plan.programDelayMs });
    const items = (await obs.request('GetSceneItemList', { sceneName: SCENE })).sceneItems;
    await obs.request('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: coverId, sceneItemIndex: items.length - 1 });
    await obs.request('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: cameraId, sceneItemIndex: items.length - 1 });
    for (const id of [coverId, cameraId]) await obs.request('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: id, sceneItemEnabled: true });
    await readyCapture(obs, cameraId);
  }
  if (!await matchesSync(obs, offsetMs, platform)) throw Error('OBS did not confirm the sync adjustment. Try Set up OBS again.');
  return plan;
}

async function matchesSync(obs, offsetMs, platform = process.platform) {
  const plan = syncPlan(offsetMs);
  const capture = captureForPlatform(platform);
  const audioInput = capture.processAudioKind ? WINDOWS_STAGE_AUDIO : STAGE;
  const [audio, filters, items] = await Promise.all([
    obs.request('GetInputAudioSyncOffset', { inputName: audioInput }),
    obs.request('GetSourceFilterList', { sourceName: STAGE }),
    obs.request('GetSceneItemList', { sceneName: SCENE })
  ]);
  const effectiveDelay = list => { const f = list.find(f => f.filterName === FILTER); return f?.filterEnabled ? Number(f.filterSettings.delay_ms) : 0; };
  if (audio.inputAudioSyncOffset !== plan.programDelayMs || effectiveDelay(filters.filters) !== plan.programDelayMs) return false;
  const camera = items.sceneItems.find(i => i.sourceName === CAMERA), cover = items.sceneItems.find(i => i.sourceName === COVER);
  if (offsetMs === 0) return !camera?.sceneItemEnabled && !cover?.sceneItemEnabled;
  if (!camera?.sceneItemEnabled || !cover?.sceneItemEnabled) return false;
  const base = items.sceneItems.find(i => i.sourceName === STAGE);
  if (!(base.sceneItemIndex < cover.sceneItemIndex && cover.sceneItemIndex < camera.sceneItemIndex)) return false;
  if (capture.processAudioKind) {
    const [cameraFilters, overlay] = await Promise.all([
      obs.request('GetSourceFilterList', { sourceName: CAMERA }), obs.request('GetInputSettings', { inputName: CAMERA })
    ]);
    return effectiveDelay(cameraFilters.filters) === plan.cameraDelayMs && overlay.inputSettings.capture_audio === false;
  }
  const [cameraFilters, mute, monitor, tracks] = await Promise.all([
    obs.request('GetSourceFilterList', { sourceName: CAMERA }), obs.request('GetInputMute', { inputName: CAMERA }),
    obs.request('GetInputAudioMonitorType', { inputName: CAMERA }), obs.request('GetInputAudioTracks', { inputName: CAMERA })
  ]);
  return effectiveDelay(cameraFilters.filters) === plan.cameraDelayMs && mute.inputMuted && monitor.monitorType === 'OBS_MONITORING_TYPE_NONE' && Object.values(tracks.inputAudioTracks).every(v => !v);
}

module.exports = { syncPlan, geometry, applySync, matchesSync, readyCapture, SCENE, STAGE, CAMERA, COVER, FILTER };
