/* global electron */
'use strict';

// Fetch version safely via IPC so a failure here never blocks the rest of the UI
electron.invoke('app:version').then((v) => {
  document.getElementById('appVersion').textContent = `v${v}`;
}).catch(() => {});

// ── State ────────────────────────────────────────────────────────────────────
let currentFolder    = null;
let isConverting     = false;
let isPaused         = false;
let pendingOriginals = [];
let pendingReview    = [];
let reviewIndex      = 0;

let lastCbzBytes     = 0;    // total size of CBZ files created in the last conversion session
let convertStart     = 0;
let resizeStart      = 0;
let sortStart        = 0;

let resizeFolder     = null;
let isResizing       = false;
let isResizePaused   = false;
let pendingResized   = [];   // [{ original, tmp, pagesResized, totalPages }]

let sortSourceFolder = 'I:\\Unsorted Comics';
let sortTargetFolder = 'Y:\\Comix';
let isSorting        = false;
let isSortPaused     = false;

let dupFolder  = null;
let isScanning = false;
let dupGroups  = [];  // [{ type, files: [{path,size,mtimeMs,checked,trashed}] }]

let fixFolder       = null;
let isFixing        = false;
let fixPreview      = [];  // groups from last scan
let fixAppliedRels  = [];  // outerRels submitted to the last flatten:apply call
let fixStart        = 0;   // Date.now() when the current fix operation started

let bundlePreview   = [];  // groups from last bundle scan
let bundleExtracted = [];  // { cbzPath, cbzRel, targetFolder, targetFolderRel } after apply

let extConvertGroups  = [];  // Category A groups from last ext-folder scan
let extRenameGroups   = [];  // Category B groups from last ext-folder scan
let extConverted      = [];  // { folderPath, folderRel, outputPaths } after convert

// ── DOM refs ─────────────────────────────────────────────────────────────────
// Tabs
const tabBtns  = document.querySelectorAll('.tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');

// Convert tab
const folderPathEl     = document.getElementById('folderPath');
const browseBtn        = document.getElementById('browseBtn');
const startBtn         = document.getElementById('startBtn');
const pauseBtn         = document.getElementById('pauseBtn');
const cancelBtn        = document.getElementById('cancelBtn');
const mangaModeEl      = document.getElementById('mangaMode');
const modeHint         = document.getElementById('modeHint');
const progressWrap     = document.getElementById('progressWrap');
const progressFill     = document.getElementById('progressFill');
const progressLabel    = document.getElementById('progressLabel');
const etaLabel         = document.getElementById('etaLabel');

// Resize tab
const resizeFolderPathEl  = document.getElementById('resizeFolderPath');
const browseResizeBtn     = document.getElementById('browseResizeBtn');
const startResizeBtn      = document.getElementById('startResizeBtn');
const pauseResizeBtn      = document.getElementById('pauseResizeBtn');
const cancelResizeBtn     = document.getElementById('cancelResizeBtn');
const resizeProgressWrap  = document.getElementById('resizeProgressWrap');
const resizeProgressFill  = document.getElementById('resizeProgressFill');
const resizeProgressLabel = document.getElementById('resizeProgressLabel');

// Sort tab
const sortSourcePathEl    = document.getElementById('sortSourcePath');
const browseSortSourceBtn = document.getElementById('browseSortSourceBtn');
const sortTargetPathEl    = document.getElementById('sortTargetPath');
const browseSortTargetBtn = document.getElementById('browseSortTargetBtn');
const sortBtn             = document.getElementById('sortBtn');
const pauseSortBtn        = document.getElementById('pauseSortBtn');
const cancelSortBtn       = document.getElementById('cancelSortBtn');

// Shared
const logContainer    = document.getElementById('logContainer');
const clearLogBtn     = document.getElementById('clearLogBtn');

// Fix the Library tab
const fixFolderPathEl   = document.getElementById('fixFolderPath');
const browseFixBtn      = document.getElementById('browseFixBtn');
const scanFixBtn        = document.getElementById('scanFixBtn');
const scanBundlesBtn    = document.getElementById('scanBundlesBtn');
const cancelFixBtn      = document.getElementById('cancelFixBtn');
const fixPreviewPanel   = document.getElementById('fixPreviewPanel');
const fixPreviewSummary = document.getElementById('fixPreviewSummary');
const fixSelectAll      = document.getElementById('fixSelectAll');
const applyFixBtn       = document.getElementById('applyFixBtn');
const fixGroupList      = document.getElementById('fixGroupList');
const deleteEmptyBtn    = document.getElementById('deleteEmptyBtn');
const fixProgressWrap   = document.getElementById('fixProgressWrap');
const fixProgressFill   = document.getElementById('fixProgressFill');
const fixProgressLabel  = document.getElementById('fixProgressLabel');
const fixEtaLabel       = document.getElementById('fixEtaLabel');

// Ext-folders scan
const scanExtFoldersBtn      = document.getElementById('scanExtFoldersBtn');
const extConvertPanel        = document.getElementById('extConvertPanel');
const extConvertSummary      = document.getElementById('extConvertSummary');
const extConvertSelectAll    = document.getElementById('extConvertSelectAll');
const applyExtConvertBtn     = document.getElementById('applyExtConvertBtn');
const extConvertList         = document.getElementById('extConvertList');
const extRenamePanel         = document.getElementById('extRenamePanel');
const extRenameSummary       = document.getElementById('extRenameSummary');
const applyExtRenameBtn      = document.getElementById('applyExtRenameBtn');
const extRenameList          = document.getElementById('extRenameList');
const extDeletionPanel       = document.getElementById('extDeletionPanel');
const extDeletionSummary     = document.getElementById('extDeletionSummary');
const extDeletionList        = document.getElementById('extDeletionList');
const deleteAllExtFoldersBtn = document.getElementById('deleteAllExtFoldersBtn');

// Bundle unwrap
const bundlePreviewPanel    = document.getElementById('bundlePreviewPanel');
const bundlePreviewSummary  = document.getElementById('bundlePreviewSummary');
const bundleSelectAll       = document.getElementById('bundleSelectAll');
const applyUnwrapBtn        = document.getElementById('applyUnwrapBtn');
const bundleGroupList       = document.getElementById('bundleGroupList');
const bundleDeletionPanel   = document.getElementById('bundleDeletionPanel');
const bundleDeletionSummary = document.getElementById('bundleDeletionSummary');
const bundleDeletionList    = document.getElementById('bundleDeletionList');
const deleteAllOriginalsBtn = document.getElementById('deleteAllOriginalsBtn');

// Duplicates tab
const dupFolderPathEl  = document.getElementById('dupFolderPath');
const browseDupBtn     = document.getElementById('browseDupBtn');
const startDupBtn      = document.getElementById('startDupBtn');
const cancelDupBtn     = document.getElementById('cancelDupBtn');
const dupProgressWrap  = document.getElementById('dupProgressWrap');
const dupProgressFill  = document.getElementById('dupProgressFill');
const dupProgressLabel = document.getElementById('dupProgressLabel');
const dupResultsPanel  = document.getElementById('dupResultsPanel');
const dupSummary       = document.getElementById('dupSummary');
const dupResultsList   = document.getElementById('dupResultsList');
const invertDupSelBtn  = document.getElementById('invertDupSelBtn');
const trashCheckedBtn  = document.getElementById('trashCheckedBtn');

// Modals
const deleteModal      = document.getElementById('deleteModal');
const deleteList       = document.getElementById('deleteList');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const skipDeleteBtn    = document.getElementById('skipDeleteBtn');

const resizeModal      = document.getElementById('resizeModal');
const resizeList       = document.getElementById('resizeList');
const confirmResizeBtn = document.getElementById('confirmResizeBtn');
const discardResizeBtn = document.getElementById('discardResizeBtn');

const sortModal        = document.getElementById('sortModal');
const sortModalFile    = document.getElementById('sortModalFile');
const sortModalOptions = document.getElementById('sortModalOptions');
const sortModalSkipBtn = document.getElementById('sortModalSkipBtn');

// ── Default folder values ─────────────────────────────────────────────────────
sortSourcePathEl.value = sortSourceFolder;
sortTargetPathEl.value = sortTargetFolder;

// ── Tab switching ─────────────────────────────────────────────────────────────
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (isConverting || isResizing || isSorting || isScanning || isFixing) return;
    tabBtns.forEach((b) => b.classList.remove('active'));
    tabPanes.forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

function setTabsDisabled(disabled) {
  tabBtns.forEach((b) => (b.disabled = disabled));
  document.querySelectorAll('.tab-preset-btn').forEach((b) => (b.disabled = disabled));
  if (scanBundlesBtn)     scanBundlesBtn.disabled    = disabled || !fixFolder;
  if (scanExtFoldersBtn)  scanExtFoldersBtn.disabled = disabled || !fixFolder;
}

// ── Convert tab: folder selection ─────────────────────────────────────────────
document.querySelectorAll('.preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setFolder(btn.dataset.path);
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

browseBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    setFolder(folder);
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  }
});

// ── Tab preset buttons (Resize / Duplicates / Fix the Library) ────────────────
// Each button has data-target (input element ID) and data-path (folder path).
// The setters map each target input to its tab's folder variable and enable button.
const tabPresetSetters = {
  resizeFolderPath: (folder) => {
    resizeFolder = folder;
    resizeFolderPathEl.value = folder;
    startResizeBtn.disabled = false;
  },
  dupFolderPath: (folder) => {
    dupFolder = folder;
    dupFolderPathEl.value = folder;
    startDupBtn.disabled = false;
  },
  fixFolderPath: (folder) => {
    fixFolder = folder;
    fixFolderPathEl.value = folder;
    scanFixBtn.disabled         = false;
    scanBundlesBtn.disabled     = false;
    scanExtFoldersBtn.disabled  = false;
    deleteEmptyBtn.disabled     = false;
    fixPreviewPanel.classList.add('hidden');
    fixPreview = [];
  },
};

document.querySelectorAll('.tab-preset-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const setter = tabPresetSetters[btn.dataset.target];
    if (!setter) return;
    setter(btn.dataset.path);
    // Highlight active preset within the same target group
    document.querySelectorAll(`.tab-preset-btn[data-target="${btn.dataset.target}"]`)
      .forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
  });
});

