#!/usr/bin/env node
// Keeps only the N most recent GitHub releases for this repo.
// Deletes both the release object and its associated git tag.
// Reads GH_TOKEN from environment (same var electron-builder uses).

const https = require('https');

const OWNER  = 'Gemanoneko';
const REPO   = 'ComixManagementTool';
const KEEP   = 4;
const TOKEN  = process.env.GH_TOKEN;

if (!TOKEN) {
  console.error('cleanup-releases: GH_TOKEN not set — skipping cleanup');
  process.exit(0);
}

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `token ${TOKEN}`,
        'User-Agent':    'comixmanagementtool-cleanup',
        'Accept':        'application/vnd.github+json',
      },
    };
    if (body) opts.headers['Content-Length'] = 0;

    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`${method} ${path} → HTTP ${res.statusCode}: ${data}`));
        } else {
          resolve(data ? JSON.parse(data) : null);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getAllReleases() {
  let page = 1, all = [];
  while (true) {
    const batch = await api('GET', `/repos/${OWNER}/${REPO}/releases?per_page=100&page=${page}`);
    if (!batch || batch.length === 0) break;
    all = all.concat(batch);
    if (batch.length < 100) break;
    page++;
  }
  // GitHub returns newest first; sort explicitly just in case
  all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return all;
}

async function main() {
  console.log(`cleanup-releases: fetching releases for ${OWNER}/${REPO}…`);
  const releases = await getAllReleases();
  console.log(`  found ${releases.length} release(s), keeping ${KEEP}`);

  const toDelete = releases.slice(KEEP);
  if (toDelete.length === 0) {
    console.log('  nothing to delete');
    return;
  }

  for (const r of toDelete) {
    const tag = r.tag_name;
    console.log(`  deleting release "${r.name || tag}" (id ${r.id}, tag ${tag})`);
    await api('DELETE', `/repos/${OWNER}/${REPO}/releases/${r.id}`);
    try {
      await api('DELETE', `/repos/${OWNER}/${REPO}/git/refs/tags/${tag}`);
    } catch (e) {
      console.warn(`  warning: could not delete tag ${tag}: ${e.message}`);
    }
  }

  console.log(`cleanup-releases: done — ${toDelete.length} release(s) removed`);
}

main().catch(e => {
  console.error('cleanup-releases error:', e.message);
  process.exit(1);
});
