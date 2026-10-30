#!/usr/bin/env node
// proof guard: run a command under a time limit and memory ceilings, and kill its whole process group when one is
// breached. Enforcement lives in a separate watcher process, so it continues even if this process, or whatever
// launched it, is killed (SIGKILL included), and it also covers anything the command leaves running in the background.
// It also keeps the machine under its memory ceiling: if the machine passes it, the newest guarded run is stopped
// first. And it records how much memory each kind of run needed, so the next one can wait for room.
//
//   node guard.mjs [--timeout 900] [--mem MB] [--proc-mem MB] [--kind test|e2e|build|check|wait] [--data DIR] -- <command>
//     --timeout   seconds before the run is killed (default 900)
//     --mem       ceiling for all of the run's processes together (default: half of RAM)
//     --proc-mem  ceiling for any single process (default: a quarter of RAM)
//     --kind      what the run is; it decides the wording when the run is stopped
//     --need      MB the run is expected to need, held back from other runs' admission until it has started up
//     --hold      the hold its admission made (mem.hold), released once the run is registered
//     --data      proof's state folder (the hooks pass it on; commands run by Claude don't inherit it)
//   Exits with the command's own code, or 124 when the guard stopped it.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const opts = sep < 0 ? argv : argv.slice(0, sep);
const opt = (k, d) => { const i = opts.indexOf(k); return i > -1 && opts[i + 1] != null ? opts[i + 1] : d; };
const num = (k, d) => { const v = Number(opt(k, NaN)); return Number.isFinite(v) && v > 0 ? v : d; };
if (opt('--data')) process.env.PROOF_DATA_DIR = opt('--data');
const mem = await import('./mem.mjs');
const fit = await import('./fit.mjs');
const RAM_MB = os.totalmem() / 2 ** 20;
const timeoutS = num('--timeout', 900);
const memMB = num('--mem', Math.round(RAM_MB / 2));
const procMB = num('--proc-mem', Math.round(RAM_MB / 4));
const kind = opt('--kind', 'other');
const needMB = num('--need', 0);
const ADVICE = 'Find the cause before running it again; running it again won\'t change the result.';

if (opts.includes('--watch')) watch();
else run();

// ---- foreground: run the command, report how it ended -----------------------------------------------------------

function run() {
  if (sep < 0 || sep === argv.length - 1) {
    console.error('usage: node guard.mjs [--timeout s] [--mem MB] [--proc-mem MB] [--kind k] -- <command>');
    process.exit(2);
  }
  const cmd = argv.slice(sep + 1).join(' ');
  const dir = mkdtempSync(join(os.tmpdir(), 'proof-guard-'));
  const root = gitRoot(process.cwd()) || process.cwd();
  const found = fit.findRunner(cmd, root);
  writeFileSync(join(dir, 'info.json'), JSON.stringify({ key: mem.peakKey(root, cmd), kind, root, workers: found ? fit.workersOf(found, cmd) : 0 }));
  // pytest prints every thread's stack once a single test runs past 60s, so a hang names its own line.
  const env = { ...process.env, PYTEST_ADDOPTS: `${process.env.PYTEST_ADDOPTS ?? ''} -o faulthandler_timeout=60`.trim() };
  const child = spawn(cmd, { shell: true, detached: true, stdio: 'inherit', env });   // its own process group
  mem.registerRun(child.pid, { start: Date.now(), cmd: cmd.slice(0, 300), cwd: process.cwd(), kind, guard: process.pid, need: needMB });
  mem.release(opt('--hold'));                                   // the run now holds its own need
  const watcher = spawn(process.execPath, [fileURLToPath(import.meta.url), '--watch', String(child.pid), '--dir', dir,
    '--timeout', String(timeoutS), '--mem', String(memMB), '--proc-mem', String(procMB), '--kind', kind, '--data', mem.dataDir(), '--start', String(Date.now())],
  { detached: true, stdio: 'ignore' });
  watcher.unref();

  let signalled = null;
  for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(s, () => {
      signalled ||= s;
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 1000).unref();
    });
  }
  process.stderr.on('error', () => {});
  child.on('error', e => { console.error(`[proof guard] could not start the command: ${e.message}`); process.exit(127); });
  child.on('exit', (code, sig) => {
    let reason = null;
    try { reason = readFileSync(join(dir, 'reason'), 'utf8').trim(); } catch {}
    try { writeFileSync(join(dir, 'released'), ''); } catch {}   // tells the watcher this was a normal exit
    mem.unregisterRun(child.pid);
    if (reason) {
      // Stopped because the machine ran out of room: the run may be fine. Otherwise it was its own runaway.
      const tail = /^machine memory/.test(reason) ? '' : kind === 'wait' && /^time/.test(reason) ? '' : ` ${ADVICE}`;
      console.error(`\n[proof guard] stopped this run — ${reason}${tail}`);
      process.exit(124);
    }
    if (signalled) process.exit(128 + (os.constants.signals[signalled] || 0));
    process.exit(code ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1));
  });
}

