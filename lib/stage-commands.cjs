// Shared command contract for the local HTTP bridge and control tests.
const SUPPORTED_STAGE_COMMANDS=new Set(['load','play','pause','restart','seek','enableMedia','stop','voiceDb','music','reverb','reverbMix','reverbDecay','reverbPredelay','reverbTone','delayMix','delayMs','delayFeedback','compression','compressionAmount','compressionThreshold','compressionRatio','compressionMakeup','compressionAttack','compressionRelease','limiterDb','setDevices','inputDeviceId','outputDeviceId','refreshDevices','settings','syncSettings','requestStatus']);
module.exports={SUPPORTED_STAGE_COMMANDS};