function setFolder(folder) {
  currentFolder = folder;
  folderPathEl.value = folder;
  startBtn.disabled = isConverting;
}

// ── Drag and drop ─────────────────────────────────────────────────────────────
const folderPanel = document.querySelector('.folder-panel');

folderPanel.addEventListener('dragover', (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  folderPanel.classList.add('drag-over');
});

folderPanel.addEventListener('dragleave', (e) => {
  if (!folderPanel.contains(e.relatedTarget)) {
    folderPanel.classList.remove('drag-over');
  }
});

folderPanel.addEventListener('drop', (e) => {
  e.preventDefault();
  folderPanel.classList.remove('drag-over');
  if (isConverting) return;

  const item = e.dataTransfer.files[0];
  if (item && item.path) {
    setFolder(item.path);
    document.querySelectorAll('.preset-btn').forEach((b) => b.classList.remove('active'));
  }
});

// ── Manga mode toggle ────────────────────────────────────────────────────────
mangaModeEl.addEventListener('change', () => {
  modeHint.textContent = mangaModeEl.checked ? 'Manga naming' : 'Comics naming';
});

// ── Conversion controls ───────────────────────────────────────────────────────
startBtn.addEventListener('click', startConversion);

pauseBtn.addEventListener('click', () => {
  if (!isPaused) {
    isPaused = true;
    pauseBtn.textContent = '▶  Resume';
    electron.invoke('conversion:pause');
  } else {
    isPaused = false;
    pauseBtn.textContent = '⏸  Pause';
    electron.invoke('conversion:resume');
  }
});

cancelBtn.addEventListener('click', () => electron.invoke('conversion:cancel'));

async function startConversion() {
  if (!currentFolder || isConverting) return;

  isConverting = true;
  isPaused = false;
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  pauseBtn.textContent = '⏸  Pause';
  cancelBtn.disabled = false;
  browseBtn.disabled = true;
  document.querySelectorAll('.preset-btn, .tab-preset-btn').forEach((b) => (b.disabled = true));
  setTabsDisabled(true);

  convertStart = Date.now();
  logContainer.innerHTML = '';
  progressWrap.classList.remove('hidden');
  setProgress(0, 0);

  await electron.invoke('conversion:start', {
    rootFolder: currentFolder,
    isManga: mangaModeEl.checked,
  });
  // Result arrives via 'conversion:complete'
}

function resetConvertControls() {
  isConverting = false;
  isPaused = false;
  startBtn.disabled = !currentFolder;
  pauseBtn.disabled = true;
  pauseBtn.textContent = '⏸  Pause';
  cancelBtn.disabled = true;
  browseBtn.disabled = false;
  document.querySelectorAll('.preset-btn, .tab-preset-btn').forEach((b) => (b.disabled = false));
  setTabsDisabled(false);
}

// ── IPC: Conversion ───────────────────────────────────────────────────────────
electron.on('conversion:log', ({ msg, type }) => {
  appendLog(msg, type);
});

electron.on('conversion:logUpdate', ({ msg, type }) => {
  updateLastLog(msg, type);
});

electron.on('conversion:progress', ({ current, total, etaMs }) => {
  setProgress(current, total, etaMs);
});

electron.on('conversion:complete', (result) => {
  resetConvertControls();

  const converted    = result.converted   || [];
  const preExisting  = result.preExisting || [];
  const needsReview  = result.needsReview || [];
  const allDeletable = [...converted, ...preExisting];

  lastCbzBytes = result.totalCbzBytes || 0;
  const convertElapsed = convertStart ? formatDuration(Date.now() - convertStart) : null;
  if (lastCbzBytes > 0 || convertElapsed) {
    const parts = [];
    if (lastCbzBytes > 0)  parts.push(`new CBZs: ${formatBytes(lastCbzBytes)}`);
    if (convertElapsed)    parts.push(`elapsed: ${convertElapsed}`);
    appendLog(parts.join('  |  '), 'info');
  }

  pendingReview = needsReview;
  reviewIndex   = 0;

  if (allDeletable.length > 0) {
    pendingOriginals = allDeletable;
    showDeleteModal(converted, preExisting);
  } else if (needsReview.length > 0) {
    appendLog('\nSome files need manual review:', 'warn');
    showNextReview();
  }
});

// ── Log helpers ───────────────────────────────────────────────────────────────
function appendLog(msg, type = 'info', folderPath = null) {
  const placeholder = logContainer.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  if (type === 'header') {
    logContainer.querySelectorAll('.log-progress-line')
      .forEach((s) => s.classList.remove('log-progress-line'));
  }

  const span = document.createElement('span');
  span.className = `log-${type}`;

  if (folderPath) {
    span.appendChild(document.createTextNode(msg + '  '));
    const btn = document.createElement('button');
    btn.className   = 'log-open-btn';
    btn.textContent = 'Open Folder';
    btn.addEventListener('click', () => electron.invoke('shell:openPath', folderPath));
    span.appendChild(btn);
    span.appendChild(document.createTextNode('\n'));
  } else {
    span.textContent = msg + '\n';
  }

  logContainer.appendChild(span);
  logContainer.scrollTop = logContainer.scrollHeight;
}

function updateLastLog(msg, type = 'info') {
  let target = logContainer.querySelector('span.log-progress-line');
  if (!target) {
    const spans = logContainer.querySelectorAll('span');
    if (spans.length === 0) { appendLog(msg, type); return; }
    target = spans[spans.length - 1];
  }
  target.className = `log-${type} log-progress-line`;
  target.textContent = msg + '\n';
  logContainer.scrollTop = logContainer.scrollHeight;
}

clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = '<span class="log-placeholder">Output will appear here…</span>';
});

// ── Progress bar (Convert) ────────────────────────────────────────────────────
function setProgress(current, total, etaMs = 0) {
  if (total === 0) {
    progressFill.style.width = '0%';
    progressLabel.textContent = '';
    etaLabel.textContent = '';
    return;
  }
  const pct = Math.round((current / total) * 100);
  progressFill.style.width = `${pct}%`;
  progressLabel.textContent = `${current} / ${total}`;
  etaLabel.textContent = current < total && etaMs > 0 ? `ETA: ${formatDuration(etaMs)}` : '';
}

function formatDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function formatBytes(bytes) {
  if (bytes <= 0)          return '0 B';
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 ** 2)   return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3)   return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

// ── Progress bar (Resize) ─────────────────────────────────────────────────────
function setResizeProgress(current, total) {
  if (total === 0) {
    resizeProgressFill.style.width = '0%';
    resizeProgressLabel.textContent = '';
    return;
  }
  const pct = Math.round((current / total) * 100);
  resizeProgressFill.style.width = `${pct}%`;
  resizeProgressLabel.textContent = `${current} / ${total}`;
}

// ── Delete-originals modal ────────────────────────────────────────────────────
function showDeleteModal(converted, preExisting) {
  deleteList.innerHTML = '';

  function addSection(label, files, itemClass) {
    if (files.length === 0) return;
    const hdr = document.createElement('div');
    hdr.className = 'dl-section-header';
    hdr.textContent = label;
    deleteList.appendChild(hdr);
    for (const f of files) {
      const div = document.createElement('div');
      div.className = `dl-item ${itemClass}`;
      div.textContent = f;
      deleteList.appendChild(div);
    }
  }

  addSection(`Converted this session (${converted.length})`, converted, 'dl-converted');
  addSection(`Pre-existing — matching .cbz already present (${preExisting.length})`, preExisting, 'dl-preexisting');

  deleteModal.classList.remove('hidden');
}

confirmDeleteBtn.addEventListener('click', async () => {
  deleteModal.classList.add('hidden');
  appendLog('\nDeleting originals…', 'header');

  const results = await electron.invoke('conversion:deleteOriginals', pendingOriginals);
  for (const r of results) {
    if (r.success) appendLog(`  DELETED: ${r.file}`, 'success');
    else           appendLog(`  FAILED:  ${r.file}  (${r.error})`, 'error');
  }
  const freedBytes = results.reduce((sum, r) => sum + (r.success ? (r.sizeBytes || 0) : 0), 0);
  const parts = [];
  if (freedBytes > 0)   parts.push(`freed ${formatBytes(freedBytes)}`);
  if (lastCbzBytes > 0) parts.push(`new CBZs: ${formatBytes(lastCbzBytes)}`);
  if (freedBytes > 0 && lastCbzBytes > 0) {
    const net = freedBytes - lastCbzBytes;
    parts.push(net >= 0 ? `net gain ${formatBytes(net)}` : `net loss ${formatBytes(-net)}`);
  }
  appendLog(`Done${parts.length ? ' — ' + parts.join(', ') : ''}.`, 'success');
  pendingOriginals = [];
  if (pendingReview.length > 0) {
    appendLog('\nSome files need manual review:', 'warn');
    showNextReview();
  }
});

skipDeleteBtn.addEventListener('click', () => {
  deleteModal.classList.add('hidden');
  const kept = `\nOriginals kept.${lastCbzBytes > 0 ? `  New CBZs: ${formatBytes(lastCbzBytes)}.` : ''}`;
  appendLog(kept, 'info');
  pendingOriginals = [];
  if (pendingReview.length > 0) {
    appendLog('\nSome files need manual review:', 'warn');
    showNextReview();
  }
});

// ── Resize CBZs tab ───────────────────────────────────────────────────────────
browseResizeBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    resizeFolder = folder;
    resizeFolderPathEl.value = folder;
    startResizeBtn.disabled = false;
    document.querySelectorAll('.tab-preset-btn[data-target="resizeFolderPath"]')
      .forEach((b) => b.classList.remove('active'));
  }
});

startResizeBtn.addEventListener('click', async () => {
  if (!resizeFolder || isResizing) return;

  isResizing = true;
  isResizePaused = false;
  startResizeBtn.disabled = true;
  pauseResizeBtn.disabled = false;
  pauseResizeBtn.textContent = '⏸  Pause';
  cancelResizeBtn.disabled = false;
  browseResizeBtn.disabled = true;
  setTabsDisabled(true);

  logContainer.innerHTML = '';
  resizeStart = Date.now();
  resizeProgressWrap.classList.remove('hidden');
  setResizeProgress(0, 0);

  await electron.invoke('resize:start', { folder: resizeFolder });
  // Result arrives via 'resize:complete'
});

