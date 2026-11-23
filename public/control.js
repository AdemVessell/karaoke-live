import { createBus, parseYouTubeUrl, DEFAULTS, normalizeVoiceSettings, compressionPresetFromAmount } from './common.js';
import { VOCAL_PRESETS, vocalSettings } from './vocal-presets.js';

const $ = id => document.getElementById(id);
const bus = createBus();
const storeKey = 'karaoke-live-settings';
const presetStoreKey = 'karaoke-live-vocal-presets';
const presetButtons = [...document.querySelectorAll('[data-vocal-preset]')];
const DEVICE_DEFAULTS = { inputDeviceId: '', outputDeviceId: '' };
const RANGE_FIELDS = [
  ['voice', 'voiceDb', ' dB'], ['music', 'music', '%'], ['reverb', 'reverbMix', '%'],
  ['compressionAmount', 'compressionAmount', '%'], ['compressionThreshold', 'compressionThreshold', ' dB'],
  ['compressionRatio', 'compressionRatio', ':1'], ['compressionMakeup', 'compressionMakeup', ' dB'],
  ['compressionAttack', 'compressionAttack', ' ms'], ['compressionRelease', 'compressionRelease', ' ms'],
  ['reverbDecay', 'reverbDecay', ' s'], ['reverbPredelay', 'reverbPredelay', ' ms'],
  ['reverbTone', 'reverbTone', ' Hz'], ['delayMix', 'delayMix', '%'], ['delayMs', 'delayMs', ' ms'],
  ['limiterDb', 'limiterDb', ' dB']
];

let settings = { ...DEFAULTS, ...DEVICE_DEFAULTS, videoUrl: '' };
let captureActive = false, statusReceived = false, effectsSupported = false, stageSettingsSynced = false;
let obsState = { connected: false, recording: false, streaming: false };
let obsStatusKnown = false;
let captureMode = sessionStorage.getItem('karaoke-capture-mode') === 'website' ? 'website' : 'karaoke';
let websiteRefresh = false, obsAction = false, configuredWebsiteWindow = '';
const websiteWindowIds = new Map();
let obsActionError = '';
let syncOffsetMs = 0, syncDirty = false, syncLoaded = false, syncPending = false, syncRequestId = 0;
let selectedPreset = 'manual';
const savedPresets = {};
let audioUpdates = Promise.resolve();
let audioEdit = 0;
try {
  const previous = JSON.parse(localStorage.getItem(storeKey) || '{}');
  settings = { ...settings, ...previous, ...normalizeVoiceSettings(previous) };
} catch {}
try {
  const previous = JSON.parse(localStorage.getItem(presetStoreKey) || '{}');
  for (const id of ['manual', ...Object.keys(VOCAL_PRESETS)]) {
    const saved = previous.profiles?.[id];
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      savedPresets[id] = vocalSettings({ ...VOCAL_PRESETS[id]?.settings, ...saved });
    }
  }
  if (Object.hasOwn(VOCAL_PRESETS, previous.selected)) selectedPreset = previous.selected;
  Object.assign(settings, savedPresets[selectedPreset] || VOCAL_PRESETS[selectedPreset]?.settings);
} catch {}
settings.inputDeviceId = String(settings.inputDeviceId || '');
settings.outputDeviceId = String(settings.outputDeviceId || '');

function save() {
  if (captureActive) return;
  localStorage.setItem(storeKey, JSON.stringify({ ...settings }));
}

function savePresets() {
  localStorage.setItem(presetStoreKey, JSON.stringify({ selected: selectedPreset, profiles: savedPresets }));
}

function message(text, error = false) {
  $('songMessage').textContent = text;
  $('songMessage').classList.toggle('danger', error);
}

function clampSyncOffset(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-500, Math.min(500, Math.round(number / 10) * 10));
}

function syncOffsetFromEditor() {
  const amount = Math.max(0, Math.min(500, Number($('syncAmount')?.value || 0)));
  const direction = $('syncDirection')?.value || 'aligned';
  return clampSyncOffset(direction === 'voice-first' ? -amount : direction === 'picture-first' ? amount : 0);
}

function syncEditorFromOffset(offsetMs) {
  syncOffsetMs = clampSyncOffset(offsetMs);
  const direction = syncOffsetMs < 0 ? 'voice-first' : syncOffsetMs > 0 ? 'picture-first' : 'aligned';
  $('syncDirection').value = direction;
  $('syncAmount').value = Math.abs(syncOffsetMs);
  renderSyncMeaning();
}

