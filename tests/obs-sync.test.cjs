const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applySync,
  geometry,
  syncPlan,
  SCENE,
  STAGE,
  CAMERA,
  COVER,
  FILTER
} = require('../lib/obs-sync.cjs');

const clone = value => structuredClone(value);
const cameraTracks = () => ({ '1': true, '2': true, '3': true, '4': true, '5': true, '6': true });

class FakeObs {
  constructor({ sourceWidth = 1280, sourceHeight = 720, outputWidth = 1920, outputHeight = 1080, baseReadbacksBeforeReady = 0 } = {}) {
    this.calls = [];
    this.forceMismatch = false;
    this.captureWindowAvailable = true;
    this.cameraReady = false;
    this.cameraCaptureReadbacks = 0;
    this.baseReadbacksBeforeReady = baseReadbacksBeforeReady;
    this.baseCaptureReadbacks = 0;
    this.state = {
      streamActive: false,
      recordActive: false,
      output: { baseWidth: outputWidth, baseHeight: outputHeight },
      inputs: {
        [STAGE]: { inputKind: 'screen_capture', inputSettings: { window: 'stage' } },
        [CAMERA]: { inputKind: 'screen_capture', inputSettings: { window: 'stage' } },
        [COVER]: { inputKind: 'color_source_v3', inputSettings: { color: 0xff100d0c, width: 640, height: sourceHeight } }
      },
      audioOffsets: { [STAGE]: 0 },
      mutes: { [STAGE]: false, [CAMERA]: false },
      tracks: { [STAGE]: { '1': true }, [CAMERA]: cameraTracks() },
      monitors: { [CAMERA]: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' },
      windowItems: [{ itemEnabled: true, itemValue: 'stage' }],
      filters: {
        [STAGE]: [{ filterName: FILTER, filterKind: 'gpu_delay', filterSettings: { delay_ms: 0 }, filterEnabled: false }],
        [CAMERA]: [{ filterName: FILTER, filterKind: 'gpu_delay', filterSettings: { delay_ms: 125 }, filterEnabled: true }]
      },
      items: [
        { sceneItemId: 10, sourceName: STAGE, sceneItemIndex: 0, sceneItemEnabled: true, sceneItemTransform: { positionX: 0, positionY: 0 } },
        { sceneItemId: 11, sourceName: COVER, sceneItemIndex: 1, sceneItemEnabled: false, sceneItemTransform: { positionX: 0, positionY: 0 } },
        { sceneItemId: 12, sourceName: CAMERA, sceneItemIndex: 2, sceneItemEnabled: false, sceneItemTransform: { positionX: 0, positionY: 0 } }
      ],
      stageTransform: { sourceWidth, sourceHeight }
    };
  }

  snapshot() {
    return clone(this.state);
  }

  async request(type, data = {}) {
    this.calls.push({ type, data: clone(data) });
    switch (type) {
      case 'GetStreamStatus': return { outputActive: this.state.streamActive };
      case 'GetRecordStatus': return { outputActive: this.state.recordActive };
      case 'GetInputSettings': {
        const input = this.state.inputs[data.inputName];
        if (!input) throw new Error(`missing input ${data.inputName}`);
        return { inputKind: input.inputKind, inputSettings: clone(input.inputSettings) };
      }
      case 'GetInputList':
        return { inputs: Object.entries(this.state.inputs).map(([inputName, input]) => ({ inputName, inputKind: input.inputKind })) };
      case 'SetInputSettings':
        this.state.inputs[data.inputName].inputSettings = { ...this.state.inputs[data.inputName].inputSettings, ...clone(data.inputSettings) };
        if (data.inputName === CAMERA && data.inputSettings.window === this.state.inputs[STAGE].inputSettings.window) this.cameraReady = true;
        return {};
      case 'CreateInput':
        this.state.inputs[data.inputName] = { inputKind: data.inputKind, inputSettings: clone(data.inputSettings) };
        this.state.items.push({ sceneItemId: this.nextId(), sourceName: data.inputName, sceneItemEnabled: Boolean(data.sceneItemEnabled), sceneItemTransform: {} });
        return {};
      case 'CreateSceneItem':
        this.state.items.push({ sceneItemId: this.nextId(), sourceName: data.sourceName, sceneItemEnabled: Boolean(data.sceneItemEnabled), sceneItemTransform: {} });
        return { sceneItemId: this.state.items.at(-1).sceneItemId };
      case 'GetSceneItemList':
        return { sceneItems: this.state.items.map(item => clone(item)) };
      case 'GetSceneItemId':
        return { sceneItemId: this.state.items.find(item => item.sourceName === data.sourceName)?.sceneItemId };
      case 'GetSceneItemTransform':
        if (data.sceneItemId === 10) {
          this.baseCaptureReadbacks += 1;
          if (this.baseReadbacksBeforeReady > 0) {
            this.baseReadbacksBeforeReady -= 1;
            return { sceneItemTransform: { sourceWidth: 0, sourceHeight: 0 } };
          }
          return { sceneItemTransform: clone(this.state.stageTransform) };
        }
        const item = this.state.items.find(entry => entry.sceneItemId === data.sceneItemId);
        if (item?.sourceName === CAMERA && this.cameraReady) {
          this.cameraCaptureReadbacks += 1;
          return { sceneItemTransform: { ...clone(item.sceneItemTransform), sourceWidth: this.state.stageTransform.sourceWidth, sourceHeight: this.state.stageTransform.sourceHeight } };
        }
        return { sceneItemTransform: clone(item?.sceneItemTransform || {}) };
      case 'SetSceneItemTransform': {
        const item = this.state.items.find(item => item.sceneItemId === data.sceneItemId);
        if (!item) throw new Error(`missing scene item ${data.sceneItemId}`);
        item.sceneItemTransform = clone(data.sceneItemTransform);
        return {};
      }
      case 'SetSceneItemIndex': {
        const item = this.state.items.find(item => item.sceneItemId === data.sceneItemId);
        if (item) {
          this.state.items.splice(this.state.items.indexOf(item), 1);
          this.state.items.splice(Math.max(0, Math.min(data.sceneItemIndex, this.state.items.length)), 0, item);
          this.state.items.forEach((entry, index) => { entry.sceneItemIndex = index; });
        }
        return {};
      }
      case 'SetSceneItemEnabled': {
        const item = this.state.items.find(item => item.sceneItemId === data.sceneItemId);
        if (item) item.sceneItemEnabled = data.sceneItemEnabled;
        return {};
      }
      case 'GetVideoSettings': return clone(this.state.output);
      case 'GetInputPropertiesListPropertyItems':
        return { propertyItems: this.captureWindowAvailable ? clone(this.state.windowItems) : [] };
      case 'GetSourceFilterList': return { filters: clone(this.state.filters[data.sourceName] || []) };
      case 'CreateSourceFilter':
        (this.state.filters[data.sourceName] ||= []).push({ filterName: data.filterName, filterKind: data.filterKind, filterSettings: clone(data.filterSettings), filterEnabled: false });
        return {};
      case 'SetSourceFilterSettings': {
        const filter = this.findFilter(data.sourceName, data.filterName);
        filter.filterSettings = clone(data.filterSettings);
        return {};
      }
      case 'SetSourceFilterEnabled':
        this.findFilter(data.sourceName, data.filterName).filterEnabled = data.filterEnabled;
        return {};
      case 'SetInputAudioSyncOffset': this.state.audioOffsets[data.inputName] = data.inputAudioSyncOffset; return {};
      case 'GetInputAudioSyncOffset': {
        const value = this.state.audioOffsets[data.inputName] || 0;
        return { inputAudioSyncOffset: this.forceMismatch ? value + 1 : value };
      }
      case 'SetInputMute': this.state.mutes[data.inputName] = data.inputMuted; return {};
      case 'GetInputMute': return { inputMuted: Boolean(this.state.mutes[data.inputName]) };
      case 'SetInputAudioTracks': this.state.tracks[data.inputName] = clone(data.inputAudioTracks); return {};
      case 'GetInputAudioTracks': return { inputAudioTracks: clone(this.state.tracks[data.inputName] || {}) };
      case 'SetInputAudioMonitorType': this.state.monitors[data.inputName] = data.monitorType; return {};
      case 'GetInputAudioMonitorType': return { monitorType: this.state.monitors[data.inputName] };
      default: throw new Error(`unexpected OBS request ${type}`);
    }
  }

  findFilter(sourceName, filterName) {
    const filter = (this.state.filters[sourceName] || []).find(item => item.filterName === filterName);
    if (!filter) throw new Error(`missing filter ${sourceName}/${filterName}`);
    return filter;
  }

  nextId() {
    return Math.max(...this.state.items.map(item => item.sceneItemId)) + 1;
  }
}

const layout = (width = 1280, height = 720, splitX = width / 2) => ({ width, height, splitX });
const mutatingRequests = new Set([
  'SetInputSettings', 'CreateInput', 'CreateSceneItem', 'SetSceneItemTransform', 'SetSceneItemIndex',
  'SetSceneItemEnabled', 'CreateSourceFilter', 'SetSourceFilterSettings', 'SetSourceFilterEnabled',
  'SetInputAudioSyncOffset', 'SetInputMute', 'SetInputAudioTracks', 'SetInputAudioMonitorType'
]);

test('syncPlan keeps the domain sign: mouth-first delays camera, voice-first delays program', () => {
  assert.deepEqual(syncPlan(150), { offsetMs: 150, cameraDelayMs: 150, programDelayMs: 0 });
  assert.deepEqual(syncPlan(-150), { offsetMs: -150, cameraDelayMs: 0, programDelayMs: 150 });
  assert.deepEqual(syncPlan(0), { offsetMs: 0, cameraDelayMs: 0, programDelayMs: 0 });
});

test('syncPlan rejects noninteger and out-of-range offsets', () => {
  for (const value of [-501, 501, 1.5, NaN, '150', null]) {
    assert.throws(() => syncPlan(value), /between -500 and 500 ms/);
  }
});

test('geometry uses natural 1280x720 dimensions and retina 1920x1080 capture dimensions', () => {
  assert.deepEqual(geometry(layout(), { sourceWidth: 1280, sourceHeight: 720 }, { baseWidth: 1920, baseHeight: 1080 }), {
    leftWidth: 640, sourceWidth: 1280, sourceHeight: 720, scale: 1.5, x: 0, y: 0
  });
  assert.deepEqual(geometry(layout(3840, 2160, 1920), { sourceWidth: 1920, sourceHeight: 1080 }, { baseWidth: 1920, baseHeight: 1080 }), {
    leftWidth: 960, sourceWidth: 1920, sourceHeight: 1080, scale: 1, x: 0, y: 0
  });
  assert.throws(() => geometry({ width: 1280, height: 720 }, { sourceWidth: 1280, sourceHeight: 720 }, { baseWidth: 1920, baseHeight: 1080 }), /Stage capture is not ready/);
});

test('waits for a cold-start Stage capture to expose dimensions before applying sync', async () => {
  const obs = new FakeObs({ baseReadbacksBeforeReady: 1 });
  await applySync(obs, 150, layout());
  assert.equal(obs.baseCaptureReadbacks, 2, 'the first zero-dimension readback is retried');
  assert.equal(obs.findFilter(CAMERA, FILTER).filterSettings.delay_ms, 150);
  assert.equal(obs.state.items.find(item => item.sourceName === CAMERA).sceneItemEnabled, true);
});

test('mouth-first +150 applies delay to camera only and isolates camera audio', async () => {
  const obs = new FakeObs();
  const plan = await applySync(obs, 150, layout());
  assert.deepEqual(plan, { offsetMs: 150, cameraDelayMs: 150, programDelayMs: 0 });
  assert.equal(obs.findFilter(CAMERA, FILTER).filterSettings.delay_ms, 150);
  assert.equal(obs.findFilter(CAMERA, FILTER).filterEnabled, true);
  assert.equal(obs.findFilter(STAGE, FILTER).filterSettings.delay_ms, 0);
  assert.equal(obs.findFilter(STAGE, FILTER).filterEnabled, false);
  assert.equal(obs.state.audioOffsets[STAGE], 0);
  assert.equal(obs.state.mutes[CAMERA], true);
  assert.deepEqual(obs.state.tracks[CAMERA], { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false });
  assert.equal(obs.state.monitors[CAMERA], 'OBS_MONITORING_TYPE_NONE');
  assert.equal(obs.state.tracks[STAGE]['1'], true, 'Karaoke Stage remains the sole audible path');
  assert.equal(obs.state.inputs[CAMERA].inputSettings.window, 'stage', 'camera capture selects the refreshed observed Stage window');
  assert.equal(obs.cameraCaptureReadbacks > 0, true, 'camera readiness readback exposes natural capture geometry');
  assert.deepEqual(obs.state.items.map(item => [item.sourceName, item.sceneItemIndex]), [[STAGE, 0], [COVER, 1], [CAMERA, 2]]);
  assertAllowedRequests(obs);
});

test('voice-first -150 delays base video and mixed audio while camera delay stays zero', async () => {
  const obs = new FakeObs();
  await applySync(obs, -150, layout());
  assert.equal(obs.findFilter(CAMERA, FILTER).filterSettings.delay_ms, 0);
  assert.equal(obs.findFilter(CAMERA, FILTER).filterEnabled, false);
  assert.equal(obs.findFilter(STAGE, FILTER).filterSettings.delay_ms, 150);
  assert.equal(obs.findFilter(STAGE, FILTER).filterEnabled, true);
  assert.equal(obs.state.audioOffsets[STAGE], 150);
  assert.equal(obs.state.mutes[CAMERA], true);
  assert.deepEqual(obs.state.tracks[CAMERA], { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false });
  assertAllowedRequests(obs);
});

test('zero reset disables overlay and cover and clears owned delays', async () => {
  const obs = new FakeObs();
  obs.state.items.find(item => item.sourceName === STAGE).sceneItemTransform = { positionX: 44, positionY: 22, scaleX: 0.5, scaleY: 0.5, cropRight: 17 };
  obs.state.items.find(item => item.sourceName === CAMERA).sceneItemEnabled = true;
  obs.state.items.find(item => item.sourceName === COVER).sceneItemEnabled = true;
  obs.state.filters[STAGE][0].filterSettings.delay_ms = 150;
  obs.state.filters[STAGE][0].filterEnabled = true;
  await applySync(obs, 0);
  assert.equal(obs.state.items.find(item => item.sourceName === CAMERA).sceneItemEnabled, false);
  assert.equal(obs.state.items.find(item => item.sourceName === COVER).sceneItemEnabled, false);
  assert.equal(obs.findFilter(STAGE, FILTER).filterSettings.delay_ms, 0);
  assert.equal(obs.findFilter(STAGE, FILTER).filterEnabled, false);
  assert.equal(obs.findFilter(CAMERA, FILTER).filterSettings.delay_ms, 0);
  assert.equal(obs.findFilter(CAMERA, FILTER).filterEnabled, false);
  assert.equal(obs.state.audioOffsets[STAGE], 0);
  assert.deepEqual(obs.state.items.find(item => item.sourceName === STAGE).sceneItemTransform, {
    positionX: 0, positionY: 0, rotation: 0, scaleX: 1, scaleY: 1, alignment: 5,
    boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080,
    boundsAlignment: 0, cropLeft: 0, cropTop: 0, cropBottom: 0, cropRight: 0
  });
  assertAllowedRequests(obs);
});

test('recording or streaming activity is rejected before any mutation', async () => {
  for (const active of [{ streamActive: true }, { recordActive: true }, { streamActive: true, recordActive: true }]) {
    const obs = new FakeObs();
    Object.assign(obs.state, active);
    const before = obs.snapshot();
    await assert.rejects(applySync(obs, 150, layout()), /Stop recording and streaming/);
    assert.deepEqual(obs.snapshot(), before);
    assert.deepEqual(obs.calls.map(call => call.type).sort(), ['GetRecordStatus', 'GetStreamStatus'].sort());
    assert.equal(obs.calls.some(call => mutatingRequests.has(call.type)), false);
  }
});

test('invalid stage capture geometry and differing owned source kind fail before mutation', async () => {
  const missingGeometry = new FakeObs();
  const beforeGeometry = missingGeometry.snapshot();
  await assert.rejects(applySync(missingGeometry, 150, { width: 1280, height: 720 }), /Stage capture is not ready/);
  assert.deepEqual(missingGeometry.snapshot(), beforeGeometry);
  assert.equal(missingGeometry.calls.some(call => mutatingRequests.has(call.type)), false);

  const wrongKind = new FakeObs();
  wrongKind.state.inputs[CAMERA].inputKind = 'browser_source';
  const beforeKind = wrongKind.snapshot();
  await assert.rejects(applySync(wrongKind, 150, layout()), /different type/);
  assert.deepEqual(wrongKind.snapshot(), beforeKind);
  assert.equal(wrongKind.calls.some(call => mutatingRequests.has(call.type)), false);
});

test('an unobserved overlay window aborts before creating or applying the cover layer', async () => {
  const obs = new FakeObs();
  obs.captureWindowAvailable = false;
  await assert.rejects(applySync(obs, 150, layout()), /cannot see the camera overlay window/);
  assert.equal(obs.calls.some(call => call.type === 'GetInputPropertiesListPropertyItems'), true);
  assert.equal(obs.calls.some(call => call.type === 'CreateInput' && call.data.inputName === COVER), false);
  assert.equal(obs.calls.some(call => call.type === 'CreateSceneItem' && call.data.sourceName === COVER), false);
  assert.equal(obs.calls.some(call => ['SetInputMute', 'SetInputAudioTracks', 'SetInputAudioMonitorType', 'SetSceneItemTransform', 'SetSourceFilterSettings', 'SetSourceFilterEnabled', 'SetInputAudioSyncOffset'].includes(call.type)), false);
  assert.equal(obs.state.items.find(item => item.sourceName === CAMERA).sceneItemEnabled, false);
  assert.equal(obs.state.items.find(item => item.sourceName === COVER).sceneItemEnabled, false);
  assert.equal(obs.state.audioOffsets[STAGE], 0);
});

test('readback mismatch fails after OBS mutation instead of claiming sync applied', async () => {
  const obs = new FakeObs();
  obs.forceMismatch = true;
  await assert.rejects(applySync(obs, -150, layout()), /did not confirm the sync adjustment/);
  assert.equal(obs.state.audioOffsets[STAGE], 150);
  assert.equal(obs.findFilter(STAGE, FILTER).filterSettings.delay_ms, 150);
});

function assertAllowedRequests(obs) {
  const allowed = new Set([
    'GetStreamStatus', 'GetRecordStatus', 'GetInputSettings', 'GetInputList', 'SetInputSettings', 'CreateInput',
    'CreateSceneItem', 'GetSceneItemList', 'GetSceneItemId', 'GetSceneItemTransform', 'SetSceneItemTransform',
    'GetVideoSettings', 'GetInputPropertiesListPropertyItems', 'GetSourceFilterList', 'CreateSourceFilter', 'SetSourceFilterSettings', 'SetSourceFilterEnabled',
    'SetInputAudioSyncOffset', 'GetInputAudioSyncOffset', 'SetInputMute', 'GetInputMute', 'SetInputAudioTracks',
    'GetInputAudioTracks', 'SetInputAudioMonitorType', 'GetInputAudioMonitorType', 'SetSceneItemIndex', 'SetSceneItemEnabled'
  ]);
  assert.ok(obs.calls.every(call => allowed.has(call.type)), `unexpected OBS requests: ${obs.calls.map(call => call.type).join(', ')}`);
  assert.equal(obs.calls.some(call => /^(Start|Stop)(Stream|Record)$/.test(call.type)), false);
  assert.equal(obs.calls.some(call => /Device|Microphone|Mic|Camera/.test(call.type)), false);
  assert.equal(obs.calls.some(call => /Microphone|Mic/.test(String(call.data.inputName || ''))), false);
}
