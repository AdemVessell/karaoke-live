class KaraokeZeroLatencyCompressor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.envelopeDb = -100;
    this.compressionAmount = 35;
  }
  static get parameterDescriptors() {
    return [
      { name: 'compressionAmount', defaultValue: 35, minValue: 0, maxValue: 100, automationRate: 'k-rate' },
      { name: 'thresholdDb', defaultValue: -20, minValue: -40, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio', defaultValue: 3, minValue: 1, maxValue: 8, automationRate: 'k-rate' },
      { name: 'makeupDb', defaultValue: 0, minValue: 0, maxValue: 12, automationRate: 'k-rate' },
      { name: 'attackMs', defaultValue: 5, minValue: 1, maxValue: 30, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 120, minValue: 40, maxValue: 400, automationRate: 'k-rate' }
    ];
  }
  gainReductionDb(levelDb, amount, threshold, ratio) {
    const t = Math.max(0, Math.min(100, Number(amount) || 0)) / 100;
    const thresholdDb = Number.isFinite(threshold) ? threshold : -20 - (t - 0.35) * 12.3;
    const kneeDb = 20;
    ratio = Number.isFinite(ratio) ? Math.max(1, ratio) : Math.max(1.05, 3 + (t - 0.35) * 4.6);
    const x = levelDb - thresholdDb; const halfKnee = kneeDb / 2;
    if (x <= -halfKnee) return 0;
    if (x >= halfKnee) return -(1 - 1 / ratio) * x;
    const over = x + halfKnee;
    return -(1 - 1 / ratio) * (over * over) / (2 * kneeDb);
  }
  process(inputs, outputs, parameters) {
    const input = inputs[0], output = outputs[0];
    if (!input?.length || !output?.length) return true;
    for (let i = 0; i < output[0].length; i++) {
      let peak = 0; for (let channel = 0; channel < input.length; channel++) peak = Math.max(peak, Math.abs(input[channel][i] || 0));
      const levelDb = 20 * Math.log10(Math.max(peak, 1e-5));
      const attackMs = Math.max(1, Number(parameters.attackMs?.[0]) || 5), releaseMs = Math.max(40, Number(parameters.releaseMs?.[0]) || 120);
      const attack = Math.exp(-1 / (sampleRate * attackMs / 1000)), release = Math.exp(-1 / (sampleRate * releaseMs / 1000));
      const coefficient = levelDb > this.envelopeDb ? attack : release;
      this.envelopeDb = coefficient * this.envelopeDb + (1 - coefficient) * levelDb;
      const amount = parameters.compressionAmount?.[0] ?? 35;
      const threshold = Number(parameters.thresholdDb?.[0]), ratio = Number(parameters.ratio?.[0]);
      const makeup = Math.max(0, Number(parameters.makeupDb?.[0]) || 0);
      const gain = Math.pow(10, (this.gainReductionDb(this.envelopeDb, amount, threshold, ratio) + makeup) / 20);
      for (let channel = 0; channel < output.length; channel++) { const value = (input[channel]?.[i] || 0) * gain; output[channel][i] = Number.isFinite(value) ? value : 0; }
    }
    return true;
  }
}
registerProcessor('karaoke-zero-latency-compressor', KaraokeZeroLatencyCompressor);
