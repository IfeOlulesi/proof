#!/usr/bin/env node
// proof — completion gate. One script, three entry points:
//   Stop hook (no flag)       After a reply that changed files, run the relevant checks, using each check's `fast`
//                             variant where one is configured. Failures go back to Claude until they pass.
//   --commit (PreToolUse)     Before `git commit`, run every relevant check in full. A failure blocks the commit.
//   --run [dir] [--no-cache]  By hand: run every check in full and print the results.
//   --quick <session-id>      Quick mode for this session (the proof:quick skill turns it on): small, clear fixes skip
//                             the full process; if the change grows past the limits, the gate switches back.
// A pass is cached against the exact content of the code, so identical code is never checked twice.
// A session that loosens the checks themselves (removes or rewrites a check, edits the fidelity kit) has to ask the user.
// Every check runs under the proof guard (guard.mjs): a time limit and memory ceilings that keep working even if
// this process is killed. The whole gate also finishes inside its hook's timeout, so it is never cut off mid-check.
// Checks fit the memory there is: each runs with as many test workers as fit, or waits for room (see room()).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cacheGet, cachePut, dataDir, git, gitRoot, loadConfig, loadState, protectedSnapshot, readStdin, saveState, sha, treeFingerprint,
} from './lib.mjs';
import { planRun } from './fit.mjs';
import { admit, hold, liveRuns } from './mem.mjs';

// Checks may reference $CLAUDE_PLUGIN_ROOT; make sure it is set even when run by hand.
process.env.CLAUDE_PLUGIN_ROOT ||= resolve(dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);
const MODE = argv.includes('--commit') ? 'commit' : argv.includes('--run') ? 'manual' : argv.includes('--quick') ? 'quick' : 'stop';
const NO_CACHE = argv.includes('--no-cache');
const TTL = 12 * 3600e3;
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');
const RAM_MB = os.totalmem() / 2 ** 20;
// The hooks get 900s from Claude Code. Finish well inside that, or Claude Code cancels the gate and moves on.
const DEADLINE = MODE === 'manual' ? Infinity : Date.now() + (Number(process.env.PROOF_GATE_BUDGET) || 840) * 1000;
const input = MODE === 'manual' || MODE === 'quick' ? {} : readStdin();
const QUICK_TTL = 3 * 3600e3;
const SENSITIVE = /(^|\/)\(?(auth|security|payments?|billing|checkout|migrations?|policies|rls)\)?(\/|\.|_|-|$)|\.sql$|(^|\/)\.claude\/|(^|\/)\.github\/workflows\//i;

if (MODE === 'quick') { quickOn(argv[argv.indexOf('--quick') + 1]); process.exit(0); }

// The PreToolUse hook sees every git command; anything that isn't a commit passes straight through.
if (MODE === 'commit') {
  const cmd = input.tool_input?.command;
  const at = commitIndex(cmd);
  if (at < 0) process.exit(0);
  // This hook runs before the command does, so it can't see files the same command writes before committing.
  // Only git and cd may come before the commit; anything else has to run as its own step first.
  const before = cmd.slice(0, at).split(/&&|\|\||[;|\n]/).map(s => s.trim()).filter(Boolean)
    .filter(s => !/^(?:[A-Za-z_]\w*=\S*\s*)+$/.test(s) && !/^(?:[A-Za-z_]\w*=\S*\s+)*(?:cd|pushd|git|true|:)(?:\s|$)/.test(s));
  if (before.length) {
    process.stderr.write(`proof: commit refused — this command runs \`${short(before[0])}\` before committing. The commit gate checks files before the command runs, so it can't see what the same command changes. Make the file changes first, in their own step, then run \`git add … && git commit …\` on its own.`);
    process.exit(2);
  }
}

const cwd = (MODE === 'manual' && argv.find(a => !a.startsWith('--'))) || input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const root = gitRoot(cwd);
const base = root || cwd;

// Each running check is a guard process. SIGTERM lets a guard stop its run cleanly; its watcher covers the rest.
const running = new Set();
const START = Date.now();
let inflight = 0;
process.on('SIGTERM', () => { for (const pid of running) killGroup(pid, 'SIGTERM'); process.exit(1); });

await main();

