// Speech engines. Each emits { text, isFinal } hypotheses via onHypothesis and
// a 0..1 microphone level via onLevel.
//
// VoskEngine runs Vosk (Kaldi) compiled to WebAssembly via vosk-browser, fully
// offline. When the script has a manageable vocabulary the recognizer runs in
// grammar mode — constrained to only the script's words — which is far more
// accurate for fast or accented speech. Off-script speech falls through to
// "[unk]", which is stripped so it simply produces no match (a correct pause).

const MAX_GRAMMAR_WORDS = 1200;
const modelCache = new Map(); // url -> Promise<Model>

function loadModel(url) {
  if (!modelCache.has(url)) {
    const p = window.Vosk.createModel(url).catch((err) => {
      modelCache.delete(url);
      throw err;
    });
    modelCache.set(url, p);
  }
  return modelCache.get(url);
}

export function buildGrammar(matchWords) {
  const distinct = [...new Set(matchWords.filter(Boolean).map((w) => w.toLowerCase()))].sort();
  if (distinct.length === 0 || distinct.length > MAX_GRAMMAR_WORDS) return null;
  return JSON.stringify([...distinct, '[unk]']);
}

const cleanUnknowns = (text) => text.split(/\s+/).filter((w) => w && w !== '[unk]').join(' ');

export class VoskEngine {
  constructor({ modelUrl, deviceId, matchWords }) {
    this.modelUrl = modelUrl;
    this.deviceId = deviceId;
    this.matchWords = matchWords;
    this.onHypothesis = () => {};
    this.onLevel = () => {};
    this.usingGrammar = false;
  }

  async start() {
    const model = await loadModel(this.modelUrl);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    // 16 kHz is what the model wants; let the browser resample the mic.
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
      this.source = this.ctx.createMediaStreamSource(this.stream);
    } catch {
      this.ctx?.close();
      this.ctx = new AudioContext();
      this.source = this.ctx.createMediaStreamSource(this.stream);
    }

    const grammar = buildGrammar(this.matchWords);
    this.usingGrammar = !!grammar;
    this.recognizer = grammar
      ? new model.KaldiRecognizer(this.ctx.sampleRate, grammar)
      : new model.KaldiRecognizer(this.ctx.sampleRate);

    this.recognizer.on('partialresult', (m) => {
      const text = cleanUnknowns(m.result?.partial ?? '');
      if (text) this.onHypothesis({ text, isFinal: false });
    });
    this.recognizer.on('result', (m) => {
      const text = cleanUnknowns(m.result?.text ?? '');
      if (text) this.onHypothesis({ text, isFinal: true });
    });

    // ScriptProcessor is deprecated but universally supported and is what
    // vosk-browser's acceptWaveform(AudioBuffer) is designed around.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      this.onLevel(Math.min(1, Math.sqrt(sum / (data.length / 4)) * 6));
      try {
        this.recognizer.acceptWaveform(event.inputBuffer);
      } catch {
        // Skip a bad chunk rather than tearing down the session.
      }
    };
    this.source.connect(this.node);
    // The processor only runs while connected to the destination; it outputs silence.
    this.node.connect(this.ctx.destination);
  }

  stop() {
    try { this.recognizer?.retrieveFinalResult(); } catch { /* shutting down */ }
    try { this.node?.disconnect(); } catch { /* already gone */ }
    try { this.source?.disconnect(); } catch { /* already gone */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    const rec = this.recognizer;
    // Give the final result a moment to arrive before freeing the recognizer.
    setTimeout(() => { try { rec?.remove(); } catch { /* ignore */ } }, 500);
    this.recognizer = null;
    this.onLevel(0);
  }
}

// ---------------------------------------------------------------------------
// ZipformerEngine — streaming zipformer models (e.g. Bangla) via
// onnxruntime-web and core/zipformer.mjs. No grammar mode: the recognizer
// hears open vocabulary and the matcher absorbs the errors.

const zipformerCache = new Map(); // language code -> Promise<ZipformerModel>
let ortPromise = null;

function loadOrt() {
  ortPromise ??= import(new URL('vendor/ort/ort.wasm.min.mjs', document.baseURI).href).then((ort) => {
    ort.env.wasm.wasmPaths = new URL('vendor/ort/', document.baseURI).href;
    // Multi-threading needs cross-origin isolation, which these pages don't have.
    ort.env.wasm.numThreads = 1;
    return ort;
  });
  return ortPromise;
}

/** Fetches a model file; with `cache`, keeps it in Cache Storage for offline use. */
async function fetchModelFile(url, cache, onProgress) {
  const store = cache && 'caches' in window ? await caches.open('tp-voice-packs-v1') : null;
  let res = store ? await store.match(url) : null;
  let saving = Promise.resolve();
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`Voice pack download failed (HTTP ${res.status})`);
    // Save a copy while we read the original (progress keeps updating).
    if (store) saving = store.put(url, res.clone()).catch(() => {});
  }
  if (!onProgress || !res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    await saving;
    return bytes;
  }
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  await saving;
  return out;
}

