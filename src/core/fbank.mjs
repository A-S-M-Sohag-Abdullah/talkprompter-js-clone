// Streaming Kaldi-compatible log-mel filterbank features — the input that
// k2/icefall/sherpa-onnx speech models are trained on. Matches
// kaldi-native-fbank with the options sherpa-onnx uses:
//   16 kHz, 25 ms frames every 10 ms, povey window, pre-emphasis 0.97,
//   DC removal, 512-point FFT, power spectrum, 80 mel bins 20..(nyquist-400) Hz,
//   snip_edges = false, no dither, log with float-epsilon floor.
// Pure JS, no dependencies, so it runs the same in browsers, Electron,
// mobile WebViews and Node (for tests).

const FLT_EPSILON = 1.1920928955078125e-7;

export class OnlineFbank {
  constructor({ sampleRate = 16000, numBins = 80, lowFreq = 20, highFreq = -400 } = {}) {
    this.sampleRate = sampleRate;
    this.shift = Math.round(sampleRate * 0.010);   // 160
    this.length = Math.round(sampleRate * 0.025);  // 400
    this.fftSize = 512;
    while (this.fftSize < this.length) this.fftSize *= 2;
    this.numBins = numBins;
    this.samples = new Float32Array(0); // retained input (trimmed as frames are made)
    this.offset = 0;                    // absolute index of samples[0]
    this.totalSamples = 0;
    this.framesDone = 0;
    this.head = new Float32Array(this.length); // first samples, for left-edge reflection

    // Povey window.
    this.window = new Float32Array(this.length);
    for (let i = 0; i < this.length; i++) {
      this.window[i] = Math.pow(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.length - 1)), 0.85);
    }

    // Mel filterbank over the first fftSize/2 FFT bins (Kaldi ignores Nyquist).
    const nyquist = sampleRate / 2;
    const high = highFreq <= 0 ? nyquist + highFreq : highFreq;
    const mel = (f) => 1127 * Math.log(1 + f / 700);
    const melLow = mel(lowFreq);
    const melDelta = (mel(high) - melLow) / (numBins + 1);
    const binWidth = sampleRate / this.fftSize;
    const half = this.fftSize / 2;
    this.melFilters = [];
    for (let b = 0; b < numBins; b++) {
      const left = melLow + b * melDelta;
      const center = left + melDelta;
      const right = center + melDelta;
      const weights = [];
      let first = -1;
      for (let i = 0; i < half; i++) {
        const m = mel(binWidth * i);
        if (m > left && m < right) {
          if (first < 0) first = i;
          weights.push(m <= center ? (m - left) / (center - left) : (right - m) / (right - center));
        } else if (first >= 0) {
          break;
        }
      }
      this.melFilters.push({ first, weights: Float32Array.from(weights) });
    }

    // FFT tables.
    this.re = new Float64Array(this.fftSize);
    this.im = new Float64Array(this.fftSize);
    this.rev = new Uint32Array(this.fftSize);
    const bits = Math.log2(this.fftSize);
    for (let i = 0; i < this.fftSize; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(this.fftSize / 2);
    this.sin = new Float64Array(this.fftSize / 2);
    for (let i = 0; i < this.fftSize / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / this.fftSize);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / this.fftSize);
    }
    this.frameBuf = new Float64Array(this.length);
  }

  /** Accepts float samples in [-1, 1]. Returns an array of new feature frames (Float32Array(numBins)). */
  acceptWaveform(chunk) {
    const merged = new Float32Array(this.samples.length + chunk.length);
    merged.set(this.samples);
    merged.set(chunk, this.samples.length);
    this.samples = merged;
    for (let i = 0; i < chunk.length && this.totalSamples + i < this.length; i++) {
      this.head[this.totalSamples + i] = chunk[i];
    }
    this.totalSamples += chunk.length;

    const out = [];
    // With snip_edges=false, frame i covers [i*shift + shift/2 - length/2, +length).
    // Without flushing, only frames that end inside the received audio are ready.
    for (;;) {
      const start = this.framesDone * this.shift + this.shift / 2 - this.length / 2;
      if (start + this.length > this.totalSamples) break;
      out.push(this.#computeFrame(start));
      this.framesDone++;
    }
    // Drop samples no future frame needs.
    const nextStart = this.framesDone * this.shift + this.shift / 2 - this.length / 2;
    const keepFrom = Math.max(0, nextStart);
    if (keepFrom > this.offset) {
      this.samples = this.samples.slice(keepFrom - this.offset);
      this.offset = keepFrom;
    }
    return out;
  }

  sampleAt(i) {
    if (i < 0) i = -i - 1; // Kaldi reflects at the left edge
    if (i < this.offset) return this.head[i];
    return this.samples[i - this.offset];
  }

  #computeFrame(start) {
    const L = this.length;
    const w = this.frameBuf;
    let mean = 0;
    for (let i = 0; i < L; i++) {
      w[i] = this.sampleAt(start + i);
      mean += w[i];
    }
    mean /= L;
    for (let i = 0; i < L; i++) w[i] -= mean;
    for (let i = L - 1; i > 0; i--) w[i] -= 0.97 * w[i - 1];
    w[0] -= 0.97 * w[0];

    const { re, im, rev } = this;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < L; i++) re[rev[i]] = w[i] * this.window[i];
    // Iterative radix-2 FFT.
    const n = this.fftSize;
    for (let size = 2; size <= n; size <<= 1) {
      const halfSize = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < halfSize; j++, k += step) {
          const tr = re[i + j + halfSize] * this.cos[k] - im[i + j + halfSize] * this.sin[k];
          const ti = re[i + j + halfSize] * this.sin[k] + im[i + j + halfSize] * this.cos[k];
          re[i + j + halfSize] = re[i + j] - tr;
          im[i + j + halfSize] = im[i + j] - ti;
          re[i + j] += tr;
          im[i + j] += ti;
        }
      }
    }

    const feat = new Float32Array(this.numBins);
    for (let b = 0; b < this.numBins; b++) {
      const { first, weights } = this.melFilters[b];
      let e = 0;
      for (let k = 0; k < weights.length; k++) {
        const i = first + k;
        e += weights[k] * (re[i] * re[i] + im[i] * im[i]);
      }
      feat[b] = Math.log(Math.max(e, FLT_EPSILON));
    }
    return feat;
  }
}
