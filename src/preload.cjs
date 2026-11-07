const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('connector', Object.freeze({
  getState: () => ipcRenderer.invoke('connector:state'),
  connect: profile => ipcRenderer.invoke('connector:connect', profile),
  disconnect: () => ipcRenderer.invoke('connector:disconnect'),
  remove: id => ipcRenderer.invoke('connector:remove', id),
  showSettings: () => ipcRenderer.invoke('connector:settings'),
  showWorkspace: () => ipcRenderer.invoke('connector:workspace'),
  reload: () => ipcRenderer.invoke('connector:reload'),
  reconnect: () => ipcRenderer.invoke('connector:reconnect'),
  resetAddress: id => ipcRenderer.invoke('connector:reset-address', id),
  onState: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('connector:changed', handler);
    return () => ipcRenderer.removeListener('connector:changed', handler);
  },
}));