async function main() {
  const { config, error } = loadConfig(base);
  const st = MODE === 'manual' ? {} : loadState(input.session_id, base) || {};

  let changed = [];
  if (MODE !== 'manual') {
    if (!root) return;                          // the gate needs git to see what this session changed
    changed = changedFiles(root, st);
  }
  const tamper = MODE === 'manual' ? null : checkTamper(st);
  if (MODE === 'stop' && st.quick && changed.length && quickTripped(st, changed)) return;
  if (!config && !error && !tamper) {
    if (MODE === 'manual') console.log(`No .claude/proof.json in ${base} — nothing to run.`);
    return;
  }
  if (MODE !== 'manual' && !changed.length && !tamper) return;   // chats and brainstorms pass straight through

  // A new prompt whose reply left the code exactly as the last check saw it (a question, a chat) has nothing new to
  // check, even while the session has uncommitted work. Fix rounds within a prompt still re-run, and so does the commit.
  const snap = MODE === 'stop' ? treeFingerprint(base) : null;
  const newPrompt = input.prompt_id ? input.prompt_id !== st.promptId : input.stop_hook_active !== true;
  if (snap && newPrompt && !tamper && snap === st.lastTree) {
    if (st.lastFailing) emit({ systemMessage: `proof: no file changes since the last check (${st.lastFailing} still failing).` });
    return;
  }

  const tier = MODE === 'stop' ? 'fast' : 'full';
  const checks = error || !config ? [] : normalize(config.checks);
  const caching = !NO_CACHE && checks.some(c => c.cache !== false);
  const tree = caching ? snap ?? treeFingerprint(base) : null;

  // Decide what runs, and skip anything that already passed on identical code.
  const jobs = [];
  for (const c of checks) {
    const p = MODE === 'manual' ? { cmd: c.run, kind: 'full' } : plan(c, changed, tier);
    if (!p) continue;
    const cacheable = tree && c.cache !== false;
    const cacheKey = cacheable ? sha(JSON.stringify([tree, c.name, p.cmd])) : null;
    const fullKey = cacheable ? sha(JSON.stringify([tree, c.name, c.run])) : null;
    const cached = !!(cacheable && (cacheGet(fullKey, TTL) || cacheGet(cacheKey, TTL)));
    jobs.push({
      name: c.name, run: p.cmd, kind: p.kind, cacheKey, cached, timeout: c.timeout,
      mem: Number(c.maxMemoryMB) || Number(config?.maxMemoryMB) || Math.round(RAM_MB / 2),
      procMem: Number(c.maxProcessMemoryMB) || Number(config?.maxProcessMemoryMB) || Math.round(RAM_MB / 4),
    });
  }

  const env = { ...process.env, CI: process.env.CI ?? 'true', PROOF_CHANGED_FILES: changed.join('\n'), PROOF_TIER: tier };
  const limit = Math.max(1, Number(config?.concurrency) || 4);
  const toRun = jobs.filter(j => !j.cached);
  const ran = await runAll(toRun, limit, env, Number(config?.timeout) || 300);
  toRun.forEach((j, i) => { j.result = ran[i]; if (ran[i].ok && j.cacheKey) cachePut(j.cacheKey, { name: j.name }); });

  const results = [];
  if (error) results.push({ name: 'proof.json', run: 'parse .claude/proof.json', ok: false, code: 1, out: `Invalid JSON: ${error}`, weight: 1 });
  if (tamper) results.push(tamper.result);
  for (const j of jobs) results.push(j.cached ? { ...j, ok: true, weight: 0 } : j.result);
  if (!results.length) return;
  const failed = results.filter(r => !r.ok);

  if (MODE === 'manual') return report(results, failed);
  if (MODE === 'commit') return commitDecision(results, failed);
  const stillFailing = failed.filter(r => r !== tamper?.result);   // changed checks are asked about once, not repeated
  Object.assign(st, { lastTree: snap, lastFailing: stillFailing.length ? names(stillFailing) : null });
  return stopDecision(st, results, failed, tamper, Number(config?.maxRounds) || 5);
}

// ---- decisions --------------------------------------------------------------------------------------------------

