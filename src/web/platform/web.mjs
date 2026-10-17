// Plain browser / installable PWA.
//
// Voice packs: browsers can't download from alphacephei.com (no CORS), so a
// pack is loaded from, in order:
//   1. this site's own voice-packs/ folder, if `npm run fetch-packs` put it
//      there (listed in voice-packs/index.json), or
//   2. the language's public CORS mirror (see core/languages.mjs).
// vosk-browser caches the extracted model in IndexedDB after first use, so a
// pack only downloads once and then works offline.

import { readFileObject, pickScriptFile, localSettings, browserWakeLock, noop, noopSubscribe } from './common.mjs';

export async function createWebPlatform() {
  let selfHosted = new Set();
  try {
    const res = await fetch('voice-packs/index.json', { cache: 'no-cache' });
    if (res.ok) selfHosted = new Set((await res.json()).map((p) => p.file));
  } catch {
    // No self-hosted packs.
  }

  const loaded = () => {
    try { return new Set(JSON.parse(localStorage.getItem('talkprompter.loadedPacks') || '[]')); } catch { return new Set(); }
  };

  const canFullscreen = !!document.documentElement.requestFullscreen;
  const fsListeners = new Set();
  document.addEventListener('fullscreenchange', () => fsListeners.forEach((cb) => cb(!!document.fullscreenElement)));

  const sourceFor = (lang) => (selfHosted.has(lang.file) ? `voice-packs/${lang.file}` : lang.webMirror);

  return {
    kind: 'web',
    label: 'Web',
    features: {
      topmost: false,
      camera: false,
      fullscreen: canFullscreen,
      globalShortcut: false,
      fileWatch: false,
      hideFromCapture: false,
      dataFolder: false,
      packDownload: false, // packs stream from the server on first use
      keepAwake: 'wakeLock' in navigator
    },
    ...localSettings(),
    async appInfo() { return { platform: 'web', version: '' }; },
    async requestMic() { return true; },

    openScript: pickScriptFile,
    async readDroppedFile(file) { return { text: await readFileObject(file), name: file.name }; },
    watchScript: noop,
    onScriptFileChanged: noopSubscribe,

    packs: {
      // On the web every pack with a source is usable; "installed" means it
      // has been loaded once in this browser (so it works offline).
      async list(languages) {
        const done = loaded();
        return languages.map((l) => ({
          code: l.code,
          available: !!sourceFor(l),
          installed: done.has(l.code),
          downloading: false
        }));
      },
      async install() { return { ok: true }; },
      cancel: noop,
      async remove(code) {
        const done = loaded();
        done.delete(code);
        localStorage.setItem('talkprompter.loadedPacks', JSON.stringify([...done]));
      },
      modelUrl(lang) {
        const src = sourceFor(lang);
        return src ? new URL(src, location.href).toString() : null;
      },
      markLoaded(code) {
        const done = loaded();
        done.add(code);
        localStorage.setItem('talkprompter.loadedPacks', JSON.stringify([...done]));
      }
    },

    setTopmost: noop,
    async setFullscreen(on) {
      const want = on ?? !document.fullscreenElement;
      if (want && !document.fullscreenElement) await document.documentElement.requestFullscreen().catch(noop);
      if (!want && document.fullscreenElement) await document.exitFullscreen().catch(noop);
      return !!document.fullscreenElement;
    },
    onFullscreenChanged(cb) { fsListeners.add(cb); return () => fsListeners.delete(cb); },
    setCameraMode: async () => false,
    setTheme: noop,
    keepAwake: browserWakeLock(),
    openDataFolder: noop,
    openExternal(url) { window.open(url, '_blank', 'noopener'); },
    onShortcutToggle: noopSubscribe
  };
}
