const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYouTubeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw Object.assign(new Error('Paste a YouTube link first.'), { code: 'empty' });
  let url;
  try { url = new URL(raw); } catch { throw Object.assign(new Error('That is not a valid YouTube URL.'), { code: 'invalid_url' }); }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
  else if (['youtube.com', 'm.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else if (/^\/(?:shorts|embed|live)\//.test(url.pathname)) id = url.pathname.split('/')[2] || '';
  }
  if (!YOUTUBE_ID.test(id)) throw Object.assign(new Error('Use a single YouTube video link, not a playlist.'), { code: 'invalid_video' });
  return id;
}

export const DEFAULTS = Object.freeze({ effectsVersion: 2, voiceDb: 0, music: 65, reverb: 8, reverbMix: 8, reverbDecay: 1.2, reverbPredelay: 12, reverbTone: 8000, delayMix: 0, delayMs: 220, delayFeedback: 0.15, compression: true, compressionAmount: 35, compressionThreshold: -20, compressionRatio: 3, compressionMakeup: 0, compressionAttack: 5, compressionRelease: 120, limiterDb: -1 });

const preparedContexts = new WeakSet();
export async function prepareVoiceProcessing(context) {
  if (preparedContexts.has(context)) return;
  if (!context?.audioWorklet?.addModule) throw new Error('This browser cannot load the low-latency vocal processor.');
  await context.audioWorklet.addModule(new URL('./compressor-worklet.js', import.meta.url));
  preparedContexts.add(context);
}

function finiteClamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function compressionPresetFromAmount(value) {
  const amount = finiteClamp(value, 0, 100, DEFAULTS.compressionAmount) / 100;
  return { threshold: -20 - (amount - 0.35) * 12.3, ratio: Math.max(1, 3 + (amount - 0.35) * 4.6) };
}

export function normalizeVoiceSettings(settings = {}) {
  const raw = settings || {};
  const merged = { ...DEFAULTS, ...raw };
  const hasReverbMix = Object.prototype.hasOwnProperty.call(raw, 'reverbMix');
  const requestedReverb = hasReverbMix ? raw.reverbMix : (Object.prototype.hasOwnProperty.call(raw, 'reverb') ? raw.reverb : merged.reverbMix);
  const reverbMix = finiteClamp(requestedReverb, 0, 60, DEFAULTS.reverbMix);
  const preset = compressionPresetFromAmount(merged.compressionAmount);
  const threshold = Object.prototype.hasOwnProperty.call(raw, 'compressionThreshold') ? finiteClamp(merged.compressionThreshold, -40, 0, DEFAULTS.compressionThreshold) : (Object.prototype.hasOwnProperty.call(raw, 'compressionAmount') ? preset.threshold : DEFAULTS.compressionThreshold);
  const ratio = Object.prototype.hasOwnProperty.call(raw, 'compressionRatio') ? finiteClamp(merged.compressionRatio, 1, 8, DEFAULTS.compressionRatio) : (Object.prototype.hasOwnProperty.call(raw, 'compressionAmount') ? preset.ratio : DEFAULTS.compressionRatio);
  return {
    effectsVersion: 2,
    voiceDb: finiteClamp(merged.voiceDb, -12, 18, DEFAULTS.voiceDb),
    music: finiteClamp(merged.music, 0, 100, DEFAULTS.music),
    reverb: reverbMix,
    reverbMix,
    reverbDecay: finiteClamp(merged.reverbDecay, 0.3, 3, DEFAULTS.reverbDecay),
    reverbPredelay: finiteClamp(merged.reverbPredelay, 0, 60, DEFAULTS.reverbPredelay),
    reverbTone: finiteClamp(merged.reverbTone, 2000, 12000, DEFAULTS.reverbTone),
    delayMix: finiteClamp(merged.delayMix, 0, 25, DEFAULTS.delayMix),
    delayMs: finiteClamp(merged.delayMs, 80, 500, DEFAULTS.delayMs),
    delayFeedback: finiteClamp(merged.delayFeedback, 0, 0.25, DEFAULTS.delayFeedback),
    compression: Boolean(merged.compression),
    compressionAmount: finiteClamp(merged.compressionAmount, 0, 100, DEFAULTS.compressionAmount),
    compressionThreshold: threshold,
    compressionRatio: ratio,
    compressionMakeup: finiteClamp(merged.compressionMakeup, 0, 12, DEFAULTS.compressionMakeup),
    compressionAttack: finiteClamp(merged.compressionAttack, 1, 30, DEFAULTS.compressionAttack),
    compressionRelease: finiteClamp(merged.compressionRelease, 40, 400, DEFAULTS.compressionRelease),
    limiterDb: finiteClamp(merged.limiterDb, -12, -1, DEFAULTS.limiterDb)
  };
}

