import { createBus, createVoiceChain, prepareVoiceProcessing, DEFAULTS, normalizeVoiceSettings, compressionPresetFromAmount, youtubeStateUpdate } from './common.js';

const $ = id => document.getElementById(id);
const bus = createBus();
const camera = $('camera');
let player = null, playerReady = false, queuedVideo = null, media = null, audio = null, chain = null;
let settings = { ...DEFAULTS, inputDeviceId: '', outputDeviceId: '' };let mediaStarting=false;
let status = { ready: true, camera: false, mic: false, audio: false, player: 'idle', recording: false, ...DEFAULTS, effectsVersion: 2, micDb: -Infinity, clip: false, devices: { inputs: [], outputs: [] } };

function publish() { bus.post({ type: 'status', data: { ...status } }); }
function setStatus(next) { status = { ...status, ...next }; publish(); }
function applySettings(patch) {
  if (Object.prototype.hasOwnProperty.call(patch, 'reverb') && !Object.prototype.hasOwnProperty.call(patch, 'reverbMix')) patch = { ...patch, reverbMix: patch.reverb };
  const simpleCompressionPreset = Object.prototype.hasOwnProperty.call(patch, 'compressionAmount') && !['compressionThreshold', 'compressionRatio', 'compressionMakeup', 'compressionAttack', 'compressionRelease'].some(key => Object.prototype.hasOwnProperty.call(patch, key));
  settings = { ...settings, ...normalizeVoiceSettings({ ...settings, ...patch }), inputDeviceId: patch.inputDeviceId ?? settings.inputDeviceId, outputDeviceId: patch.outputDeviceId ?? settings.outputDeviceId };
  chain?.setVoiceDb(settings.voiceDb);
  chain?.setCompression(settings.compression);
  if (!simpleCompressionPreset) chain?.setCompressionAmount(settings.compressionAmount);
  chain?.setCompressionThreshold(settings.compressionThreshold);
  chain?.setCompressionRatio(settings.compressionRatio);
  chain?.setCompressionMakeup(settings.compressionMakeup);
  chain?.setCompressionAttack(settings.compressionAttack);
  chain?.setCompressionRelease(settings.compressionRelease);
  chain?.setReverbMix(settings.reverbMix);
  chain?.setReverbDecay(settings.reverbDecay);
  chain?.setReverbPredelay(settings.reverbPredelay);
  chain?.setReverbTone(settings.reverbTone);
  chain?.setDelayMix(settings.delayMix);
  chain?.setDelayMs(settings.delayMs);
  chain?.setDelayFeedback(settings.delayFeedback);
  chain?.setLimiterDb(settings.limiterDb);
  if (simpleCompressionPreset) {
    const preset = compressionPresetFromAmount(settings.compressionAmount);
    chain?.setCompressionAmount(settings.compressionAmount);
    settings.compressionThreshold = preset.threshold; settings.compressionRatio = preset.ratio;
  }
  player?.setVolume?.(Number(settings.music));
  setStatus({ ...settings });
}
function youtubeError(code) { return ({ 2: 'Invalid YouTube request.', 5: 'YouTube cannot play this video in HTML5.', 100: 'This YouTube video is unavailable or private.', 101: 'This YouTube video owner does not allow embedded playback.', 150: 'This YouTube video owner does not allow embedded playback.', 153: 'YouTube needs an embedded page referrer; reload the Stage from Karaoke Live.' }[Number(code)] || `YouTube player error ${code}.`); }
function loadPlayerScript() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('YouTube player timed out while loading. Check your internet connection.')), 12000); const script = document.createElement('script'); script.src = 'https://www.youtube.com/iframe_api'; script.onerror = () => { clearTimeout(timer); reject(new Error('YouTube player could not load.')); }; window.onYouTubeIframeAPIReady = () => { clearTimeout(timer); resolve(); }; document.head.append(script); });
}
async function initPlayer(videoId) {
  await loadPlayerScript();
  if (!player) {
    player = new window.YT.Player('player', { width: '100%', height: '100%', videoId, playerVars: { playsinline: 1, controls: 1, origin: location.origin, widget_referrer: 'https://org.stevenson.karaoke-live/', rel: 0, modestbranding: 1 }, events: { onReady: () => { playerReady = true; player.setVolume(Number(settings.music)); $('songStatus').textContent = 'Song ready — press Play'; setStatus({ player: 'ready', error: '' }); if (queuedVideo) { player.cueVideoById(queuedVideo); queuedVideo = null; } }, onStateChange: event => { const update=youtubeStateUpdate(event.data,status.player);const name=update.player; $('songStatus').textContent = name === 'playing' ? 'Playing' : name === 'paused' ? 'Paused' : name === 'ended' ? 'Song ended' : 'Song loading'; setStatus(update); }, onError: event => { const error = youtubeError(event.data); $('songStatus').textContent = error; setStatus({ player: `error ${event.data}`, error }); } } });
  } else if (playerReady) player.cueVideoById(videoId); else queuedVideo = videoId;
}
async function refreshDevices() {
  const list = await navigator.mediaDevices.enumerateDevices();
  const inputs = list.filter(device => device.kind === 'audioinput').map(device => ({ id: device.deviceId, label: device.label || 'Microphone' }));
  const outputs = list.filter(device => device.kind === 'audiooutput').map(device => ({ id: device.deviceId, label: device.label || 'System output' }));
  setStatus({ devices: { inputs, outputs } });
  return { inputs, outputs };
}
async function setOutputDevice(deviceId) {
  const requested = String(deviceId || '');
  if (!status.devices.outputs.length) await refreshDevices();
  if (requested && !status.devices.outputs.some(device => device.id === requested)) throw new Error('That output device is no longer available.');
  settings.outputDeviceId = requested;
  if (audio?.setSinkId) await audio.setSinkId(requested).catch(error => { throw new Error(`Output device could not be selected: ${error.message}`); });
  setStatus({ outputDeviceId: requested });
}
async function setInputDevice(deviceId) {
  const requested = String(deviceId || '');
  if (!status.devices.inputs.length) await refreshDevices();
  if (requested && !status.devices.inputs.some(device => device.id === requested)) throw new Error('That microphone is no longer available.');
  const previous = settings.inputDeviceId;
  settings.inputDeviceId = requested;
  if (!media) { setStatus({ inputDeviceId: requested }); return; }
  let next;
  try {
    next = await navigator.mediaDevices.getUserMedia({ audio: { ...(requested ? { deviceId: { exact: requested } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } }, video: false });
    const oldTrack = media.getAudioTracks()[0]; const nextTrack = next.getAudioTracks()[0];
    if (!nextTrack) throw new Error('No audio track was returned.');
    const nextChain = createVoiceChain(audio, nextTrack, audio.destination, settings);
    media.removeTrack(oldTrack); oldTrack?.stop(); media.addTrack(nextTrack);
    chain?.stop(); chain = nextChain;
    setStatus({ mic: true, audio: true, inputDeviceId: requested, micLabel: nextTrack.label, error: '' });
  } catch (error) { settings.inputDeviceId = previous; next?.getTracks().forEach(track => track.stop()); setStatus({ error: error.message }); throw error; }
}
async function enableMedia() {
  if (media||mediaStarting) return;
  mediaStarting=true;
  let first = null;
  try {
    first = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } }, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } } });
    const devices = await navigator.mediaDevices.enumerateDevices(); const requestedInput = settings.inputDeviceId && devices.some(device => device.kind === 'audioinput' && device.deviceId === settings.inputDeviceId) ? settings.inputDeviceId : '';
    if (requestedInput && first.getAudioTracks()[0]?.getSettings().deviceId !== requestedInput) {
      const exact = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: requestedInput }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 }, sampleRate: { ideal: 48000 } }, video: false });
      const oldAudio = first.getAudioTracks(); oldAudio.forEach(track => { first.removeTrack(track); track.stop(); }); exact.getAudioTracks().forEach(track => first.addTrack(track)); exact.getVideoTracks().forEach(track => track.stop());
    }
    media = first; camera.srcObject = media;camera.dataset.active='true'; await camera.play(); $('cameraPlaceholder').hidden = true;
    audio = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 }); await audio.resume();
    if (audio.setSinkId && settings.outputDeviceId) await setOutputDevice(settings.outputDeviceId);
    await prepareVoiceProcessing(audio);
    chain = createVoiceChain(audio, media.getAudioTracks()[0], audio.destination, settings);
    $('songStatus').textContent = 'Vocal chain ready'; await refreshDevices(); setStatus({ camera: true, mic: true, audio: true, inputDeviceId: media.getAudioTracks()[0]?.getSettings().deviceId || '', outputDeviceId: settings.outputDeviceId || '', micLabel: media.getAudioTracks()[0]?.label || 'Microphone', inputLatencyMs:1000*(media.getAudioTracks()[0]?.getSettings().latency||0),baseLatencyMs:1000*audio.baseLatency,outputLatencyMs:1000*(audio.outputLatency||0),algorithmicLookaheadMs:chain.algorithmicLookaheadMs, error: '' }); $('micStatus').textContent = `${media.getAudioTracks()[0]?.label || 'Microphone'} vocal chain`;
  } catch (error) {
    first?.getTracks().forEach(track => track.stop()); chain?.stop(); chain = null; if (audio) await audio.close().catch(() => {}); audio = null; media = null; camera.srcObject = null;camera.removeAttribute('data-active');camera.removeAttribute('src');camera.load(); $('cameraPlaceholder').hidden = false; setStatus({ camera: false, mic: false, audio: false, error: error.message }); throw error;
  }finally{mediaStarting=false;}
}
function stopAll() { if (player?.pauseVideo) player.pauseVideo(); media?.getTracks().forEach(track => track.stop()); media = null; camera.srcObject = null;camera.removeAttribute('data-active');camera.removeAttribute('src');camera.load(); $('cameraPlaceholder').hidden = false; chain?.stop(); chain = null; audio?.close(); audio = null; $('songStatus').textContent = 'Paused'; setStatus({ camera: false, mic: false, audio: false, player: 'paused', micDb: -Infinity, clip: false, error: '' }); $('micStatus').textContent = 'Mic off'; }
function execute(command, payload = {}) {
  if (command === 'load') { setStatus({player:'loading',error:''});settings.videoId = payload.videoId; initPlayer(payload.videoId).catch(error => setStatus({ player:'error',error:error.message })); }
  else if (command === 'play') player?.playVideo?.();
  else if (command === 'pause') player?.pauseVideo?.();
  else if (command === 'restart') player?.seekTo?.(0, true);
  else if (command === 'seek') player?.seekTo?.(Math.max(0,Number(payload.seconds)||0),true);
  else if (command === 'enableMedia') enableMedia().catch(error => setStatus({ error: error.message }));
  else if (command === 'stop') stopAll();
  else if (command === 'setDevices') Promise.all([setInputDevice(payload.inputDeviceId ?? settings.inputDeviceId), setOutputDevice(payload.outputDeviceId ?? settings.outputDeviceId)]).catch(error => setStatus({ error: error.message }));
  else if (command === 'refreshDevices') refreshDevices().catch(error => setStatus({ error: error.message }));
  else if (command === 'inputDeviceId') setInputDevice(payload.value).catch(error => setStatus({ error: error.message }));
  else if (command === 'outputDeviceId') setOutputDevice(payload.value).catch(error => setStatus({ error: error.message }));
  else if (['voiceDb','music','reverb','reverbMix','reverbDecay','reverbPredelay','reverbTone','delayMix','delayMs','delayFeedback','compression','compressionAmount','compressionThreshold','compressionRatio','compressionMakeup','compressionAttack','compressionRelease','limiterDb'].includes(command)) applySettings({ [command]: payload.value });
  else if (command === 'syncSettings') applySettings(payload);
  else if (command === 'requestStatus') publish();
}
bus.on(message => { if (message?.type === 'command') execute(message.command, message.payload); });
setInterval(() => { if (chain && audio) { const values = new Float32Array(chain.analyser.fftSize); chain.analyser.getFloatTimeDomainData(values); let sum = 0, peak = 0; for (const value of values) { sum += value * value; peak = Math.max(peak, Math.abs(value)); } const rms = Math.sqrt(sum / values.length) || 1e-7; setStatus({ micDb: 20 * Math.log10(rms), clip: peak >= 0.98 }); } else publish(); }, 500);
window.__karaoke = { getStatus: () => ({ ...status, queuedVideo: settings.videoId || null, playbackTime:player?.getCurrentTime?.()||0, playbackState:player?.getPlayerState?.()??null }), getDevices: () => ({ ...status.devices }), execute };
window.addEventListener('beforeunload', stopAll);
void refreshDevices().catch(() => {});
publish();
