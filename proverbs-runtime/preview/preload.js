'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proverbs', {
  navigate:      (url) => ipcRenderer.send('navigate', url),
  back:          ()    => ipcRenderer.send('back'),
  forward:       ()    => ipcRenderer.send('forward'),
  reload:        ()    => ipcRenderer.send('reload'),
  openInBrowser: (url) => ipcRenderer.send('open-browser', url),
  getUrl:        ()    => ipcRenderer.send('get-url'),

  onUrlChanged:     (cb) => ipcRenderer.on('url-changed',     (_, v) => cb(v)),
  onTitleChanged:   (cb) => ipcRenderer.on('title-changed',   (_, v) => cb(v)),
  onLoadingChanged: (cb) => ipcRenderer.on('loading-changed', (_, v) => cb(v)),
  onNavState:       (cb) => ipcRenderer.on('nav-state',       (_, v) => cb(v)),
});