// ---- watcher: detached, enforces the limits ---------------------------------------------------------------------

function watch() {
  const pgid = Number(opt('--watch'));
  const dir = opt('--dir');
  const start = Number(opt('--start', Date.now()));
  const launcher = process.ppid;       // the foreground guard; if it changes, the guard is gone
  let killing = false, peak = 0, over = 0, n = 0, shared = 1, busy = 0;
  let info = {};
  try { info = JSON.parse(readFileSync(join(dir, 'info.json'), 'utf8')); } catch {}

  const released = () => { try { readFileSync(join(dir, 'released')); return true; } catch { return false; } };
  const stop = reason => {
    killing = true;
    try { writeFileSync(join(dir, 'reason'), reason); } catch {}
    killGroup(pgid, 'SIGTERM');
    setTimeout(() => killGroup(pgid, 'SIGKILL'), 1500);
  };
  const finish = () => {
    clearInterval(timer);
    if (peak > 0 && info.key && !killing) mem.learnPeak(info.key, info.kind || kind, peak * shared, info.root, info.workers ? Math.max(1, Math.min(info.workers, busy - 1)) : 0);
    mem.unregisterRun(pgid);
    // Leave the folder until the guard has read it (or is gone), then clean up.
    const until = Date.now() + 5000;
    const done = () => {
      if (process.ppid === launcher && Date.now() < until) return setTimeout(done, 200);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      process.exit(0);
    };
    done();
  };
  const tick = () => {
    const members = group(pgid);
    if (!members.length) return finish();
    if ((Date.now() - start) / 1000 > timeoutS + 120) return finish();   // never outlive the run by long
    if (killing) return;
    const total = members.reduce((s, p) => s + p.mb, 0);
    // Workers it actually started: a run of one file, or fewer files than workers, never starts them all, and its
    // peak must not later be scaled as if it had. The main process (and npx in front of it) counts as one.
    if (total > peak) busy = members.filter(p => p.mb >= 40).length;
    peak = Math.max(peak, total);
    if (n % 5 === 2) shared = footprintShare(members, total) ?? shared;
    const top = members.reduce((a, b) => (b.mb > a.mb ? b : a));
    const secs = Math.round((Date.now() - start) / 1000);
    const who = `pid ${top.pid}: ${top.cmd.slice(0, 140)}`;
    if (top.mb > procMB) {
      stop(`memory: one process reached ${gb(top.mb)} (limit ${gb(procMB)} per process) after ${secs}s (${who}). That's runaway allocation — a leak or an unbounded loop — not an ordinary test failure.`);
    } else if (total > memMB) {
      stop(`memory: the run reached ${gb(total)} across ${members.length} processes (limit ${gb(memMB)}) after ${secs}s; largest ${who}. That's runaway allocation, not an ordinary test failure.`);
    } else if (secs > timeoutS) {
      stop(kind === 'wait'
        ? `time: this wait ran ${timeoutS}s and its condition never came true. If it waits on a background run, check that run itself (TaskOutput on its id): if it died or is waiting on something else, the line you're polling for will never appear.`
        : `time: still running after ${timeoutS}s; largest ${who}. That's a hang or an infinite loop, not a slow test.`);
    } else if (process.ppid !== launcher && !released()) {
      stop('the process that launched this run was killed, so the run was stopped with it.');
    } else if (++n % 2 === 0) {
      machineCheck(total);
    }
  };
  // The machine as a whole over its ceiling (two readings in a row): the newest guarded run stops first.
  const machineCheck = runMB => {
    const s = systemNow();
    if (!s) return;
    over = s.pct >= s.ceilingPct ? over + 1 : 0;
    if (over < 2) return;
    const newest = mem.liveRuns()[0];
    if (newest && newest.pgid !== pgid) return;
    mem.logEvent({ kind: 'memoryStop', pid: pgid, command: (info.key || '').split('|')[1] || '', mb: Math.round(runMB), pct: Math.round(s.pct), guarded: true });
    stop(`machine memory: the ${mem.MACHINE} reached ${s.pct.toFixed(0)}% of its memory (${gb(s.usedMB)} of ${gb(s.totalMB)}), over proof's ${s.ceilingPct}% ceiling. This was the newest run Claude started (${gb(runMB)}), so it was stopped first. The run itself may be fine: free memory (\`node mem.mjs\` in proof's scripts lists what is using it; stop your own idle dev servers, simulators and browsers, and tell the user which of their apps would free the most), then run it again.`);
  };
  const timer = setInterval(tick, 1000);
  tick();
}

