const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * Delete leftover temp files from previous crashed sessions.
 *
 * Only sweeps items we own (prefix `cbz_`) so we can't accidentally yank
 * in-flight scratch files from another ImageMagick-using tool running on the
 * same machine.  ImageMagick's own `magick-*` scratch files are NOT swept —
 * those belong to whoever spawned them, and a foreground process may still
 * be actively writing them.
 *
 * Swept:
 *   cbz_*              — our own extraction temp directories (and any file
 *                        prefixed cbz_, e.g. cbz_resized_*.cbz from resizer)
 */
function cleanupOrphanedTempDirs() {
  const tmpBase = os.tmpdir();
  try {
    for (const entry of fs.readdirSync(tmpBase, { withFileTypes: true })) {
      if (!entry.name.startsWith('cbz_')) continue;
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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Standard Electron hardening — the renderer only loads bundled local files
  // under a strict CSP, but defence-in-depth: a future regression (DOM-inject,
  // compromised dep) cannot pivot into navigating the app window to arbitrary
  // content or opening popup windows with main-world privileges.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

app.whenReady().then(() => {
  cleanupOrphanedTempDirs();
  createWindow();

  const { setupUpdater, checkForUpdates } = require('./src/updater');
  setupUpdater(mainWindow);
  ipcMain.handle('check-update', () => checkForUpdates());
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
  dupAbortController?.abort();
  flattenAbortController?.abort();
  unwrapAbortController?.abort();
  folderPackAbortController?.abort();
});

// App version
ipcMain.handle('app:version', () => app.getVersion());

// ── Persistent settings (JSON file in userData) ──────────────────────────────
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); }
  catch { return {}; }
}

function writeSettings(data) {
  fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2), 'utf-8');
}

ipcMain.handle('settings:get', (event, key) => {
  return readSettings()[key] ?? null;
});

ipcMain.handle('settings:set', (event, key, value) => {
  const s = readSettings();
  s[key] = value;
  writeSettings(s);
});

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

// Open a path directly in Explorer (for folders)
ipcMain.handle('shell:openPath', (event, folderPath) => {
  shell.openPath(folderPath);
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

// ── Find Duplicates ───────────────────────────────────────────────────────────
let dupAbortController = null;

ipcMain.handle('duplicates:scan', async (event, { folder }) => {
  dupAbortController = new AbortController();
  const signal = dupAbortController.signal;

  const sendLog = (msg, type = 'info') => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('duplicates:log', { msg, type });
  };

  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('duplicates:progress', { current, total });
  };

  try {
    const { scanDuplicates } = require('./src/duplicates');
    const result = await scanDuplicates(folder, sendLog, sendProgress, signal);
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('duplicates:complete', result);
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('duplicates:complete', { groups: [], aborted: true });
  } finally {
    dupAbortController = null;
  }
});

ipcMain.handle('duplicates:cancel', () => {
  dupAbortController?.abort();
});

ipcMain.handle('duplicates:trash', async (event, filePaths) => {
  const results = [];
  for (const filePath of filePaths) {
    try {
      await shell.trashItem(filePath);
      results.push({ file: filePath, success: true });
    } catch (err) {
      results.push({ file: filePath, success: false, error: err.message });
    }
  }
  return results;
});

// ── Fix the Library — Flatten ─────────────────────────────────────────────────
let flattenAbortController  = null;
let flattenPendingGroups    = null;  // held between scan and apply

ipcMain.handle('flatten:scan', async (event, { folder }) => {
  flattenAbortController = new AbortController();
  const signal = flattenAbortController.signal;
  flattenPendingGroups = null;

  const sendLog = (msg, type = 'info', path = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:log', { msg, type, path });
  };

  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:progress', { current, total, phase: 'scan' });
  };

  try {
    const { scanFlattenable } = require('./src/flattener');
    const { groups, journalsDeleted } = await scanFlattenable(folder, sendLog, sendProgress, signal);
    flattenPendingGroups = groups;

    // Send renderer a display-friendly summary
    const preview = groups.map((g) => ({
      outer:     g.outer,      // absolute path (for Open Folder)
      outerRel:  g.outerRel,
      innerName: g.innerName,
      itemCount: g.itemCount,
    }));

    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:scanComplete', {
        preview, journalsDeleted, aborted: false,
      });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:scanComplete', {
        preview: [], journalsDeleted: 0, aborted: true,
      });
  } finally {
    flattenAbortController = null;
  }
});

