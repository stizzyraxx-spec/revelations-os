'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const http = require('http');
const https = require('https');

// Parse CLI args: --url <url> --title <name>
const argv = process.argv.slice(2);
let targetUrl = 'http://localhost:3000';
let windowTitle = 'Preview';
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--url' && argv[i + 1]) targetUrl = argv[++i];
  if (argv[i] === '--title' && argv[i + 1]) windowTitle = argv[++i];
}

const TOOLBAR_HEIGHT = 44;
let mainWin, webView;

function createWindow() {
  nativeTheme.themeSource = 'dark';

  mainWin = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0d0d0d',
    title: windowTitle + ' — Proverbs Preview',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWin.loadFile(path.join(__dirname, 'toolbar.html'));

  webView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Allow all localhost origins
      webSecurity: false,
    },
  });
  mainWin.contentView.addChildView(webView);

  function syncWebViewBounds() {
    const [w, h] = mainWin.getContentSize();
    webView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width: w, height: h - TOOLBAR_HEIGHT });
  }

  mainWin.on('resize', syncWebViewBounds);
  syncWebViewBounds();

  webView.webContents.loadURL(targetUrl);

  webView.webContents.on('did-navigate', (_, url) => {
    mainWin.webContents.send('url-changed', url);
  });
  webView.webContents.on('did-navigate-in-page', (_, url) => {
    mainWin.webContents.send('url-changed', url);
  });
  webView.webContents.on('page-title-updated', (_, title) => {
    mainWin.webContents.send('title-changed', title);
    mainWin.setTitle((title || windowTitle) + ' — Proverbs Preview');
  });
  webView.webContents.on('did-start-loading', () => {
    mainWin.webContents.send('loading-changed', true);
  });
  webView.webContents.on('did-stop-loading', () => {
    mainWin.webContents.send('loading-changed', false);
    mainWin.webContents.send('nav-state', {
      canGoBack: webView.webContents.canGoBack(),
      canGoForward: webView.webContents.canGoForward(),
    });
  });

  // IPC from toolbar
  ipcMain.on('navigate', (_, url) => webView.webContents.loadURL(url));
  ipcMain.on('back', () => webView.webContents.goBack());
  ipcMain.on('forward', () => webView.webContents.goForward());
  ipcMain.on('reload', () => webView.webContents.reload());
  ipcMain.on('open-browser', (_, url) => shell.openExternal(url));
  ipcMain.on('get-url', () => mainWin.webContents.send('url-changed', webView.webContents.getURL()));
}

app.on('ready', () => {
  createWindow();
  // Poll for server readiness and auto-reload if initial load fails
  let attempts = 0;
  const maxAttempts = 30;
  const interval = setInterval(() => {
    if (attempts++ >= maxAttempts) { clearInterval(interval); return; }
    const mod = targetUrl.startsWith('https') ? https : http;
    mod.get(targetUrl, () => clearInterval(interval))
       .on('error', () => {
         if (webView && webView.webContents) {
           webView.webContents.loadURL(targetUrl);
         }
       });
  }, 2000);
});

app.on('window-all-closed', () => {
  ipcMain.removeAllListeners();
  app.quit();
});
