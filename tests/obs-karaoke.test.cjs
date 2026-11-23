const test = require('node:test');
const assert = require('node:assert/strict');
const { setupKaraokeCapture } = require('../lib/obs-karaoke.cjs');

const STAGE = 'Karaoke Stage';
const SCENE = 'Karaoke Live';
const WINDOWS_AUDIO = 'Karaoke Stage Audio';
const STAGE_WINDOW = 'Karaoke Live — Stage:Chrome_WidgetWin_1:Karaoke Live.exe';
const RECORD_TRACKS = { '1': true, '2': false, '3': false, '4': false, '5': false, '6': false };

const clone = value => structuredClone(value);

class FakeObs {
  constructor({ platform = 'win32', globalInputs = {}, currentScene = 'Main' } = {}) {
    this.platform = platform;
    this.calls = [];
    this.nextId = 20;
    this.currentScene = currentScene;
    this.state = {
      globals: globalInputs,
      scenes: { [SCENE]: [{ sceneItemId: 10, sourceName: STAGE, sceneItemEnabled: true, sceneItemIndex: 0 }] },
      inputs: platform === 'win32'
        ? { [STAGE]: { inputKind: 'window_capture', inputSettings: {} } }
        : { [STAGE]: { inputKind: 'screen_capture', inputSettings: {} } },
      windows: platform === 'win32'
        ? [{ itemEnabled: true, itemName: STAGE, itemValue: STAGE_WINDOW }]
        : [{ itemEnabled: true, itemName: 'Karaoke Live — Stage', itemValue: '501' }],
      filters: {},
      mutes: {},
      tracks: {},
      monitors: {},
      output: { baseWidth: 1920, baseHeight: 1080 },
      dimensions: { sourceWidth: 1280, sourceHeight: 720 }
    };
  }

  inputList() {
    return Object.entries(this.state.inputs).map(([inputName, input]) => ({ inputName, inputKind: input.inputKind }));
  }

  sceneItems(sceneName = SCENE) {
    return (this.state.scenes[sceneName] || []).map(clone);
  }

  async request(type, data = {}) {
    this.calls.push({ type, data: clone(data) });
    switch (type) {
      case 'GetSpecialInputs': return clone(this.state.globals);
      case 'GetInputMute': return { inputMuted: Boolean(this.state.mutes[data.inputName]) };
      case 'GetSceneList': return { scenes: Object.keys(this.state.scenes).map(sceneName => ({ sceneName })) };
      case 'CreateScene': this.state.scenes[data.sceneName] = []; return {};
      case 'GetInputList': return { inputs: this.inputList() };
      case 'CreateInput': {
        this.state.inputs[data.inputName] = { inputKind: data.inputKind, inputSettings: clone(data.inputSettings) };
        const items = this.state.scenes[data.sceneName] ||= [];
        const sceneItemId = this.nextId++;
        items.push({ sceneItemId, sourceName: data.inputName, sceneItemEnabled: Boolean(data.sceneItemEnabled), sceneItemIndex: items.length });
        return { sceneItemId };
      }
      case 'CreateSceneItem': {
        const items = this.state.scenes[data.sceneName] ||= [];
        const sceneItemId = this.nextId++;
        items.push({ sceneItemId, sourceName: data.sourceName, sceneItemEnabled: Boolean(data.sceneItemEnabled), sceneItemIndex: items.length });
        return { sceneItemId };
      }
      case 'GetSceneItemList': return { sceneItems: this.sceneItems(data.sceneName) };
      case 'SetSceneItemEnabled': {
        for (const items of Object.values(this.state.scenes)) {
          const item = items.find(entry => entry.sceneItemId === data.sceneItemId);
          if (item) item.sceneItemEnabled = data.sceneItemEnabled;
        }
        return {};
      }
      case 'GetInputPropertiesListPropertyItems': return { propertyItems: clone(this.state.windows) };
      case 'SetInputSettings': {
        const input = this.state.inputs[data.inputName];
        if (!input) throw Error(`Missing input ${data.inputName}`);
        input.inputSettings = { ...input.inputSettings, ...clone(data.inputSettings) };
        return {};
      }
      case 'GetInputSettings': {
        const input = this.state.inputs[data.inputName];
        if (!input) throw Error(`Missing input ${data.inputName}`);
        return { inputKind: input.inputKind, inputSettings: clone(input.inputSettings) };
      }
      case 'SetInputMute': this.state.mutes[data.inputName] = data.inputMuted; return {};
      case 'SetInputVolume': this.state.volumes ||= {}; this.state.volumes[data.inputName] = data.inputVolumeDb; return {};
      case 'SetInputAudioMonitorType': this.state.monitors[data.inputName] = data.monitorType; return {};
      case 'SetInputAudioTracks': this.state.tracks[data.inputName] = clone(data.inputAudioTracks); return {};
      case 'GetSourceFilterList': return { filters: clone(this.state.filters[data.sourceName] || []) };
      case 'CreateSourceFilter': {
        (this.state.filters[data.sourceName] ||= []).push({ filterName: data.filterName, filterKind: data.filterKind, filterSettings: clone(data.filterSettings) });
        return {};
      }
      case 'GetVideoSettings': return clone(this.state.output);
      case 'SetSceneItemTransform': this.state.transform = clone(data.sceneItemTransform); return {};
      case 'GetCurrentProgramScene': return { currentProgramSceneName: this.currentScene };
      case 'SetCurrentProgramScene': this.currentScene = data.sceneName; return {};
      case 'GetSceneItemTransform': {
        // WGC is intentionally cold until the Stage is shown in the program scene.
        if (this.currentScene !== SCENE) return { sceneItemTransform: { sourceWidth: 0, sourceHeight: 0 } };
        return { sceneItemTransform: clone(this.state.dimensions) };
      }
      default: throw Error(`Unexpected OBS request ${type}`);
    }
  }
}

