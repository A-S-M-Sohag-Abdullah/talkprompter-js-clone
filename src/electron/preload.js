// Exposes a small, explicit desktop API to the web app as window.tpDesktop.
// The web app's platform layer (src/web/platform/electron.mjs) wraps it.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const on = (channel) => (cb) => {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('tpDesktop', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  appInfo: () => ipcRenderer.invoke('app:info'),
  requestMic: () => ipcRenderer.invoke('mic:request'),

  openScript: () => ipcRenderer.invoke('script:open'),
  readScript: (filePath) => ipcRenderer.invoke('script:read', filePath),
  watchScript: (filePath) => ipcRenderer.invoke('script:watch', filePath),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onScriptFileChanged: on('script:file-changed'),

  listPacks: () => ipcRenderer.invoke('packs:list'),
  installPack: (code) => ipcRenderer.invoke('packs:install', code),
  cancelPack: (code) => ipcRenderer.invoke('packs:cancel', code),
  removePack: (code) => ipcRenderer.invoke('packs:remove', code),
  onPackProgress: on('packs:progress'),

  setTopmost: (on) => ipcRenderer.invoke('window:topmost', on),
  setFullscreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
  onFullscreenChanged: on('window:fullscreen-changed'),
  setCameraMode: (on) => ipcRenderer.invoke('window:camera', on),
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
  openDataFolder: () => ipcRenderer.invoke('shell:openDataFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  onShortcutToggle: on('shortcut:toggle')
});
