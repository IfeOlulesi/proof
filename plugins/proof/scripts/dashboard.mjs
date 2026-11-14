#!/usr/bin/env node
// proof dashboard data: turns parsed sessions (timeline.mjs) and memory readings (mem.mjs) into what the dashboard
// page draws. The live monitor (monitor.mjs) calls board() on every refresh. On its own, it replays a past build up to
// a moment and writes a self-contained page (handy for reviewing a past build, or for working on the page itself):
//   node dashboard.mjs --logs <project-dir> [--session <id-prefix>] [--at <ISO time>] [--window 6h] --out page.html
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backfillDone, markerPath, progressPath } from './backfill.mjs';
import { ledgerPath, readLedger, tally } from './ledger.mjs';
import { CATEGORIES, intervals, loadSessions, normCmd, sessionEnd, simplify, sweep } from './timeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.4.0';
const REVIEW = /verifier|judge|review/i;
const BUSY_STATES = new Set(['working', 'thinking', 'agents']);

// Who launched whom. Claude Code's meta names the launching agent (parentAgentId) for an agent launched by an agent;
// failing that, the meta's toolUseId is the Agent or Task call that launched it, and the thread whose log holds that
// call is the parent. A fork's log starts with a copy of its parent's history, calls included, so a fork only owns
// calls no other log has. When neither is found, the parent is the main thread and the depth falls back to the
// agent's spawnDepth (1 if it has none). Nested agents' logs sit beside the others in <session>/subagents/.
export function lineage(s, agents) {
  const owner = new Map();
  for (const t of s.tools) if (t.id) owner.set(t.id, 'main');
  for (const fork of [false, true]) {
    for (const a of agents) if (!!a.agent?.fork === fork) for (const t of a.tools) if (t.id && !owner.has(t.id)) owner.set(t.id, a.id);
  }
  const byAgentId = new Map(agents.map(a => [a.id, a]));
  const linkOf = a => (byAgentId.has(a.agent?.parentId) ? a.agent.parentId : owner.get(a.agent?.toolUseId) || null);
  const parentOf = a => { const p = linkOf(a); return p && p !== a.id ? p : 'main'; };
  const depthOf = a => {
    let d = 1, cur = a;
    const seen = new Set([a.id]);
    for (;;) {
      const p = linkOf(cur);
      if (!p) return a.agent?.depth || d;
      if (p === 'main') return d;
      const next = byAgentId.get(p);
      if (!next || seen.has(p)) return a.agent?.depth || d;
      seen.add(p); cur = next; d++;
    }
  };
  const callOf = id => (id && (s.byId.get(id) || agents.map(a => a.byId.get(id)).find(Boolean))) || null;
  return { parentOf, depthOf, callOf };
}

// ---- one session ----------------------------------------------------------------------------------------------------