function renderSyncMeaning() {
  const offset = syncOffsetFromEditor();
  $('syncAmountValue').textContent = `${Math.abs(offset)} ms`;
  $('syncMeaning').textContent = offset > 0
    ? `Camera will be delayed ${offset} ms in the OBS stream/recording.`
    : offset < 0
      ? `Broadcast mix + song picture will be delayed ${Math.abs(offset)} ms.`
      : 'No correction.';
}

function setSyncStatus(text, error = false) {
  const element = $('syncStatus');
  if (!element) return;
  element.textContent = text;
  element.classList.toggle('danger', error);
}

function renderSyncResponse(data, fallback) {
  const text = data.message || fallback;
  const needsAttention = data.applied === false || data.stale === true;
  setSyncStatus(needsAttention ? `Lip sync needs attention: ${text}` : text, needsAttention);
  return !needsAttention;
}

function syncBusy() {
  return Boolean(obsState.recording || obsState.streaming);
}

function updateObsState(data = {}) {
  obsStatusKnown = true;
  obsState = { ...obsState, connected: data.connected !== false, recording: Boolean(data.recording), streaming: Boolean(data.streaming) };
  updateSyncAvailability();
  renderCaptureMode();
}

function updateSyncAvailability() {
  const busy = syncBusy();
  const unavailable = obsStatusKnown && obsState.connected === false;
  for (const control of [$('syncDirection'), $('syncAmount')]) if (control) control.disabled = syncPending || busy;
  for (const control of [$('applySync'), $('resetSync')]) if (control) control.disabled = syncPending || busy || unavailable;
  if (busy && !syncPending) {
    setSyncStatus(obsState.streaming ? 'Stop the OBS stream before applying lip sync.' : 'Stop the OBS recording before applying lip sync.', true);
  } else if (unavailable && !syncPending) {
    setSyncStatus('OBS status unavailable. Check OBS before applying lip sync.', true);
  }
}

async function loadSavedSync() {
  const requestId = ++syncRequestId;
  try {
    const data = await obs('sync');
    if (requestId !== syncRequestId || syncDirty) return;
    syncLoaded = true;
    syncOffsetMs = clampSyncOffset(data.offsetMs);
    syncEditorFromOffset(syncOffsetMs);
    renderSyncResponse(data, 'Saved lip-sync setting loaded.');
  } catch (error) {
    if (requestId !== syncRequestId) return;
    syncLoaded = false;
    setSyncStatus(`Lip sync unavailable: ${error.message}`, true);
  }
  updateSyncAvailability();
}

async function applySyncOffset(offsetMs, label = 'Lip-sync setting saved.') {
  if (syncBusy()) {
    updateSyncAvailability();
    return;
  }
  const requestId = ++syncRequestId;
  const requestedOffset = clampSyncOffset(offsetMs);
  syncPending = true;
  updateSyncAvailability();
  setSyncStatus('Applying to OBS…');
  try {
    const data = await obs('sync', { offsetMs: requestedOffset });
    if (requestId !== syncRequestId) return;
    syncLoaded = true;
    syncOffsetMs = clampSyncOffset(data.offsetMs);
    syncEditorFromOffset(syncOffsetMs);
    if (renderSyncResponse(data, label)) syncDirty = false;
  } catch (error) {
    if (requestId === syncRequestId) setSyncStatus(`Lip sync not applied: ${error.message}`, true);
  } finally {
    if (requestId === syncRequestId) {
      syncPending = false;
      updateSyncAvailability();
    }
  }
}

const command = async (name, payload = {}) => {
  try {
    const response = await fetch('/api/stage/command', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command: name, payload }) });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Stage did not respond.');
    if (data.status) updateStatus(data.status);
    return data;
  } catch (error) { message(error.message, true); return null; }
};

// Keep changes in the order the performer makes them, even during a live mic session.
function sendAudioUpdate(name, payload) {
  const edit = ++audioEdit;
  audioUpdates = audioUpdates.then(async () => {
    const result = await command(name, payload);
    if (!result && edit === audioEdit && name === 'syncSettings') {
      renderPreset('Stage did not respond. Select this preset again to retry.');
    }
  });
}

function syncControls() {
  for (const [id, key, suffix] of RANGE_FIELDS) {
    const input = $(id), output = $(`${id}Value`);
    if (!input || !output) continue;
    input.value = settings[key];
    output.textContent = `${input.value}${suffix}`;
  }
  if ($('compression')) $('compression').checked = Boolean(settings.compression);
}

function renderPreset(error = '') {
  for (const button of presetButtons) button.setAttribute('aria-pressed', String(button.dataset.vocalPreset === selectedPreset));
  const preset = VOCAL_PRESETS[selectedPreset];
  $('resetVocalPreset').hidden = !preset;
  const status = $('vocalPresetStatus');
  status.classList.toggle('danger', Boolean(error));
  status.textContent = error || (preset ? `${preset.label}. ${preset.description}` : 'Adjust the vocal settings below.');
}