function safetyCurve(limiterDb) {
  const ceiling = Math.pow(10, finiteClamp(limiterDb, -12, -1, -1) / 20);
  const transparent = Math.min(0.85, ceiling * 0.85);
  const curve = new Float32Array(2048);
  const denominator = 1 - Math.exp(-3);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    const sign = Math.sign(x); const magnitude = Math.abs(x);
    if (magnitude <= transparent) curve[i] = x;
    else { const t = Math.min(1, (magnitude - transparent) / Math.max(1e-6, 1 - transparent)); curve[i] = sign * (transparent + (ceiling - transparent) * (1 - Math.exp(-3 * t)) / denominator); }
  }
  return curve;
}

export function createBus(name = 'karaoke-live-v1') {
  const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : null;
  const listeners = new Set();
  if (channel) channel.onmessage = event => listeners.forEach(fn => fn(event.data));
  return {
    post(message) { channel?.postMessage(message); },
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { channel?.close(); listeners.clear(); }
  };
}

export function makeImpulseResponse(context, seconds = 1.2) {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  let seed = 0x6d2b79f5;
  const random = () => { seed = Math.imul(seed ^ seed >>> 15, 1 | seed); seed ^= seed + Math.imul(seed ^ seed >>> 7, 61 | seed); return ((seed ^ seed >>> 14) >>> 0) / 4294967296; };
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const decay = Math.pow(1 - i / length, 2.7 / Math.max(0.3, seconds));
      const early = i < context.sampleRate * 0.012 ? 0.75 : 1;
      data[i] = (random() * 2 - 1) * decay * early;
    }
  }
  return buffer;
}

