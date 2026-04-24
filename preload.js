const { contextBridge, ipcRenderer } = require('electron');

// ── IPC allowlist ──────────────────────────────────────────────────────────
// Only channels explicitly registered here may be invoked from the renderer.
// Enumerated from `ipcMain.handle(...)` / `ipcMain.on(...)` in main.js and
// `ipcMain.handle(...)` in src/updater.js.  Unknown channels throw so the
// mistake surfaces loudly rather than silently failing in the renderer.
//
// Defence-in-depth: Electron is sandboxed (contextIsolation on, no
// nodeIntegration, CSP allows only 'self'+'data:'), but a future regression
// (DOM injection, dependency with XSS, bad copy-paste) becomes significantly
// less dangerous when `electron.invoke('conversion:deleteOriginals', [...])`
// can only be called on channels we actually handle on the main side.
const INVOKE_CHANNELS = new Set([
  // updater (src/updater.js)
  'check-update', 'download-update', 'install-update',
  // main.js — app / settings / dialog
  'app:version', 'settings:get', 'settings:set', 'dialog:openFolder',
  // main.js — conversion
  'conversion:start', 'conversion:pause', 'conversion:resume',
  'conversion:cancel', 'conversion:convertSingle', 'conversion:deleteOriginals',
  // main.js — sort
  'sort:start', 'sort:pause', 'sort:resume', 'sort:choice', 'sort:cancel',
  // main.js — shell
  'shell:openFolder', 'shell:openPath',
  // main.js — resize
  'resize:start', 'resize:pause', 'resize:resume', 'resize:cancel',
  'resize:confirm', 'resize:discard',
  // main.js — duplicates
  'duplicates:scan', 'duplicates:cancel', 'duplicates:trash',
  // main.js — flatten
  'flatten:scan', 'flatten:apply', 'flatten:cancel', 'flatten:deleteEmpty',
  // main.js — unwrap
  'unwrap:scan', 'unwrap:apply', 'unwrap:cancel', 'unwrap:deleteOriginal',
  // main.js — folder-packer
  'folderpack:scan', 'folderpack:convert', 'folderpack:rename',
  'folderpack:cancel', 'folderpack:deleteFolder',
]);

// Channels the main process sends TO the renderer.  Only channels that the
// renderer is allowed to subscribe to are listed.  `removeAllListeners`
// honours the same set.
const ON_CHANNELS = new Set([
  // conversion
  'conversion:log', 'conversion:logUpdate', 'conversion:progress',
  'conversion:complete',
  // sort
  'sort:log', 'sort:ambiguous', 'sort:complete',
  // resize
  'resize:log', 'resize:progress', 'resize:complete',
  // duplicates
  'duplicates:log', 'duplicates:progress', 'duplicates:complete',
  // flatten
  'flatten:log', 'flatten:progress', 'flatten:scanComplete',
  'flatten:applyComplete', 'flatten:deleteEmptyComplete',
  // unwrap
  'unwrap:log', 'unwrap:progress', 'unwrap:scanComplete', 'unwrap:applyComplete',
  // folder-packer
  'folderpack:log', 'folderpack:progress', 'folderpack:scanComplete',
  'folderpack:convertComplete', 'folderpack:renameComplete',
  // updater (src/updater.js emits these via _win.webContents.send)
  'update-checking', 'update-available', 'update-not-available',
  'update-progress', 'update-ready', 'update-error',
]);

contextBridge.exposeInMainWorld('electron', {
  invoke: (channel, ...args) => {
    if (!INVOKE_CHANNELS.has(channel)) {
      throw new Error(`blocked IPC channel: ${channel}`);
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, listener) => {
    if (!ON_CHANNELS.has(channel)) {
      throw new Error(`blocked IPC channel: ${channel}`);
    }
    ipcRenderer.on(channel, (_event, ...args) => listener(...args));
  },
  removeAllListeners: (channel) => {
    if (!ON_CHANNELS.has(channel)) {
      throw new Error(`blocked IPC channel: ${channel}`);
    }
    ipcRenderer.removeAllListeners(channel);
  },
});