pauseResizeBtn.addEventListener('click', () => {
  if (!isResizePaused) {
    isResizePaused = true;
    pauseResizeBtn.textContent = '▶  Resume';
    electron.invoke('resize:pause');
  } else {
    isResizePaused = false;
    pauseResizeBtn.textContent = '⏸  Pause';
    electron.invoke('resize:resume');
  }
});

cancelResizeBtn.addEventListener('click', () => {
  electron.invoke('resize:cancel');
});

electron.on('resize:log', ({ msg, type }) => {
  appendLog(msg, type);
});

electron.on('resize:progress', ({ current, total }) => {
  setResizeProgress(current, total);
});

electron.on('resize:complete', (result) => {
  isResizing = false;
  isResizePaused = false;
  startResizeBtn.disabled = !resizeFolder;
  pauseResizeBtn.disabled = true;
  pauseResizeBtn.textContent = '⏸  Pause';
  cancelResizeBtn.disabled = true;
  browseResizeBtn.disabled = false;
  setTabsDisabled(false);

  pendingResized = result.resized || [];

  const resizeElapsed = resizeStart ? formatDuration(Date.now() - resizeStart) : null;

  const skipped = result.skipped || 0;
  const errors  = result.errors  || [];

  if (result.aborted) {
    if (pendingResized.length > 0) {
      appendLog(
        `Resize cancelled${resizeElapsed ? ` after ${resizeElapsed}` : ''} — ` +
        `${pendingResized.length} file(s) finished before cancellation.`,
        'warn'
      );
      showResizeModal(pendingResized, skipped, errors);
    } else {
      appendLog(`Resize cancelled${resizeElapsed ? ` after ${resizeElapsed}` : ''}.`, 'warn');
    }
    return;
  }

  if (pendingResized.length > 0) {
    if (resizeElapsed) appendLog(`Scan complete — elapsed: ${resizeElapsed}`, 'info');
    showResizeModal(pendingResized, skipped, errors);
  } else {
    const msg = `Done — ${skipped} file(s) already within 4 500 px, ${errors.length} error(s).` +
                (resizeElapsed ? `  Elapsed: ${resizeElapsed}.` : '');
    appendLog(msg, errors.length > 0 ? 'warn' : 'success');
  }
});

function showResizeModal(resized, skipped, errors) {
  resizeList.innerHTML = '';

  const totalSaved = resized.reduce((sum, r) => sum + Math.max(0, r.originalSize - r.newSize), 0);
  const hdr = document.createElement('div');
  hdr.className = 'dl-section-header';
  hdr.textContent = `Ready to replace (${resized.length}) — ${formatBytes(totalSaved)} total savings`;
  resizeList.appendChild(hdr);

  for (const item of resized) {
    const saved = Math.max(0, item.originalSize - item.newSize);
    const div = document.createElement('div');
    div.className = 'dl-item dl-converted';
    div.textContent =
      `${item.original}  [${item.pagesResized}/${item.totalPages} pages — ${formatBytes(saved)} saved]`;
    resizeList.appendChild(div);
  }

  if (errors.length > 0) {
    const ehdr = document.createElement('div');
    ehdr.className = 'dl-section-header';
    ehdr.textContent = `Errors (${errors.length})`;
    resizeList.appendChild(ehdr);
    for (const e of errors) {
      const div = document.createElement('div');
      div.className = 'dl-item dl-preexisting';
      div.textContent = `${e.file}  — ${e.reason}`;
      resizeList.appendChild(div);
    }
  }

  resizeModal.classList.remove('hidden');
}

confirmResizeBtn.addEventListener('click', async () => {
  resizeModal.classList.add('hidden');
  appendLog('\nApplying resized CBZ files…', 'header');

  const totalSaved = pendingResized.reduce((sum, r) => sum + Math.max(0, r.originalSize - r.newSize), 0);
  const results = await electron.invoke('resize:confirm', pendingResized);
  let succeeded = 0;
  for (const r of results) {
    if (r.success) { appendLog(`  REPLACED: ${r.file}`, 'success'); succeeded++; }
    else           appendLog(`  FAILED:   ${r.file}  (${r.error})`, 'error');
  }
  if (succeeded > 0) {
    appendLog(`Done — ${succeeded} file(s) replaced, ${formatBytes(totalSaved)} freed.`, 'success');
  } else {
    appendLog('Done.', 'info');
  }
  pendingResized = [];
});

discardResizeBtn.addEventListener('click', async () => {
  resizeModal.classList.add('hidden');
  await electron.invoke('resize:discard', pendingResized);
  appendLog('Resized copies discarded — originals unchanged.', 'info');
  pendingResized = [];
});

// ── Sort Comics tab ───────────────────────────────────────────────────────────
browseSortSourceBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    sortSourceFolder = folder;
    sortSourcePathEl.value = folder;
    updateSortBtn();
  }
});

browseSortTargetBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    sortTargetFolder = folder;
    sortTargetPathEl.value = folder;
    updateSortBtn();
  }
});

function updateSortBtn() {
  sortBtn.disabled = isSorting || !sortSourceFolder || !sortTargetFolder;
}

sortBtn.addEventListener('click', async () => {
  if (!sortSourceFolder || !sortTargetFolder || isSorting) return;

  isSorting = true;
  isSortPaused = false;
  sortBtn.disabled = true;
  pauseSortBtn.disabled = false;
  pauseSortBtn.textContent = '⏸  Pause';
  cancelSortBtn.disabled = false;
  browseSortSourceBtn.disabled = true;
  browseSortTargetBtn.disabled = true;
  setTabsDisabled(true);

  sortStart = Date.now();
  logContainer.innerHTML = '';

  await electron.invoke('sort:start', {
    sourceFolder: sortSourceFolder,
    targetFolder: sortTargetFolder,
  });
  // Result arrives via 'sort:complete'
});

pauseSortBtn.addEventListener('click', () => {
  if (!isSortPaused) {
    isSortPaused = true;
    pauseSortBtn.textContent = '▶  Resume';
    electron.invoke('sort:pause');
  } else {
    isSortPaused = false;
    pauseSortBtn.textContent = '⏸  Pause';
    electron.invoke('sort:resume');
  }
});

cancelSortBtn.addEventListener('click', () => {
  electron.invoke('sort:cancel');
});

electron.on('sort:log', ({ msg, type }) => {
  appendLog(msg, type);
});

electron.on('sort:ambiguous', ({ file, matches }) => {
  showSortModal(file, matches);
});

electron.on('sort:complete', ({ moved, skipped, manual, totalMovedBytes }) => {
  isSorting = false;
  isSortPaused = false;
  pauseSortBtn.disabled = true;
  pauseSortBtn.textContent = '⏸  Pause';
  cancelSortBtn.disabled = true;
  browseSortSourceBtn.disabled = false;
  browseSortTargetBtn.disabled = false;
  setTabsDisabled(false);
  updateSortBtn();

  const sortElapsed = sortStart ? formatDuration(Date.now() - sortStart) : null;
  appendLog('', 'info');
  appendLog(
    `Sort complete — moved: ${moved}, skipped: ${skipped}, manual: ${manual}` +
    (sortElapsed ? `  |  elapsed: ${sortElapsed}` : ''),
    'success'
  );

  // Show space freed on the source drive only when files crossed to a different drive.
  // Same-drive moves are renames — no disk space is freed or consumed.
  const sourceDrive = sortSourceFolder ? sortSourceFolder.slice(0, 2).toLowerCase() : '';
  const targetDrive = sortTargetFolder ? sortTargetFolder.slice(0, 2).toLowerCase() : '';
  if (sourceDrive && targetDrive && sourceDrive !== targetDrive && totalMovedBytes > 0) {
    appendLog(`Source drive (${sourceDrive.toUpperCase()}) freed: ${formatBytes(totalMovedBytes)}`, 'success');
  }
});

function showSortModal(file, matches) {
  sortModalFile.textContent = file;
  sortModalOptions.innerHTML = '';

  for (const m of matches) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sort-option';
    btn.textContent = m.label;
    btn.title = m.fullPath;
    btn.addEventListener('click', () => {
      sortModal.classList.add('hidden');
      electron.invoke('sort:choice', { choice: m.fullPath });
    });
    sortModalOptions.appendChild(btn);
  }

  sortModal.classList.remove('hidden');
}

sortModalSkipBtn.addEventListener('click', () => {
  sortModal.classList.add('hidden');
  electron.invoke('sort:choice', { choice: null });
});

// ── Needs-review modal ────────────────────────────────────────────────────────
const reviewModal          = document.getElementById('reviewModal');
const reviewCounter        = document.getElementById('reviewCounter');
const reviewFileEl         = document.getElementById('reviewFile');
const reviewLikelySection  = document.getElementById('reviewLikelySection');
const reviewLikelyList     = document.getElementById('reviewLikelyList');
const reviewNoMatch        = document.getElementById('reviewNoMatch');
const reviewStatus         = document.getElementById('reviewStatus');
const reviewKeepBtn        = document.getElementById('reviewKeepBtn');
const reviewDeleteBtn      = document.getElementById('reviewDeleteBtn');
const reviewConvertBtn     = document.getElementById('reviewConvertBtn');
const reviewOpenFolderBtn  = document.getElementById('reviewOpenFolderBtn');
const reviewKeepAllBtn     = document.getElementById('reviewKeepAllBtn');
const reviewDeleteAllBtn   = document.getElementById('reviewDeleteAllBtn');

function showNextReview() {
  if (reviewIndex >= pendingReview.length) {
    reviewModal.classList.add('hidden');
    pendingReview = [];
    return;
  }
  const item = pendingReview[reviewIndex];
  reviewCounter.textContent = `${reviewIndex + 1} of ${pendingReview.length}`;
  reviewFileEl.textContent  = item.file;
  reviewStatus.classList.add('hidden');
  reviewStatus.textContent = '';
  setReviewBusy(false);

  if (item.likelyMatches && item.likelyMatches.length > 0) {
    reviewLikelyList.innerHTML = '';
    for (const cbz of item.likelyMatches) {
      const div = document.createElement('div');
      div.className   = 'review-cbz-item';
      div.textContent = cbz;
      reviewLikelyList.appendChild(div);
    }
    reviewLikelySection.classList.remove('hidden');
    reviewNoMatch.classList.add('hidden');
  } else {
    reviewLikelySection.classList.add('hidden');
    reviewNoMatch.classList.remove('hidden');
  }

  reviewModal.classList.remove('hidden');
}

