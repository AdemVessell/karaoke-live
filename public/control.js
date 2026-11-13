import { createBus, parseYouTubeUrl, DEFAULTS, normalizeVoiceSettings } from './common.js';

const $ = id => document.getElementById(id);
const bus = createBus();
const storeKey = 'karaoke-live-settings';
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
try { settings = { ...settings, ...JSON.parse(localStorage.getItem(storeKey) || '{}') }; } catch {}
settings = { ...settings, ...normalizeVoiceSettings(settings) };
settings.inputDeviceId = String(settings.inputDeviceId || '');
settings.outputDeviceId = String(settings.outputDeviceId || '');

function save() {
  if (captureActive) return;
  localStorage.setItem(storeKey, JSON.stringify({ ...settings }));
}

function message(text, error = false) {
  $('songMessage').textContent = text;
  $('songMessage').classList.toggle('danger', error);
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

function syncControls() {
  for (const [id, key, suffix] of RANGE_FIELDS) {
    const input = $(id), output = $(`${id}Value`);
    if (!input || !output) continue;
    input.value = settings[key];
    output.textContent = `${input.value}${suffix}`;
  }
  if ($('compression')) $('compression').checked = Boolean(settings.compression);
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
    for (const key of Object.keys(DEFAULTS)) if (data[key] !== undefined) settings[key] = data[key];
    settings = { ...settings, ...normalizeVoiceSettings(settings) };
    settings.inputDeviceId = String(data.inputDeviceId ?? settings.inputDeviceId ?? '');
    settings.outputDeviceId = String(data.outputDeviceId ?? settings.outputDeviceId ?? '');
    syncControls();
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
    if (!captureActive) command('syncSettings', { ...settings });
  }
}

function bindRange(id, key, suffix) {
  const input = $(id), output = $(`${id}Value`);
  if (!input || !output) return;
  input.value = settings[key]; output.textContent = `${input.value}${suffix}`;
  input.oninput = () => {
    settings[key] = Number(input.value);
    output.textContent = `${input.value}${suffix}`;
    save();
    command(key, { value: settings[key] });
  };
}

for (const [id, key, suffix] of RANGE_FIELDS) bindRange(id, key, suffix);
if ($('compression')) $('compression').onchange = () => { settings.compression = $('compression').checked; save(); command('compression', { value: settings.compression }); };
syncControls(); setAdvancedAvailability();

$('youtubeUrl').value = settings.videoUrl;
$('load').onclick = () => { try { const videoId = parseYouTubeUrl($('youtubeUrl').value); settings.videoUrl = $('youtubeUrl').value.trim(); save(); command('load', { videoId }); message('Loaded privately. Press Play when ready.'); } catch (error) { message(error.message, true); } };
$('play').onclick = () => command('play'); $('pause').onclick = () => command('pause'); $('restart').onclick = () => command('restart');
$('enableMedia').onclick = () => command('enableMedia');
$('refreshDevices').onclick = () => command('refreshDevices');
$('applyDevices').onclick = () => captureActive ? message('Stop capture before changing devices.', true) : command('setDevices', { inputDeviceId: settings.inputDeviceId, outputDeviceId: settings.outputDeviceId });
for (const [id, key] of [['micDevice', 'inputDeviceId'], ['outputDevice', 'outputDeviceId']]) $(id)?.addEventListener('change', event => { settings[key] = event.target.value; save(); });

function obs(path, body) { return fetch(`/api/obs/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async response => { const data = await response.json(); if (!response.ok) throw Error(data.error || 'OBS request failed.'); return data; }); }
$('obsSetup').onclick = async () => { try { const data = await obs('setup', {}); $('obsStatus').textContent = data.error || (data.connected ? 'OBS scene ready.' : 'OBS unavailable.'); } catch (error) { $('obsStatus').textContent = error.message; } };
$('record').onclick = async () => { try { const current = await obs('status'); const data = await obs('record', { action: current.recording ? 'stop' : 'start' }); $('record').textContent = data.recording ? 'Stop & save' : 'Record in OBS'; $('obsStatus').textContent = data.savedPath ? `Saved: ${data.savedPath}` : (data.message || 'OBS updated.'); } catch (error) { $('obsStatus').textContent = error.message; } };

bus.on(messageData => { if (messageData?.type === 'status') updateStatus(messageData.data); });
command('requestStatus');

async function karaokeRefreshObs() {
  try {
    const data = await obs('status');
    $('record').textContent = data.recording ? 'Stop & save' : 'Record in OBS';
    $('obsStatus').textContent = data.streaming ? 'OBS is streaming.' : data.recording ? 'OBS recording.' : data.correctScene ? 'OBS ready.' : 'Select Karaoke Live in OBS.';
  } catch (error) { $('obsStatus').textContent = error.message; }
}

$('stop').onclick = async () => {
  try {
    const current = await obs('status');
    if (current.recording) { const saved = await obs('record', { action: 'stop' }); $('obsStatus').textContent = saved.savedPath ? `Saved: ${saved.savedPath}` : (saved.message || 'Recording stopped.'); }
  } catch (error) { $('obsStatus').textContent = error.message; }
  finally { $('record').textContent = 'Record in OBS'; command('stop'); }
};

karaokeRefreshObs();
setInterval(karaokeRefreshObs, 1000);
