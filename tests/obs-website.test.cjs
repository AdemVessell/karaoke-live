const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WEBSITE_SCENE,
  WEBSITE_BROWSER,
  WEBSITE_AUDIO,
  WEBSITE_CAMERA,
  listWebsiteWindows,
  setupWebsiteScene
} = require('../lib/obs-website.cjs');

const clone = value => structuredClone(value);

class FakeObs {
  constructor({ stage = true, activeGlobal = false, wrongWebsiteSource = false } = {}) {
    this.calls = [];
    this.nextId = 20;
    this.state = {
      stream: false,
      record: false,
      activeGlobal,
      output: { baseWidth: 1920, baseHeight: 1080 },
      windows: [
        { itemEnabled: true, itemName: '[Google Chrome] Suno — Example Track', itemValue: 310 },
        { itemEnabled: true, itemName: '[Google Chrome] Docs', itemValue: 311 },
        { itemEnabled: true, itemName: '[Firefox] Other browser', itemValue: 312 },
        { itemEnabled: false, itemName: '[Google Chrome] Hidden', itemValue: 313 },
        { itemEnabled: true, itemName: '[Karaoke Live] Karaoke Live — Stage', itemValue: 320 }
      ],
      inputs: {},
      scenes: stage ? {
        'Karaoke Live': [{ sceneItemId: 10, sourceName: 'Karaoke Stage', sceneItemEnabled: true, sceneItemIndex: 0 }]
      } : {},
      transforms: { 10: { sourceWidth: 1280, sourceHeight: 720 } },
      mutes: {}, tracks: {}, monitors: {}
    };
    if (stage) this.state.inputs['Karaoke Stage'] = { inputKind: 'screen_capture', inputSettings: { type: 1, window: 'stage-window' } };
    if (wrongWebsiteSource) this.state.inputs[WEBSITE_BROWSER] = { inputKind: 'window_capture', inputSettings: {} };
  }

  async request(type, data = {}) {
    this.calls.push({ type, data: clone(data) });
    switch (type) {
      case 'GetStreamStatus': return { outputActive: this.state.stream };
      case 'GetRecordStatus': return { outputActive: this.state.record };
      case 'GetSpecialInputs': return { desktop1: 'Desktop Audio', aux1: 'Mic/Aux' };
      case 'GetInputMute': {
        const global = data.inputName === 'Desktop Audio' || data.inputName === 'Mic/Aux';
        return { inputMuted: global ? !this.state.activeGlobal : Boolean(this.state.mutes[data.inputName]) };
      }
      case 'GetInputList': return { inputs: Object.entries(this.state.inputs).map(([inputName, value]) => ({ inputName, inputKind: value.inputKind })) };
      case 'GetSceneList': return { scenes: Object.keys(this.state.scenes).map(sceneName => ({ sceneName })) };
      case 'CreateScene': this.state.scenes[data.sceneName] = []; return {};
      case 'GetSceneItemList': return { sceneItems: (this.state.scenes[data.sceneName] || []).map(clone) };
      case 'GetSceneItemId': return { sceneItemId: (this.state.scenes[data.sceneName] || []).find(item => item.sourceName === data.sourceName)?.sceneItemId };
      case 'CreateInput': {
        this.state.inputs[data.inputName] = { inputKind: data.inputKind, inputSettings: clone(data.inputSettings) };
        this.state.scenes[data.sceneName] ||= [];
        this.state.scenes[data.sceneName].push({ sceneItemId: this.nextId++, sourceName: data.inputName, sceneItemEnabled: Boolean(data.sceneItemEnabled), sceneItemIndex: this.state.scenes[data.sceneName].length });
        this.state.transforms[this.nextId - 1] = { sourceWidth: data.inputName === WEBSITE_BROWSER ? 1600 : 1280, sourceHeight: 900 };
        return {};
      }
      case 'CreateSceneItem': {
        this.state.scenes[data.sceneName].push({ sceneItemId: this.nextId++, sourceName: data.sourceName, sceneItemEnabled: Boolean(data.sceneItemEnabled), sceneItemIndex: this.state.scenes[data.sceneName].length });
        return {};
      }
      case 'GetInputSettings': {
        const input = this.state.inputs[data.inputName];
        if (!input) throw Error(`Missing ${data.inputName}`);
        return { inputKind: input.inputKind, inputSettings: clone(input.inputSettings) };
      }
      case 'SetInputSettings':
        this.state.inputs[data.inputName].inputSettings = { ...this.state.inputs[data.inputName].inputSettings, ...clone(data.inputSettings) };
        return {};
      case 'GetInputPropertiesListPropertyItems': return { propertyItems: this.state.windows.map(clone) };
      case 'GetSceneItemTransform': return { sceneItemTransform: clone(this.state.transforms[data.sceneItemId] || { sourceWidth: 1600, sourceHeight: 900 }) };
      case 'GetVideoSettings': return clone(this.state.output);
      case 'SetSceneItemTransform': this.state.transforms[data.sceneItemId] = clone(data.sceneItemTransform); return {};
      case 'SetInputMute': this.state.mutes[data.inputName] = data.inputMuted; return {};
      case 'SetInputAudioTracks': this.state.tracks[data.inputName] = clone(data.inputAudioTracks); return {};
      case 'SetInputAudioMonitorType': this.state.monitors[data.inputName] = data.monitorType; return {};
      case 'GetInputAudioTracks': return { inputAudioTracks: clone(this.state.tracks[data.inputName] || {}) };
      case 'GetInputAudioMonitorType': return { monitorType: this.state.monitors[data.inputName] };
      case 'SetSceneItemEnabled': {
        for (const items of Object.values(this.state.scenes)) {
          const item = items.find(entry => entry.sceneItemId === data.sceneItemId);
          if (item) item.sceneItemEnabled = data.sceneItemEnabled;
        }
        return {};
      }
      default: throw Error(`Unexpected OBS request ${type}`);
    }
  }
}

