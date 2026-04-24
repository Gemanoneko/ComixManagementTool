'use strict';
/**
 * Shared execFile helper.
 *
 * Every child process in this app (7-Zip, ImageMagick, …) is spawned through
 * execFilePromise.  Having a single wrapper instead of five drifting copies
 * means:
 *   • abort-signal handling is uniform (every call can be cancelled)
 *   • child processes run at below-normal priority so foreground apps
 *     (games, browsers) are never starved by a long pack or resize
 *   • maxBuffer defaults are consistent (512 MB — large CBZ listings)
 *
 * Signature:  execFilePromise(cmd, args, signal?, execOpts?)
 *   cmd       – absolute path or PATH-resolved name
 *   args      – argv array (never a shell string)
 *   signal    – optional AbortSignal; on abort the child is killed and the
 *               promise rejects with { name: 'AbortError' }
 *   execOpts  – merged into Node's execFile options (cwd, env, windowsHide, …)
 *               maxBuffer defaults to 512 MB but may be overridden.
 */

const { execFile } = require('child_process');
const os = require('os');

function execFilePromise(cmd, args, signal, execOpts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 1024 * 1024 * 512, ...execOpts },
      (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr }));
        else     resolve({ stdout, stderr });
      }
    );
    // Run at below-normal priority so games and other foreground apps
    // are never starved by ImageMagick / 7-Zip workers.
    try {
      os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch { /* ignore — not all platforms support this */ }

    if (signal) {
      if (signal.aborted) {
        try { child.kill(); } catch {}
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        return;
      }
      const onAbort = () => {
        try { child.kill(); } catch {}
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

module.exports = { execFilePromise };