export function createVoiceGraph(context, sourceAudioNode, destination, settings = DEFAULTS) {
  if (!preparedContexts.has(context)) throw new Error('Low-latency vocal processing is not prepared.');
  settings = normalizeVoiceSettings(settings);
  const highpass = context.createBiquadFilter(); highpass.type = 'highpass'; highpass.frequency.value = 80; highpass.Q.value = 0.7;
  const input = context.createGain();
  const analyser = context.createAnalyser(); analyser.fftSize = 512;
  const compressor = new AudioWorkletNode(context, 'karaoke-zero-latency-compressor', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
  const compressedLevel = context.createGain();
  const bypassLevel = context.createGain();
  const blend = context.createGain();
  const dry = context.createGain();
  const reverbPreDelay = context.createDelay(0.1); const reverb = context.createConvolver();
  const reverbTone = context.createBiquadFilter(); reverbTone.type = 'lowpass';
  const wet = context.createGain();
  const delay = context.createDelay(0.5); const delayFeedback = context.createGain(); const delayWet = context.createGain();
  const limiter = context.createWaveShaper(); limiter.curve = safetyCurve(settings.limiterDb); limiter.oversample = 'none';
  const mono = context.createGain();mono.channelCount=1;mono.channelCountMode='explicit';
  sourceAudioNode.connect(mono).connect(highpass).connect(input);
  const chain = { source: sourceAudioNode, mono, highpass, input, analyser, compressor, compressedLevel, bypassLevel, blend, dry, reverbPreDelay, reverb, reverbTone, wet, delay, delayFeedback, delayWet, limiter, compression: Boolean(settings.compression), voiceDb: finiteClamp(settings.voiceDb, -12, 18, 0), reverbPct: finiteClamp(settings.reverbMix, 0, 60, 8), reverbDecay: finiteClamp(settings.reverbDecay, 0.3, 3, 1.2), reverbPredelay: finiteClamp(settings.reverbPredelay, 0, 60, 12), reverbToneHz: finiteClamp(settings.reverbTone, 2000, 12000, 8000), delayMix: finiteClamp(settings.delayMix, 0, 25, 0), delayMs: finiteClamp(settings.delayMs, 80, 500, 220), delayFeedbackPct: finiteClamp(settings.delayFeedback, 0, 0.25, 0.15), compressionAmount: finiteClamp(settings.compressionAmount, 0, 100, 35), limiterDb: finiteClamp(settings.limiterDb, -12, -1, -1), algorithmicLookaheadMs: 0, processingInfo: { compressor: 'AudioWorklet zero-lookahead, adjustable threshold/ratio/knee/attack/release', limiter: 'WaveShaper peak safety ceiling, configurable -12 to -1 dBFS; not loudness normalization', algorithmicLookaheadMs: 0 } };
  reverbPreDelay.delayTime.value = chain.reverbPredelay / 1000; reverb.buffer = makeImpulseResponse(context, chain.reverbDecay); reverbTone.frequency.value = chain.reverbToneHz;
  delay.delayTime.value = chain.delayMs / 1000; delayFeedback.gain.value = chain.delayFeedbackPct; delayWet.gain.value = chain.delayMix / 100;
  input.gain.value = Math.pow(10, chain.voiceDb / 20); dry.gain.value = 1; wet.gain.value = chain.reverbPct / 100;
  input.connect(analyser); input.connect(compressor); input.connect(bypassLevel); compressor.connect(compressedLevel); compressedLevel.connect(blend); bypassLevel.connect(blend); blend.connect(dry); blend.connect(reverbPreDelay).connect(reverb).connect(reverbTone).connect(wet); blend.connect(delay).connect(delayWet); delay.connect(delayFeedback).connect(delay); dry.connect(limiter); wet.connect(limiter); delayWet.connect(limiter); limiter.connect(destination);
  compressedLevel.gain.value = chain.compression ? 1 : 0; bypassLevel.gain.value = chain.compression ? 0 : 1;
  const setParameter = (name, value) => compressor.parameters.get(name)?.setValueAtTime(value, context.currentTime);
  setParameter('compressionAmount', chain.compressionAmount); setParameter('thresholdDb', settings.compressionThreshold); setParameter('ratio', settings.compressionRatio); setParameter('makeupDb', settings.compressionMakeup); setParameter('attackMs', settings.compressionAttack); setParameter('releaseMs', settings.compressionRelease);
  chain.setVoiceDb = value => { chain.voiceDb = finiteClamp(value, -12, 18, chain.voiceDb); input.gain.setTargetAtTime(Math.pow(10, chain.voiceDb / 20), context.currentTime, 0.02); };
  chain.setReverb = value => { chain.reverbPct = finiteClamp(value, 0, 60, chain.reverbPct); wet.gain.setTargetAtTime(chain.reverbPct / 100, context.currentTime, 0.02); };
  chain.setReverbMix = chain.setReverb;
  chain.setReverbDecay = value => { const next = finiteClamp(value, 0.3, 3, chain.reverbDecay); if (next === chain.reverbDecay) return; chain.reverbDecay = next; reverb.buffer = makeImpulseResponse(context, chain.reverbDecay); };
  chain.setReverbPredelay = value => { chain.reverbPredelay = finiteClamp(value, 0, 60, chain.reverbPredelay); reverbPreDelay.delayTime.setTargetAtTime(chain.reverbPredelay / 1000, context.currentTime, 0.02); };
  chain.setReverbTone = value => { chain.reverbToneHz = finiteClamp(value, 2000, 12000, chain.reverbToneHz); reverbTone.frequency.setTargetAtTime(chain.reverbToneHz, context.currentTime, 0.02); };
  chain.setDelayMix = value => { chain.delayMix = finiteClamp(value, 0, 25, chain.delayMix); delayWet.gain.setTargetAtTime(chain.delayMix / 100, context.currentTime, 0.02); };
  chain.setDelayMs = value => { chain.delayMs = finiteClamp(value, 80, 500, chain.delayMs); delay.delayTime.setTargetAtTime(chain.delayMs / 1000, context.currentTime, 0.02); };
  chain.setDelayFeedback = value => { chain.delayFeedbackPct = finiteClamp(value, 0, 0.25, chain.delayFeedbackPct); delayFeedback.gain.setTargetAtTime(chain.delayFeedbackPct, context.currentTime, 0.02); };
  chain.setCompressionThreshold = value => { const next = finiteClamp(value, -40, 0, settings.compressionThreshold); settings.compressionThreshold = next; compressor.parameters.get('thresholdDb')?.setTargetAtTime(next, context.currentTime, 0.02); };
  chain.setCompressionRatio = value => { const next = finiteClamp(value, 1, 8, settings.compressionRatio); settings.compressionRatio = next; compressor.parameters.get('ratio')?.setTargetAtTime(next, context.currentTime, 0.02); };
  chain.setCompressionMakeup = value => { const next = finiteClamp(value, 0, 12, settings.compressionMakeup); settings.compressionMakeup = next; compressor.parameters.get('makeupDb')?.setTargetAtTime(next, context.currentTime, 0.02); };
  chain.setCompressionAttack = value => { const next = finiteClamp(value, 1, 30, settings.compressionAttack); settings.compressionAttack = next; compressor.parameters.get('attackMs')?.setTargetAtTime(next, context.currentTime, 0.02); };
  chain.setCompressionRelease = value => { const next = finiteClamp(value, 40, 400, settings.compressionRelease); settings.compressionRelease = next; compressor.parameters.get('releaseMs')?.setTargetAtTime(next, context.currentTime, 0.02); };
  chain.setCompressionAmount = value => { chain.compressionAmount = finiteClamp(value, 0, 100, chain.compressionAmount); const preset = compressionPresetFromAmount(chain.compressionAmount); const parameter = compressor.parameters.get('compressionAmount'); parameter?.setTargetAtTime(chain.compressionAmount, context.currentTime, 0.02); compressor.parameters.get('thresholdDb')?.setTargetAtTime(preset.threshold, context.currentTime, 0.02); compressor.parameters.get('ratio')?.setTargetAtTime(preset.ratio, context.currentTime, 0.02); return preset; };
  chain.setLimiterDb = value => { const next = finiteClamp(value, -12, -1, chain.limiterDb); if (next !== chain.limiterDb) { chain.limiterDb = next; limiter.curve = safetyCurve(next); } };
  chain.setCompression = value => { chain.compression = Boolean(value); compressedLevel.gain.setTargetAtTime(chain.compression ? 1 : 0, context.currentTime, 0.02); bypassLevel.gain.setTargetAtTime(chain.compression ? 0 : 1, context.currentTime, 0.02); };
  chain.stop = () => [sourceAudioNode, mono, highpass, input, analyser, compressor, compressedLevel, bypassLevel, blend, dry, reverbPreDelay, reverb, reverbTone, wet, delay, delayFeedback, delayWet, limiter].forEach(node => { try { node.disconnect(); } catch {} });
  return chain;
}

export function createVoiceChain(context, track, destination, settings = DEFAULTS) {
  const source = context.createMediaStreamSource(new MediaStream([track]));
  return createVoiceGraph(context, source, destination, settings);
}

export function extractVideoId(value) { return parseYouTubeUrl(value); }

export function youtubeStateUpdate(code, previous = 'idle') {
 const name=({[-1]:'loading',0:'ended',1:'playing',2:'paused',3:'buffering',5:'ready'})[code]||previous;
 return {player:name,...([0,1,5].includes(code)?{error:''}:{})};
}
