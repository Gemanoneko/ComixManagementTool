const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;
let activeAbortController = null;

// ── Pause state ───────────────────────────────────────────────────────────────
let pausePromise = null;
let pauseResolve = null;

/**
 * Called inside the conversion loop at each inter-file checkpoint.
 * Blocks until resumed; races against the abort signal so Cancel while paused
 * unblocks immediately and propagates as an AbortError.
 */
function waitIfPaused(signal) {
  if (!pausePromise) return Promise.resolve();
  return Promise.race([
    pausePromise,
    new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
}

function clearPause() {
  if (pauseResolve) { pauseResolve(); }
  pauseResolve = null;
  pausePromise = null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'ComixManagementTool',
    backgroundColor: '#1a1a2e',
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// App version
ipcMain.handle('app:version', () => app.getVersion());

// Open folder picker dialog
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// Start conversion
ipcMain.handle('conversion:start', async (event, options) => {
  activeAbortController = new AbortController();

  const sendLog = (msg, type = 'info', update = false) => {
    if (!mainWindow.isDestroyed()) {
      // update=true → renderer replaces the last log line in place
      mainWindow.webContents.send(update ? 'conversion:logUpdate' : 'conversion:log', { msg, type });
    }
  };

  const sendProgress = (current, total, etaMs = 0) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conversion:progress', { current, total, etaMs });
    }
  };

  try {
    const { startConversion } = require('./src/converter');
    const result = await startConversion(
      options,
      sendLog,
      sendProgress,
      activeAbortController.signal,
      waitIfPaused
    );
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conversion:complete', result);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      sendLog(`Fatal error: ${err.message}`, 'error');
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conversion:complete', { converted: [], preExisting: [], needsReview: [], aborted: true });
    }
  } finally {
    clearPause();
    activeAbortController = null;
  }
});

// Pause running conversion (takes effect after the current file finishes)
ipcMain.handle('conversion:pause', () => {
  if (activeAbortController && !pausePromise) {
    pausePromise = new Promise((resolve) => { pauseResolve = resolve; });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conversion:log', { msg: 'Pausing after current file…', type: 'warn' });
    }
  }
});

// Resume a paused conversion
ipcMain.handle('conversion:resume', () => {
  if (pauseResolve) {
    clearPause();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conversion:log', { msg: 'Resumed.', type: 'info' });
    }
  }
});

// Cancel running conversion
ipcMain.handle('conversion:cancel', () => {
  clearPause(); // unblock waitIfPaused so AbortError propagates immediately
  if (activeAbortController) {
    activeAbortController.abort();
  }
});

// Delete original files after user confirms
ipcMain.handle('conversion:deleteOriginals', async (event, files) => {
  const results = [];
  for (const filePath of files) {
    try {
      fs.unlinkSync(filePath);
      results.push({ file: filePath, success: true });
    } catch (err) {
      results.push({ file: filePath, success: false, error: err.message });
    }
  }
  return results;
});