function report(results, failed) {
  for (const r of results) {
    const how = r.cached ? ' (cached — passed on this exact code)' : r.ms != null ? ` (${(r.ms / 1000).toFixed(1)}s)` : '';
    const why = r.killed || r.notRun ? `\n    ${outcome(r)}` : '';
    console.log(`${r.ok ? '✓' : '✗'} ${r.name}${how}${why}${r.ok ? '' : `\n${indent(tail(r.out, 40))}`}`);
  }
  console.log(failed.length ? `\n${failed.length} of ${results.length} checks failing.` : `\nAll ${results.length} checks passed.`);
  process.exitCode = failed.length ? 1 : 0;
}

function commitDecision(results, failed) {
  if (!failed.length) {
    const st = loadState(input.session_id, base);
    if (st?.quick) { delete st.quick; saveState(input.session_id, base, st); }   // the quick fix is done
    return emit({ systemMessage: `proof ✓ full checks passed — commit allowed: ${summary(results)}` });
  }
  const each = Math.max(600, Math.floor(7000 / failed.length));
  process.stderr.write([
    `proof: commit blocked — ${failed.length} of ${results.length} full check(s) failing. Every relevant check must pass in full before a commit.`,
    ...killedNote(failed),
    ...failed.map(r => `✗ ${r.name} — ${outcome(r)}\n${tail(r.out, 60).slice(-each)}`),
    'Fix the cause, then commit again. If a failure is not caused by your change, say so and end your message with a line starting NEEDS-INPUT:.',
  ].join('\n\n').slice(0, 9500));
  process.exitCode = 2;
}

// A check the guard stopped is a loop, a leak or a hang. Say so, so Claude doesn't spend rounds re-running it.
function killedNote(failed) {
  const notes = [];
  if (failed.some(r => r.killed && !/^machine memory/.test(r.killReason))) notes.push('A check was stopped by the proof guard for runaway memory or time. That means a loop, a leak or a hang, not a failing assertion. The output below shows where it was (pytest prints every thread\'s stack for a test that runs past 60s). Fix the cause; running it again won\'t change the result.');
  if (failed.some(r => r.killed && /^machine memory/.test(r.killReason))) notes.push('A check was stopped because the machine ran short of memory, not because of the check itself. Free memory (stop your own dev servers, simulators and browsers you no longer need; if the user\'s apps hold it, ask them), then finish again.');
  return notes;
}

function outcome(r) {
  if (r.killed) return `stopped by the proof guard: ${r.killReason}`;
  if (r.notRun) return 'not run: the gate ran out of time before it could start';
  return `\`${short(r.run)}\` ${r.timedOut ? 'timed out' : `exited ${r.code}`}`;
}

function stopDecision(st, results, failed, tamper, max) {
  // A new user prompt starts a fresh count of fix rounds.
  const newTurn = input.prompt_id ? input.prompt_id !== st.promptId : input.stop_hook_active !== true;
  if (newTurn) Object.assign(st, { promptId: input.prompt_id ?? null, rounds: 0, lastWeight: null, stall: 0 });

  if (!failed.length) {
    Object.assign(st, { rounds: 0, lastWeight: null, stall: 0 });
    saveState(input.session_id, base, st);
    const fast = results.some(r => r.kind === 'fast');
    return emit({ systemMessage: `proof ✓ ${summary(results)}${fast ? ' · full checks run before each commit' : ''}` });
  }

  if (/^\s*NEEDS-INPUT:/m.test(input.last_assistant_message || '')) {
    if (tamper) st.ackedProtected = tamper.sig;   // the user has now been asked about the changed checks
    saveState(input.session_id, base, st);
    return emit({ systemMessage: `proof: ${names(failed)} still failing — Claude stopped to ask you something.` });
  }

  const weight = failed.reduce((n, r) => n + r.weight, 0);
  st.rounds = (st.rounds || 0) + 1;
  st.stall = st.lastWeight != null && weight >= st.lastWeight ? (st.stall || 0) + 1 : 0;
  st.lastWeight = weight;
  if (st.rounds > max || st.stall >= 2) {
    if (tamper) st.ackedProtected = tamper.sig;
    saveState(input.session_id, base, st);
    return emit({ systemMessage: `proof ✗ ${names(failed)} still failing after ${st.rounds - 1} fix round(s). Claude was allowed to stop — this is not done.` });
  }
  saveState(input.session_id, base, st);
  emit({
    decision: 'block',
    reason: stopReason(failed, results.length, st.rounds, max),
    systemMessage: `proof: ${names(failed)} failing — sent back to Claude (round ${st.rounds}/${max})`,
  });
}