// The monitor writes a reading every 2 seconds; use it when it's fresh, so watchers don't each poll the system.
function systemNow() {
  try {
    const j = JSON.parse(readFileSync(join(mem.dataDir(), 'memory-now.json'), 'utf8'));
    if (Date.now() - j.t < 5000) return j;
  } catch {}
  try { return mem.readSystem(); } catch { return null; }
}

// Resident memory counts pages the run's processes share (the runtime, its libraries) once per process, so a run
// with many workers looks bigger than it is: 8 Node workers measured 677 MB resident against 432 MB of footprint,
// what macOS charges them. The limits above stay on resident memory (the cautious side); what the run is learned to
// need is scaled by footprint/resident, sampled every 5s because reading footprints takes about half a second.
function footprintShare(members, total) {
  if (!mem.IS_MAC || !(total > 0)) return null;
  try {
    const fp = mem.parseTopMem(execFileSync('top', ['-l', '1', '-s', '0', '-stats', 'pid,mem'], { encoding: 'utf8', maxBuffer: 16 * 2 ** 20, timeout: 5000 }));
    const sum = members.reduce((s, p) => s + (fp.get(p.pid) ?? p.mb), 0);
    return Math.min(1, sum / total);
  } catch { return null; }
}

// Live (non-zombie) processes in a process group, with resident memory in MB.
function group(pgid) {
  let out = '';
  try { out = execFileSync('ps', ['-A', '-o', 'pgid=,pid=,stat=,rss=,command='], { encoding: 'utf8', maxBuffer: 16 * 2 ** 20 }); }
  catch { return [{ pid: pgid, mb: 0, cmd: '?' }]; }   // can't see: assume still running, never kill blind
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/);
    if (m && Number(m[1]) === pgid && !m[3].startsWith('Z')) list.push({ pid: Number(m[2]), mb: Number(m[4]) / 1024, cmd: m[5] });
  }
  return list;
}

function gitRoot(cwd) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

function killGroup(pgid, sig) {
  try { process.kill(-pgid, sig); } catch {}
}

function gb(mb) { return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`; }