function selectPreset(id, reset = false) {
  if (id !== selectedPreset && selectedPreset === 'manual') savedPresets.manual = vocalSettings(settings);
  selectedPreset = id;
  if (reset) delete savedPresets[id];
  const profile = savedPresets[id] || VOCAL_PRESETS[id]?.settings || vocalSettings(settings);
  Object.assign(settings, profile);
  syncControls();
  savePresets();
  renderPreset();
  sendAudioUpdate('syncSettings', profile);
}

function saveVocalEdit(name) {
  savedPresets[selectedPreset] = vocalSettings(settings);
  savePresets();
  renderPreset();
  sendAudioUpdate(name, { value: settings[name] });
}

function setAdvancedAvailability() {
  document.querySelectorAll('[data-advanced-effect]').forEach(input => { input.disabled = !effectsSupported; });
  const notice = $('effectsNotice');
  if (notice) notice.hidden = effectsSupported || !statusReceived;
}

function deviceItems(data, key) {
  const lists = data.devices || {};
  const list = lists[key] || [];
  return Array.isArray(list) ? list : [];
}

function renderDeviceSelect(id, items, selected) {
  const select = $(id);
  if (!select) return;
  select.replaceChildren(new Option('System default', ''));
  for (const item of items) {
    const value = String(item.id ?? item.deviceId ?? '');
    if (!value) continue;
    select.append(new Option(String(item.label ?? item.name ?? 'Unnamed device'), value));
  }
  const wanted = String(selected || '');
  if ([...select.options].some(option => option.value === wanted)) select.value = wanted;
}

function adoptStageSettings(data) {
  if (captureActive) {
    // Reopening the Control Desk must reflect an active Stage instead of applying startup defaults.
    if (!stageSettingsSynced && audioEdit === 0) {
      for (const key of Object.keys(DEFAULTS)) if (data[key] !== undefined) settings[key] = data[key];
      settings = { ...settings, ...normalizeVoiceSettings(settings) };
      syncControls();
    }
    settings.inputDeviceId = String(data.inputDeviceId ?? settings.inputDeviceId ?? '');
    settings.outputDeviceId = String(data.outputDeviceId ?? settings.outputDeviceId ?? '');
  }
}

function updateStatus(data = {}) {
  statusReceived = true;
  captureActive = Boolean(data.camera || data.mic || data.audio);
  effectsSupported = Number(data.effectsVersion || 0) >= 2;
  setAdvancedAvailability();
  adoptStageSettings(data);
  renderDeviceSelect('micDevice', deviceItems(data, 'inputs'), data.inputDeviceId ?? settings.inputDeviceId);
  renderDeviceSelect('outputDevice', deviceItems(data, 'outputs'), data.outputDeviceId ?? settings.outputDeviceId);
  $('connection').textContent = data.audio ? 'Stage + audio ready' : data.camera ? 'Camera ready' : data.player ? `Song ${data.player}` : 'Stage waiting';
  $('mediaStatus').textContent = data.mic ? `${data.micLabel || 'Microphone'} on` : 'Microphone off';
  if ($('latencyInfo')) $('latencyInfo').textContent = data.mic ? `Monitor output ≈ ${Math.round((data.baseLatencyMs || 0) + (data.outputLatencyMs || 0))} ms · ${Number(data.algorithmicLookaheadMs || 0)} ms effect lookahead` : 'Low-latency monitoring · choose headphones on the Stage';
  $('micMeter').style.width = `${Math.min(100, Math.max(0, Number(data.micDb || -60) + 60) * 1.66)}%`;
  $('clipStatus').textContent = data.clip ? 'Clip warning — lower Voice.' : data.mic ? `Mic ${Number(data.micDb || -60).toFixed(1)} dBFS` : 'Waiting for the stage microphone.';
  if ($('deviceMessage')) $('deviceMessage').textContent = captureActive ? 'Stop capture before changing devices.' : 'Apply while capture is stopped.';
  if (data.error) message(data.error, true);
  else if (data.player) message(({ playing: 'Playing', paused: 'Paused', ready: 'Song ready — press Play', loading: 'Loading video…', buffering: 'Buffering…', ended: 'Song finished' })[data.player] || 'Ready');
  if (data.ready && !stageSettingsSynced) {
    stageSettingsSynced = true;
    if (!captureActive && audioEdit === 0) sendAudioUpdate('syncSettings', { ...settings });
  }
  updateSyncAvailability();
}

