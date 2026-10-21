#!/usr/bin/env node
// proof dashboard data: turns parsed sessions (timeline.mjs) and memory readings (mem.mjs) into what the dashboard
// page draws. The live monitor (monitor.mjs) calls board() on every refresh. On its own, it replays a past build up to
// a moment and writes a self-contained page (handy for reviewing a past build, or for working on the page itself):
//   node dashboard.mjs --logs <project-dir> [--session <id-prefix>] [--at <ISO time>] [--window 6h] --out page.html
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, intervals, loadSessions, normCmd, sessionEnd, simplify, sweep } from './timeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const VERSION = '0.4.0';
const REVIEW = /verifier|judge|review/i;

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
    nowList.push({ who: a.agent?.description || a.id, type: a.agent?.agentType || 'agent', where: nameOf(workspaceOf(a, s.cwd)), ...st });
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
    .concat(s.gate.map(g => ({ t: g.t, kind: g.ok ? 'gatePass' : 'gateFail', text: g.text, who: 'proof gate' })))
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
    .map(a => ({ desc: a.agent?.description || a.id, type: a.agent?.agentType || 'agent', prompt: s.byId.get(a.agent?.toolUseId)?.agentPrompt || '', result: activeIds.has(a.id) ? '' : String(a.lastText || '').trim().slice(0, 400), where: nameOf(workspaceOf(a, s.cwd)), start: a.start, end: activeIds.has(a.id) ? null : a.end, running: activeIds.has(a.id), commits: a.commits.length, errors: a.counts.toolErrors }))
    .sort((x, y) => (y.running - x.running) || y.start - x.start);

  return {
    id: s.id, title: s.title || 'Untitled session', cwd: s.cwd, project: nameOf(s.cwd), branch: s.branch, model: s.model,
    start: s.start, last: Math.max(s.end, ...agents.map(a => a.end)), to, from,
    status, now: nowList,
    rows, asleep,
    share: whole.share, busyMs: whole.busyMs, parallel: whole.parallel, windowShare: win.share,
    tasks, units: units.slice(0, 60), unitsDone: units.filter(u => !u.running).length, commits: commits.slice(0, 40), events: events.slice(0, 120), feed: feed.slice(0, 120),
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
  return {
    version: VERSION, now, windowMs, replay, live,
    categories: Object.fromEntries(Object.entries(CATEGORIES).map(([k, v]) => [k, v.label])),
    machine,
    sessions: views,
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
