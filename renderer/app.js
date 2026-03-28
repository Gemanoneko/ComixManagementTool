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

let sortSourceFolder = null;
let sortTargetFolder = null;
let isSorting        = false;
let isSortPaused     = false;

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

// ── Tab switching ─────────────────────────────────────────────────────────────
tabBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    if (isConverting || isResizing || isSorting) return;
    tabBtns.forEach((b) => b.classList.remove('active'));
    tabPanes.forEach((p) => p.classList.add('hidden'));
    btn.classList.add('active');
    document.getElementById(`tab-${btn.dataset.tab}`).classList.remove('hidden');
  });
});

function setTabsDisabled(disabled) {
  tabBtns.forEach((b) => (b.disabled = disabled));
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
  document.querySelectorAll('.preset-btn').forEach((b) => (b.disabled = true));
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
  document.querySelectorAll('.preset-btn').forEach((b) => (b.disabled = false));
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
function appendLog(msg, type = 'info') {
  const placeholder = logContainer.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();

  if (type === 'header') {
    logContainer.querySelectorAll('.log-progress-line')
      .forEach((s) => s.classList.remove('log-progress-line'));
  }

  const span = document.createElement('span');
  span.className = `log-${type}`;
  span.textContent = msg + '\n';
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
