#!/usr/bin/env node
// proof — update check.
// Claude Code doesn't auto-update third-party marketplaces unless the user turns it on, so session-start tells Claude
// when a newer proof is released. It reads a cached answer only; when that's a day old it runs this file with
// --refresh in the background, which fetches the released plugin.json from GitHub. Offline, nothing is shown.
// Off with "updateCheck": false in ~/.config/proof/machine.json, or PROOF_UPDATE_CHECK=0.
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './lib.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const here = dirname(fileURLToPath(import.meta.url));
const cacheFile = () => join(dataDir(), 'update-check.json');
const releaseUrl = () => process.env.PROOF_UPDATE_URL || 'https://raw.githubusercontent.com/IfeOlulesi/proof/main/plugins/proof/.claude-plugin/plugin.json';

const readJSON = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

// True when version a is later than b (major.minor.patch; anything after is ignored).
export function newer(a, b) {
  const parts = v => String(v).split(/[.+-]/).slice(0, 3).map(n => parseInt(n, 10) || 0);
  const x = parts(a), y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

// The line for session context when a newer release is known, else null. Starts a background refresh when due.
export function updateNotice(pluginRoot) {
  const cache = readJSON(cacheFile()) || {};
  if (!(Date.now() - (Number(cache.checkedAt) || 0) < DAY_MS)) {
    try { spawn(process.execPath, [join(here, 'updates.mjs'), '--refresh'], { detached: true, stdio: 'ignore', env: { ...process.env, PROOF_DATA_DIR: dataDir() } }).unref(); } catch {}
  }
  const current = readJSON(join(pluginRoot, '.claude-plugin', 'plugin.json'))?.version;
  if (!current || !cache.latest || !newer(cache.latest, current)) return null;
  return `proof update: ${cache.latest} is out (this session runs ${current}). Tell the user once, and offer to run \`claude plugin marketplace update proof && claude plugin update proof@proof\`, then /reload-plugins. To get updates without asking, they can turn on auto-update for the proof marketplace in /plugin → Marketplaces → proof → Enable auto-update.`;
}

async function refresh() {
  const cache = readJSON(cacheFile()) || {};
  let latest = cache.latest ?? null;
  try {
    const res = await fetch(releaseUrl(), { signal: AbortSignal.timeout(5000) });
    const version = res.ok ? (await res.json()).version : null;
    if (/^\d+\.\d+\.\d+/.test(String(version))) latest = version;
  } catch {}
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ checkedAt: Date.now(), latest }));
  } catch {}
}

if (process.argv[2] === '--refresh') await refresh();
