const { autoUpdater } = require('electron-updater');
const { app, ipcMain } = require('electron');

let _win = null;

// Guard: only send if the window is still alive
function send(channel, ...args) {
  if (_win && !_win.isDestroyed() && _win.webContents && !_win.webContents.isDestroyed()) {
    _win.webContents.send(channel, ...args);
  }
}

function setupUpdater(win) {
  _win = win;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    send('update-checking');
  });

  autoUpdater.on('update-available', (info) => {
    send('update-available', { version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    send('update-not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    send('update-progress', Math.floor(progress.percent));
  });

  autoUpdater.on('update-downloaded', () => {
    send('update-ready');
  });

  autoUpdater.on('error', (err) => {
    send('update-error', err.message);
  });

  ipcMain.handle('download-update', async () => {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      send('update-error', err.message);
    }
  });

  // Silent install: no installer UI shown, app restarts automatically
  ipcMain.handle('install-update', () => {
    autoUpdater.quitAndInstall(true, true);
  });

  // Auto-check 5 seconds after launch (packaged only)
  if (app.isPackaged) {
    setTimeout(() => checkForUpdates(), 5000);
  }
}

function checkForUpdates() {
  if (!app.isPackaged) {
    // In dev mode just send "up to date"
    send('update-not-available');
    return;
  }
  autoUpdater.checkForUpdates().catch((err) => {
    send('update-error', err.message);
  });
}

module.exports = { setupUpdater, checkForUpdates };
