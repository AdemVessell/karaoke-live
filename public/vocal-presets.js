import { DEFAULTS, normalizeVoiceSettings } from './common.js';

const VOCAL_KEYS = Object.keys(DEFAULTS).filter(key => !['effectsVersion', 'music'].includes(key));

export function vocalSettings(settings) {
  const normalized = normalizeVoiceSettings(settings);
  return Object.fromEntries(VOCAL_KEYS.map(key => [key, normalized[key]]));
}

function preset(label, description, settings) {
  return Object.freeze({ label, description, settings: Object.freeze(vocalSettings(settings)) });
}

export const VOCAL_PRESETS = Object.freeze({
  'male-rock': preset('Male · Rock Vocals', 'Firm compression and a short, warm room.', {
    compressionAmount: 67, compressionThreshold: -24, compressionRatio: 4.5,
    compressionAttack: 4, compressionRelease: 105, compressionMakeup: 1,
    reverbMix: 12, reverbDecay: 0.9, reverbPredelay: 14, reverbTone: 6400, limiterDb: -4
  }),
  'male-rap': preset('Male · Rap Vocals', 'Tight dynamics with a nearly dry vocal.', {
    compressionAmount: 55, compressionThreshold: -23, compressionRatio: 4,
    compressionAttack: 6, compressionRelease: 75, compressionMakeup: 1,
    reverbMix: 3, reverbDecay: 0.4, reverbPredelay: 5, reverbTone: 6200, limiterDb: -3
  }),
  'male-pop': preset('Male · Pop Vocals', 'Smooth compression, open reverb and a light echo.', {
    compressionAmount: 44, compressionThreshold: -21, compressionRatio: 3.5,
    compressionAttack: 10, compressionRelease: 140, compressionMakeup: 1,
    reverbMix: 17, reverbDecay: 1.6, reverbPredelay: 25, reverbTone: 7800,
    delayMix: 5, delayMs: 190, limiterDb: -3
  }),
  'female-rock': preset('Female · Rock Vocals', 'Firm peak control and a brighter short room.', {
    compressionAmount: 63, compressionThreshold: -23, compressionRatio: 4.5,
    compressionAttack: 3, compressionRelease: 95, compressionMakeup: 1,
    reverbMix: 10, reverbDecay: 0.8, reverbPredelay: 16, reverbTone: 7500, limiterDb: -4
  }),
  'female-rap': preset('Female · Rap Vocals', 'Quick, dry dynamics for clear consonants.', {
    compressionAmount: 51, compressionThreshold: -22, compressionRatio: 3.5,
    compressionAttack: 5, compressionRelease: 65, compressionMakeup: 1,
    reverbMix: 2, reverbDecay: 0.4, reverbPredelay: 7, reverbTone: 7100, limiterDb: -3
  }),
  'female-pop': preset('Female · Pop Vocals', 'Gentle compression and a brighter reverb tail.', {
    compressionAmount: 40, compressionThreshold: -21, compressionRatio: 3,
    compressionAttack: 9, compressionRelease: 130, compressionMakeup: 1,
    reverbMix: 15, reverbDecay: 1.5, reverbPredelay: 28, reverbTone: 9100,
    delayMix: 4, delayMs: 210, limiterDb: -3
  })
});
