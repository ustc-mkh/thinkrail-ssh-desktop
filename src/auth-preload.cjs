const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('windowControls', Object.freeze({
  getState: () => ipcRenderer.invoke('window:state'),
  control: action => ipcRenderer.invoke('window:action', action),
  onState: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('window:changed', handler);
    return () => ipcRenderer.removeListener('window:changed', handler);
  },
}));
contextBridge.exposeInMainWorld('authentication', Object.freeze({
  getPrompt: () => ipcRenderer.invoke('authentication:prompt'),
  answer: value => ipcRenderer.invoke('authentication:answer', value),
}));