function workspaceOf(a, sessionCwd) {
  const depth = sessionCwd ? sessionCwd.split('/').length : 0;
  const counts = new Map();
  const add = p => {
    if (typeof p !== 'string' || !p.startsWith('/') || /^\/(tmp|private|var)\//.test(p)) return;
    const w = sessionCwd && (p === sessionCwd || p.startsWith(`${sessionCwd}/`)) ? sessionCwd : p.split('/').slice(0, depth || 6).join('/');
    counts.set(w, (counts.get(w) || 0) + 1);
  };
  for (const t of a.tools) {
    if (t.file) add(t.file);
    if (t.cmd) for (const m of t.cmd.matchAll(/(?:^|[\s;&|(])cd\s+["']?(\/[^"'\s;&|)]+)/g)) add(m[1]);
  }
  let best = null, n = 0;
  for (const [w, c] of counts) if (c > n) { best = w; n = c; }
  return best || a.cwd || sessionCwd || '';
}

const ownIntervals = (x, now) => {
  const solo = Object.assign(Object.create(Object.getPrototypeOf(x)), x, { subagents: new Map(), asleep: [] });
  return intervals(solo, now, new Set());
};

const nameOf = p => (p ? p.split('/').filter(Boolean).pop() : '');
const STUCK_MS = 5 * 60e3;

export function sessionView(s, now, windowMs) {
  const to = sessionEnd(s, now);
  const from = Math.max(s.start, to - windowMs);
  const minSeg = Math.max(1000, (to - from) / 1400);
  const agents = [...s.subagents.values()];
  const { parentOf, depthOf, callOf } = lineage(s, agents);
  const iv = intervals(s, now);
  const whole = sweep(iv, s.start, to);
  const win = sweep(iv, from, to);

  // Rows: the main thread, then agents grouped by the worktree they worked in, then reviews.
  const groups = new Map();
  for (const a of agents) {
    const key = REVIEW.test(a.agent?.agentType || '') ? 'Reviews' : workspaceOf(a, s.cwd);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const rows = [{ key: 'main', label: 'Main thread', sub: 'orchestrates, talks to you', lane: simplify(sweep(ownIntervals(s, now), from, to).lane, minSeg).filter(x => x[2] !== 'idle') }];
  const asleep = (s.asleep || []).filter(([a, b]) => b > from && a < to);
  const ordered = [...groups.entries()].sort((a, b) => (a[0] === 'Reviews') - (b[0] === 'Reviews') || b[1].length - a[1].length);
  for (const [key, list] of ordered) {
    const ivs = list.flatMap(a => ownIntervals(a, now));
    const lane = simplify(sweep(ivs, from, to).lane, minSeg).filter(x => x[2] !== 'idle');
    const alive = list.filter(a => a.end >= from && a.start <= to);
    if (!alive.length && !lane.length) continue;
    rows.push({ key, label: key === 'Reviews' ? 'Reviews' : nameOf(key) || 'agents', sub: key === 'Reviews' ? 'verifier, screen judge' : `${list.length} agent${list.length === 1 ? '' : 's'}`, lane, agents: alive.length, who: list.map(a => a.agent?.description || a.agent?.agentType || a.id) });
  }
  for (const r of rows) for (const [a, b] of asleep) r.lane.push([a, b, 'asleep']);

  // What is running right now: the main thread and every agent that is mid-work.
  const status = s.status(now);
  const nowList = [{ who: 'Main thread', type: 'main', ...status }];
  for (const a of s.activeAgents(now)) {
    const st = a.status(now);
    nowList.push({ who: a.agent?.description || a.id, id: a.id, parent: parentOf(a), depth: depthOf(a), type: a.agent?.agentType || 'agent', where: nameOf(workspaceOf(a, s.cwd)), start: a.start, ...st });
  }

  // Recent tool calls across the main thread and agents.
  const feed = [];
  for (const x of [s, ...agents]) {
    for (const t of x.tools) {
      if (t.start < from - 60e3 && (t.end ?? now) < from) continue;
      feed.push({ t: t.start, end: t.end, cat: t.cat, desc: t.desc, ok: t.ok, who: x.agent ? (x.agent.description || x.agent.agentType) : 'Main thread', bg: !!t.background });
    }
  }
  feed.sort((a, b) => b.t - a.t);

  // Plan and progress.
  const tasks = [...s.tasks.values()].filter(t => t.id && !String(t.id).startsWith('pending:')).map(t => ({ id: t.id, subject: t.subject, status: t.status, active: t.active, t: t.t }));
  const commits = [s, ...agents].flatMap(x => x.commits.map(c => ({ ...c, who: x.agent ? x.agent.description : 'Main thread' }))).sort((a, b) => b.t - a.t);
  const events = [s, ...agents].flatMap(x => x.events.map(e => ({ ...e, who: x.agent ? x.agent.description : 'Main thread' })))
    .concat([s, ...agents].flatMap(x => x.gate.map(g => ({ t: g.t, kind: g.ok ? 'gatePass' : 'gateFail', text: g.text, who: x.agent ? x.agent.description : 'proof gate' }))))
    .concat(commits.map(c => ({ t: c.t, kind: 'commit', text: `${c.sha.slice(0, 7)} ${c.msg}`, who: c.who })))
    .filter(e => e.t >= from - 1).sort((a, b) => b.t - a.t);

  // Findings: the patterns that cost the most time in past builds.
  const allTools = [s, ...agents].flatMap(x => x.tools.filter(t => t.end));
  const ceiling = allTools.filter(t => t.end - t.start >= 590e3 && t.end - t.start < 700e3);
  const polls = allTools.filter(t => /(^|[;&|]\s*)(until|while)\s[^;]*;\s*do\s+sleep/.test(t.cmd || ''));
  const e2e = allTools.filter(t => /npm run e2e|playwright test|maestro test|detox test/.test(t.cmd || ''));
  const specs = {};
  for (const t of e2e) for (const m of (t.cmd.match(/[\w-]+\.spec\.ts/g) || [])) specs[m] = (specs[m] || 0) + 1;
  const topSpec = Object.entries(specs).sort((a, b) => b[1] - a[1])[0];
  const sumMs = list => list.reduce((n, t) => n + (t.end - t.start), 0);
  const counts = { ...s.counts };
  for (const a of agents) for (const [k, v] of Object.entries(a.counts)) counts[k] = (counts[k] || 0) + v;

  const byType = {};
  for (const a of agents) { const k = a.agent?.agentType || 'agent'; byType[k] = (byType[k] || 0) + 1; }
  // Work items: the agents Claude launched, newest first, with what became of them. A build that keeps no task
  // list still shows its units this way.
  const activeIds = new Set(s.activeAgents(now).map(a => a.id));
  const units = agents.filter(a => !REVIEW.test(a.agent?.agentType || '') && a.start <= now)
    .map(a => ({ id: a.id, parent: parentOf(a), depth: depthOf(a), desc: a.agent?.description || a.id, type: a.agent?.agentType || 'agent', prompt: callOf(a.agent?.toolUseId)?.agentPrompt || '', result: activeIds.has(a.id) ? '' : String(a.lastText || '').trim().slice(0, 400), where: nameOf(workspaceOf(a, s.cwd)), start: a.start, end: activeIds.has(a.id) ? null : a.end, running: activeIds.has(a.id), commits: a.commits.length, errors: a.counts.toolErrors }))
    .sort((x, y) => (y.running - x.running) || y.start - x.start);
  // The whole launch tree, reviews included, so a child of a verifier still has its parent in the list.
  const tree = [{ id: 'main', parent: null, depth: 0, name: 'Main thread', type: 'main', running: BUSY_STATES.has(status.state), start: s.start, end: null, commits: s.commits.length }]
    .concat(agents.map(a => ({ id: a.id, parent: parentOf(a), depth: depthOf(a), name: a.agent?.description || a.id, type: a.agent?.agentType || 'agent', running: activeIds.has(a.id), start: a.start, end: activeIds.has(a.id) ? null : a.end, commits: a.commits.length })))
    .sort((x, y) => x.depth - y.depth || x.start - y.start);

  return {
    id: s.id, title: s.title || 'Untitled session', cwd: s.cwd, project: nameOf(s.cwd), branch: s.branch, model: s.model,
    agent: s.harness || 'claude', agentLabel: s.harnessLabel || 'Claude',
    start: s.start, last: Math.max(s.end, ...agents.map(a => a.end)), to, from,
    status, now: nowList,
    rows, asleep,
    share: whole.share, busyMs: whole.busyMs, parallel: whole.parallel, windowShare: win.share,
    tasks, units: units.slice(0, 60), unitsDone: units.filter(u => !u.running).length, tree, commits: commits.slice(0, 40), events: events.slice(0, 120), feed: feed.slice(0, 120),
    prompts: s.prompts.slice(-6).map(p => ({ t: p.t, text: p.text })), away: s.away,
    agents: { total: agents.length, active: nowList.length - 1, byType },
    counts,
    stuck: nowList.filter(n => n.state === 'working' && now - n.since >= STUCK_MS).length,
    findings: {
      asleepMs: (s.asleep || []).reduce((n, [a, b]) => n + (b - a), 0), asleepN: (s.asleep || []).length,
      waitMs: whole.share.waitUser || 0,
      ceilingN: ceiling.length, ceilingMs: sumMs(ceiling),
      pollN: polls.length, pollMs: sumMs(polls),
      e2eN: e2e.length, e2eMs: sumMs(e2e), topSpec: topSpec ? { name: topSpec[0], n: topSpec[1] } : null,
      longest: allTools.sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5).map(t => ({ ms: t.end - t.start, desc: t.desc, cat: t.cat })),
    },
  };
}

// ---- the whole page ---------------------------------------------------------------------------------------------------

export function board(sessions, { now = Date.now(), windowMs = 6 * 3600e3, machine = null, replay = null, live = true } = {}) {
  const views = sessions.map(s => sessionView(s, now, windowMs)).sort((a, b) => rank(b, now) - rank(a, now));
  const rc = recapOf(now);
  for (const v of views) v.recap = rc.session(v.id);
  return {
    version: VERSION, now, windowMs, replay, live,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
    machine,
    recap: rc.data,
    sessions: views,
  };
}

// ---- what proof caught (the "What proof caught" card), from the ledger ------------------------------------------------
// All time, the last 7 days (calendar days, today last) and each session. The bars: catches per week for the last 12
// weeks (7-day spans ending now) and per day for the 7 days. The monitor asks every 2 seconds, so the ledger is read
// and tallied at most every 30 seconds. While the first backfill is still reading Claude's logs, `reading` says how far
// it got and the card shows that instead.
const RECAP_MS = 30e3, DAY = 864e5, WEEK = 7 * DAY;
let recapMemo = null;
const recapNums = t => ({ runs: t.runs, caught: t.caught, commitsBlocked: t.commitsBlocked, askedUser: t.askedUser, gaveUp: t.gaveUp, flaky: t.flaky, checkMs: t.checkMs, sessions: t.sessions });

function backfillReading() {
  if (backfillDone()) return null;
  try { if (Date.now() - statSync(`${markerPath()}.lock`).mtimeMs > 600e3) return null; } catch { return null; }   // none running
  try { const p = JSON.parse(readFileSync(progressPath(), 'utf8')); return { done: Number(p.done) || 0, total: Number(p.total) || 0 }; } catch { return { done: 0, total: 0 }; }
}

export function recapOf(now = Date.now(), { path = ledgerPath() } = {}) {
  const reading = backfillReading();
  const stale = !recapMemo || recapMemo.path !== path || now < recapMemo.at || now - recapMemo.at >= RECAP_MS || (recapMemo.reading && !reading);
  if (stale) {
    const entries = readLedger({ path }).filter(e => e.t <= now);
    const upTo = end => entries.filter(e => e.t < end);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const dayStart = i => { const d = new Date(today); d.setDate(d.getDate() - i); return d.getTime(); };   // DST-safe
    const weeks = Array.from({ length: 12 }, (_, i) => tally(upTo(now - (11 - i) * WEEK + (i === 11 ? 1 : 0)), { from: now - (12 - i) * WEEK }).caught);
    const days = Array.from({ length: 7 }, (_, i) => tally(upTo(i === 6 ? now + 1 : dayStart(5 - i)), { from: dayStart(6 - i) }).caught);
    const bySession = new Map();
    for (const e of entries) if (e.session) { if (!bySession.has(e.session)) bySession.set(e.session, []); bySession.get(e.session).push(e); }
    recapMemo = { at: now, path, bySession, per: new Map(), data: {
      all: { ...recapNums(tally(entries)), bars: weeks },
      week: { ...recapNums(tally(entries, { from: dayStart(6) })), bars: days },
    } };
  }
  recapMemo.reading = reading;
  const memo = recapMemo;
  return {
    data: { ...memo.data, reading },
    session: id => {
      if (!memo.per.has(id)) memo.per.set(id, recapNums(tally(memo.bySession.get(id) || [])));
      return memo.per.get(id);
    },
  };
}

// Busy sessions first, then the most recently active.
function rank(v, now) {
  const busy = /working|thinking|agents|approval/.test(v.status.state) ? 1e15 : 0;
  return busy + v.last;
}

export function renderPage(data) {
  const html = readFileSync(process.env.PROOF_DASHBOARD_HTML || join(here, 'dashboard.html'), 'utf8');
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return html.replace('/*__PROOF_DATA__*/', () => `window.__PROOF_DATA__ = ${json};`);
}

// ---- example data for the memory panel when replaying old logs (logs carry no memory readings) ------------------------

export function exampleMachine(at) {
  const total = 24576;
  const samples = [];
  for (let t = at - 3 * 3600e3, i = 0; t <= at; t += 60e3, i++) {
    const wave = 66 + 7 * Math.sin(i / 23) + 4 * Math.sin(i / 7.3) + (i > 150 ? 6 : 0);
    samples.push([t, Math.min(84.2, Math.max(55, wave))]);
  }
  const pct = samples[samples.length - 1][1];
  const used = (pct / 100) * total;
  const apps = [
    { name: 'Docker (3 local Supabase stacks)', mb: 5300, claude: true },
    { name: 'Google Chrome', mb: 4200, claude: false },
    { name: 'Claude Code (3 sessions)', mb: 2100, claude: true },
    { name: 'Expo / Metro (3 dev servers)', mb: 2600, claude: true },
    { name: 'Xcode', mb: 1900, claude: false },
    { name: 'Playwright', mb: 900, claude: true },
    { name: 'Slack', mb: 700, claude: false },
  ];
  return {
    example: true,
    system: { totalMB: total, usedMB: used, pct, warnPct: 75, ceilingPct: 90, pressure: pct > 80 ? 'warn' : 'normal', swapMB: 1300, headroomMB: 0.9 * total - used, platform: 'darwin' },
    samples, apps, keepAwake: { on: true },
    runs: [
      { pid: 48211, mb: 1120, command: 'node node_modules/.bin/expo start --web --port 8084', cwd: '/x/app' },
      { pid: 47102, mb: 860, command: 'npx playwright test -c e2e/playwright.config.ts e2e/today.spec.ts', cwd: '/x/app' },
    ],
    advice: {
      userApps: [{ name: 'Google Chrome', mb: 4200 }, { name: 'Xcode', mb: 1900 }],
      text: 'Closing Google Chrome and Xcode would free about 5.9 GB, so the three lanes can run their checks side by side instead of taking turns.',
    },
  };
}

// ---- CLI --------------------------------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
  const logs = arg('--logs');
  if (!logs) { console.error('usage: node dashboard.mjs --logs <project-dir> [--session id] [--at ISO] [--window 6h] --out page.html [--json]'); process.exit(2); }
  const ats = String(arg('--at', '')).split(',').filter(Boolean);
  const labels = String(arg('--labels', '')).split('|');
  const win = String(arg('--window', '6h'));
  const windowMs = Number.parseFloat(win) * (win.endsWith('m') ? 60e3 : 3600e3);
  const want = arg('--session');
  const make = at => {
    let sessions = loadSessions([logs], { until: at });
    if (want) sessions = sessions.filter(s => s.id.startsWith(want));
    const now = at || Math.max(...sessions.map(s => s.end));
    return board(sessions, { now, windowMs, machine: exampleMachine(now), replay: { at: now, source: arg('--name', basename(logs)) }, live: false });
  };
  const data = ats.length > 1 ? { moments: ats.map((a, i) => ({ label: labels[i] || a, data: make(Date.parse(a)) })) } : make(ats[0] ? Date.parse(ats[0]) : null);
  const out = arg('--out', 'proof-dashboard.html');
  if (process.argv.includes('--json')) writeFileSync(out, JSON.stringify(data));
  else writeFileSync(out, renderPage(data));
  const sessions = { length: data.moments ? data.moments[0].data.sessions.length : data.sessions.length };
  console.log(`wrote ${out} (${sessions.length} session(s), ${(JSON.stringify(data).length / 1024).toFixed(0)} KB of data)`);
}

export { normCmd };