function setReviewBusy(busy) {
  reviewKeepBtn.disabled       = busy;
  reviewDeleteBtn.disabled     = busy;
  reviewConvertBtn.disabled    = busy;
  reviewOpenFolderBtn.disabled = busy;
  reviewKeepAllBtn.disabled    = busy;
  reviewDeleteAllBtn.disabled  = busy;
}

reviewOpenFolderBtn.addEventListener('click', () => {
  electron.invoke('shell:openFolder', pendingReview[reviewIndex].file);
});

reviewKeepBtn.addEventListener('click', () => {
  appendLog(`  KEPT:    ${pendingReview[reviewIndex].file}`, 'info');
  reviewIndex++;
  showNextReview();
});

reviewDeleteBtn.addEventListener('click', async () => {
  setReviewBusy(true);
  const file = pendingReview[reviewIndex].file;
  const results = await electron.invoke('conversion:deleteOriginals', [file]);
  if (results[0].success) appendLog(`  DELETED: ${file}`, 'success');
  else                    appendLog(`  FAILED:  ${file}  (${results[0].error})`, 'error');
  reviewIndex++;
  showNextReview();
});

reviewConvertBtn.addEventListener('click', async () => {
  const item = pendingReview[reviewIndex];
  setReviewBusy(true);
  reviewStatus.textContent = 'Converting… (see log for progress)';
  reviewStatus.className   = 'review-status review-status-info';

  appendLog(`\nConverting: ${item.file}`, 'header');
  const result = await electron.invoke('conversion:convertSingle', {
    filePath: item.file,
    isManga:  mangaModeEl.checked,
  });

  if (result && result.success) {
    const del = await electron.invoke('conversion:deleteOriginals', [item.file]);
    if (del[0].success) appendLog(`  DELETED original: ${item.file}`, 'success');
    else                appendLog(`  FAILED to delete original: ${del[0].error}`, 'error');
    reviewIndex++;
    showNextReview();
  } else {
    reviewStatus.textContent = 'Conversion failed — see log for details.';
    reviewStatus.className   = 'review-status review-status-error';
    setReviewBusy(false);
    reviewConvertBtn.disabled = true;
  }
});

reviewKeepAllBtn.addEventListener('click', () => {
  const remaining = pendingReview.length - reviewIndex;
  appendLog(`  Kept ${remaining} remaining file(s).`, 'info');
  reviewModal.classList.add('hidden');
  pendingReview = [];
});

reviewDeleteAllBtn.addEventListener('click', async () => {
  reviewModal.classList.add('hidden');
  appendLog('  Deleting all remaining review files…', 'header');
  const toDelete = pendingReview.slice(reviewIndex).map((item) => item.file);
  const results  = await electron.invoke('conversion:deleteOriginals', toDelete);
  for (const r of results) {
    if (r.success) appendLog(`  DELETED: ${r.file}`, 'success');
    else           appendLog(`  FAILED:  ${r.file}  (${r.error})`, 'error');
  }
  appendLog('Done.', 'success');
  pendingReview = [];
});

// ── Find Duplicates tab ───────────────────────────────────────────────────────
browseDupBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    dupFolder = folder;
    dupFolderPathEl.value = folder;
    startDupBtn.disabled = false;
    document.querySelectorAll('.tab-preset-btn[data-target="dupFolderPath"]')
      .forEach((b) => b.classList.remove('active'));
  }
});

startDupBtn.addEventListener('click', async () => {
  if (!dupFolder || isScanning) return;

  isScanning = true;
  startDupBtn.disabled  = true;
  cancelDupBtn.disabled = false;
  browseDupBtn.disabled = true;
  setTabsDisabled(true);
  dupResultsPanel.classList.add('hidden');
  dupProgressWrap.classList.add('hidden');   // shown only when hashing starts
  setDupProgress(0, 0);
  logContainer.innerHTML = '';

  await electron.invoke('duplicates:scan', { folder: dupFolder });
  // Result arrives via 'duplicates:complete'
});

cancelDupBtn.addEventListener('click', () => {
  electron.invoke('duplicates:cancel');
});

function setDupProgress(current, total) {
  if (total === 0) {
    dupProgressFill.style.width = '0%';
    dupProgressLabel.textContent = '';
    return;
  }
  const pct = Math.round((current / total) * 100);
  dupProgressFill.style.width = `${pct}%`;
  dupProgressLabel.textContent = `${current} / ${total}`;
}

electron.on('duplicates:log', ({ msg, type }) => {
  appendLog(msg, type);
});

electron.on('duplicates:progress', ({ current, total }) => {
  // Show progress wrap only once hashing actually starts (total > 0).
  if (total > 0) dupProgressWrap.classList.remove('hidden');
  setDupProgress(current, total);
});

electron.on('duplicates:complete', (result) => {
  isScanning = false;
  startDupBtn.disabled  = !dupFolder;
  cancelDupBtn.disabled = true;
  browseDupBtn.disabled = false;
  setTabsDisabled(false);
  dupProgressWrap.classList.add('hidden');

  if (result.aborted) return;

  renderDuplicates(result.groups || []);
  dupResultsPanel.classList.remove('hidden');
});

