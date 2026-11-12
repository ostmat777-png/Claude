'use strict';
// The only door between the app's pages and the main process.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('kaplya', {
  platform: process.platform,
  invoke: (channel, ...args) => ipcRenderer.invoke('k:' + channel, ...args),
  send: (channel, ...args) => ipcRenderer.send('k:' + channel, ...args),
  on: (channel, callback) => {
    const listener = (_event, ...args) => callback(...args);
    ipcRenderer.on('k:' + channel, listener);
    return () => ipcRenderer.removeListener('k:' + channel, listener);
  },
  /** Full path of a file dropped onto the page. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
});
