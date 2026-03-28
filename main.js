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
      const isCbzDir    = entry.isDirectory() && entry.name.startsWith('cbz_');
      // cbz_resized_*.cbz — orphaned temp CBZ files from crashed resize sessions
      const isCbzFile   = entry.isFile()      && entry.name.startsWith('cbz_resized_');
      const isMagick    = entry.isFile()      && entry.name.startsWith('magick-');
      if (!isCbzDir && !isCbzFile && !isMagick) continue;
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

// Abort any running child processes before quitting so the event loop drains
// cleanly. Without this, awaited execFile handles keep the process alive even
// after all windows are closed, leaving a ghost process in Task Manager.
app.on('before-quit', () => {
  clearPause();
  clearSortPause();
  clearResizePause();
  activeAbortController?.abort();
  sortAbortController?.abort();
  resizeAbortController?.abort();
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
let sortPausePromise          = null;
let sortPauseResolve          = null;

function waitIfSortPaused(signal) {
  if (!sortPausePromise) return Promise.resolve();
  return Promise.race([
    sortPausePromise,
    new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
}

function clearSortPause() {
  if (sortPauseResolve) sortPauseResolve();
  sortPauseResolve = null;
  sortPausePromise = null;
}

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
          file:    path.basename(filePath),
          matches: matches.map((m) => ({ label: path.basename(m), fullPath: m })),
        });
      }
    });
  };

  try {
    const { startSort } = require('./src/sorter');
    const result = await startSort({ sourceFolder, targetFolder }, sendLog, onAmbiguous, signal, waitIfSortPaused);
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('sort:complete', result);
  } catch (err) {
    sendLog(`Fatal error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('sort:complete', { moved: 0, skipped: 0, manual: 0 });
  } finally {
    clearSortPause();
    sortAbortController      = null;
    pendingSortChoiceResolve = null;
  }
});

ipcMain.handle('sort:pause', () => {
  if (sortAbortController && !sortPausePromise) {
    sortPausePromise = new Promise((resolve) => { sortPauseResolve = resolve; });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sort:log', { msg: 'Pausing after current file…', type: 'warn' });
    }
  }
});

ipcMain.handle('sort:resume', () => {
  if (sortPauseResolve) {
    clearSortPause();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sort:log', { msg: 'Resumed.', type: 'info' });
    }
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
  clearSortPause();
  sortAbortController?.abort();
});

// Open a file's containing folder in Explorer, with the file highlighted
ipcMain.handle('shell:openFolder', (event, filePath) => {
  shell.showItemInFolder(filePath);
});

// ── Resize CBZs ───────────────────────────────────────────────────────────────
let resizeAbortController = null;
let resizePausePromise    = null;
let resizePauseResolve    = null;

function waitIfResizePaused(signal) {
  if (!resizePausePromise) return Promise.resolve();
  return Promise.race([
    resizePausePromise,
    new Promise((_, reject) => {
      const onAbort = () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
}

function clearResizePause() {
  if (resizePauseResolve) resizePauseResolve();
  resizePauseResolve = null;
  resizePausePromise = null;
}

ipcMain.handle('resize:start', async (event, { folder }) => {
  resizeAbortController = new AbortController();

  const sendLog = (msg, type = 'info') => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('resize:log', { msg, type });
    }
  };

  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('resize:progress', { current, total });
    }
  };

  try {
    const { startResize } = require('./src/resizer');
    const result = await startResize(
      { folder },
      sendLog,
      sendProgress,
      resizeAbortController.signal,
      waitIfResizePaused
    );
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('resize:complete', result);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      sendLog(`Fatal error: ${err.message}`, 'error');
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('resize:complete', { resized: [], skipped: 0, errors: [], aborted: true });
    }
  } finally {
    clearResizePause();
    resizeAbortController = null;
  }
});

ipcMain.handle('resize:pause', () => {
  if (resizeAbortController && !resizePausePromise) {
    resizePausePromise = new Promise((resolve) => { resizePauseResolve = resolve; });
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('resize:log', { msg: 'Pausing after current file…', type: 'warn' });
    }
  }
});

ipcMain.handle('resize:resume', () => {
  if (resizePauseResolve) {
    clearResizePause();
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('resize:log', { msg: 'Resumed.', type: 'info' });
    }
  }
});

ipcMain.handle('resize:cancel', () => {
  clearResizePause();
  resizeAbortController?.abort();
});

// Replace each original CBZ with its resized temp copy
ipcMain.handle('resize:confirm', async (event, items) => {
  const results = [];
  for (const { original, tmp } of items) {
    try {
      await fs.promises.rename(tmp, original);
      results.push({ file: original, success: true });
    } catch (err) {
      // rename can fail across drives — fall back to copy + delete
      try {
        await fs.promises.copyFile(tmp, original);
        await fs.promises.unlink(tmp);
        results.push({ file: original, success: true });
      } catch (err2) {
        results.push({ file: original, success: false, error: err2.message });
      }
    }
  }
  return results;
});

// Discard pending resize temp files without applying changes
ipcMain.handle('resize:discard', async (event, items) => {
  for (const { tmp } of items) {
    try { await fs.promises.unlink(tmp); } catch {}
  }
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
    let sizeBytes = 0;
    try { sizeBytes = (await fs.promises.stat(filePath)).size; } catch {}
    try {
      await fs.promises.unlink(filePath);
      results.push({ file: filePath, success: true, sizeBytes });
    } catch (err) {
      results.push({ file: filePath, success: false, error: err.message, sizeBytes: 0 });
    }
  }
  return results;
});