function bindRange(id, key, suffix) {
  const input = $(id), output = $(`${id}Value`);
  if (!input || !output) return;
  input.value = settings[key]; output.textContent = `${input.value}${suffix}`;
  input.oninput = () => {
    settings[key] = Number(input.value);
    if (key === 'compressionAmount') {
      const { threshold, ratio } = compressionPresetFromAmount(settings.compressionAmount);
      settings.compressionThreshold = threshold;
      settings.compressionRatio = ratio;
    }
    if (key === 'reverbMix') settings.reverb = settings.reverbMix;
    syncControls();
    if (key === 'music') {
      save();
      sendAudioUpdate(key, { value: settings[key] });
    } else {
      saveVocalEdit(key);
    }
  };
}

for (const [id, key, suffix] of RANGE_FIELDS) bindRange(id, key, suffix);
$('compression').onchange = () => {
  settings.compression = $('compression').checked;
  saveVocalEdit('compression');
};
for (const button of presetButtons) button.onclick = () => selectPreset(button.dataset.vocalPreset);
$('resetVocalPreset').onclick = () => selectPreset(selectedPreset, true);
syncControls(); setAdvancedAvailability(); renderPreset();

$('youtubeUrl').value = settings.videoUrl;
$('load').onclick = () => { try { const videoId = parseYouTubeUrl($('youtubeUrl').value); settings.videoUrl = $('youtubeUrl').value.trim(); save(); command('load', { videoId }); message('Loaded privately. Press Play when ready.'); } catch (error) { message(error.message, true); } };
$('play').onclick = () => command('play'); $('pause').onclick = () => command('pause'); $('restart').onclick = () => command('restart');
$('enableMedia').onclick = () => command('enableMedia');
$('refreshDevices').onclick = () => command('refreshDevices');
$('applyDevices').onclick = () => captureActive ? message('Stop capture before changing devices.', true) : command('setDevices', { inputDeviceId: settings.inputDeviceId, outputDeviceId: settings.outputDeviceId });
for (const [id, key] of [['micDevice', 'inputDeviceId'], ['outputDevice', 'outputDeviceId']]) $(id)?.addEventListener('change', event => { settings[key] = event.target.value; save(); });

function obs(path, body) { return fetch(`/api/obs/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error || 'OBS request failed.'); return data; }); }
function appRoute(path, body = {}) { return fetch(`/api/app/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error || 'App request failed.'); return data; }); }

function renderCaptureMode() {
  const website = captureMode === 'website';
  const busy = obsAction || obsState.recording || obsState.streaming;
  $('youtubeSource').hidden = website;
  $('websiteSource').hidden = !website;
  $('backingTrackLevel').hidden = website;
  $('syncDetails').closest('.sync-panel').hidden = website;
  $('karaokeMode').setAttribute('aria-pressed', String(!website));
  $('websiteMode').setAttribute('aria-pressed', String(website));
  $('karaokeMode').disabled = $('websiteMode').disabled = busy;
  $('websiteWindow').disabled = $('refreshWebsiteWindows').disabled = busy || websiteRefresh;
  $('obsSetup').disabled = busy;
  $('record').disabled = obsAction || (obsState.streaming && !obsState.recording);
  $('stop').disabled = obsAction;
}

async function refreshWebsiteWindows() {
  if (websiteRefresh || obsAction || obsState.recording || obsState.streaming) return;
  websiteRefresh = true;
  renderCaptureMode();
  const output = $('websiteStatus');
  output.textContent = 'Looking for Chrome windows…';
  output.classList.remove('danger');
  try {
    const { windows } = await obs('website-windows', {});
    const select = $('websiteWindow');
    const selected = select.value || sessionStorage.getItem('karaoke-website-window');
    select.replaceChildren(new Option('Select a window', ''));
    websiteWindowIds.clear();
    for (const { id, title } of windows) {
      websiteWindowIds.set(String(id), id);
      select.add(new Option(title, String(id)));
    }
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
    output.textContent = windows.length ? 'Choose a window, then use Set up OBS.' : 'Open a Chrome window with the website and refresh.';
  } catch (error) {
    output.textContent = error.message;
    output.classList.add('danger');
  } finally {
    websiteRefresh = false;
    renderCaptureMode();
  }
}

function selectCaptureMode(mode) {
  captureMode = mode;
  obsActionError = '';
  sessionStorage.setItem('karaoke-capture-mode', mode);
  renderCaptureMode();
  if (mode === 'website') refreshWebsiteWindows();
}

function recordingSource() {
  if (captureMode === 'karaoke') return {};
  const windowId = websiteWindowIds.get($('websiteWindow').value);
  if (windowId === undefined) throw Error('Choose a Chrome window in Website mode.');
  return { mode: 'website', windowId };
}