export function loadZipformerModel(lang, urls, { cache = false, onProgress } = {}) {
  if (!zipformerCache.has(lang.code)) {
    const p = (async () => {
      const [ort, { loadZipformer }, { BN_ZIPFORMER }] = await Promise.all([
        loadOrt(), import('./core/zipformer.mjs'), import('./core/zipformerBn.mjs')
      ]);
      const sizes = Object.fromEntries(lang.files.map((f) => [f.name, f.bytes]));
      const got = {};
      const report = () => onProgress?.(Object.values(got).reduce((a, b) => a + b, 0), lang.bytes);
      const files = {};
      for (const name of Object.keys(urls)) {
        files[name] = await fetchModelFile(urls[name], cache, (r) => { got[name] = Math.min(r, sizes[name] ?? r); report(); });
      }
      return loadZipformer(ort, {
        encoder: files['encoder.onnx'],
        decoder: files['decoder.onnx'],
        joiner: files['joiner.onnx'],
        tokens: new TextDecoder().decode(files['tokens.txt'])
      }, BN_ZIPFORMER);
    })().catch((err) => {
      zipformerCache.delete(lang.code);
      throw err;
    });
    zipformerCache.set(lang.code, p);
  }
  return zipformerCache.get(lang.code);
}

const PAUSE_FRAMES = 30; // 30 encoder frames × 40 ms = 1.2 s of silence ends an utterance

export class ZipformerEngine {
  constructor({ lang, urls, cache, deviceId, onProgress }) {
    Object.assign(this, { lang, urls, cache, deviceId, onProgress });
    this.onHypothesis = () => {};
    this.onLevel = () => {};
    this.usingGrammar = false;
  }

  async start() {
    const model = await loadZipformerModel(this.lang, this.urls, { cache: this.cache, onProgress: this.onProgress });
    this.stream = model.createStream();
    this.lastText = '';

    this.media = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.deviceId ? { exact: this.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: true,
        autoGainControl: true
      }
    });
    try {
      this.ctx = new AudioContext({ sampleRate: 16000 });
      this.source = this.ctx.createMediaStreamSource(this.media);
    } catch {
      this.ctx?.close();
      this.ctx = new AudioContext();
      this.source = this.ctx.createMediaStreamSource(this.media);
    }
    const ratio = this.ctx.sampleRate / 16000;

    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (event) => {
      const data = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i] * data[i];
      this.onLevel(Math.min(1, Math.sqrt(sum / (data.length / 4)) * 6));
      const samples = ratio === 1 ? Float32Array.from(data) : resample(data, ratio);
      const stream = this.stream;
      if (!stream) return;
      stream.acceptWaveform(samples).then(() => this.#emit(stream)).catch((err) => console.error(err));
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination);
  }

  #emit(stream) {
    if (stream !== this.stream) return;
    const text = stream.text;
    if (text && text !== this.lastText) {
      this.lastText = text;
      this.onHypothesis({ text, isFinal: false });
    }
    // A long pause ends the utterance, so the next one starts fresh.
    if (text && stream.trailingBlanks >= PAUSE_FRAMES) {
      this.onHypothesis({ text, isFinal: true });
      stream.resetText();
      this.lastText = '';
    }
  }

  stop() {
    this.stream = null;
    try { this.node?.disconnect(); } catch { /* already gone */ }
    try { this.source?.disconnect(); } catch { /* already gone */ }
    this.media?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.onLevel(0);
  }
}

/** Linear-interpolation resampler to 16 kHz (used only if the browser can't open a 16 kHz context). */
function resample(data, ratio) {
  const out = new Float32Array(Math.floor(data.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const frac = pos - j;
    out[i] = data[j] * (1 - frac) + (data[j + 1] ?? data[j]) * frac;
  }
  return out;
}

/** Reads the script aloud by itself at a fixed pace — for trying the app without a mic. */
export class SimulatedEngine {
  constructor({ words, fromWord = 0, wordsPerMinute = 150 }) {
    this.words = words;
    this.position = Math.max(0, fromWord);
    this.utteranceStart = this.position;
    this.interval = 60000 / Math.max(30, wordsPerMinute);
    this.onHypothesis = () => {};
    this.onLevel = () => {};
  }

  async start() {
    this.timer = setInterval(() => {
      if (this.position >= this.words.length) {
        this.stop();
        return;
      }
      this.position++;
      const partial = this.words.slice(this.utteranceStart, this.position).join(' ');
      const boundary = this.position - this.utteranceStart >= 8;
      this.onLevel(0.3 + Math.random() * 0.4);
      this.onHypothesis({ text: partial, isFinal: boundary });
      if (boundary) this.utteranceStart = this.position;
    }, this.interval);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.onLevel(0);
  }
}
