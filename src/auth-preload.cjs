const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('authentication', Object.freeze({
  getPrompt: () => ipcRenderer.invoke('authentication:prompt'),
  answer: value => ipcRenderer.invoke('authentication:answer', value),
}));