ipcMain.handle('flatten:apply', async (event, { folder, selectedOuterRels }) => {
  if (!flattenPendingGroups) {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:applyComplete', { flattened: 0, failed: 0, aborted: false });
    return;
  }

  flattenAbortController = new AbortController();
  const signal = flattenAbortController.signal;

  const sendLog = (msg, type = 'info', path = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:log', { msg, type, path });
  };

  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:progress', { current, total, phase: 'apply' });
  };

  const selected = new Set(selectedOuterRels);
  const groups   = flattenPendingGroups.filter((g) => selected.has(g.outerRel));

  try {
    const { applyFlatten } = require('./src/flattener');
    const result = await applyFlatten(folder, groups, sendLog, sendProgress, signal);
    flattenPendingGroups = null;
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:applyComplete', {
        flattened:     result.flattened,
        failed:        result.failed,
        flattenedRels: result.flattenedRels,
        failedRels:    result.failedRels,
        aborted:       false,
      });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:applyComplete', { flattened: 0, failed: 0, aborted: true });
  } finally {
    flattenAbortController = null;
  }
});

ipcMain.handle('flatten:cancel', () => {
  flattenAbortController?.abort();
});

ipcMain.handle('flatten:deleteEmpty', async (event, { folder }) => {
  flattenAbortController = new AbortController();
  const signal = flattenAbortController.signal;

  const sendLog = (msg, type = 'info') => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:log', { msg, type });
  };

  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:progress', { current, total, phase: 'deleteEmpty' });
  };

  try {
    const { deleteEmptyFolders } = require('./src/flattener');
    const result = await deleteEmptyFolders(folder, sendLog, sendProgress, signal);
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:deleteEmptyComplete', { ...result, aborted: false });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('flatten:deleteEmptyComplete', { deleted: [], aborted: true });
  } finally {
    flattenAbortController = null;
  }
});

// ── Unwrap Bundle CBZs ────────────────────────────────────────────────────────
let unwrapAbortController = null;
let unwrapPendingGroups   = null;

ipcMain.handle('unwrap:scan', async (event, { folder }) => {
  unwrapAbortController = new AbortController();
  const signal = unwrapAbortController.signal;
  unwrapPendingGroups = null;

  const sendLog = (msg, type = 'info', pathArg = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:log', { msg, type, path: pathArg });
  };
  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:progress', { current, total });
  };

  try {
    const { scanBundles } = require('./src/unwrapper');
    const { groups } = await scanBundles(folder, sendLog, sendProgress, signal);
    unwrapPendingGroups = groups;

    const preview = groups.map((g) => ({
      cbzPath:          g.cbzPath,
      cbzRel:           g.cbzRel,
      previewTarget:    g.previewTarget,
      previewTargetRel: g.previewTargetRel,
      archiveCount:     g.archiveCount,
      totalEntries:     g.totalEntries,
    }));

    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:scanComplete', { preview, aborted: false });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:scanComplete', { preview: [], aborted: true });
  } finally {
    unwrapAbortController = null;
  }
});

ipcMain.handle('unwrap:apply', async (event, { folder, selectedCbzPaths }) => {
  if (!unwrapPendingGroups) {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:applyComplete', { unwrapped: 0, failed: 0, extracted: [], aborted: false });
    return;
  }

  unwrapAbortController = new AbortController();
  const signal = unwrapAbortController.signal;

  const sendLog = (msg, type = 'info', pathArg = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:log', { msg, type, path: pathArg });
  };
  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:progress', { current, total });
  };

  const selected = new Set(selectedCbzPaths);
  const groups   = unwrapPendingGroups.filter((g) => selected.has(g.cbzPath));

  try {
    const { applyUnwrap } = require('./src/unwrapper');
    const result = await applyUnwrap(folder, groups, sendLog, sendProgress, signal);
    unwrapPendingGroups = null;
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:applyComplete', { ...result, aborted: false });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('unwrap:applyComplete', { unwrapped: 0, failed: 0, extracted: [], aborted: true });
  } finally {
    unwrapAbortController = null;
  }
});

