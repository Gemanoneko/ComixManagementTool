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

// ── DOM refs ─────────────────────────────────────────────────────────────────
const folderPathEl    = document.getElementById('folderPath');
const browseBtn       = document.getElementById('browseBtn');
const startBtn        = document.getElementById('startBtn');
const pauseBtn        = document.getElementById('pauseBtn');
const cancelBtn       = document.getElementById('cancelBtn');
const mangaModeEl     = document.getElementById('mangaMode');
const modeHint        = document.getElementById('modeHint');
const logContainer    = document.getElementById('logContainer');
const clearLogBtn     = document.getElementById('clearLogBtn');
const progressWrap    = document.getElementById('progressWrap');
const progressFill    = document.getElementById('progressFill');
const progressLabel   = document.getElementById('progressLabel');
const etaLabel        = document.getElementById('etaLabel');
const deleteModal     = document.getElementById('deleteModal');
const deleteList      = document.getElementById('deleteList');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const skipDeleteBtn   = document.getElementById('skipDeleteBtn');

// ── Folder selection ─────────────────────────────────────────────────────────
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
  updateSortBtn();
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

  // Reset log
  logContainer.innerHTML = '';
  progressWrap.classList.remove('hidden');
  setProgress(0, 0);

  await electron.invoke('conversion:start', {
    rootFolder: currentFolder,
    isManga: mangaModeEl.checked,
  });
  // Result arrives via the 'conversion:complete' event
}

function resetControls() {
  isConverting = false;
  isPaused = false;
  startBtn.disabled = !currentFolder;
  pauseBtn.disabled = true;
  pauseBtn.textContent = '⏸  Pause';
  cancelBtn.disabled = true;
  browseBtn.disabled = false;
  document.querySelectorAll('.preset-btn').forEach((b) => (b.disabled = false));
}

// ── IPC event handlers ────────────────────────────────────────────────────────
electron.on('conversion:log', ({ msg, type }) => {
  appendLog(msg, type);
});

// Replace the last log line in place (used for PDF page-by-page progress)
electron.on('conversion:logUpdate', ({ msg, type }) => {
  updateLastLog(msg, type);
});

electron.on('conversion:progress', ({ current, total, etaMs }) => {
  setProgress(current, total, etaMs);
});

electron.on('conversion:complete', (result) => {
  resetControls();

  const converted    = result.converted   || [];
  const preExisting  = result.preExisting || [];
  const needsReview  = result.needsReview || [];
  const allDeletable = [...converted, ...preExisting];

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

  const span = document.createElement('span');
  span.className = `log-${type}`;
  span.textContent = msg + '\n';
  logContainer.appendChild(span);
  logContainer.scrollTop = logContainer.scrollHeight;
}

/** Replace the last log span in place — used for live PDF progress updates. */
function updateLastLog(msg, type = 'info') {
  const spans = logContainer.querySelectorAll('span');
  if (spans.length === 0) {
    appendLog(msg, type);
    return;
  }
  const last = spans[spans.length - 1];
  last.className = `log-${type}`;
  last.textContent = msg + '\n';
  logContainer.scrollTop = logContainer.scrollHeight;
}

clearLogBtn.addEventListener('click', () => {
  logContainer.innerHTML = '<span class="log-placeholder">Conversion output will appear here…</span>';
});

// ── Progress bar ──────────────────────────────────────────────────────────────
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
  etaLabel.textContent = current < total && etaMs > 0 ? `ETA: ${formatEta(etaMs)}` : '';
}

function formatEta(ms) {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
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
    if (r.success) {
      appendLog(`  DELETED: ${r.file}`, 'success');
    } else {
      appendLog(`  FAILED:  ${r.file}  (${r.error})`, 'error');
    }
  }
  appendLog('Done.', 'success');
  pendingOriginals = [];
  if (pendingReview.length > 0) {
    appendLog('\nSome files need manual review:', 'warn');
    showNextReview();
  }
});

skipDeleteBtn.addEventListener('click', () => {
  deleteModal.classList.add('hidden');
  appendLog('\nOriginals kept.', 'info');
  pendingOriginals = [];
  if (pendingReview.length > 0) {
    appendLog('\nSome files need manual review:', 'warn');
    showNextReview();
  }
});

