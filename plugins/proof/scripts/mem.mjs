#!/usr/bin/env node
// proof memory: how much of the machine's memory is in use, what is using it (Claude's own processes versus your
// other apps), and whether there is room for a heavy job. The hooks use it to keep the machine under its ceiling
// (90% by default); on its own it prints a summary:
//   node mem.mjs [--json] [--need MB]
// Machine-wide settings live in ~/.config/proof/machine.json (all optional):
//   { "memoryWarnPercent": 75, "memoryCeilingPercent": 90, "keepAwake": true,
//     "dashboardPort": 47331, "autoOpenDashboard": true, "autoOpenAfterMinutes": 45 }
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_MAC = process.platform === 'darwin';
export const MACHINE = IS_MAC ? 'Mac' : 'machine';     // how messages refer to this computer
// Where proof keeps its state. Hooks get CLAUDE_PLUGIN_DATA; commands run through Claude's shell don't, so the
// hooks pass the same folder on as PROOF_DATA_DIR.
export const dataDir = () => process.env.PROOF_DATA_DIR || process.env.CLAUDE_PLUGIN_DATA || join(os.tmpdir(), 'proof-plugin');

export function machineConfig() {
  let file = {};
  try { file = JSON.parse(readFileSync(join(os.homedir(), '.config', 'proof', 'machine.json'), 'utf8')); } catch {}
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  const env = process.env;
  return {
    warnPct: num(env.PROOF_MEMORY_WARN_PERCENT ?? file.memoryWarnPercent, 75),
    ceilingPct: num(env.PROOF_MEMORY_CEILING_PERCENT ?? file.memoryCeilingPercent, 90),
    keepAwake: (env.PROOF_KEEP_AWAKE ?? file.keepAwake ?? true) !== false && env.PROOF_KEEP_AWAKE !== '0',
    port: num(env.PROOF_DASHBOARD_PORT ?? file.dashboardPort, 47331),
    autoOpen: (file.autoOpenDashboard ?? true) !== false && env.PROOF_AUTO_OPEN !== '0',
    autoOpenAfterMin: num(file.autoOpenAfterMinutes, 45),
    admitWaitS: num(env.PROOF_ADMIT_WAIT ?? file.admitWaitSeconds, 180),
  };
}

const run = (cmd, args, max = 32) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: max * 2 ** 20, stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });

// ---- the machine ------------------------------------------------------------------------------------------------------

