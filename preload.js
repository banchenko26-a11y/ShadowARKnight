const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menu', {
  init: () => ipcRenderer.invoke('init'),
  setHotkey: (action, accel) => ipcRenderer.invoke('hotkeys:set', action, accel),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),
  suspendHotkeys: () => ipcRenderer.send('hotkeys:suspend'),
  resumeHotkeys: () => ipcRenderer.send('hotkeys:resume'),
  patchConfig: (patch) => ipcRenderer.send('config:patch', patch),
  setOpacity: (v) => ipcRenderer.send('opacity:set', v),
  runAction: (a) => ipcRenderer.send('action', a),
  chooseBg: () => ipcRenderer.invoke('bg:choose'),
  resetBg: () => ipcRenderer.invoke('bg:reset'),
  notify: (title, body) => ipcRenderer.send('notify', { title, body }),
  hide: () => ipcRenderer.send('window:hide'),
  quit: () => ipcRenderer.send('window:quit'),
  on: (channel, cb) => {
    const ok = ['action', 'stats', 'toast', 'opacity', 'clickthrough', 'hotkeys:status'];
    if (ok.includes(channel)) ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