ipcMain.handle('unwrap:cancel', () => {
  unwrapAbortController?.abort();
});

ipcMain.handle('unwrap:deleteOriginal', async (event, filePath) => {
  try {
    await shell.trashItem(filePath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── Scan Ext-Folders (folder-packer) ─────────────────────────────────────────
let folderPackAbortController = null;
let folderPackScanResult      = null;  // { convertGroups, renameGroups }

ipcMain.handle('folderpack:scan', async (event, { folder }) => {
  folderPackAbortController = new AbortController();
  const signal = folderPackAbortController.signal;
  folderPackScanResult = null;

  const sendLog = (msg, type = 'info', pathArg = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:log', { msg, type, path: pathArg });
  };
  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:progress', { current, total });
  };

  try {
    const { scanExtFolders } = require('./src/folder-packer');
    const result = await scanExtFolders(folder, sendLog, sendProgress, signal);
    folderPackScanResult = result;

    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:scanComplete', {
        convertGroups: result.convertGroups,
        renameGroups:  result.renameGroups,
        aborted: false,
      });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:scanComplete', { convertGroups: [], renameGroups: [], aborted: true });
  } finally {
    folderPackAbortController = null;
  }
});

ipcMain.handle('folderpack:convert', async (event, { folder, selectedFolderPaths }) => {
  if (!folderPackScanResult) {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:convertComplete', { converted: 0, failed: 0, convertedItems: [], aborted: false });
    return;
  }

  folderPackAbortController = new AbortController();
  const signal = folderPackAbortController.signal;

  const sendLog = (msg, type = 'info', pathArg = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:log', { msg, type, path: pathArg });
  };
  const sendProgress = (current, total) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:progress', { current, total });
  };

  const selected = new Set(selectedFolderPaths);
  const groups   = folderPackScanResult.convertGroups.filter((g) => selected.has(g.folderPath));

  try {
    const { applyConvertFolders } = require('./src/folder-packer');
    const result = await applyConvertFolders(folder, groups, sendLog, sendProgress, signal);
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:convertComplete', { ...result, aborted: false });
  } catch (err) {
    if (err.name !== 'AbortError') sendLog(`Error: ${err.message}`, 'error');
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:convertComplete', { converted: 0, failed: 0, convertedItems: [], aborted: true });
  } finally {
    folderPackAbortController = null;
  }
});

ipcMain.handle('folderpack:rename', (event, { folder, selectedFolderPaths }) => {
  if (!folderPackScanResult) return { renamed: 0, failed: 0 };

  const sendLog = (msg, type = 'info', pathArg = null) => {
    if (!mainWindow.isDestroyed())
      mainWindow.webContents.send('folderpack:log', { msg, type, path: pathArg });
  };

  const selected = new Set(selectedFolderPaths);
  const groups   = folderPackScanResult.renameGroups.filter((g) => selected.has(g.folderPath));

  const { applyRenameFolders } = require('./src/folder-packer');
  const result = applyRenameFolders(folder, groups, sendLog);

  if (!mainWindow.isDestroyed())
    mainWindow.webContents.send('folderpack:renameComplete', { ...result });

  return result;
});

ipcMain.handle('folderpack:cancel', () => {
  folderPackAbortController?.abort();
});

ipcMain.handle('folderpack:deleteFolder', async (event, folderPath) => {
  try {
    await shell.trashItem(folderPath);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
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
      // ENOENT = already gone; treat as success (goal achieved)
      if (err.code === 'ENOENT') {
        results.push({ file: filePath, success: true, sizeBytes: 0 });
      } else {
        results.push({ file: filePath, success: false, error: err.message, sizeBytes: 0 });
      }
    }
  }
  return results;
});