function stopReason(failed, total, round, max) {
  const each = Math.max(600, Math.floor(7000 / failed.length));
  return [
    `proof gate: ${failed.length} of ${total} check(s) failing — round ${round} of ${max}. Fix the cause and finish again; the gate re-runs the checks. While iterating, run only the failing test or file, not the whole suite.`,
    ...killedNote(failed),
    ...failed.map(r => `✗ ${r.name} — ${outcome(r)}\n${tail(r.out, 60).slice(-each)}`),
    'Do not edit tests, specs, inventories or .claude/proof.json to get past this. If a check is wrong, or you need the user, explain why and end your message with a line starting NEEDS-INPUT:.',
  ].join('\n\n').slice(0, 9500);
}

// ---- what to run ------------------------------------------------------------------------------------------------

function normalize(list) {
  const arr = v => (v ? [].concat(v) : null);
  return (Array.isArray(list) ? list : [])
    .map(c => (typeof c === 'string' ? { name: c, run: c } : c))
    .filter(c => c && typeof c.run === 'string' && c.run.trim())
    .map(c => ({
      ...c,
      name: c.name || c.run,
      when: arr(c.when),
      files: arr(c.files),
      fullWhen: arr(c.fullWhen),
      fast: typeof c.fast === 'string' && c.fast.trim() ? c.fast : null,
    }));
}

// Per reply: a check's `fast` command over the changed files it cares about, unless something forces the full run.
// Before a commit: always the full command.
function plan(c, changed, tier) {
  if (c.when && !c.when.some(g => changed.some(f => globMatch(g, f)))) return null;
  if (tier === 'full' || !c.fast) return { cmd: c.run, kind: 'full' };
  if (c.fullWhen && c.fullWhen.some(g => changed.some(f => globMatch(g, f)))) return { cmd: c.run, kind: 'full' };
  const filter = c.files || c.when;
  const picked = filter ? changed.filter(f => filter.some(g => globMatch(g, f))) : changed;
  if (!picked.length) return null;                                   // nothing this check looks at was touched
  const abs = picked.map(f => join(base, f));
  if (picked.length > 200 || abs.some(p => !existsSync(p))) return { cmd: c.run, kind: 'full' };   // deletions and big changes: full
  return { cmd: c.fast.split('{files}').join(abs.map(shq).join(' ')), kind: 'fast' };
}

// Files this session touched: tracked changes since the session's starting commit (or HEAD, if that commit isn't
// known in this repo), plus untracked files modified since it began. Changes against HEAD — staged or not — are
// always included, so a commit can never slip past with an empty change list.
function changedFiles(dir, st) {
  const set = new Set();
  const start = st.startHead && git(['cat-file', '-e', `${st.startHead}^{commit}`], dir) !== null ? st.startHead : null;
  for (const ref of start ? [start, 'HEAD'] : ['HEAD'])
    for (const f of (git(['diff', '--name-only', ref], dir) || '').split('\n')) if (f.trim()) set.add(f.trim());
  for (const f of (git(['ls-files', '--others', '--exclude-standard'], dir) || '').split('\n')) {
    if (!f) continue;
    if (!st.startTime) { set.add(f); continue; }
    try { if (statSync(join(dir, f)).mtimeMs >= st.startTime - 1000) set.add(f); } catch {}
  }
  return [...set].filter(f => !f.startsWith('.proof/'));
}

