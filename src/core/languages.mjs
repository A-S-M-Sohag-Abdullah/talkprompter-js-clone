// Every voice-pack language the app offers.
//
// engine 'vosk' — classic Vosk (Kaldi) "small" models from Alpha Cephei
//   (Apache 2.0), one .zip loaded by vosk-browser (WASM). Supports grammar
//   mode (recognizer restricted to the script's words).
//   - `url`: the official .zip. Desktop and mobile download it natively.
//   - `webMirror`: a CORS-enabled copy for the plain web build (alphacephei.com
//     sends no CORS headers). Languages without one work on the web only when
//     self-hosted with `npm run fetch-packs` (see README).
//
// engine 'zipformer' — newer Vosk streaming models in sherpa-onnx format
//   (encoder/decoder/joiner .onnx + tokens), run by onnxruntime-web with our
//   own decoder (core/zipformer.mjs). Hosted on Hugging Face, which allows
//   CORS, so they also download directly in the web build.

const VOSK = 'https://alphacephei.com/vosk/models/';
const MIRROR = 'https://ccoreilly.github.io/vosk-browser/models/';

function vosk(code, englishName, nativeName, folder, bytes, mirrorFolder) {
  return {
    code,
    englishName,
    nativeName,
    engine: 'vosk',
    folder,
    file: `${folder}.zip`,
    url: `${VOSK}${folder}.zip`,
    bytes,
    webMirror: mirrorFolder ? `${MIRROR}${mirrorFolder}.tar.gz` : null
  };
}

// Pinned to one revision so the files can never change under installed apps.
const BN_REPO = 'https://huggingface.co/alphacep/vosk-model-small-streaming-bn/resolve/501097ae5257e5859d7956b50e4ba53a3f2be106/';
const bnFile = (name, path, bytes) => ({ name, url: BN_REPO + path, bytes });
const BN_FILES = [
  bnFile('encoder.onnx', 'am-onnx/encoder.onnx', 90_994_145),
  bnFile('decoder.onnx', 'am-onnx/decoder.onnx', 2_093_080),
  bnFile('joiner.onnx', 'am-onnx/joiner.onnx', 1_026_462),
  bnFile('tokens.txt', 'lang/tokens.txt', 6_252)
];

export const LANGUAGES = [
  vosk('en', 'English', 'English', 'vosk-model-small-en-us-0.15', 41_205_931, 'vosk-model-small-en-us-0.15'),
  {
    code: 'bn',
    englishName: 'Bangla',
    nativeName: 'বাংলা',
    engine: 'zipformer',
    folder: 'vosk-model-small-streaming-bn',
    files: BN_FILES,
    bytes: BN_FILES.reduce((sum, f) => sum + f.bytes, 0),
    webDirect: true
  },
  vosk('cs', 'Czech', 'Čeština', 'vosk-model-small-cs-0.4-rhasspy', 46_088_666),
  vosk('nl', 'Dutch', 'Nederlands', 'vosk-model-small-nl-0.22', 40_441_176),
  vosk('fr', 'French', 'Français', 'vosk-model-small-fr-0.22', 42_233_323, 'vosk-model-small-fr-pguyot-0.3'),
  vosk('de', 'German', 'Deutsch', 'vosk-model-small-de-0.15', 46_499_967, 'vosk-model-small-de-0.15'),
  vosk('it', 'Italian', 'Italiano', 'vosk-model-small-it-0.22', 49_665_141, 'vosk-model-small-it-0.4'),
  vosk('pl', 'Polish', 'Polski', 'vosk-model-small-pl-0.22', 52_979_372),
  vosk('pt', 'Portuguese', 'Português', 'vosk-model-small-pt-0.3', 32_453_112, 'vosk-model-small-pt-0.3'),
  vosk('ru', 'Russian', 'Русский', 'vosk-model-small-ru-0.22', 46_236_750, 'vosk-model-small-ru-0.4'),
  vosk('es', 'Spanish', 'Español', 'vosk-model-small-es-0.42', 39_817_833, 'vosk-model-small-es-0.3'),
  vosk('tr', 'Turkish', 'Türkçe', 'vosk-model-small-tr-0.3', 36_855_784, 'vosk-model-small-tr-0.3')
];

export function findLanguage(code) {
  return LANGUAGES.find((l) => l.code === code) ?? null;
}