// macOS reports memory the way Activity Monitor does: "Memory Used" = app memory (anonymous pages that can't be
// purged) + wired + compressed. Cached files don't count; macOS drops them when it needs room.
export function parseVmStat(text) {
  const page = Number((text.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const get = name => Number(((text.match(new RegExp(`${name}:\\s+(\\d+)`)) || [])[1]) || 0);
  const anon = get('Anonymous pages'), purgeable = get('Pages purgeable'), wired = get('Pages wired down');
  const compressed = get('Pages occupied by compressor'), fileBacked = get('File-backed pages'), free = get('Pages free');
  const mb = p => (p * page) / 2 ** 20;
  return { appMB: mb(Math.max(0, anon - purgeable)), wiredMB: mb(wired), compressedMB: mb(compressed), cachedMB: mb(fileBacked + purgeable), freeMB: mb(free) };
}

export function parseMeminfo(text) {
  const kb = k => Number(((text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm')) || [])[1]) || 0);
  const total = kb('MemTotal') / 1024, avail = kb('MemAvailable') / 1024;
  return { totalMB: total, usedMB: Math.max(0, total - avail), swapMB: (kb('SwapTotal') - kb('SwapFree')) / 1024 };
}

export function readSystem() {
  if (process.env.PROOF_FAKE_MEM) {                       // tests: {"totalMB":24576,"usedMB":20000}
    try {
      const f = JSON.parse(process.env.PROOF_FAKE_MEM.startsWith('{') ? process.env.PROOF_FAKE_MEM : readFileSync(process.env.PROOF_FAKE_MEM, 'utf8'));
      return finish({ platform: 'fake', pressure: null, swapMB: 0, ...f });
    } catch {}
  }
  try {
    if (IS_MAC) {
      const v = parseVmStat(run('vm_stat', []));
      const totalMB = Number(run('sysctl', ['-n', 'hw.memsize']).trim()) / 2 ** 20;
      let swapMB = 0, level = 0;
      try { swapMB = Number((run('sysctl', ['-n', 'vm.swapusage']).match(/used = ([\d.]+)M/) || [])[1]) || 0; } catch {}
      try { level = Number(run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim()); } catch {}
      return finish({ platform: 'darwin', totalMB, usedMB: v.appMB + v.wiredMB + v.compressedMB, ...v, swapMB, pressure: level === 4 ? 'critical' : level === 2 ? 'warn' : level === 1 ? 'normal' : null });
    }
    // Windows: Node reads GlobalMemoryStatusEx, so total minus available is Task Manager's "In use" (plus the small
    // modified list). Windows reports no swap or pressure level that maps onto macOS's.
    if (process.platform === 'win32') {
      const totalMB = os.totalmem() / 2 ** 20;
      return finish({ platform: 'win32', totalMB, usedMB: totalMB - os.freemem() / 2 ** 20, pressure: null, swapMB: 0 });
    }
    return finish({ platform: process.platform, pressure: null, ...parseMeminfo(readFileSync('/proc/meminfo', 'utf8')) });
  } catch {
    const totalMB = os.totalmem() / 2 ** 20;
    return finish({ platform: process.platform, totalMB, usedMB: totalMB - os.freemem() / 2 ** 20, pressure: null, swapMB: 0, rough: true });
  }
}

function finish(s) {
  const cfg = machineConfig();
  s.pct = s.totalMB ? (100 * s.usedMB) / s.totalMB : 0;
  s.warnPct = cfg.warnPct; s.ceilingPct = cfg.ceilingPct;
  s.headroomMB = (cfg.ceilingPct / 100) * s.totalMB - s.usedMB;      // room left before the ceiling
  s.strain = strain(s);
  return s;
}

// The used percentage alone can look calm while the machine is struggling: macOS keeps "used" down by compressing
// memory and swapping it to disk, which slows everything. Its own pressure level says when that is happening.
// Swap on its own stays high long after the pressure has passed, so it is reported, not acted on.
function strain(s) {
  const swap = s.swapMB >= 1024 ? `${gb(s.swapMB)} is swapped to disk` : '';
  if (s.pressure === 'critical' || s.pressure === 'warn') return `macOS reports ${s.pressure === 'critical' ? 'critical' : 'raised'} memory pressure${swap ? ` and ${swap}` : ''}: it is compressing and swapping memory to keep up, which slows every build.`;
  return '';
}

// ---- processes --------------------------------------------------------------------------------------------------------

export function parseEtime(e) {
  const m = String(e).trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  return (((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3])) * 60 + Number(m[4])) * 1000;
}

export function readProcesses() {
  if (process.platform === 'win32') return readWinProcesses();
  let out = '';
  try { out = run('ps', ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,rss=,etime=,command=']); } catch { return []; }
  const now = Date.now();
  const fp = IS_MAC ? readFootprints() : new Map();
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) list.push({ pid: +m[1], ppid: +m[2], pgid: +m[3], mb: fp.get(+m[1]) ?? +m[4] / 1024, start: now - parseEtime(m[5]), command: m[6] });
  }
  return list;
}

// macOS: each process's memory as Activity Monitor counts it (phys_footprint: what it holds in RAM plus what has been
// compressed or swapped out, without shared pages). Resident size from ps misses swapped memory and double-counts
// shared memory. top reports phys_footprint for every process in one call.
export function parseTopMem(text) {
  const out = new Map();
  const unit = { B: 1 / 2 ** 20, K: 1 / 1024, M: 1, G: 1024, T: 2 ** 20 };
  for (const line of String(text).split('\n')) {
    const m = line.trim().match(/^(\d+)\s+([\d.]+)([BKMGT])[+-]?$/);
    if (m) out.set(+m[1], Number(m[2]) * unit[m[3]]);
  }
  return out;
}

function readFootprints() {
  try { return parseTopMem(run('top', ['-l', '1', '-s', '0', '-stats', 'pid,mem'])); } catch { return new Map(); }
}

// Windows has no ps. PowerShell lists every process with its private working set, the figure Task Manager's Memory
// column shows (the working set where that counter is missing). Windows has no process groups, so each process is
// its own. Output: [{ p: pid, pp: parent pid, m: bytes, c: command line, n: name, t: start time in ms }]. System
// processes with no command line (Registry, Memory Compression) are labelled by their name as it is.
const WIN_PS = [
  "$ErrorActionPreference = 'SilentlyContinue'; $ws = @{}",
  "Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -ne '_Total' -and $_.IDProcess -gt 0 } | ForEach-Object { $ws[[int]$_.IDProcess] = [long]$_.WorkingSetPrivate }",
  "Get-CimInstance Win32_Process | ForEach-Object { $id = [int]$_.ProcessId; [pscustomobject]@{ p = $id; pp = [int]$_.ParentProcessId; m = $(if ($ws.ContainsKey($id)) { $ws[$id] } else { [long]$_.WorkingSetSize }); c = $(if ($_.CommandLine) { $_.CommandLine } else { [string]$_.ExecutablePath }); n = $_.Name; t = $(if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }) } } | ConvertTo-Json -Compress",
].join('; ');

export function parseWinProcs(text) {
  let rows = JSON.parse(text);
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const now = Date.now();
  return rows.filter(r => r && Number(r.p) > 0).map(r => ({ pid: +r.p, ppid: +r.pp || 0, pgid: +r.p, mb: (Number(r.m) || 0) / 2 ** 20, start: Number(r.t) || now, command: String(r.c || r.n || ''), ...(!r.c && r.n ? { label: String(r.n) } : {}) }));
}

function readWinProcesses() {
  try { return parseWinProcs(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_PS], 64)); } catch { return []; }
}

// Claude Code itself: the CLI (native or npm build), not the desktop app.
export const isClaudeCli = c => !/\.app\//.test(c) && /(^|[\/\\])claude(\.exe)?("|\s|$)|@anthropic-ai[\\/]claude-code|claude-code[\\/]cli\.js|\/claude\/versions\/[^/\s]+(\s|$)/.test(c);
const isShell = c => /shell-snapshots|^(\/bin\/)?(ba|z)?sh -c|[\\/]bash\.exe"? -c/i.test(c);

// Group a process under the app a person would recognise.
export function appName(command) {
  const c = String(command);
  if (isClaudeCli(c)) return 'Claude Code';
  if (/Simulator\.app\/|CoreSimulator|launchd_sim|SimulatorTrampoline|\/Devices\/[0-9A-F-]{36}\/data\//.test(c)) return 'iOS Simulator';
  if (/qemu-system|emulator64|\/emulator\/emulator/.test(c)) return 'Android Emulator';
  if (/com\.docker|Docker\.app|Docker Desktop|vpnkit|docker-desktop/.test(c)) return 'Docker';
  if (/com\.apple\.Virtualization\.VirtualMachine/.test(c)) return 'Virtual machines (Docker, OrbStack…)';
  if (/OrbStack/.test(c)) return 'OrbStack';
  const app = c.match(/\/([^/]+)\.app\//);
  if (app) return app[1];
  const exe = c.match(/^"?(?:[A-Za-z]:\\[^"]*?\\)?([^\\/"\s]+)\.exe\b/i);   // Windows: "C:\...\node.exe" args, or node.exe
  const bin = exe ? exe[1] : basename(c.split(/\s+/)[0] || '');
  if (/^(node|bun|deno)$/.test(bin)) {
    if (/expo|metro/.test(c)) return 'Expo / Metro';
    if (/next[\s/]/.test(c)) return 'Next.js';
    if (/vite/.test(c)) return 'Vite';
    if (/jest/.test(c)) return 'Jest';
    if (/playwright|@playwright/.test(c)) return 'Playwright';
    if (/tsserver|typescript/.test(c)) return 'TypeScript server';
    if (/eslint/.test(c)) return 'ESLint';
    if (/mcp/.test(c)) return 'MCP servers';
    return 'Node';
  }
  if (/headless_shell|chrome-headless|Chromium|ms-playwright/.test(c)) return 'Playwright';
  if (/^java$/.test(bin) && /gradle/i.test(c)) return 'Gradle';
  if (/^(postgres|postmaster)$/.test(bin)) return 'Postgres';
  if (/^(python[\d.]*|pytest)$/.test(bin)) return /pytest/.test(c) ? 'pytest' : 'Python';
  return bin || '?';
}

// Which processes Claude Code started: everything below a Claude Code process, split into what its Bash tool ran
// (stoppable) and its own servers (MCP, hooks). Processes that outlived their shell count when they still carry
// Claude Code's environment (best effort; macOS shows it only for your own processes).
export function claudeTree(procs, { env = false } = {}) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); }
  const sessions = procs.filter(p => isClaudeCli(p.command) && !isClaudeCli(byPid.get(p.ppid)?.command || ''));
  const ran = new Map();      // pid -> { session, viaShell }
  const walk = (p, session, viaShell) => {
    for (const k of kids.get(p.pid) || []) {
      if (isClaudeCli(k.command)) continue;                 // a nested Claude Code is its own session
      const shell = viaShell || isShell(k.command);
      ran.set(k.pid, { session: session.pid, viaShell: shell });
      walk(k, session, shell);
    }
  };
  for (const s of sessions) walk(s, s, false);
  if (env) for (const pid of claudeEnvPids()) if (byPid.has(pid) && !ran.has(pid) && !isClaudeCli(byPid.get(pid).command)) ran.set(pid, { session: null, viaShell: true, orphan: true });
  return { sessions, ran };
}

function claudeEnvPids() {
  try {
    if (IS_MAC) {
      const out = run('ps', ['-A', '-E', '-ww', '-o', 'pid=,command='], 64);
      return out.split('\n').filter(l => /\sCLAUDECODE=1(\s|$)/.test(l)).map(l => Number(l.trim().split(/\s+/)[0]));
    }
    return readdirSync('/proc').filter(d => /^\d+$/.test(d)).filter(d => {
      try { return readFileSync(`/proc/${d}/environ`, 'utf8').split('\0').includes('CLAUDECODE=1'); } catch { return false; }
    }).map(Number);
  } catch { return []; }
}

// Working folder of each Claude Code session, so its processes can be named by worktree.
export function cwdOf(pids) {
  const out = new Map();
  if (!pids.length) return out;
  try {
    if (IS_MAC) {
      let pid = null;
      for (const l of run('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]).split('\n')) {
        if (l[0] === 'p') pid = Number(l.slice(1)); else if (l[0] === 'n' && pid) out.set(pid, l.slice(1));
      }
    } else for (const p of pids) { try { out.set(p, readlinkSync(`/proc/${p}/cwd`)); } catch {} }
  } catch {}
  return out;
}

// Everything the dashboard and the hooks need, in one pass.
export function snapshot({ env = false } = {}) {
  const system = readSystem();
  const procs = readProcesses();
  const { sessions, ran } = claudeTree(procs, { env });
  const cwds = cwdOf(sessions.map(s => s.pid));
  const apps = new Map();
  for (const p of procs) {
    const name = p.label || appName(p.command);
    const claude = ran.has(p.pid) || name === 'Claude Code';
    const key = `${claude ? 'c' : 'o'}|${name}`;
    const e = apps.get(key) || { name, mb: 0, n: 0, claude };
    e.mb += p.mb; e.n++;
    apps.set(key, e);
  }
  // Claude's stoppable runs: process groups started through its Bash tool, newest first.
  const groups = new Map();
  const self = procs.find(p => p.pid === process.pid);
  for (const p of procs) {
    const r = ran.get(p.pid);
    if (!r || !r.viaShell || isShell(p.command) || (self && p.pgid === self.pgid)) continue;
    const g = groups.get(p.pgid) || { pgid: p.pgid, pid: p.pid, mb: 0, start: p.start, command: p.command, session: r.session, cwd: cwds.get(r.session) || null };
    g.mb += p.mb;
    if (p.start < g.start) { g.start = p.start; g.pid = p.pid; g.command = p.command; }
    groups.set(p.pgid, g);
  }
  return {
    at: Date.now(), system,
    apps: [...apps.values()].sort((a, b) => b.mb - a.mb),
    sessions: sessions.map(s => ({ pid: s.pid, mb: s.mb, cwd: cwds.get(s.pid) || null, start: s.start })),
    runs: [...groups.values()].filter(g => g.mb >= 50).sort((a, b) => b.start - a.start),
  };
}

// ---- advice -----------------------------------------------------------------------------------------------------------

export const gb = mb => (Math.abs(mb) >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);
const short = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const where = cwd => (cwd ? ` in ${cwd.split('/').slice(-1)[0]}` : '');

// What to say when memory is tight: Claude's own processes it can stop, and the apps you could close, framed by
// what closing them buys (speed), never as an instruction to close them for you.
export function advice(snap, needMB = 0) {
  const s = snap.system;
  const lines = [`Memory: ${gb(s.usedMB)} of ${gb(s.totalMB)} used (${s.pct.toFixed(0)}%); proof keeps it under ${s.ceilingPct}% (${gb((s.ceilingPct / 100) * s.totalMB)}).${needMB ? ` This job needs about ${gb(needMB)}; ${s.headroomMB > 0 ? `${gb(s.headroomMB)} is left` : 'there is no room left'}.` : ''}${s.strain ? ` ${s.strain}` : ''}`];
  const mine = snap.runs.slice(0, 6);
  if (mine.length) {
    lines.push('Claude\'s own processes you may no longer need (stop the ones you aren\'t using; never kill another session\'s run):');
    for (const r of mine) lines.push(`  - ${short(r.command)}${where(r.cwd)} — ${gb(r.mb)}, pid ${r.pid} (stop: kill ${r.pid})`);
  }
  const others = snap.apps.filter(a => !a.claude && a.mb >= 400 && !/^(kernel_task|WindowServer|launchd|Finder|Dock|loginwindow|mds_stores|mds|corespotlightd|Spotlight)$/.test(a.name)).slice(0, 5);
  if (others.length) {
    const free = others.slice(0, 2).reduce((n, a) => n + a.mb, 0);
    lines.push(`Your other apps holding the most memory: ${others.map(a => `${a.name} ${gb(a.mb)}`).join(', ')}.`);
    lines.push(`Tell the user (don't close them yourself): closing ${others.slice(0, 2).map(a => a.name).join(' and ')} would free about ${gb(free)}, so checks and agents can run side by side instead of waiting their turn, and macOS stops compressing and swapping memory, which slows every build.`);
  }
  return { text: lines.join('\n'), userApps: others, claudeRuns: mine };
}

// ---- learned peaks ----------------------------------------------------------------------------------------------------

export const DEFAULT_NEED = { test: 1500, e2e: 1800, build: 2500, devserver: 1200, simulator: 3000, docker: 2500, browser: 700, fidelity: 900, subagent: 1200, check: 1500, wait: 0 };
const peaksFile = () => join(dataDir(), 'peaks.json');
export const peakKey = (root, cmd) => `${root || ''}|${String(cmd).replace(/\s+/g, ' ').replace(/'[^']*'|"[^"]*"/g, '…').replace(/(^|\s)\/\S+/g, '$1…').split(' ').slice(0, 4).join(' ')}`;

export function readPeaks() { try { return JSON.parse(readFileSync(peaksFile(), 'utf8')); } catch { return {}; } }

export function learnPeak(key, kind, mb, root) {
  if (!(mb > 0)) return;
  try {
    const all = readPeaks();
    const e = all[key] || { mb: 0, n: 0, kind, root };
    e.mb = Math.max(mb, e.n >= 5 ? e.mb * 0.9 : e.mb);       // slowly forget an old record
    e.n++; e.at = Date.now(); e.kind = kind; e.root = root;
    all[key] = e;
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(peaksFile(), JSON.stringify(all));
  } catch {}
}

export function expectedNeed(kind, key, root) {
  const all = readPeaks();
  if (all[key]) return Math.round(all[key].mb * 1.15);
  const same = Object.values(all).filter(e => e.kind === kind && e.root === root).map(e => e.mb);
  if (same.length) return Math.round(Math.max(...same) * 1.15);
  return DEFAULT_NEED[kind] ?? 1000;
}

// ---- runs Claude started under the guard (so the newest can be stopped first) ---------------------------------------

const runsDir = () => join(dataDir(), 'runs');
export function registerRun(pgid, info) {
  try { mkdirSync(runsDir(), { recursive: true }); writeFileSync(join(runsDir(), `${pgid}.json`), JSON.stringify({ pgid, ...info })); } catch {}
}
export function unregisterRun(pgid) { try { unlinkSync(join(runsDir(), `${pgid}.json`)); } catch {} }
export function liveRuns() {
  const out = [];
  let files = [];
  try { files = readdirSync(runsDir()); } catch { return out; }
  for (const f of files) {
    try {
      const r = JSON.parse(readFileSync(join(runsDir(), f), 'utf8'));
      try { process.kill(-r.pgid, 0); out.push(r); } catch (e) { if (e.code === 'EPERM') out.push(r); else unregisterRun(r.pgid); }
    } catch {}
  }
  return out.sort((a, b) => b.start - a.start);
}

// ---- events Claude should hear about (the next hook passes them on) --------------------------------------------------

const eventsFile = () => join(dataDir(), 'memory-events.jsonl');
export function logEvent(ev) {
  try { mkdirSync(dataDir(), { recursive: true }); writeFileSync(eventsFile(), `${JSON.stringify({ t: Date.now(), ...ev })}\n`, { flag: 'a' }); } catch {}
}
export function recentEvents(sinceMs) {
  try {
    return readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(e => e.t > sinceMs);
  } catch { return []; }
}

// ---- admission --------------------------------------------------------------------------------------------------------

// The monitor writes a reading every 2 seconds; use it while it's fresh instead of asking the system again.
export function readSystemFast() {
  if (!process.env.PROOF_FAKE_MEM) {
    try {
      const j = JSON.parse(readFileSync(join(dataDir(), 'memory-now.json'), 'utf8'));
      if (Date.now() - j.t < 5000 && j.totalMB) return finish({ pressure: null, swapMB: 0, ...j, platform: process.platform });
    } catch {}
  }
  return readSystem();
}

// Can a job that needs `needMB` start now without taking the machine past the ceiling? Critical memory pressure
// also says no, whatever the percentage: the machine is already swapping hard.
export function admit(needMB) {
  const s = readSystemFast();
  const after = s.usedMB + needMB;
  const limit = (s.ceilingPct / 100) * s.totalMB;
  const critical = s.pressure === 'critical';
  return { ok: after <= limit && !critical, critical: critical && after <= limit, warn: s.pct >= s.warnPct || after > (s.warnPct / 100) * s.totalMB || !!s.pressure && s.pressure !== 'normal', system: s, needMB };
}

// ---- CLI --------------------------------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const i = process.argv.indexOf('--need');
  const need = i > -1 ? Number(process.argv[i + 1]) || 0 : 0;
  const snap = snapshot({ env: true });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(snap, null, 2)); process.exit(0); }
  const a = advice(snap, need);
  console.log(a.text);
  console.log(`\nBiggest users: ${snap.apps.slice(0, 8).map(x => `${x.name}${x.claude ? ' (Claude)' : ''} ${gb(x.mb)}`).join(', ')}`);
  if (snap.sessions.length) console.log(`Claude Code sessions: ${snap.sessions.length} (${snap.sessions.map(s => `${s.cwd ? s.cwd.split('/').pop() : s.pid} ${gb(s.mb)}`).join(', ')})`);
  if (snap.system.rough) console.log('(Rough reading: the precise memory tools were unavailable.)');
}

export { statSync };