// ── Render duplicate groups ───────────────────────────────────────────────────
function renderDuplicates(groups) {
  // Only map the groups we will actually render into dupGroups.
  // Trashing, checkbox state, and summary all operate on dupGroups — if we
  // mapped all groups here, trash would send invisible files to the Recycle Bin.
  const RENDER_LIMIT  = 100;
  const totalGroups   = groups.length;
  const toRender      = groups.slice(0, RENDER_LIMIT);

  dupGroups = toRender.map((g) => ({
    type: g.type,
    files: g.files.map((f, i) => ({
      ...f,
      // Exact: pre-check all but the newest (keep newest by default).
      // Same-name / similar: nothing pre-checked — too risky to guess.
      checked: g.type === 'exact' && i < g.files.length - 1,
      trashed: false,
    })),
  }));

  dupResultsList.innerHTML = '';

  if (totalGroups === 0) {
    dupSummary.textContent = 'Results';
    const msg = document.createElement('div');
    msg.className   = 'dup-no-results';
    msg.textContent = 'No duplicates found.';
    dupResultsList.appendChild(msg);
    return;
  }

  // Compute summary counts from the full server-side list (not just rendered)
  const exactCount    = groups.filter((g) => g.type === 'exact').length;
  const sameNameCount = groups.filter((g) => g.type === 'samename').length;
  const similarCount  = groups.filter((g) => g.type === 'similar').length;
  const parts = [];
  if (exactCount    > 0) parts.push(`${exactCount} exact`);
  if (sameNameCount > 0) parts.push(`${sameNameCount} same-name`);
  if (similarCount  > 0) parts.push(`${similarCount} similar`);
  dupSummary.textContent = `${totalGroups} group(s)  —  ${parts.join(', ')}`;

  dupGroups.forEach((group, gi) => {
    const div       = document.createElement('div');
    div.className   = 'dup-group';
    div.dataset.gi  = gi;

    // Header
    const hdr       = document.createElement('div');
    hdr.className   = 'dup-group-header';

    const badge     = document.createElement('span');
    badge.className = `dup-badge dup-badge-${group.type}`;
    badge.textContent = { exact: 'Exact Copy', samename: 'Same Name', similar: 'Similar Name' }[group.type];

    const totalSize  = group.files.reduce((s, f) => s + f.size, 0);
    const info       = document.createElement('span');
    info.className   = 'dup-group-info';
    let infoText     = `${group.files.length} files · ${formatBytes(totalSize)}`;
    if (group.type === 'similar') {
      // Show the normalised key so users understand why these files were matched.
      const key = group.files[0].path
        .split(/[\\/]/).pop()                       // basename
        .replace(/\.[^.]+$/, '')                    // strip extension
        .toLowerCase()
        .replace(/^(the|a|an) /, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
      infoText += `  ·  matched as "${key}"`;
    }
    info.textContent = infoText;

    const chevron   = document.createElement('span');
    chevron.className = 'dup-group-chevron';
    chevron.textContent = '▾';

    hdr.appendChild(badge);
    hdr.appendChild(info);
    hdr.appendChild(chevron);
    hdr.addEventListener('click', () => div.classList.toggle('collapsed'));

    // Files
    const filesDiv    = document.createElement('div');
    filesDiv.className = 'dup-group-files';

    group.files.forEach((f, fi) => {
      const row       = document.createElement('div');
      row.className   = 'dup-file-row';
      row.dataset.gi  = gi;
      row.dataset.fi  = fi;

      const cb        = document.createElement('input');
      cb.type         = 'checkbox';
      cb.className    = 'dup-file-check';
      cb.checked      = f.checked;
      cb.dataset.gi   = gi;
      cb.dataset.fi   = fi;
      cb.addEventListener('change', onDupCheckChange);

      const pathSpan    = document.createElement('span');
      pathSpan.className = 'dup-file-path';
      pathSpan.textContent = f.path;
      pathSpan.title       = f.path;

      const meta      = document.createElement('span');
      meta.className  = 'dup-file-meta';
      const date      = new Date(f.mtimeMs).toLocaleDateString(undefined,
        { year: 'numeric', month: 'short', day: 'numeric' });
      meta.textContent = `${formatBytes(f.size)}  ${date}`;

      const openBtn     = document.createElement('button');
      openBtn.className = 'dup-file-open';
      openBtn.textContent = 'Open Folder';
      openBtn.title     = 'Show this file in Explorer';
      openBtn.addEventListener('click', () => electron.invoke('shell:openFolder', f.path));

      row.appendChild(cb);
      row.appendChild(pathSpan);
      row.appendChild(meta);
      row.appendChild(openBtn);
      filesDiv.appendChild(row);
    });

    div.appendChild(hdr);
    div.appendChild(filesDiv);
    dupResultsList.appendChild(div);
  });

  if (totalGroups > RENDER_LIMIT) {
    const notice = document.createElement('div');
    notice.className   = 'dup-no-results';
    notice.style.color = 'var(--warn)';
    notice.textContent =
      `Showing ${RENDER_LIMIT} of ${totalGroups} groups. ` +
      `Trash the checked items above, then re-scan to see the rest.`;
    dupResultsList.appendChild(notice);
  }

  updateDupCheckboxStates();
  updateTrashBtn();
}

function onDupCheckChange(e) {
  const gi = parseInt(e.target.dataset.gi);
  const fi = parseInt(e.target.dataset.fi);
  dupGroups[gi].files[fi].checked = e.target.checked;
  updateDupCheckboxStates();
  updateTrashBtn();
}

// Ensures at least one file per group can never be checked (i.e. must always
// have one survivor). Disables unchecked boxes when only one live file remains.
function updateDupCheckboxStates() {
  dupGroups.forEach((group, gi) => {
    const live         = group.files.filter((f) => !f.trashed);
    const checkedCount = live.filter((f) => f.checked).length;
    const atLimit      = checkedCount >= live.length - 1;

    group.files.forEach((f, fi) => {
      if (f.trashed) return;
      const cb = document.querySelector(`.dup-file-check[data-gi="${gi}"][data-fi="${fi}"]`);
      if (!cb) return;
      cb.disabled = !f.checked && atLimit;
    });
  });
}

// Recount only groups that still have 2+ live files and update the header text.
function refreshDupSummary() {
  const activeGroups = dupGroups.filter((g) => g.files.filter((f) => !f.trashed).length >= 2);
  if (activeGroups.length === 0) {
    dupSummary.textContent = 'Results — all resolved';
    return;
  }
  const counts = { exact: 0, samename: 0, similar: 0 };
  for (const g of activeGroups) counts[g.type]++;
  const parts = [];
  if (counts.exact    > 0) parts.push(`${counts.exact} exact`);
  if (counts.samename > 0) parts.push(`${counts.samename} same-name`);
  if (counts.similar  > 0) parts.push(`${counts.similar} similar`);
  dupSummary.textContent = `${activeGroups.length} group(s)  —  ${parts.join(', ')}`;
}

function updateTrashBtn() {
  const totalChecked = dupGroups.reduce(
    (sum, g) => sum + g.files.filter((f) => f.checked && !f.trashed).length, 0
  );
  trashCheckedBtn.disabled = totalChecked === 0;
  invertDupSelBtn.disabled = dupGroups.length === 0;
}

invertDupSelBtn.addEventListener('click', () => {
  dupGroups.forEach((group, gi) => {
    const live = group.files.filter((f) => !f.trashed);
    live.forEach((f) => { f.checked = !f.checked; });
    // Safety: if all live files ended up checked, uncheck the last one
    if (live.every((f) => f.checked)) live[live.length - 1].checked = false;
    // Sync DOM checkboxes
    group.files.forEach((f, fi) => {
      if (f.trashed) return;
      const cb = document.querySelector(`.dup-file-check[data-gi="${gi}"][data-fi="${fi}"]`);
      if (cb) cb.checked = f.checked;
    });
  });
  updateDupCheckboxStates();
  updateTrashBtn();
});

trashCheckedBtn.addEventListener('click', async () => {
  const toTrash = [];
  dupGroups.forEach((group, gi) => {
    group.files.forEach((f, fi) => {
      if (f.checked && !f.trashed) toTrash.push({ filePath: f.path, gi, fi });
    });
  });
  if (toTrash.length === 0) return;

  trashCheckedBtn.disabled = true;
  invertDupSelBtn.disabled = true;

  // Results are returned in the same order as the sent paths — match by index.
  const results = await electron.invoke('duplicates:trash', toTrash.map((t) => t.filePath));

  let freedBytes = 0;
  let trashedCount = 0;
  toTrash.forEach(({ filePath, gi, fi }, idx) => {
    const r = results[idx];
    if (r?.success) {
      freedBytes += dupGroups[gi].files[fi].size || 0;
      trashedCount++;
      dupGroups[gi].files[fi].trashed = true;
      dupGroups[gi].files[fi].checked = false;
      const row = document.querySelector(`.dup-file-row[data-gi="${gi}"][data-fi="${fi}"]`);
      if (row) row.classList.add('trashed');
      appendLog(`  TRASHED: ${filePath}`, 'success');
    } else {
      appendLog(`  FAILED:  ${filePath}  (${r?.error || 'unknown error'})`, 'error');
    }
  });
  if (trashedCount > 0) {
    appendLog(`${trashedCount} file(s) trashed — ${formatBytes(freedBytes)} freed`, 'success');
  }

  // Update group headers; hide groups that no longer have 2+ live files
  dupGroups.forEach((group, gi) => {
    const live    = group.files.filter((f) => !f.trashed);
    const groupEl = document.querySelector(`.dup-group[data-gi="${gi}"]`);
    if (!groupEl) return;
    if (live.length < 2) {
      groupEl.classList.add('hidden');
    } else {
      const totalSize = live.reduce((s, f) => s + f.size, 0);
      const info = groupEl.querySelector('.dup-group-info');
      if (info) info.textContent = `${live.length} files · ${formatBytes(totalSize)}`;
    }
  });

  refreshDupSummary();
  updateDupCheckboxStates();
  updateTrashBtn();
});

// ── Fix the Library tab ───────────────────────────────────────────────────────

function setFixProgress(current, total, phase) {
  fixProgressWrap.classList.remove('hidden');

  if (total === 0) {
    // Indeterminate: scanning with unknown total — animate via CSS width bounce
    fixProgressFill.style.width = '100%';
    fixProgressFill.style.opacity = '0.5';
    fixProgressLabel.textContent = phase === 'deleteEmpty'
      ? `Scanning… (${current} folder(s) checked)`
      : `Scanning… (${current} folder(s) found)`;
    fixEtaLabel.textContent = '';
    return;
  }

  fixProgressFill.style.opacity = '1';
  const pct = Math.round((current / total) * 100);
  fixProgressFill.style.width = `${pct}%`;
  fixProgressLabel.textContent = `${current} / ${total}`;

  // ETA
  if (current > 0 && fixStart > 0) {
    const elapsed   = Date.now() - fixStart;
    const msPerItem = elapsed / current;
    const remaining = total - current;
    const etaMs     = remaining * msPerItem;
    fixEtaLabel.textContent = etaMs < 2000 ? '' : `ETA: ${formatDuration(etaMs)}`;
  } else {
    fixEtaLabel.textContent = '';
  }
}

electron.on('flatten:progress', ({ current, total, phase }) => {
  setFixProgress(current, total, phase);
});

browseFixBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    fixFolder = folder;
    fixFolderPathEl.value = folder;
    scanFixBtn.disabled         = false;
    scanBundlesBtn.disabled     = false;
    scanExtFoldersBtn.disabled  = false;
    deleteEmptyBtn.disabled     = false;
    fixPreviewPanel.classList.add('hidden');
    fixPreview = [];
    document.querySelectorAll('.tab-preset-btn[data-target="fixFolderPath"]')
      .forEach((b) => b.classList.remove('active'));
  }
});

// ── Scan ──────────────────────────────────────────────────────────────────────

scanFixBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing) return;

  isFixing    = true;
  fixPreview  = [];
  fixStart    = Date.now();

  scanFixBtn.disabled     = true;
  cancelFixBtn.disabled   = false;
  applyFixBtn.disabled    = true;
  browseFixBtn.disabled   = true;
  deleteEmptyBtn.disabled = true;
  fixPreviewPanel.classList.add('hidden');
  fixProgressWrap.classList.add('hidden');
  fixProgressFill.style.width = '0%';
  fixProgressFill.style.opacity = '1';
  fixProgressLabel.textContent = '';
  fixEtaLabel.textContent = '';
  setTabsDisabled(true);
  logContainer.innerHTML = '';

  await electron.invoke('flatten:scan', { folder: fixFolder });
  // Result arrives via 'flatten:scanComplete'
});

cancelFixBtn.addEventListener('click', () => {
  electron.invoke('flatten:cancel');
  electron.invoke('unwrap:cancel');
  electron.invoke('folderpack:cancel');
});

// ── Render preview ────────────────────────────────────────────────────────────