$('karaokeMode').onclick = () => selectCaptureMode('karaoke');
$('websiteMode').onclick = () => selectCaptureMode('website');
$('refreshWebsiteWindows').onclick = refreshWebsiteWindows;
$('websiteWindow').onchange = () => {
  obsActionError = '';
  sessionStorage.setItem('karaoke-website-window', $('websiteWindow').value);
};
renderCaptureMode();

async function whileUpdatingObs(action) {
  if (obsAction) return;
  obsAction = true;
  obsActionError = '';
  renderCaptureMode();
  try { await action(); }
  catch (error) { $('obsStatus').textContent = obsActionError = error.message; }
  finally { obsAction = false; renderCaptureMode(); }
}

function showSavedRecording(data) {
  if (!data?.savedPath) return;
  const button = $('showRecording');
  button.hidden = false;
  button.dataset.savedPath = data.savedPath;
}

$('obsSetup').onclick = () => whileUpdatingObs(async () => {
  const source = recordingSource();
  const data = await obs('setup', source);
  configuredWebsiteWindow = String(source.windowId ?? '');
  updateObsState(data);
  $('obsStatus').textContent = data.message || 'OBS scene ready.';
  if (data.connected && !source.windowId) loadSavedSync();
});
$('record').onclick = () => whileUpdatingObs(async () => {
  const current = await obs('status');
  updateObsState(current);
  const source = current.recording ? { action: 'stop' } : { action: 'start', ...recordingSource() };
  const data = await obs('record', source);
  if (!current.recording) configuredWebsiteWindow = String(source.windowId ?? '');
  updateObsState(data);
  $('record').textContent = data.recording ? 'Stop & save' : 'Record in OBS';
  showSavedRecording(data);
  $('obsStatus').textContent = data.savedPath ? `Saved: ${data.savedPath}` : (data.message || 'OBS updated.');
});
$('showRecording').onclick = async () => { try { await appRoute('show-recording'); $('obsStatus').textContent = 'Showing the saved recording.'; } catch (error) { $('obsStatus').textContent = error.message; } };

$('syncDirection').onchange = () => {
  if ($('syncDirection').value === 'aligned') $('syncAmount').value = '0';
  syncDirty = true;
  renderSyncMeaning();
  setSyncStatus('Unsaved lip-sync change.');
};
$('syncAmount').oninput = () => {
  if (Number($('syncAmount').value) > 0 && $('syncDirection').value === 'aligned') $('syncDirection').value = 'picture-first';
  syncDirty = true;
  renderSyncMeaning();
  setSyncStatus('Unsaved lip-sync change.');
};
$('applySync').onclick = () => applySyncOffset(syncOffsetFromEditor());
$('resetSync').onclick = () => {
  syncDirty = true;
  syncEditorFromOffset(0);
  applySyncOffset(0, 'Lip sync reset.');
};
syncEditorFromOffset(0);
loadSavedSync();

bus.on(messageData => { if (messageData?.type === 'status') updateStatus(messageData.data); });
command('requestStatus');

async function karaokeRefreshObs() {
  try {
    const data = await obs('status');
    updateObsState(data);
    $('record').textContent = data.recording ? 'Stop & save' : 'Record in OBS';
    if (obsAction) return;
    const websiteReady = data.websiteScene && configuredWebsiteWindow && configuredWebsiteWindow === $('websiteWindow').value;
    $('obsStatus').textContent = data.streaming ? 'OBS is streaming.' : data.recording ? 'OBS recording.' : obsActionError || (captureMode === 'website'
      ? (websiteReady ? 'Website ready in OBS.' : 'Choose a Chrome window and use Set up OBS.')
      : (data.correctScene ? 'OBS ready.' : 'Use Set up OBS for YouTube karaoke.'));
  } catch (error) {
    updateObsState({ connected: false, recording: false, streaming: false });
    $('obsStatus').textContent = error.message;
  }
}

$('stop').onclick = () => whileUpdatingObs(async () => {
  try {
    const current = await obs('status');
    updateObsState(current);
    if (current.recording) { const saved = await obs('record', { action: 'stop' }); updateObsState(saved); showSavedRecording(saved); $('obsStatus').textContent = saved.savedPath ? `Saved: ${saved.savedPath}` : (saved.message || 'Recording stopped.'); }
  } finally { $('record').textContent = 'Record in OBS'; command('stop'); }
});

karaokeRefreshObs();
if (captureMode === 'website') refreshWebsiteWindows();
setInterval(karaokeRefreshObs, 1000);
