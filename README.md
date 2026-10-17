# TalkPrompter (cross-platform)

A teleprompter that **listens to your voice and scrolls the script for you**. When you pause or go off script, it waits. When you continue, it picks up where you left off. Speech recognition runs **100% offline**: your voice never leaves the device.

This is a JavaScript port of [Sven-Bo/talkprompter](https://github.com/Sven-Bo/talkprompter) (C#/WPF, Windows only). One shared web app runs everywhere:

| Platform | How it ships | Built with |
|---|---|---|
| **macOS** | `.dmg` / `.zip` (Apple Silicon + Intel) | Electron |
| **Windows** | installer + portable `.exe` | Electron |
| **Linux** | `.AppImage` / `.deb` | Electron |
| **Web** | installable PWA, works offline | static files |
| **Android** | APK / Play Store | Capacitor |
| **iOS / iPadOS** | Xcode project | Capacitor |

Speech recognition is [Vosk](https://alphacephei.com/vosk/), running as WebAssembly on every platform with nothing native to compile: classic models through [vosk-browser](https://github.com/ccoreilly/vosk-browser), and the newer streaming models (used for Bangla) through [ONNX Runtime Web](https://onnxruntime.ai/) with a built-in streaming decoder.

## Features

- Scrolls by listening to your voice: no fixed speed, pauses when you pause
- Re-reading a sentence after a flubbed take? It follows you back
- 12 languages: English, **Bangla (বাংলা)**, Czech, Dutch, French, German, Italian, Polish, Portuguese, Russian, Spanish, Turkish
- Click or tap any word to jump there
- Loads `.docx` / `.txt` (button or drag and drop). On desktop it reloads when you save in Word
- Remembers recent scripts and where you stopped in each
- **Camera mode** (desktop): a narrow always-on-top strip right under your webcam, so viewers don't see your eyes move
- **Hide from screen recordings** (desktop): the prompter stays invisible in your capture
- Mirror mode for teleprompter glass, full screen, text size, column width, dark/light theme
- 3-2-1 countdown, reading-time estimate, words-per-minute stats after each take
- Keeps the screen awake while reading (mobile / web)
- Simulation mode to try it without a microphone

### Shortcuts

| Key | Action |
|---|---|
| Space | Start / stop |
| ⌘⇧Space (Mac) · Ctrl+Alt+Space (Win/Linux) | Start / stop from **any** app (configurable) |
| ↑ / ↓ or PageUp / PageDown | Nudge 8 words |
| Shift+↑ / ↓ or ⌘/Ctrl+PageUp / PageDown | Previous / next paragraph |
| Home | Back to the top |
| ⌘/Ctrl + / − | Text size |
| F11 or ⌃⌘F | Full screen |
| Esc | Close panel / leave full screen |

## Run it

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
```

```bash
npm start
```

On first start, pick your language and the app downloads its voice pack once (30–55 MB; Bangla is 94 MB).

### macOS

Copy this folder to your Mac (or clone it from GitHub), then:

```bash
npm install
```

```bash
npm start
```

To build a real `TalkPrompter.app` (in `dist/desktop/`):

```bash
npm run dist:mac
```

macOS asks for microphone access the first time you press **Start**. The build isn't signed with an Apple Developer ID. If macOS says the app "is damaged" or "can't be opened", run this once:

```bash
xattr -cr /Applications/TalkPrompter.app && codesign --force --deep --sign - /Applications/TalkPrompter.app
```

> Mac apps can only be built on a Mac. If you push this project to GitHub, the included workflow (`.github/workflows/build.yml`) builds the Mac, Windows, Linux and Android versions in the cloud. Download them from the **Actions** tab, under **Artifacts**.

### Windows / Linux

```bash
npm run dist:win
```

```bash
npm run dist:linux
```

### Web (PWA)

```bash
npm run web
```

This opens <http://localhost:5173>. To publish, upload the `dist/web` folder (built by `npm run build:web`) to any static host with HTTPS: GitHub Pages, Netlify, Cloudflare Pages, etc. Browsers need HTTPS for microphone access.

**Voice packs on the web.** Browsers can't download from alphacephei.com (it sends no CORS headers). Bangla downloads directly from Hugging Face, and English, French, German, Italian, Portuguese, Russian, Spanish and Turkish load from a public mirror, all automatically. To self-host packs (needed for Czech, Dutch and Polish):

```bash
npm run fetch-packs -- nl pl cs
```

```bash
npm run build:web
```

Packs are cached in the browser after first use, so they work offline afterwards.

### Android & iOS

```bash
npm run mobile:sync
```

This builds the web app into the native projects and sets the microphone permissions. Then open the native project:

- **Android**: `npm run android:open` opens Android Studio, then press ▶ Run (or *Build › Generate Signed Bundle* for the Play Store).
- **iOS**: on a Mac, `npm run ios:open` opens Xcode. Pick your team under *Signing & Capabilities*, then press ▶ Run.

Run `npm run mobile:sync` again after every change to `src/`. Voice packs download inside the app, like on desktop. App icons: `npx @capacitor/assets generate` uses `resources/icon.png`.

## Keeping everything off the C: drive (Windows)

The project keeps npm's cache in `.cache/npm`, and a development run (`npm start`) keeps settings, voice packs and browser caches in `.userdata/`, all inside the project. Electron's own download cache and temp files follow environment variables, so set them in PowerShell before `npm install` or a build:

```powershell
$env:electron_config_cache="$PWD\.cache\electron"; $env:ELECTRON_BUILDER_CACHE="$PWD\.cache\electron-builder"; $env:TEMP="$PWD\.cache\tmp"; $env:TMP="$PWD\.cache\tmp"
```

An installed (packaged) app stores its data in the normal per-user folder. Set `TALKPROMPTER_DATA_DIR` to put it somewhere else.

## How it works

```
microphone → Vosk (WASM, grammar = the script's words) → partial transcripts
           → ScriptMatcher (word-level Levenshtein over a window ahead of the anchor)
           → current word → highlight + critically-damped spring scrolling
```

- **Grammar mode**: the recognizer only listens for words that appear in the script, which makes it very accurate. Off-script speech becomes `[unk]` and simply doesn't match, so scrolling pauses.
- **Matcher**: advances only when recent speech matches the script near the current position. Pause, ad-lib or cough means no match, so it holds. If it stays lost, it scans further ahead (skipped paragraph) and behind (re-read sentence).
- **Numbers**: "25" in an English script matches "twenty five".

### Bangla

Bangla uses [alphacep/vosk-model-small-streaming-bn](https://huggingface.co/alphacep/vosk-model-small-streaming-bn) (Apache 2.0), a streaming zipformer model in sherpa-onnx format. The app runs it with ONNX Runtime Web plus its own JavaScript feature extractor and decoder (`src/core/fbank.mjs`, `src/core/zipformer.mjs`), verified to give the same transcript as the official sherpa-onnx decoder.

- This model can't be restricted to the script's words (no grammar mode), so it hears open vocabulary and makes more spelling slips than grammar-mode languages. The matcher tolerates them. If the prompter hesitates, raise **Tracking sensitivity** in Settings.
- Write the script in Bangla script. Numbers work best written as words.
- It needs a 14 MB runtime that only loads when Bangla is in use.

The matcher and text logic are ported 1:1 from the original C# and covered by its unit tests (`npm test`).

## Project layout

```
src/core/       shared logic: matcher, text normalizer, numbers, smooth scroll, languages,
                fbank + zipformer (streaming decoder for Bangla)
src/web/        the app UI (runs on every platform)
  platform/     adapters: electron.mjs · web.mjs · capacitor.mjs
src/electron/   desktop shell: window, camera mode, voice-pack downloads, Word sync
scripts/        build-web, serve, vendor, fetch-packs, patch-native, make-icons, dev tests
vendor/         browser runtimes copied from node_modules (generated, not committed)
tests/          unit tests (node --test)
android/ ios/   Capacitor native projects
```

Dev checks (desktop): `npx electron scripts/electron-smoke.js` saves UI screenshots to `.cache/shots/`. `npx electron scripts/voice-e2e.js` plays a recorded WAV through the real voice pipeline.

## Differences from the original

- Indonesian isn't included yet. Its sherpa-onnx model could run on the same engine as Bangla.
- There's no built-in auto-updater. Use the GitHub workflow to build new releases.

## License

MIT, like the original. Voice packs: [Vosk models](https://alphacephei.com/vosk/models) by Alpha Cephei (Apache 2.0), including the [Bangla streaming model](https://huggingface.co/alphacep/vosk-model-small-streaming-bn). Original app by Sven Bosau ([Bosau Digital LLC](https://pythonandvba.com)).