// Check definitions this session loosened, compared with how they were when it started, and not yet shown to the user.
// Setting checks up or adding to them is the agent's job and isn't asked about: a file the session created, and a
// proof.json that still runs every starting command on at least the same paths, pass. Removing a check, changing its
// command or `fast`, narrowing its `when` or `files`, deleting the file, creating or editing settings.json, or editing
// the fidelity kit still stops for the user.
function checkTamper(st) {
  if (!st.protectedAtStart) return null;
  const now = protectedSnapshot(base);
  const diffs = Object.keys(now)
    .filter(p => now[p] !== st.protectedAtStart[p] && (st.protectedAtStart[p] !== null || p === '.claude/settings.json'))
    .map(p => ({ p, why: !now[p] ? null : p === '.claude/proof.json' ? loosened(st.checksAtStart) : [] }))
    .filter(d => d.p !== '.claude/proof.json' || !d.why || d.why.length);
  if (!diffs.length) return null;
  const sig = sha(JSON.stringify(diffs.map(({ p }) => [p, now[p]])));
  if (st.ackedProtected === sig) return null;
  return {
    sig,
    result: {
      name: 'check definitions', run: 'compare with session start', ok: false, code: 1, weight: 1,
      out: `${diffs.map(({ p, why }) => [`${why ? 'changed' : 'deleted'}: ${p}`, ...(why || []).map(w => `  ${w}`)].join('\n')).join('\n')}\nThis weakens what proves the work, so it needs the user's OK: say in plain words what would no longer be checked and why, then end your message with a line starting NEEDS-INPUT:.`,
    },
  };
}

// What the current proof.json no longer checks that the starting one did. Checks are matched by command, so renaming
// or reordering them is fine. Without a starting copy (an older session's state), any change counts.
function loosened(before) {
  if (before === undefined) return ['changed since the session started'];
  if (before === null) return [];
  const { config } = loadConfig(base);
  const after = normalize(config?.checks);
  const out = [];
  for (const s of normalize(before)) {
    const c = after.find(a => a.run === s.run);
    if (!c) { out.push(`check "${s.name}" removed or its command changed (was: ${short(s.run)})`); continue; }
    if (s.fast && c.fast !== s.fast) out.push(`check "${s.name}" per-reply command changed (was: ${short(s.fast)})`);
    const lostFiles = s.files && c.files ? s.files.filter(g => !c.files.includes(g)) : [];
    if (lostFiles.length) out.push(`check "${s.name}" per-reply run no longer covers ${lostFiles.join(', ')}`);
    if (!c.when) continue;
    const lost = s.when ? s.when.filter(g => !c.when.includes(g)) : ['every change'];
    if (lost.length) out.push(`check "${s.name}" no longer runs on ${lost.join(', ')}`);
  }
  return out;
}

// Index where a `git … commit` starts in a shell command, or -1.
function commitIndex(cmd) {
  if (typeof cmd !== 'string') return -1;
  const m = /(^|[\s;&|(])git(?:\s+-{1,2}[\w-]+(?:[= ](?!commit\b)\S+)?)*\s+commit(?![\w-])/.exec(cmd);
  return m ? m.index + m[1].length : -1;
}

// ---- running ----------------------------------------------------------------------------------------------------

async function runAll(jobs, limit, env, defaultTimeout) {
  const out = new Array(jobs.length);
  let next = 0;
  const live = liveStatus(jobs);
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      await room(jobs[i]);                 // counts the job as in flight before it returns
      live.set(i, 'running');
      try { out[i] = await runOne(jobs[i], env, defaultTimeout); } finally { inflight--; }
      live.set(i, out[i].ok ? 'passed' : 'failed');
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, worker));
  live.done();
  return out;
}

// Checks fit the memory there is. A check whose runner can be capped (Jest, Vitest, Playwright, node --test, go test,
// Gradle) runs with as many workers as fit; one that can't, or doesn't fit even at one worker, waits while other runs
// finish. With nothing left to wait for, it runs anyway, at one worker if it can be capped; the guard stops it if the
// machine actually reaches the ceiling. `inflight` (declared at the top) counts this gate's admitted checks; it
// changes in the same tick as the decision, so two workers can't both see an empty machine and start together.
async function room(job) {
  const plan = planRun(job.run, base, 'check');
  // Held from the moment a check is admitted until its guard has registered it with its need.
  const take = f => {
    Object.assign(job, f ? { run: f.cmd, capped: f.workers, need: f.need } : { need: plan.need });
    job.hold = hold(job.need);
    inflight++;
  };
  for (;;) {
    let a = null;
    try { a = admit(plan.need); } catch {}
    if (!a || a.ok) return take(null);
    const f = a.system.pressure === 'critical' ? null : plan.fit(a.roomMB);
    if (f) return take(f);
    if (DEADLINE - Date.now() < 90e3 || (!inflight && !liveRuns().length)) return take(plan.least());
    await new Promise(r => setTimeout(r, 2000));
  }
}

