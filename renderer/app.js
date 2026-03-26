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

  const converted   = result.converted   || [];
  const preExisting = result.preExisting || [];
  const allDeletable = [...converted, ...preExisting];

  if (allDeletable.length > 0) {
    pendingOriginals = allDeletable;
    showDeleteModal(converted, preExisting);
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
});

skipDeleteBtn.addEventListener('click', () => {
  deleteModal.classList.add('hidden');
  appendLog('\nOriginals kept.', 'info');
  pendingOriginals = [];
});