function callsFor(obs, type, inputName) {
  return obs.calls.filter(call => call.type === type && (inputName === undefined || call.data.inputName === inputName));
}

test('Windows uses WGC Stage picture plus separate WASAPI process audio', async () => {
  const obs = new FakeObs();
  await setupKaraokeCapture(obs, 'win32');

  const stageSettings = callsFor(obs, 'SetInputSettings', STAGE).at(-1).data.inputSettings;
  assert.deepEqual(stageSettings, {
    window: STAGE_WINDOW, method: 2, priority: 1, cursor: false,
    client_area: true, capture_audio: false
  });
  assert.equal(obs.state.inputs[STAGE].inputSettings.capture_audio, false);

  const audioCreate = obs.calls.find(call => call.type === 'CreateInput' && call.data.inputName === WINDOWS_AUDIO);
  assert.deepEqual(audioCreate.data, {
    sceneName: SCENE,
    inputName: WINDOWS_AUDIO,
    inputKind: 'wasapi_process_output_capture',
    inputSettings: { window: STAGE_WINDOW, priority: 2 },
    sceneItemEnabled: true
  });
  assert.deepEqual(callsFor(obs, 'SetInputSettings', WINDOWS_AUDIO).at(-1).data.inputSettings, {
    window: STAGE_WINDOW, priority: 2
  });

  assert.equal(obs.state.mutes[WINDOWS_AUDIO], false);
  assert.equal(obs.state.volumes[WINDOWS_AUDIO], 0);
  assert.equal(obs.state.monitors[WINDOWS_AUDIO], 'OBS_MONITORING_TYPE_NONE');
  assert.deepEqual(obs.state.tracks[WINDOWS_AUDIO], RECORD_TRACKS);
  assert.deepEqual(obs.state.filters[WINDOWS_AUDIO][0], {
    filterName: 'Karaoke peak safety', filterKind: 'limiter_filter',
    filterSettings: { threshold: -1, release_time: 60 }
  });

  const transform = obs.calls.findIndex(call => call.type === 'SetSceneItemTransform');
  const current = obs.calls.findIndex(call => call.type === 'GetCurrentProgramScene');
  const shown = obs.calls.findIndex(call => call.type === 'SetCurrentProgramScene');
  const ready = obs.calls.findIndex(call => call.type === 'GetSceneItemTransform');
  assert.ok(transform < current, 'dimensions are configured before switching WGC into the program scene');
  assert.ok(current < shown && shown < ready, 'WGC readiness is checked after the source is shown');
  assert.equal(obs.calls.some(call => ['SetInputMute', 'SetInputVolume', 'SetInputAudioMonitorType', 'SetInputAudioTracks'].includes(call.type) && call.data.inputName === STAGE), false);
});

test('global OBS audio guard rejects an active desktop or auxiliary source', async () => {
  const obs = new FakeObs({ globalInputs: { desktop1: 'Desktop Audio', aux1: null } });
  await assert.rejects(setupKaraokeCapture(obs, 'win32'), /OBS global audio “Desktop Audio” is active/);
  assert.deepEqual(obs.calls.map(call => call.type), ['GetSpecialInputs', 'GetInputMute']);
  assert.equal(obs.calls.some(call => call.type === 'CreateInput' || call.type === 'SetInputSettings'), false);
});

test('Mac keeps the combined screen capture as the sole recorded audio source', async () => {
  const obs = new FakeObs({ platform: 'darwin' });
  await setupKaraokeCapture(obs, 'darwin');

  assert.equal(obs.state.inputs[STAGE].inputSettings.window, '501');
  assert.equal(obs.calls.some(call => call.type === 'CreateInput' && call.data.inputKind === 'wasapi_process_output_capture'), false);
  assert.equal(obs.calls.some(call => call.type === 'GetCurrentProgramScene'), false);
  assert.deepEqual(obs.state.tracks[STAGE], RECORD_TRACKS);
  assert.equal(obs.state.mutes[STAGE], false);
  assert.equal(obs.state.monitors[STAGE], 'OBS_MONITORING_TYPE_NONE');
});
