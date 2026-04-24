#!/usr/bin/env node
// Bridges the GitHub PAT from `gh` CLI (Windows Credential Manager / keyring)
// into electron-builder via GH_TOKEN. Invoked by `npm run release`.
// Rationale: Studio Illuminati's Team/Docs/ProcessRules.md — avoids per-machine
// env-var management and lets PAT rotations flow through `gh auth login` alone.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function resolveGhPath() {
  if (process.platform !== 'win32') return 'gh';
  const candidates = [
    `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\GitHub CLI\\gh.exe`,
    `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\GitHub CLI\\gh.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Programs\\GitHub CLI\\gh.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\GitHub CLI\\gh.exe`,
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return 'gh'; // last-ditch fall back to PATH lookup
}

const ghPath = resolveGhPath();
const tokenRun = spawnSync(ghPath, ['auth', 'token'], { encoding: 'utf8' });
if (tokenRun.status !== 0) {
  console.error(`[release] \`${ghPath} auth token\` failed (exit ${tokenRun.status}).`);
  console.error('[release] Is GitHub CLI installed and authenticated? Run `gh auth login` to fix.');
  if (tokenRun.error) console.error(`[release] ${tokenRun.error.message}`);
  if (tokenRun.stderr) console.error(tokenRun.stderr.trim());
  process.exit(1);
}

const token = tokenRun.stdout.trim();
if (!token) {
  console.error('[release] `gh auth token` returned empty output.');
  console.error('[release] Re-authenticate via `gh auth login`.');
  process.exit(1);
}

console.log(`[release] Token sourced from gh CLI (${ghPath}); starting build + publish...`);

const build = spawnSync('npm', ['run', 'build'], {
  env: { ...process.env, GH_TOKEN: token },
  stdio: 'inherit',
  shell: true, // npm on Windows is npm.cmd — needs shell
});
process.exit(build.status ?? 1);