function renderFixPreview(groups) {
  fixGroupList.innerHTML = '';

  if (groups.length === 0) {
    fixGroupList.innerHTML =
      '<p style="color:var(--text-dim);font-size:.85rem;padding:8px 0">No flattenable folders found — library looks clean.</p>';
    applyFixBtn.disabled = true;
    return;
  }

  const FIX_RENDER_LIMIT = 500;
  const toRender         = groups.slice(0, FIX_RENDER_LIMIT);

  for (const group of toRender) {
    const row = document.createElement('div');
    row.className = 'fix-group-row';
    row.dataset.outerRel = group.outerRel;

    // Checkbox
    const cb = document.createElement('input');
    cb.type      = 'checkbox';
    cb.className = 'fix-check';
    cb.checked   = true;
    cb.title     = 'Include in flatten';

    // Paths column
    const paths = document.createElement('div');
    paths.className = 'fix-group-paths';

    const sep     = group.outerRel.includes('/') ? '/' : '\\';
    const nowFull  = group.outerRel + sep + group.innerName + sep;
    const afterFull = group.outerRel + sep;
    const itemLabel = group.itemCount === 1 ? '1 item' : `${group.itemCount} items`;

    const nowLine = document.createElement('div');
    nowLine.className = 'fix-group-line fix-group-line-now';
    const nowLabel = document.createElement('span');
    nowLabel.className = 'fix-group-line-label';
    nowLabel.textContent = 'Now:';
    const nowPath = document.createElement('span');
    nowPath.className = 'fix-group-line-path';
    nowPath.textContent = nowFull;
    nowPath.title = nowFull + '  (' + itemLabel + ')';
    nowLine.appendChild(nowLabel);
    nowLine.appendChild(nowPath);

    const afterLine = document.createElement('div');
    afterLine.className = 'fix-group-line fix-group-line-after';
    const afterLabel = document.createElement('span');
    afterLabel.className = 'fix-group-line-label';
    afterLabel.textContent = 'After:';
    const afterPath = document.createElement('span');
    afterPath.className = 'fix-group-line-path';
    afterPath.textContent = afterFull + '  (' + itemLabel + ' moved here)';
    afterPath.title = afterFull;
    afterLine.appendChild(afterLabel);
    afterLine.appendChild(afterPath);

    paths.appendChild(nowLine);
    paths.appendChild(afterLine);

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'fix-group-actions';

    const openBtn = document.createElement('button');
    openBtn.className   = 'fix-row-open';
    openBtn.textContent = 'Open Folder';
    openBtn.title       = 'Open ' + group.outerRel + ' in Explorer';
    openBtn.addEventListener('click', () => {
      // Use absolute outer path if available, otherwise reconstruct
      const absPath = group.outer || (fixFolder + sep + group.outerRel);
      electron.invoke('shell:openPath', absPath);
    });

    const flattenBtn = document.createElement('button');
    flattenBtn.className   = 'fix-row-flatten';
    flattenBtn.textContent = 'Flatten';
    flattenBtn.title       = 'Flatten this folder now';
    flattenBtn.addEventListener('click', async () => {
      if (isFixing) return;
      fixAppliedRels      = [group.outerRel];
      isFixing            = true;
      fixStart            = Date.now();
      scanFixBtn.disabled     = true;
      cancelFixBtn.disabled   = false;
      applyFixBtn.disabled    = true;
      browseFixBtn.disabled   = true;
      deleteEmptyBtn.disabled = true;
      fixProgressWrap.classList.add('hidden');
      fixProgressFill.style.width = '0%';
      fixProgressFill.style.opacity = '1';
      fixProgressLabel.textContent = '';
      fixEtaLabel.textContent = '';
      setTabsDisabled(true);
      logContainer.innerHTML  = '';
      // Disable all row buttons while running
      fixGroupList.querySelectorAll('.fix-row-flatten').forEach((b) => (b.disabled = true));
      await electron.invoke('flatten:apply', { folder: fixFolder, selectedOuterRels: [group.outerRel] });
    });

    actions.appendChild(openBtn);
    actions.appendChild(flattenBtn);

    row.appendChild(cb);
    row.appendChild(paths);
    row.appendChild(actions);
    fixGroupList.appendChild(row);
  }

  if (groups.length > FIX_RENDER_LIMIT) {
    const notice = document.createElement('p');
    notice.style.cssText = 'color:var(--warn);font-size:.85rem;padding:8px 0';
    notice.textContent   =
      `Showing ${FIX_RENDER_LIMIT} of ${groups.length} entries. ` +
      `Apply to process these, then re-scan for the rest.`;
    fixGroupList.appendChild(notice);
  }

  applyFixBtn.disabled = false;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Select-all checkbox
fixSelectAll.addEventListener('change', () => {
  fixGroupList.querySelectorAll('.fix-check').forEach((cb) => {
    cb.checked = fixSelectAll.checked;
  });
  applyFixBtn.disabled = !fixSelectAll.checked ||
    fixGroupList.querySelectorAll('.fix-check').length === 0;
});

// Update select-all when individual rows change
fixGroupList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('fix-check')) return;
  const all     = fixGroupList.querySelectorAll('.fix-check');
  const checked = [...all].filter((cb) => cb.checked);
  fixSelectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  fixSelectAll.checked = checked.length === all.length;
  applyFixBtn.disabled = checked.length === 0;
});

// ── Apply ─────────────────────────────────────────────────────────────────────

applyFixBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing || fixPreview.length === 0) return;

  const selectedOuterRels = [];
  fixGroupList.querySelectorAll('.fix-group-row').forEach((row) => {
    const cb = row.querySelector('.fix-check');
    if (cb && cb.checked) selectedOuterRels.push(row.dataset.outerRel);
  });

  if (selectedOuterRels.length === 0) return;

  fixAppliedRels      = selectedOuterRels;
  isFixing            = true;
  fixStart            = Date.now();

  scanFixBtn.disabled     = true;
  cancelFixBtn.disabled   = false;
  applyFixBtn.disabled    = true;
  browseFixBtn.disabled   = true;
  deleteEmptyBtn.disabled = true;
  fixProgressWrap.classList.add('hidden');
  fixProgressFill.style.width = '0%';
  fixProgressFill.style.opacity = '1';
  fixProgressLabel.textContent = '';
  fixEtaLabel.textContent = '';
  setTabsDisabled(true);
  logContainer.innerHTML  = '';
  fixGroupList.querySelectorAll('.fix-row-flatten').forEach((b) => (b.disabled = true));

  await electron.invoke('flatten:apply', { folder: fixFolder, selectedOuterRels });
  // Result arrives via 'flatten:applyComplete'
});

// ── IPC listeners ─────────────────────────────────────────────────────────────

electron.on('flatten:log', ({ msg, type, path }) => {
  appendLog(msg, type, path || null);
});

electron.on('flatten:scanComplete', (result) => {
  isFixing = false;
  fixProgressWrap.classList.add('hidden');

  scanFixBtn.disabled     = !fixFolder;
  cancelFixBtn.disabled   = true;
  browseFixBtn.disabled   = false;
  deleteEmptyBtn.disabled = !fixFolder;
  setTabsDisabled(false);

  if (result.aborted) {
    appendLog('Scan cancelled.', 'warn');
    return;
  }

  fixPreview = result.preview;

  const { preview, journalsDeleted } = result;
  const noun = preview.length === 1 ? 'folder' : 'folders';
  fixPreviewSummary.textContent =
    `${preview.length} ${noun} to flatten` +
    (journalsDeleted > 0 ? ` · ${journalsDeleted} journal file(s) deleted` : '');

  fixSelectAll.checked = true;
  fixSelectAll.indeterminate = false;
  renderFixPreview(preview);
  fixPreviewPanel.classList.remove('hidden');
});

electron.on('flatten:applyComplete', (result) => {
  isFixing = false;
  fixProgressWrap.classList.add('hidden');

  scanFixBtn.disabled     = !fixFolder;
  cancelFixBtn.disabled   = true;
  browseFixBtn.disabled   = false;
  deleteEmptyBtn.disabled = !fixFolder;
  setTabsDisabled(false);

  appendLog(
    result.aborted
      ? 'Flatten cancelled.'
      : `Done: ${result.flattened} folder(s) flattened` +
        (result.failed > 0 ? `, ${result.failed} had conflicts (see log above)` : '') + '.',
    result.aborted ? 'warn' : result.failed > 0 ? 'warn' : 'success'
  );

  // Remove only rows that were successfully flattened.
  // Rows with conflicts stay in the list so the user can Open Folder and investigate.
  if (!result.aborted) {
    const successSet  = new Set(result.flattenedRels || []);
    const conflictSet = new Set(result.failedRels    || []);

    [...fixGroupList.querySelectorAll('.fix-group-row')].forEach((row) => {
      const rel = row.dataset.outerRel;
      if (successSet.has(rel)) {
        row.remove();
      } else if (conflictSet.has(rel)) {
        // Keep row but mark it and re-enable its buttons for manual review
        row.style.borderColor = 'var(--warn)';
        const flattenBtns = row.querySelectorAll('.fix-row-flatten');
        flattenBtns.forEach((b) => { b.disabled = false; b.textContent = 'Retry'; });
        const nowPath = row.querySelector('.fix-group-line-now .fix-group-line-path');
        if (nowPath) {
          nowPath.style.color = 'var(--warn)';
          nowPath.title = nowPath.title + '  ⚠ Conflicts — open folder to review';
        }
      }
    });
    fixPreview = fixPreview.filter((g) => !successSet.has(g.outerRel));
  }
  fixAppliedRels = [];

  // Re-enable row flatten buttons on remaining rows
  fixGroupList.querySelectorAll('.fix-row-flatten').forEach((b) => (b.disabled = false));

  // Update summary or hide panel if nothing remains
  const remaining = fixGroupList.querySelectorAll('.fix-group-row').length;
  if (remaining === 0) {
    fixPreviewPanel.classList.add('hidden');
    fixPreview = [];
  } else {
    const noun = remaining === 1 ? 'folder' : 'folders';
    fixPreviewSummary.textContent = `${remaining} ${noun} remaining`;
    applyFixBtn.disabled = fixGroupList.querySelectorAll('.fix-check:checked').length === 0;
  }
});

// ── Delete Empty Folders ─────────────────────────────────────────────────────

deleteEmptyBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing) return;

  isFixing = true;
  fixStart = Date.now();
  scanFixBtn.disabled      = true;
  cancelFixBtn.disabled    = false;
  applyFixBtn.disabled     = true;
  browseFixBtn.disabled    = true;
  deleteEmptyBtn.disabled  = true;
  fixProgressWrap.classList.add('hidden');
  fixProgressFill.style.width = '0%';
  fixProgressFill.style.opacity = '1';
  fixProgressLabel.textContent = '';
  fixEtaLabel.textContent = '';
  setTabsDisabled(true);
  logContainer.innerHTML   = '';

  await electron.invoke('flatten:deleteEmpty', { folder: fixFolder });
  // Result arrives via 'flatten:deleteEmptyComplete'
});

electron.on('flatten:deleteEmptyComplete', (result) => {
  isFixing = false;
  fixProgressWrap.classList.add('hidden');

  scanFixBtn.disabled     = !fixFolder;
  cancelFixBtn.disabled   = true;
  browseFixBtn.disabled   = false;
  deleteEmptyBtn.disabled = !fixFolder;
  setTabsDisabled(false);

  const deletedCount = result.deleted ? result.deleted.length : 0;
  appendLog(
    result.aborted
      ? 'Delete empty folders cancelled.'
      : deletedCount === 0
        ? 'No empty folders found.'
        : 'Deleted ' + deletedCount + ' empty folder(s).',
    result.aborted ? 'warn' : 'success'
  );
});

// ── Bundle Unwrap ─────────────────────────────────────────────────────────────

function setBundleBusy(busy) {
  isFixing                    = busy;
  scanFixBtn.disabled         = busy || !fixFolder;
  scanBundlesBtn.disabled     = busy || !fixFolder;
  scanExtFoldersBtn.disabled  = busy || !fixFolder;
  deleteEmptyBtn.disabled     = busy || !fixFolder;
  cancelFixBtn.disabled       = !busy;
  browseFixBtn.disabled       = busy;
  applyUnwrapBtn.disabled     = busy;
  applyExtConvertBtn.disabled = busy;
  applyExtRenameBtn.disabled  = busy;
  setTabsDisabled(busy);
  if (busy) {
    fixProgressWrap.classList.add('hidden');
    fixProgressFill.style.width   = '0%';
    fixProgressFill.style.opacity = '1';
    fixProgressLabel.textContent  = '';
    fixEtaLabel.textContent       = '';
  }
}

scanBundlesBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing) return;

  fixStart      = Date.now();
  bundlePreview = [];
  bundlePreviewPanel.classList.add('hidden');
  bundleDeletionPanel.classList.add('hidden');
  logContainer.innerHTML = '';
  setBundleBusy(true);

  await electron.invoke('unwrap:scan', { folder: fixFolder });
});

electron.on('unwrap:log', ({ msg, type, path: p }) => {
  appendLog(msg, type, p || null);
});

electron.on('folderpack:log', ({ msg, type, path: p }) => {
  appendLog(msg, type, p || null);
});

electron.on('unwrap:progress', ({ current, total }) => {
  setFixProgress(current, total, 'scan');
});

electron.on('unwrap:scanComplete', (result) => {
  setBundleBusy(false);
  fixProgressWrap.classList.add('hidden');

  if (result.aborted) {
    appendLog('Bundle scan cancelled.', 'warn');
    return;
  }

  bundlePreview = result.preview || [];
  renderBundlePreview(bundlePreview);
  bundlePreviewPanel.classList.remove('hidden');
});

function renderBundlePreview(groups) {
  bundleGroupList.innerHTML = '';

  if (groups.length === 0) {
    bundlePreviewSummary.textContent = 'Bundle Preview';
    bundleGroupList.innerHTML =
      '<p style="color:var(--text-dim);font-size:.85rem;padding:8px 0">No bundle CBZs found — all CBZs contain only images.</p>';
    applyUnwrapBtn.disabled = true;
    return;
  }

  bundlePreviewSummary.textContent = `${groups.length} bundle CBZ(s) to unwrap`;

  for (const group of groups) {
    const row = document.createElement('div');
    row.className = 'fix-group-row';
    row.dataset.cbzPath = group.cbzPath;

    const cb = document.createElement('input');
    cb.type      = 'checkbox';
    cb.className = 'fix-check';
    cb.checked   = true;

    const paths = document.createElement('div');
    paths.className = 'fix-group-paths';

    const nowLine = document.createElement('div');
    nowLine.className = 'fix-group-line fix-group-line-now';
    const nowLabel = document.createElement('span');
    nowLabel.className   = 'fix-group-line-label';
    nowLabel.textContent = 'Now:';
    const nowPath = document.createElement('span');
    nowPath.className   = 'fix-group-line-path';
    nowPath.textContent = group.cbzRel;
    nowPath.title       = group.cbzRel + '  (' + group.archiveCount + ' archive(s) inside, ' + group.totalEntries + ' total entries)';
    nowLine.appendChild(nowLabel);
    nowLine.appendChild(nowPath);

    const afterLine = document.createElement('div');
    afterLine.className = 'fix-group-line fix-group-line-after';
    const afterLabel = document.createElement('span');
    afterLabel.className   = 'fix-group-line-label';
    afterLabel.textContent = 'After:';
    const afterPath = document.createElement('span');
    afterPath.className   = 'fix-group-line-path';
    afterPath.textContent = group.previewTargetRel + '\\';
    afterPath.title       = 'Extracted here (folder may be renamed if it already exists)';
    afterLine.appendChild(afterLabel);
    afterLine.appendChild(afterPath);

    paths.appendChild(nowLine);
    paths.appendChild(afterLine);

    const actions = document.createElement('div');
    actions.className = 'fix-group-actions';

    const openBtn = document.createElement('button');
    openBtn.className   = 'fix-row-open';
    openBtn.textContent = 'Open Folder';
    openBtn.title       = 'Open containing folder in Explorer';
    openBtn.addEventListener('click', () => {
      electron.invoke('shell:openFolder', group.cbzPath);
    });

    actions.appendChild(openBtn);
    row.appendChild(cb);
    row.appendChild(paths);
    row.appendChild(actions);
    bundleGroupList.appendChild(row);
  }

  applyUnwrapBtn.disabled = false;
}

// Select-all for bundle list
bundleSelectAll.addEventListener('change', () => {
  bundleGroupList.querySelectorAll('.fix-check').forEach((cb) => {
    cb.checked = bundleSelectAll.checked;
  });
  applyUnwrapBtn.disabled = !bundleSelectAll.checked ||
    bundleGroupList.querySelectorAll('.fix-check').length === 0;
});

bundleGroupList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('fix-check')) return;
  const all     = bundleGroupList.querySelectorAll('.fix-check');
  const checked = [...all].filter((cb) => cb.checked);
  bundleSelectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  bundleSelectAll.checked       = checked.length === all.length;
  applyUnwrapBtn.disabled       = checked.length === 0;
});

applyUnwrapBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing || bundlePreview.length === 0) return;

  const selectedCbzPaths = [];
  bundleGroupList.querySelectorAll('.fix-group-row').forEach((row) => {
    const cb = row.querySelector('.fix-check');
    if (cb && cb.checked) selectedCbzPaths.push(row.dataset.cbzPath);
  });
  if (selectedCbzPaths.length === 0) return;

  fixStart = Date.now();
  logContainer.innerHTML = '';
  setBundleBusy(true);

  await electron.invoke('unwrap:apply', { folder: fixFolder, selectedCbzPaths });
});

electron.on('unwrap:applyComplete', (result) => {
  setBundleBusy(false);
  fixProgressWrap.classList.add('hidden');

  if (result.aborted) {
    appendLog('Unwrap cancelled.', 'warn');
    return;
  }

  appendLog(
    `Done: ${result.unwrapped} bundle(s) extracted` +
    (result.failed > 0 ? `, ${result.failed} failed (see log above)` : '') + '.',
    result.failed > 0 ? 'warn' : 'success'
  );

  bundlePreviewPanel.classList.add('hidden');
  bundlePreview = [];

  if (result.extracted && result.extracted.length > 0) {
    bundleExtracted = result.extracted;
    renderBundleDeletion(bundleExtracted);
    bundleDeletionPanel.classList.remove('hidden');
  }
});

function renderBundleDeletion(extracted) {
  bundleDeletionList.innerHTML = '';
  bundleDeletionSummary.textContent =
    `${extracted.length} bundle(s) extracted — review and delete originals`;

  for (const item of extracted) {
    const row = document.createElement('div');
    row.className = 'bundle-deletion-row';
    row.dataset.cbzPath = item.cbzPath;

    const info = document.createElement('div');
    info.className = 'bundle-deletion-info';

    const file = document.createElement('span');
    file.className   = 'bundle-deletion-file';
    file.textContent = item.cbzRel;
    file.title       = item.cbzPath;

    const dest = document.createElement('span');
    dest.className   = 'bundle-deletion-dest';
    dest.textContent = '→ ' + item.targetFolderRel + '\\';
    dest.title       = item.targetFolder;

    info.appendChild(file);
    info.appendChild(dest);

    const actions = document.createElement('div');
    actions.className = 'fix-group-actions';

    const openBtn = document.createElement('button');
    openBtn.className   = 'fix-row-open';
    openBtn.textContent = 'Open Folder';
    openBtn.title       = 'Open extracted folder in Explorer';
    openBtn.addEventListener('click', () => {
      electron.invoke('shell:openPath', item.targetFolder);
    });

    const delBtn = document.createElement('button');
    delBtn.className   = 'bundle-del-btn';
    delBtn.textContent = 'Delete Original';
    delBtn.title       = 'Send original CBZ to Recycle Bin';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const result = await electron.invoke('unwrap:deleteOriginal', item.cbzPath);
      if (result.success) {
        appendLog(`  Deleted: ${item.cbzRel}`, 'success');
        row.classList.add('trashed');
        setTimeout(() => row.remove(), 400);
        bundleExtracted = bundleExtracted.filter((e) => e.cbzPath !== item.cbzPath);
        if (bundleExtracted.length === 0) bundleDeletionPanel.classList.add('hidden');
      } else {
        appendLog(`  Failed to delete: ${item.cbzRel}  (${result.error})`, 'error');
        delBtn.disabled = false;
      }
    });

    actions.appendChild(openBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    bundleDeletionList.appendChild(row);
  }
}

deleteAllOriginalsBtn.addEventListener('click', async () => {
  if (bundleExtracted.length === 0) return;
  deleteAllOriginalsBtn.disabled = true;

  for (const item of [...bundleExtracted]) {
    const row = bundleDeletionList.querySelector(`[data-cbz-path="${CSS.escape(item.cbzPath)}"]`);
    const result = await electron.invoke('unwrap:deleteOriginal', item.cbzPath);
    if (result.success) {
      appendLog(`  Deleted: ${item.cbzRel}`, 'success');
      if (row) { row.classList.add('trashed'); setTimeout(() => row.remove(), 400); }
      bundleExtracted = bundleExtracted.filter((e) => e.cbzPath !== item.cbzPath);
    } else {
      appendLog(`  Failed to delete: ${item.cbzRel}  (${result.error})`, 'error');
    }
  }

  if (bundleExtracted.length === 0) bundleDeletionPanel.classList.add('hidden');
  else deleteAllOriginalsBtn.disabled = false;
});

// ── Scan Ext-Folders ──────────────────────────────────────────────────────────

electron.on('folderpack:progress', ({ current, total }) => {
  setFixProgress(current, total, 'scan');
});

electron.on('folderpack:scanComplete', (result) => {
  setBundleBusy(false);
  fixProgressWrap.classList.add('hidden');

  if (result.aborted) {
    appendLog('Ext-folder scan cancelled.', 'warn');
    return;
  }

  extConvertGroups = result.convertGroups || [];
  extRenameGroups  = result.renameGroups  || [];

  renderExtConvert(extConvertGroups);
  renderExtRename(extRenameGroups);

  if (extConvertGroups.length > 0) extConvertPanel.classList.remove('hidden');
  else                              extConvertPanel.classList.add('hidden');

  if (extRenameGroups.length > 0) extRenamePanel.classList.remove('hidden');
  else                            extRenamePanel.classList.add('hidden');

  if (extConvertGroups.length === 0 && extRenameGroups.length === 0) {
    appendLog('No ext-named folders found.', 'info');
  }
});

