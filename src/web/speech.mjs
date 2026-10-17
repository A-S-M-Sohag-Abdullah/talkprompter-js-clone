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
