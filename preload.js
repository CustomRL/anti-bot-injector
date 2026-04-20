const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (config) => ipcRenderer.invoke('settings:set', config),
    pickDll: () => ipcRenderer.invoke('settings:pickDll'),
  },
  auth: {
    status: () => ipcRenderer.invoke('auth:status'),
    login: () => ipcRenderer.invoke('auth:login'),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },
  findProcess: () => ipcRenderer.invoke('proc:find'),
  launchGame: () => ipcRenderer.invoke('game:launch'),
  dllStatus: () => ipcRenderer.invoke('dll:status'),
  dllSync: () => ipcRenderer.invoke('dll:sync'),
  dllUpdate: () => ipcRenderer.invoke('dll:update'),
  inject: (pid) => ipcRenderer.invoke('inject:run', { pid }),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
});