electron.on('folderpack:convertComplete', (result) => {
  setBundleBusy(false);
  fixProgressWrap.classList.add('hidden');

  if (result.aborted) {
    appendLog('Conversion cancelled.', 'warn');
    return;
  }

  appendLog(
    `Done: ${result.converted} folder(s) converted` +
    (result.failed > 0 ? `, ${result.failed} failed (see log above)` : '') + '.',
    result.failed > 0 ? 'warn' : 'success'
  );

  extConvertPanel.classList.add('hidden');
  extConvertGroups = [];

  if (result.convertedItems && result.convertedItems.length > 0) {
    extConverted = result.convertedItems;
    renderExtDeletion(extConverted);
    extDeletionPanel.classList.remove('hidden');
  }
});

electron.on('folderpack:renameComplete', (result) => {
  setBundleBusy(false);
  appendLog(
    `Done: ${result.renamed} folder(s) renamed` +
    (result.failed > 0 ? `, ${result.failed} failed (see log above)` : '') + '.',
    result.failed > 0 ? 'warn' : 'success'
  );
  extRenamePanel.classList.add('hidden');
  extRenameGroups = [];
});

scanExtFoldersBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing) return;

  fixStart         = Date.now();
  extConvertGroups = [];
  extRenameGroups  = [];
  extConverted     = [];
  extConvertPanel.classList.add('hidden');
  extRenamePanel.classList.add('hidden');
  extDeletionPanel.classList.add('hidden');
  logContainer.innerHTML = '';

  setBundleBusy(true);
  cancelFixBtn.disabled = false;

  fixProgressWrap.classList.remove('hidden');
  fixProgressFill.style.width  = '0%';
  fixProgressLabel.textContent = 'Scanning…';
  fixEtaLabel.textContent      = '';

  const result = await electron.invoke('folderpack:scan', { folder: fixFolder });
  if (!result) setBundleBusy(false);
});

// Render Category A (convert) preview
function renderExtConvert(groups) {
  extConvertList.innerHTML = '';

  if (groups.length === 0) {
    extConvertSummary.textContent = 'Convert to CBZ';
    applyExtConvertBtn.disabled = true;
    return;
  }

  extConvertSummary.textContent = `${groups.length} folder(s) to convert to CBZ`;

  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'fix-group-row';
    row.dataset.folderPath = g.folderPath;

    const cb = document.createElement('input');
    cb.type      = 'checkbox';
    cb.className = 'fix-check';
    cb.checked   = true;

    const info = document.createElement('div');
    info.className = 'fix-group-info';

    const from = document.createElement('span');
    from.className   = 'fix-group-from';
    from.textContent = g.folderRel + '\\';

    const arrow = document.createTextNode(' → ');

    const to = document.createElement('span');
    to.className   = 'fix-group-to';
    to.textContent = g.targetRel;

    if (g.conflict) {
      const warn = document.createElement('span');
      warn.className   = 'fix-conflict-badge';
      warn.textContent = ' ⚠ target exists — will use alternate name';
      to.appendChild(warn);
    }

    const meta = document.createElement('span');
    meta.className   = 'fix-group-meta';
    meta.textContent = `  ${g.imageCount} image(s)` + (g.hasSubdirs ? ' + subfolders' : '');

    info.appendChild(from);
    info.appendChild(arrow);
    info.appendChild(to);
    info.appendChild(meta);

    const openBtn = document.createElement('button');
    openBtn.className   = 'fix-row-open';
    openBtn.textContent = 'Open Folder';
    openBtn.addEventListener('click', () => electron.invoke('shell:openPath', g.folderPath));

    row.appendChild(cb);
    row.appendChild(info);
    row.appendChild(openBtn);
    extConvertList.appendChild(row);
  }

  applyExtConvertBtn.disabled = false;
}

// Render Category B (rename) preview
function renderExtRename(groups) {
  extRenameList.innerHTML = '';

  if (groups.length === 0) {
    extRenameSummary.textContent = 'Rename Folders';
    applyExtRenameBtn.disabled = true;
    return;
  }

  extRenameSummary.textContent = `${groups.length} folder(s) to rename (strip extension)`;

  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'fix-group-row';
    row.dataset.folderPath = g.folderPath;

    const info = document.createElement('div');
    info.className = 'fix-group-info';

    const from = document.createElement('span');
    from.className   = 'fix-group-from';
    from.textContent = g.folderRel + '\\';

    const arrow = document.createTextNode(' → ');

    const to = document.createElement('span');
    to.className   = 'fix-group-to';
    to.textContent = g.targetRel + '\\';

    if (g.conflict) {
      const warn = document.createElement('span');
      warn.className   = 'fix-conflict-badge';
      warn.textContent = ' ⚠ target exists — will use alternate name';
      to.appendChild(warn);
    }

    info.appendChild(from);
    info.appendChild(arrow);
    info.appendChild(to);

    const openBtn = document.createElement('button');
    openBtn.className   = 'fix-row-open';
    openBtn.textContent = 'Open Folder';
    openBtn.addEventListener('click', () => electron.invoke('shell:openPath', g.folderPath));

    row.appendChild(info);
    row.appendChild(openBtn);
    extRenameList.appendChild(row);
  }

  applyExtRenameBtn.disabled = false;
}

// Render post-convert deletion panel
function renderExtDeletion(items) {
  extDeletionList.innerHTML = '';
  extDeletionSummary.textContent = `${items.length} folder(s) converted — review and delete originals`;

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'bundle-deletion-row';
    row.dataset.folderPath = item.folderPath;

    const info = document.createElement('div');
    info.className = 'bundle-deletion-info';

    const file = document.createElement('span');
    file.className   = 'bundle-deletion-file';
    file.textContent = item.folderRel + '\\';

    const dest = document.createElement('span');
    dest.className   = 'bundle-deletion-dest';
    dest.textContent = '→ ' + (item.outputPaths || []).map((p) => p.replace(/.*[\\/]/, '')).join(', ');

    info.appendChild(file);
    info.appendChild(document.createTextNode(' '));
    info.appendChild(dest);

    const actions = document.createElement('div');
    actions.className = 'fix-group-actions';

    const openBtn = document.createElement('button');
    openBtn.className   = 'fix-row-open';
    openBtn.textContent = 'Open Folder';
    openBtn.addEventListener('click', () => electron.invoke('shell:openPath', item.folderPath));

    const delBtn = document.createElement('button');
    delBtn.className   = 'bundle-del-btn';
    delBtn.textContent = 'Delete Folder';
    delBtn.addEventListener('click', async () => {
      delBtn.disabled = true;
      const result = await electron.invoke('folderpack:deleteFolder', item.folderPath);
      if (result.success) {
        appendLog(`  Deleted: ${item.folderRel}`, 'success');
        row.classList.add('trashed');
        setTimeout(() => row.remove(), 400);
        extConverted = extConverted.filter((e) => e.folderPath !== item.folderPath);
        if (extConverted.length === 0) extDeletionPanel.classList.add('hidden');
      } else {
        appendLog(`  Failed to delete: ${item.folderRel}  (${result.error})`, 'error');
        delBtn.disabled = false;
      }
    });

    actions.appendChild(openBtn);
    actions.appendChild(delBtn);
    row.appendChild(info);
    row.appendChild(actions);
    extDeletionList.appendChild(row);
  }
}

// Select-all for ext-convert list
extConvertSelectAll.addEventListener('change', () => {
  extConvertList.querySelectorAll('.fix-check').forEach((cb) => {
    cb.checked = extConvertSelectAll.checked;
  });
  applyExtConvertBtn.disabled = !extConvertSelectAll.checked ||
    extConvertList.querySelectorAll('.fix-check').length === 0;
});

extConvertList.addEventListener('change', (e) => {
  if (!e.target.classList.contains('fix-check')) return;
  const all     = extConvertList.querySelectorAll('.fix-check');
  const checked = [...all].filter((cb) => cb.checked);
  extConvertSelectAll.indeterminate = checked.length > 0 && checked.length < all.length;
  extConvertSelectAll.checked       = checked.length === all.length;
  applyExtConvertBtn.disabled       = checked.length === 0;
});

applyExtConvertBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing || extConvertGroups.length === 0) return;

  const selectedFolderPaths = [];
  extConvertList.querySelectorAll('.fix-group-row').forEach((row) => {
    const cb = row.querySelector('.fix-check');
    if (cb?.checked) selectedFolderPaths.push(row.dataset.folderPath);
  });

  if (selectedFolderPaths.length === 0) return;

  fixStart = Date.now();
  setBundleBusy(true);
  cancelFixBtn.disabled = false;
  fixProgressWrap.classList.remove('hidden');
  fixProgressFill.style.width  = '0%';
  fixProgressLabel.textContent = 'Converting…';
  fixEtaLabel.textContent      = '';

  await electron.invoke('folderpack:convert', { folder: fixFolder, selectedFolderPaths });
});

applyExtRenameBtn.addEventListener('click', async () => {
  if (!fixFolder || isFixing || extRenameGroups.length === 0) return;

  setBundleBusy(true);
  cancelFixBtn.disabled = false;

  const selectedFolderPaths = extRenameGroups.map((g) => g.folderPath);
  await electron.invoke('folderpack:rename', { folder: fixFolder, selectedFolderPaths });
});

deleteAllExtFoldersBtn.addEventListener('click', async () => {
  if (extConverted.length === 0) return;
  deleteAllExtFoldersBtn.disabled = true;

  for (const item of [...extConverted]) {
    const row = extDeletionList.querySelector(`[data-folder-path="${CSS.escape(item.folderPath)}"]`);
    const result = await electron.invoke('folderpack:deleteFolder', item.folderPath);
    if (result.success) {
      appendLog(`  Deleted: ${item.folderRel}`, 'success');
      if (row) { row.classList.add('trashed'); setTimeout(() => row.remove(), 400); }
      extConverted = extConverted.filter((e) => e.folderPath !== item.folderPath);
    } else {
      appendLog(`  Failed to delete: ${item.folderRel}  (${result.error})`, 'error');
    }
  }

  if (extConverted.length === 0) extDeletionPanel.classList.add('hidden');
  else deleteAllExtFoldersBtn.disabled = false;
});
