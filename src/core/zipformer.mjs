// Streaming zipformer2 transducer decoding (the sherpa-onnx / icefall model
// format), with greedy search. Used for languages that have no classic Vosk
// (Kaldi) model — e.g. Bangla (alphacep/vosk-model-small-streaming-bn).
//
// The ONNX runtime is injected (`ort`), so this file runs unchanged with
// onnxruntime-web (browsers, Electron, mobile WebViews) and onnxruntime-node
// (tests). Feed 16 kHz float samples; read the running transcript.

import { OnlineFbank } from './fbank.mjs';

// `config` = { T, chunkShift, contextSize, states: { name: { dims, type } } }
// (see zipformerBn.mjs). Model files may be URLs, paths or Uint8Arrays.
export async function loadZipformer(ort, { encoder, decoder, joiner, tokens }, config, sessionOptions = {}) {
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all', ...sessionOptions };
  const [enc, dec, join] = await Promise.all([
    ort.InferenceSession.create(encoder, opts),
    ort.InferenceSession.create(decoder, opts),
    ort.InferenceSession.create(joiner, opts)
  ]);
  const vocab = [];
  for (const line of tokens.split('\n')) {
    const m = line.match(/^(.*)\s+(\d+)$/);
    if (m) vocab[Number(m[2])] = m[1];
  }
  return new ZipformerModel(ort, enc, dec, join, vocab, config);
}

export class ZipformerModel {
  constructor(ort, encoder, decoder, joiner, vocab, config) {
    this.ort = ort;
    this.encoder = encoder;
    this.decoder = decoder;
    this.joiner = joiner;
    this.vocab = vocab;
    // T = frames fed per chunk (chunk + right padding); shift = frames advanced.
    this.T = config.T;
    this.chunkShift = config.chunkShift;
    this.contextSize = config.contextSize;
    this.stateShapes = config.states;
    this.stateNames = encoder.inputNames.filter((n) => n !== 'x');
  }

  /** Zero-initialised encoder states, shaped from the model's declared inputs. */
  initStates(shapes = this.stateShapes) {
    const states = {};
    for (const name of this.stateNames) {
      const { dims, type } = shapes[name];
      const size = dims.reduce((a, b) => a * b, 1);
      states[name] = type === 'int64'
        ? new this.ort.Tensor('int64', new BigInt64Array(size), dims)
        : new this.ort.Tensor('float32', new Float32Array(size), dims);
    }
    return states;
  }

  createStream() {
    return new ZipformerStream(this);
  }
}

class ZipformerStream {
  constructor(model) {
    this.model = model;
    this.fbank = new OnlineFbank();
    this.features = [];          // pending feature frames
    this.states = model.initStates();
    this.hyp = new Array(model.contextSize).fill(0); // blank context
    this.decoderOut = null;
    this.tokens = [];            // emitted tokens of the current utterance
    this.trailingBlanks = 0;
    this.busy = Promise.resolve();
  }

  /** Queues audio; resolves after all complete chunks are decoded. */
  acceptWaveform(samples) {
    for (const f of this.fbank.acceptWaveform(samples)) this.features.push(f);
    this.busy = this.busy.then(() => this.#decodeReady());
    return this.busy;
  }

  get text() {
    return this.tokens.map((t) => this.model.vocab[t] ?? '').join('').replace(/▁/g, ' ').trim();
  }

  /** Starts a new utterance (keeps the acoustic context). */
  resetText() {
    this.tokens = [];
    this.trailingBlanks = 0;
  }

  async #runDecoder() {
    const { ort, decoder, contextSize } = this.model;
    const ctx = this.hyp.slice(-contextSize).map(BigInt);
    const y = new ort.Tensor('int64', BigInt64Array.from(ctx), [1, contextSize]);
    const out = await decoder.run({ y });
    this.decoderOut = out[decoder.outputNames[0]];
  }

  async #decodeReady() {
    const m = this.model;
    if (!this.decoderOut) await this.#runDecoder();
    while (this.features.length >= m.T) {
      const x = new Float32Array(m.T * 80);
      for (let t = 0; t < m.T; t++) x.set(this.features[t], t * 80);
      this.features.splice(0, m.chunkShift);

      const feeds = { x: new m.ort.Tensor('float32', x, [1, m.T, 80]), ...this.states };
      const out = await m.encoder.run(feeds);
      // Outputs are encoder_out followed by new_<state> for every state input.
      for (const name of m.stateNames) this.states[name] = out[`new_${name}`];
      const enc = out[m.encoder.outputNames[0]]; // [1, frames, dim]
      const [, frames, dim] = enc.dims;

      for (let t = 0; t < frames; t++) {
        const frame = new m.ort.Tensor('float32', enc.data.subarray(t * dim, (t + 1) * dim), [1, dim]);
        const logits = (await m.joiner.run({ encoder_out: frame, decoder_out: this.decoderOut }))[m.joiner.outputNames[0]].data;
        let best = 0;
        for (let k = 1; k < logits.length; k++) if (logits[k] > logits[best]) best = k;
        if (best !== 0 && best !== 2) { // not <blk> / <unk>
          this.hyp.push(best);
          this.tokens.push(best);
          this.trailingBlanks = 0;
          await this.#runDecoder();
        } else {
          this.trailingBlanks++;
        }
      }
    }
  }
}