// ── Needs-review modal ────────────────────────────────────────────────────────
const reviewModal         = document.getElementById('reviewModal');
const reviewCounter       = document.getElementById('reviewCounter');
const reviewFileEl        = document.getElementById('reviewFile');
const reviewLikelySection = document.getElementById('reviewLikelySection');
const reviewLikelyList    = document.getElementById('reviewLikelyList');
const reviewNoMatch       = document.getElementById('reviewNoMatch');
const reviewStatus        = document.getElementById('reviewStatus');
const reviewKeepBtn       = document.getElementById('reviewKeepBtn');
const reviewDeleteBtn     = document.getElementById('reviewDeleteBtn');
const reviewConvertBtn    = document.getElementById('reviewConvertBtn');
const reviewKeepAllBtn    = document.getElementById('reviewKeepAllBtn');
const reviewDeleteAllBtn  = document.getElementById('reviewDeleteAllBtn');

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
  reviewKeepBtn.disabled      = busy;
  reviewDeleteBtn.disabled    = busy;
  reviewConvertBtn.disabled   = busy;
  reviewKeepAllBtn.disabled   = busy;
  reviewDeleteAllBtn.disabled = busy;
}

reviewKeepBtn.addEventListener('click', () => {
  appendLog(`  KEPT:    ${pendingReview[reviewIndex].file}`, 'info');
  reviewIndex++;
  showNextReview();
});

reviewDeleteBtn.addEventListener('click', async () => {
  const file = pendingReview[reviewIndex].file;
  const results = await electron.invoke('conversion:deleteOriginals', [file]);
  if (results[0].success) {
    appendLog(`  DELETED: ${file}`, 'success');
  } else {
    appendLog(`  FAILED:  ${file}  (${results[0].error})`, 'error');
  }
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
    // Auto-delete the original and advance
    const del = await electron.invoke('conversion:deleteOriginals', [item.file]);
    if (del[0].success) {
      appendLog(`  DELETED original: ${item.file}`, 'success');
    } else {
      appendLog(`  FAILED to delete original: ${del[0].error}`, 'error');
    }
    reviewIndex++;
    showNextReview();
  } else {
    reviewStatus.textContent = 'Conversion failed — see log for details.';
    reviewStatus.className   = 'review-status review-status-error';
    setReviewBusy(false);
    reviewConvertBtn.disabled = true; // don't retry; user can Keep or Delete
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

// ── Sort Comics ───────────────────────────────────────────────────────────────
let sortTargetFolder = null;
let isSorting        = false;

const sortTargetPathEl    = document.getElementById('sortTargetPath');
const browseSortTargetBtn = document.getElementById('browseSortTargetBtn');
const sortBtn             = document.getElementById('sortBtn');
const sortModal           = document.getElementById('sortModal');
const sortModalFile       = document.getElementById('sortModalFile');
const sortModalOptions    = document.getElementById('sortModalOptions');
const sortModalSkipBtn    = document.getElementById('sortModalSkipBtn');

browseSortTargetBtn.addEventListener('click', async () => {
  const folder = await electron.invoke('dialog:openFolder');
  if (folder) {
    sortTargetFolder = folder;
    sortTargetPathEl.value = folder;
    updateSortBtn();
  }
});

function updateSortBtn() {
  sortBtn.disabled = isSorting || !currentFolder || !sortTargetFolder;
}

sortBtn.addEventListener('click', async () => {
  if (!currentFolder || !sortTargetFolder || isSorting) return;

  isSorting = true;
  sortBtn.disabled = true;
  startBtn.disabled = true;
  browseBtn.disabled = true;
  browseSortTargetBtn.disabled = true;
  document.querySelectorAll('.preset-btn').forEach((b) => (b.disabled = true));

  logContainer.innerHTML = '';

  await electron.invoke('sort:start', {
    sourceFolder: currentFolder,
    targetFolder: sortTargetFolder,
  });
  // Result arrives via 'sort:complete'
});

electron.on('sort:log', ({ msg, type }) => {
  appendLog(msg, type);
});

electron.on('sort:ambiguous', ({ file, matches }) => {
  showSortModal(file, matches);
});

electron.on('sort:complete', ({ moved, skipped, manual }) => {
  isSorting = false;
  startBtn.disabled = !currentFolder;
  browseBtn.disabled = false;
  browseSortTargetBtn.disabled = false;
  document.querySelectorAll('.preset-btn').forEach((b) => (b.disabled = false));
  updateSortBtn();

  appendLog('', 'info');
  appendLog(`Sort complete — moved: ${moved}, skipped: ${skipped}, manual: ${manual}`, 'success');
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
