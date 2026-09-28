'use strict';
/**
 * The folder every temp item of this app lives in (extraction folders,
 * resized copies waiting for Replace, 7-Zip listfiles).
 *
 * Everything used to go straight into %TEMP%, and each launch's startup
 * sweep deleted every `cbz_*` item there.  A dev copy (`npm start`) and the
 * installed app — which the single-instance lock does not stop, because they
 * have different userData folders — shared %TEMP%, so starting one deleted
 * the other's in-flight files.  main.js now points this at a folder of its
 * own per userData folder (setTempRoot), and the sweep only looks there.
 *
 * The folder name deliberately does not start with `cbz_`: older versions
 * sweep every `cbz_*` item in %TEMP%, and would delete it whole.
 *
 * Without setTempRoot (plain Node, probes) this is os.tmpdir(), as before.
 */
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const crypto = require('crypto');

let root = null;

/** Name of the per-install folder for a userData path (case-insensitive, as Windows paths are). */
function tempRootFor(userDataPath) {
  const tag = crypto.createHash('sha1').update(path.resolve(userDataPath).toLowerCase()).digest('hex').slice(0, 10);
  return path.join(os.tmpdir(), `ComixManagementTool-${tag}`);
}

function setTempRoot(dir) { root = dir; }

/** The temp folder, created on first use. */
function tempRoot() {
  const dir = root || os.tmpdir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { tempRoot, setTempRoot, tempRootFor };
