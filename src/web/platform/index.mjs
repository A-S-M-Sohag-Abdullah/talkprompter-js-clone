// Picks the platform adapter the app runs on. Every adapter exposes the same
// shape (see web.mjs for the reference implementation and docs):
//
//   kind, label, features{...}, getSettings(), setSettings(patch),
//   requestMic(), openScript(), readDroppedFile(file), watchScript(path),
//   onScriptFileChanged(cb), packs{list, install, cancel, remove, modelUrl},
//   setTopmost, setFullscreen, onFullscreenChanged, setCameraMode, setTheme,
//   keepAwake(on), openDataFolder, openExternal, onShortcutToggle, appInfo()

export async function loadPlatform() {
  if (window.tpDesktop) return (await import('./electron.mjs')).createElectronPlatform();
  if (window.Capacitor?.isNativePlatform?.()) return (await import('./capacitor.mjs')).createCapacitorPlatform();
  return (await import('./web.mjs')).createWebPlatform();
}