// What the gate is doing right now, for the dashboard: <data>/live/gate-<session>.json while it runs.
function liveStatus(jobs) {
  const file = MODE === 'manual' ? null : join(dataDir(), 'live', `gate-${String(input.session_id || 'none').replace(/[^\w.-]/g, '_')}.json`);
  const state = jobs.map(j => ({ name: j.name, kind: j.kind, state: 'queued' }));
  const write = () => { if (file) try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ pid: process.pid, mode: MODE, root: base, start: START, checks: state })); } catch {} };
  write();
  return { set: (i, s) => { state[i].state = s; write(); }, done: () => { if (file) try { unlinkSync(file); } catch {} } };
}

function runOne(job, env, defaultTimeout) {
  let limitS = Number(job.timeout) || defaultTimeout;
  const leftS = (DEADLINE - Date.now()) / 1000;
  if (leftS < 20) return Promise.resolve({ ...job, ok: false, notRun: true, code: null, out: '', weight: 1, ms: 0 });
  limitS = Math.min(limitS, Math.max(5, Math.floor(leftS - 10)));   // the budget never cuts a check below 5s
  return new Promise(done => {
    const t0 = Date.now();
    let out = '', timedOut = false, finished = false;
    // The guard enforces the limits; it runs detached, so killing this gate doesn't kill it.
    const child = spawn(process.execPath,
      [GUARD, '--timeout', String(limitS), '--mem', String(job.mem), '--proc-mem', String(job.procMem), '--kind', 'check', '--need', String(Math.round(job.need || 0)), '--hold', String(job.hold || ''), '--data', dataDir(), '--', job.run],
      { cwd: base, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    if (child.pid) running.add(child.pid);
    const add = d => { out += d; if (out.length > 400000) out = out.slice(-200000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {            // backstop, in case the guard itself is stuck
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      setTimeout(() => killGroup(child.pid, 'SIGKILL'), 5000);
    }, (limitS + 15) * 1000);
    const finish = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      running.delete(child.pid);
      const m = out.match(/\[proof guard\] stopped this run — ([^\n]*?)(?: Find the cause[^\n]*)?$/m);
      const killed = !!m;
      if (timedOut) out += `\n(timed out after ${limitS}s)`;
      const ok = !timedOut && !killed && code === 0;
      // Lines like "FAIL x" or "✕ y" give a finer progress signal than pass/fail per check.
      const marks = out.split('\n').filter(l => /^\s*(?:FAIL(?:ED)?\b|[✗✕✖×])/.test(l)).length;
      done({ ...job, ok, code, timedOut, killed, killReason: m ? m[1] : `exceeded its ${limitS}s or memory limit`, out, weight: ok ? 0 : Math.max(1, marks), ms: Date.now() - t0 });
    };
    child.on('error', e => { out += `\n${e.message}`; finish(null); });
    child.on('close', code => finish(code));
    // A background process left holding stdout open must not hang the gate.
    child.on('exit', code => setTimeout(() => { if (!finished) { killGroup(child.pid, 'SIGKILL'); finish(code); } }, 2000).unref());
  });
}

function killGroup(pid, sig) {
  if (!pid) return;
  try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch {} }
}

// ---- quick mode -------------------------------------------------------------------------------------------------

// Turned on by the proof:quick skill for one session. It ends with the next commit, after 3 hours, or when the
// change outgrows a quick fix.
function quickOn(sessionId) {
  const dir = process.cwd();
  const root = gitRoot(dir);
  if (!sessionId || /CLAUDE_SESSION_ID/.test(sessionId)) {
    console.log('Quick mode could not be recorded (no session id). Follow the quick process anyway; the gate runs as usual.');
    return;
  }
  const b = root || dir;
  const st = loadState(sessionId, b) || {};
  const { config } = loadConfig(b);
  const lim = quickLimits(config);
  st.quick = { since: Date.now(), head: root ? git(['rev-parse', 'HEAD'], root) : null };
  saveState(sessionId, b, st);
  console.log(`Quick mode is on for this session: up to ${lim.files} files and ${lim.lines} changed lines, nothing in auth, payments, migrations, security rules, CI or the check definitions. The completion and commit checks still run. If the change grows past that, the gate switches you back to the full build process.`);
}

function quickLimits(config) {
  return { files: Number(config?.quick?.maxFiles) || 3, lines: Number(config?.quick?.maxLines) || 100 };
}

// Has the change outgrown a quick fix? If so, switch the session back to the full process (once) and say why.
function quickTripped(st, changed) {
  if (Date.now() - st.quick.since > QUICK_TTL) { delete st.quick; saveState(input.session_id, base, st); return false; }
  const { config } = loadConfig(base);
  const lim = quickLimits(config);
  const head = st.quick.head && git(['cat-file', '-e', `${st.quick.head}^{commit}`], root) !== null ? st.quick.head : 'HEAD';
  let lines = 0;
  const files = new Set();
  for (const l of (git(['diff', '--numstat', head], root) || '').split('\n')) {
    const m = l.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    files.add(m[3]);
    lines += (Number(m[1]) || 0) + (Number(m[2]) || 0);
  }
  for (const f of (git(['ls-files', '--others', '--exclude-standard'], root) || '').split('\n')) {
    if (!f || f.startsWith('.proof/')) continue;
    try { if (statSync(join(root, f)).mtimeMs < st.quick.since - 1000) continue; } catch { continue; }
    files.add(f);
    try { lines += readFileSync(join(root, f), 'utf8').split('\n').length; } catch {}
  }
  const sensitive = [...files].filter(f => SENSITIVE.test(f));
  const why = [];
  if (files.size > lim.files) why.push(`${files.size} files (quick allows ${lim.files})`);
  if (lines > lim.lines) why.push(`${lines} changed lines (quick allows ${lim.lines})`);
  if (sensitive.length) why.push(`touches ${sensitive.slice(0, 3).join(', ')}`);
  if (!why.length) return false;
  delete st.quick;
  saveState(input.session_id, base, st);
  emit({
    decision: 'block',
    reason: `proof: this is no longer a quick fix: ${why.join('; ')}. Switch to the full build process now (skill proof:build): write or extend the test for the behaviour you changed and record its failing run, have the proof:verifier agent review the change before you commit, and add a PROGRESS.md entry. Then finish again.`,
    systemMessage: `proof: quick mode ended — ${why.join('; ')}. Back to the full process.`,
  });
  return true;
}

// ---- helpers ----------------------------------------------------------------------------------------------------

// Minimal glob: **, *, ?, {a,b}; a trailing "/" means everything below; a pattern without "/" also matches basenames.
function globMatch(glob, file) {
  return expandBraces(glob.trim()).some(g => {
    if (g.endsWith('/')) g += '**';
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const ch = g[i];
      if (ch === '*') {
        if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
        else re += '[^/]*';
      } else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const rx = new RegExp(`^${re}$`);
    return rx.test(file) || (!g.includes('/') && rx.test(file.split('/').pop()));
  });
}

function expandBraces(g) {
  const m = g.match(/\{([^{}]*)\}/);
  if (!m) return [g];
  return m[1].split(',').flatMap(alt => expandBraces(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length)));
}

function summary(rs) {
  return rs.map(r => `${r.name}${r.cached ? ' (cached)' : r.kind === 'fast' ? ' (fast)' : ''}${r.capped ? ` (${r.capped} worker${r.capped > 1 ? 's' : ''}, to fit memory)` : ''}`).join(', ');
}
function names(rs) { return rs.map(r => r.name).join(', '); }
function short(cmd) { return cmd.length > 160 ? `${cmd.slice(0, 157)}…` : cmd; }
function shq(s) { return `'${s.replace(/'/g, `'\\''`)}'`; }
function tail(s, n) { return String(s || '').trim().split('\n').slice(-n).join('\n'); }
function indent(s) { return s.split('\n').map(l => `    ${l}`).join('\n'); }
function emit(obj) { process.stdout.write(JSON.stringify(obj)); }
