// Desktop (Windows / macOS / Linux) via the Electron preload bridge.

export function createElectronPlatform() {
  const d = window.tpDesktop;
  let info = { platform: 'unknown' };
  d.appInfo().then((i) => { info = i; });

  return {
    kind: 'electron',
    get label() { return { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[info.platform] ?? 'Desktop'; },
    features: {
      topmost: true,
      camera: true,
      fullscreen: true,
      globalShortcut: true,
      fileWatch: true,
      hideFromCapture: true,
      dataFolder: true,
      packDownload: true,
      keepAwake: false
    },
    getSettings: d.getSettings,
    setSettings: d.setSettings,
    appInfo: d.appInfo,
    requestMic: d.requestMic,

    openScript: d.openScript,
    async readDroppedFile(file) {
      const filePath = d.pathForFile(file);
      return filePath ? d.readScript(filePath) : null;
    },
    watchScript: d.watchScript,
    onScriptFileChanged: d.onScriptFileChanged,

    packs: {
      async list(languages) {
        const status = new Map((await d.listPacks()).map((p) => [p.code, p]));
        return languages.map((l) => ({ available: true, ...status.get(l.code), code: l.code }));
      },
      async install(code, onProgress) {
        const off = d.onPackProgress((p) => { if (p.code === code) onProgress(p); });
        try {
          return await d.installPack(code);
        } finally {
          off();
        }
      },
      cancel: d.cancelPack,
      remove: d.removePack,
      modelUrl: (lang) => `app://talkprompter/voice-packs/${lang.file}`,
      fileUrls: (lang) => Object.fromEntries(lang.files.map((f) => [f.name, `app://talkprompter/voice-packs/${lang.folder}/${f.name}`])),
      cacheFiles: false,
      markLoaded() {}
    },

    setTopmost: d.setTopmost,
    setFullscreen: d.setFullscreen,
    onFullscreenChanged: d.onFullscreenChanged,
    setCameraMode: d.setCameraMode,
    setWindowButtons: d.setWindowButtons,
    setTheme: d.setTheme,
    keepAwake: async () => {},
    openDataFolder: d.openDataFolder,
    openExternal: d.openExternal,
    onShortcutToggle: d.onShortcutToggle
  };
}
