#!/usr/bin/env node
// proof — SessionStart hook.
// Puts the operating rules and this project's proof status into Claude's context (on startup, resume, /clear and
// after compaction), and records where the session started: the commit, the time, and the check definitions, so the
// gate can tell what this session changed.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, git, gitRoot, loadConfig, loadState, protectedSnapshot, pruneData, readStdin, saveState } from './lib.mjs';
import { gb, machineConfig, readSystemFast } from './mem.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || resolve(here, '..');
const input = readStdin();
const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const root = gitRoot(cwd);
const base = root || cwd;

if (input.session_id && !loadState(input.session_id, base)) {
  saveState(input.session_id, base, {
    startHead: root ? git(['rev-parse', 'HEAD'], root) : null,
    startTime: Date.now(),
    protectedAtStart: protectedSnapshot(base),
  });
  pruneData();
}

const lines = [];
const { config, error } = loadConfig(base);
if (error) {
  lines.push(`Completion gate: BROKEN — .claude/proof.json is not valid JSON (${error}). Fix it before anything else.`);
} else if (config) {
  const names = (Array.isArray(config.checks) ? config.checks : []).map(c => (typeof c === 'string' ? c : c?.name || c?.run)).filter(Boolean);
  lines.push(`Completion gate: ON — checks: ${names.join(', ') || '(none listed)'}. After each reply that changed files, the relevant ones run (fast variants where configured); before each git commit, they run in full.`);
  if (config.phase) lines.push(`Project phase (from .claude/proof.json): ${config.phase}.`);
} else {
  lines.push(root
    ? 'Completion gate: OFF here (no .claude/proof.json). Before any build work, set it up as the proof:build skill describes.'
    : 'Completion gate: OFF (not a git repository).');
}
lines.push(`To run every check by hand (the baseline at session start, or when asked): node "${join(pluginRoot, 'scripts', 'gate.mjs')}" --run. Otherwise let the gate run them; while fixing a failure, run only the failing test.`);

const found = [];
for (const f of ['SPEC.md', 'PROGRESS.md']) if (existsSync(join(base, f))) found.push(f);
const feat = readJSON(join(base, 'features.json'));
if (feat) {
  const list = Array.isArray(feat) ? feat : Array.isArray(feat.features) ? feat.features : [];
  found.push(`features.json (${list.filter(x => x && x.passes === true).length}/${list.length} passing)`);
}
if (existsSync(join(base, 'mockup'))) found.push('mockup/');
if (existsSync(join(base, 'fidelity', 'inventory'))) found.push('fidelity/ (screen inventories)');
if (found.length) lines.push(`Project state: ${found.join(', ')}. Read what's relevant before starting.`);

// Memory, and the live dashboard (started here if it isn't running).
const mcfg = machineConfig();
try {
  const m = readSystemFast();
  lines.push(`Memory now: ${m.pct.toFixed(0)}% (${gb(m.usedMB)} of ${gb(m.totalMB)}). proof keeps the machine under ${m.ceilingPct}%: heavy runs and new agents wait their turn when there isn't room, and the newest run is stopped if it gets there. To see what is using memory: node "${join(here, 'mem.mjs')}".`);
} catch {}
if (process.env.PROOF_MONITOR !== '0' && !(await monitorUp())) {
  try { spawn(process.execPath, [join(here, 'monitor.mjs'), '--daemon'], { detached: true, stdio: 'ignore', env: { ...process.env, PROOF_DATA_DIR: dataDir() } }).unref(); } catch {}
}
lines.push(`Live dashboard of every session: http://127.0.0.1:${mcfg.port}/ (the proof:watch skill opens it). For work you expect to take more than an hour, open it at the start and keep your task list current, one item per unit, so it shows progress.`);

const rules = readFileSync(join(here, 'rules.md'), 'utf8').trim();
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: `${rules}\n\n${lines.join('\n')}` },
}));

function readJSON(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }

function monitorUp() {
  return new Promise(done => {
    const req = http.get({ host: '127.0.0.1', port: mcfg.port, path: '/health', timeout: 300, headers: { host: `127.0.0.1:${mcfg.port}` } }, res => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { done(!!JSON.parse(b).proof); } catch { done(false); } });
    });
    req.on('timeout', () => { req.destroy(); done(false); });
    req.on('error', () => done(false));
  });
}
