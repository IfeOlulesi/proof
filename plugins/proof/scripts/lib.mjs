// Shared helpers for the proof hooks. Node built-ins only.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Files that define the checks. A session that changes one must show the change to the user.
export const PROTECTED = [
  '.claude/proof.json',
  '.claude/settings.json',
  'fidelity/extract-inventory.mjs',
  'fidelity/verify-screen.mjs',
  'fidelity/verify-screen.sh',
];

export const sha = s => createHash('sha256').update(s).digest('hex');

export function fileHash(p) {
  try { return sha(readFileSync(p)); } catch { return null; }
}

export function protectedSnapshot(base) {
  return Object.fromEntries(PROTECTED.map(p => [p, fileHash(join(base, p))]));
}

export function readStdin() {
  try { const s = readFileSync(0, 'utf8'); return s.trim() ? JSON.parse(s) : {}; } catch { return {}; }
}

export function git(args, cwd, env) {
  try { return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}

export const gitRoot = cwd => git(['rev-parse', '--show-toplevel'], cwd);

// Content fingerprint of the working tree: tracked and untracked files, minus ignored ones and .proof/.
// Built in a throwaway copy of the index, so the real index is never touched. Null when it can't be computed,
// in which case nothing is cached.
export function treeFingerprint(root) {
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'proof-idx-'));
    const idx = join(dir, 'index');
    const real = git(['rev-parse', '--git-path', 'index'], root);
    const realAbs = real && (isAbsolute(real) ? real : join(root, real));
    if (realAbs && existsSync(realAbs)) {
      // Keep the index's own mtime on the copy: git compares file mtimes against it to catch "racily clean" files
      // (edited in the same second the index was written). A fresh mtime would hide those edits.
      const s = statSync(realAbs);
      copyFileSync(realAbs, idx);
      utimesSync(idx, s.atime, s.mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: idx };
    execFileSync('git', ['add', '-A', '--', '.', ':(exclude).proof'], { cwd: root, env, stdio: 'ignore' });
    return git(['write-tree'], root, env) || null;
  } catch { return null; }
  finally { if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// Plugin data lives outside projects: per-session state and the cache of passing checks.
// Session state is keyed by session *and* repo, so a session that moves to another repo never reuses the
// first repo's starting point.
export const dataDir = () => process.env.PROOF_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'proof-plugin');
const sessionPath = (id, base) =>
  join(dataDir(), 'sessions', `${String(id || 'none').replace(/[^\w.-]/g, '_')}-${sha(String(base || '')).slice(0, 12)}.json`);

export function loadState(id, base) {
  try { return JSON.parse(readFileSync(sessionPath(id, base), 'utf8')); } catch { return null; }
}

export function saveState(id, base, st) {
  try { mkdirSync(join(dataDir(), 'sessions'), { recursive: true }); writeFileSync(sessionPath(id, base), JSON.stringify(st)); } catch {}
}

export function cacheGet(key, ttlMs) {
  if (!key) return null;
  try {
    const j = JSON.parse(readFileSync(join(dataDir(), 'cache', `${key}.json`), 'utf8'));
    return Date.now() - j.at < ttlMs ? j : null;
  } catch { return null; }
}

export function cachePut(key, value) {
  if (!key) return;
  try {
    mkdirSync(join(dataDir(), 'cache'), { recursive: true });
    writeFileSync(join(dataDir(), 'cache', `${key}.json`), JSON.stringify({ ...value, at: Date.now() }));
  } catch {}
}

export function pruneData(days = 14) {
  const cutoff = Date.now() - days * 864e5;
  for (const sub of ['sessions', 'cache']) {
    try {
      for (const f of readdirSync(join(dataDir(), sub))) {
        const p = join(dataDir(), sub, f);
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      }
    } catch {}
  }
}

export function loadConfig(base) {
  const path = join(base, '.claude', 'proof.json');
  if (!existsSync(path)) return { path, config: null };
  try { return { path, config: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch (e) { return { path, config: null, error: e.message }; }
}
