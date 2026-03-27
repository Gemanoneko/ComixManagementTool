const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Delete leftover temp files from previous crashed sessions:
 *   cbz_*    — our own extraction temp directories
 *   magick-* — ImageMagick scratch files (can be 1+ GB each)
 */
function cleanupOrphanedTempDirs() {
  const tmpBase = os.tmpdir();
  try {
    for (const entry of fs.readdirSync(tmpBase, { withFileTypes: true })) {
      const isCbz    = entry.isDirectory() && entry.name.startsWith('cbz_');
      const isMagick = entry.isFile()      && entry.name.startsWith('magick-');
      if (!isCbz && !isMagick) continue;
      try { fs.rmSync(path.join(tmpBase, entry.name), { recursive: true, force: true }); }
      catch { /* ignore locked entries */ }
    }
  } catch { /* ignore */ }
}

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

app.whenReady().then(() => {
  cleanupOrphanedTempDirs();
  createWindow();
});

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

// ── Sort Comics ───────────────────────────────────────────────────────────────
let sortAbortController       = null;
let pendingSortChoiceResolve  = null;

ipcMain.handle('sort:start', async (event, { sourceFolder, targetFolder }) => {
  sortAbortController = new AbortController();
  const signal = sortAbortController.signal;

  const sendLog = (msg, type = 'info') => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sort:log', { msg, type });
    }
  };

  const onAmbiguous = (filePath, matches) => {
    return new Promise((resolve) => {
      pendingSortChoiceResolve = resolve;
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sort:ambiguous', {
          file:    require('path').basename(filePath),
          matches: matches.map((m) => ({ label: require('path').basename(m), fullPath: m })),
        });
      }
    });
  };

  try {
    const { startSort } = require('./src/sorter');
    const result = await startSort({ sourceFolder, targetFolder }, sendLog, onAmbiguous, signal);
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('sort:complete', result);
  } catch (err) {
    sendLog(`Fatal error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('sort:complete', { moved: 0, skipped: 0, manual: 0 });
  } finally {
    sortAbortController      = null;
    pendingSortChoiceResolve = null;
  }
});

ipcMain.handle('sort:choice', (event, { choice }) => {
  if (pendingSortChoiceResolve) {
    const resolve = pendingSortChoiceResolve;
    pendingSortChoiceResolve = null;
    resolve(choice); // choice is a folder path string, or null to skip
  }
});

ipcMain.handle('sort:cancel', () => {
  if (pendingSortChoiceResolve) {
    const resolve = pendingSortChoiceResolve;
    pendingSortChoiceResolve = null;
    resolve(null);
  }
  sortAbortController?.abort();
});

// Open a file's containing folder in Explorer, with the file highlighted
ipcMain.handle('shell:openFolder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// Convert a single file (used by the needs-review modal)
ipcMain.handle('conversion:convertSingle', async (event, { filePath, isManga }) => {
  const sendLog = (msg, type = 'info', update = false) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(update ? 'conversion:logUpdate' : 'conversion:log', { msg, type });
    }
  };
  try {
    const { convertSingleFile } = require('./src/converter');
    return await convertSingleFile(filePath, isManga, sendLog, null);
  } catch (err) {
    sendLog(`ERROR: ${err.message}`, 'error');
    return { success: false };
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
