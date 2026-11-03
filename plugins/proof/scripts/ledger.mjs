// proof ledger: one line per gate run, kept for good (the data folder is pruned after 14 days; this file is not), so
// proof can say what it caught. No check output is stored: names, outcomes, times and the code fingerprint only.
//   ~/.config/proof/ledger.jsonl, or PROOF_LEDGER
// tally() counts from it. A catch is a check that failed and then passed in the same session on different code; a
// check that failed and then passed on the same code is flaky, not a catch.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';

export const ledgerPath = () => process.env.PROOF_LEDGER || join(os.homedir(), '.config', 'proof', 'ledger.jsonl');

// Results that aren't the project's own checks: they never count as catches.
const NOT_CHECKS = new Set(['check definitions', 'proof.json']);

export function record(...entries) {
  if (!entries.length) return;
  try {
    const p = ledgerPath();
    mkdirSync(dirname(p), { recursive: true });
    // One write for all of them, so a killed process can't leave half a batch.
    appendFileSync(p, entries.map(e => `${JSON.stringify({ v: 1, t: Date.now(), agent: process.env.PROOF_AGENT || 'claude', ...e })}\n`).join(''));
  } catch {}
}

// One ledger check from one gate result.
export function checkOf(r) {
  const c = { name: r.name, ok: !!r.ok };
  if (r.kind) c.kind = r.kind;
  if (r.cached) c.cached = true;
  if (r.ms != null) c.ms = r.ms;
  if (r.killed) c.killed = true;
  if (r.killed && /^machine memory/.test(r.killReason || '')) c.machineMemory = true;   // the machine, not the code
  if (r.timedOut) c.timedOut = true;
  if (r.notRun) c.notRun = true;
  return c;
}

// tailBytes: read only the end of the file (the gate wants the current session, not years of history).
export function readLedger({ path = ledgerPath(), tailBytes } = {}) {
  if (!existsSync(path)) return [];
  let text;
  try {
    const size = statSync(path).size;
    if (!tailBytes || size <= tailBytes) text = readFileSync(path, 'utf8');
    else {
      const fd = openSync(path, 'r'), buf = Buffer.alloc(tailBytes);
      try { readSync(fd, buf, 0, tailBytes, size - tailBytes); } finally { closeSync(fd); }
      text = buf.toString('utf8').replace(/^[^\n]*\n/, '');   // drop the partial first line
    }
  } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      const e = JSON.parse(l);
      if (!e || typeof e !== 'object' || typeof e.t !== 'number') continue;
      e.checks = Array.isArray(e.checks) ? e.checks.filter(c => c && typeof c === 'object' && c.name) : [];
      out.push(e);
    } catch {}
  }
  return out.sort((a, b) => a.t - b.t);
}

// Totals over entries (already filtered to the period, session or turn wanted). Catches are worked out per session
// and project, in time order, so pass the session's earlier entries too and narrow with `from` to count only what
// ended after it. A failure stops being a candidate catch once the user has seen it (the gate gave up or asked them)
// or once the code went back to the last commit (a "clean" line): fixing it later isn't proof catching it.
export function tally(entries, { from = 0 } = {}) {
  const t = { runs: 0, checksRun: 0, caught: 0, flaky: 0, commitsBlocked: 0, commitsAllowed: 0, gaveUp: 0, askedUser: 0, checkMs: 0, sessions: 0, caughtChecks: {}, flakyChecks: {} };
  const open = new Map();          // `${session}\0${root}\0${check}` -> fingerprint of the code it last failed on
  const sessions = new Set();
  for (const e of [...entries].sort((a, b) => a.t - b.t)) {
    const counts = e.t >= from;
    const scope = `${e.session}\0${e.root ?? ''}\0`;
    if (e.outcome === 'clean') { for (const k of [...open.keys()]) if (k.startsWith(scope)) open.delete(k); continue; }
    if (counts) {
      t.runs++;
      if (e.session) sessions.add(e.session);
      if (e.outcome === 'commitBlocked') t.commitsBlocked++;
      if (e.outcome === 'commitAllowed') t.commitsAllowed++;
      if (e.outcome === 'gaveUp') t.gaveUp++;
      if (e.outcome === 'askedUser') t.askedUser++;
    }
    const shown = e.outcome === 'gaveUp' || e.outcome === 'askedUser';
    // Time in checks is the gate's own wall time (checks run in parallel, so their times would add up to more).
    if (counts) t.checkMs += e.ms ?? (e.checks || []).reduce((n, c) => n + (c.ms || 0), 0);
    for (const c of e.checks || []) {
      if (counts && !c.cached && !c.notRun) t.checksRun++;
      if (!e.session || NOT_CHECKS.has(c.name) || c.notRun || c.machineMemory) continue;
      const k = scope + c.name;
      if (!c.ok) { if (shown) open.delete(k); else open.set(k, e.tree ?? null); continue; }
      if (!open.has(k)) continue;
      const failedOn = open.get(k);
      open.delete(k);
      if (!counts) continue;
      // A transcript's edit count and a live fingerprint can't be compared: neither caught nor flaky.
      if (failedOn != null && e.tree != null && /^edits:/.test(failedOn) !== /^edits:/.test(e.tree)) continue;
      const same = failedOn != null && failedOn === e.tree;
      const bucket = same ? 'flakyChecks' : 'caughtChecks';
      t[same ? 'flaky' : 'caught']++;
      t[bucket][c.name] = (t[bucket][c.name] || 0) + 1;
    }
  }
  t.sessions = sessions.size;
  return t;
}

export function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}