test('listWebsiteWindows returns enabled Google Chrome windows only', async () => {
  const obs = new FakeObs();
  assert.deepEqual(await listWebsiteWindows(obs), [
    { id: 310, title: 'Suno — Example Track' },
    { id: 311, title: 'Docs' }
  ]);
});

test('listWebsiteWindows creates a disabled owned browser source without changing the active scene', async () => {
  const obs = new FakeObs({ stage: false });
  const windows = await listWebsiteWindows(obs);
  assert.equal(windows[0].id, 310);
  assert.equal(obs.state.scenes[WEBSITE_SCENE].length, 1);
  assert.equal(obs.state.scenes[WEBSITE_SCENE][0].sourceName, WEBSITE_BROWSER);
  assert.equal(obs.state.scenes[WEBSITE_SCENE][0].sceneItemEnabled, false);
  assert.equal(obs.calls.some(call => call.type === 'SetCurrentProgramScene'), false);
});

test('setupWebsiteScene configures isolated picture, Chrome audio, and camera voice sources', async () => {
  const obs = new FakeObs();
  const result = await setupWebsiteScene(obs, { windowId: 310, layout: { width: 1280, height: 720, splitX: 704 } });
  assert.equal(result.sceneName, WEBSITE_SCENE);
  assert.deepEqual(result.window, { id: 310, title: 'Suno — Example Track' });
  assert.equal(obs.state.inputs[WEBSITE_BROWSER].inputSettings.window, 310);
  assert.deepEqual(obs.state.inputs[WEBSITE_AUDIO].inputSettings, { type: 1, application: 'com.google.Chrome' });
  assert.equal(obs.state.inputs[WEBSITE_CAMERA].inputSettings.window, 320);
  assert.equal(obs.state.mutes[WEBSITE_BROWSER], true);
  assert.equal(obs.state.mutes[WEBSITE_AUDIO], false);
  assert.equal(obs.state.mutes[WEBSITE_CAMERA], false);
  assert.deepEqual(obs.state.tracks[WEBSITE_BROWSER], { '1': false, '2': false, '3': false, '4': false, '5': false, '6': false });
  assert.equal(obs.state.tracks[WEBSITE_AUDIO]['1'], true);
  assert.equal(obs.state.tracks[WEBSITE_AUDIO]['2'], false);
  assert.equal(obs.state.tracks[WEBSITE_CAMERA]['1'], true);
  assert.equal(obs.state.monitors[WEBSITE_AUDIO], 'OBS_MONITORING_TYPE_NONE');
  assert.equal(result.transforms.browser.alignment, 5, 'the left edge of the browser bounds starts at the right slot');
  assert.equal(result.transforms.browser.positionX + result.transforms.browser.boundsWidth, 1920);
  assert.equal(result.transforms.face.alignment, 5, 'the cropped camera uses a top-left layout origin');
  assert.ok(result.transforms.face.positionY > 0);
  assert.equal(obs.calls.some(call => call.type === 'SetCurrentProgramScene'), false);
  assert.equal(obs.calls.some(call => call.type === 'StartRecord' || call.type === 'StartStream'), false);
});

test('setup rejects active output, active global audio, or incompatible owned sources before setup', async () => {
  await assert.rejects(setupWebsiteScene(new FakeObs({ activeGlobal: true }), { windowId: 310, layout: { width: 1280, height: 720, splitX: 704 } }), /global audio/);
  await assert.rejects(setupWebsiteScene(new FakeObs({ wrongWebsiteSource: true }), { windowId: 310, layout: { width: 1280, height: 720, splitX: 704 } }), /different type/);
});
