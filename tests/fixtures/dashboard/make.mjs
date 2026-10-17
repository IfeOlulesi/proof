#!/usr/bin/env node
// Writes the dashboard fixtures: data.json feeds that reproduce the sample data in mockup/app.html, one per screen.
// The page reads one with ?data=/tests/fixtures/dashboard/<screen>.json and stops its clock at the feed's `now`.
// Times are built in local time, so clock labels (14:31) match the mockup on any machine. Re-run after editing:
//   node tests/fixtures/dashboard/make.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const at = (h, m, s = 0) => { const d = new Date(2026, 9, 17, h, m, s); return d.getTime(); };
const NOW = at(14, 37, 12);
const min = m => m * 60e3, sec = s => s * 1e3;

const machine = (pct = 68) => ({
  system: { platform: 'darwin', totalMB: 24576, usedMB: 24576 * pct / 100, pct, warnPct: 75, ceilingPct: 93, headroomMB: 24576 * (93 - pct) / 100, pressure: pct >= 75 ? 'warn' : 'normal', swapMB: 14915 },
  samples: [], apps: [], runs: [],
  advice: { text: '', userApps: [{ name: 'Brave Browser', mb: 3914 }, { name: 'OrbStack', mb: 2691 }] },
  keepAwake: { on: true, enabled: true }, asleep: [],
});

// A session with every field the page reads, so a fixture only spells out what its screen shows.
const session = o => ({
  id: o.id, title: o.title, cwd: `/Users/you/code/${o.project}`, project: o.project, branch: o.branch || 'main', model: o.model || null,
  start: o.start, last: NOW, to: NOW, from: o.start,
  status: o.status, now: [{ who: 'Main thread', type: 'main', ...o.status }, ...(o.jobs || [])],
  rows: o.rows || [], asleep: [], share: o.share || {}, busyMs: o.busyMs || 0, parallel: o.parallel || 1, windowShare: o.share || {},
  tasks: o.tasks || [], units: o.units || [], unitsDone: (o.units || []).filter(u => !u.running).length,
  features: o.features || null, commits: o.commits || [], events: o.events || [], feed: o.feed || [], prompts: [], away: null,
  agents: { total: (o.units || []).length, active: (o.jobs || []).length, byType: {} },
  counts: { toolCalls: 0, edits: 0, testRuns: 0, gateRounds: 0, commitBlocks: 0, guardStops: 0, memoryStops: 0, compactions: 0, apiErrors: 0, interrupts: 0, approvals: 0, toolErrors: 0, agentsLaunched: 0, ...(o.counts || {}) },
  stuck: 0,
  findings: { asleepMs: 0, asleepN: 0, waitMs: 0, ceilingN: 0, ceilingMs: 0, pollN: 0, pollMs: 0, e2eN: 0, e2eMs: 0, topSpec: null, longest: [], ...(o.findings || {}) },
});

// ---- the sessions in the switcher -----------------------------------------------------------------------------------

// Lane B's 40 tool calls, oldest first: reading, editing, unit tests, a commit, a failing gate, a fix, the e2e run.
const laneB = () => {
  const who = 'Lane B unit 13: payment screen', out = [];
  const add = (t, ms, cat, desc, ok = true) => out.push({ t, end: ms == null ? null : t + ms, cat, desc, ok: ms == null ? null : ok, who, bg: false });
  const t0 = NOW - min(20);
  ['Read mockup/app.html', 'Read SPEC.md', 'Search for the card form', 'Read src/screens/Cart.tsx'].forEach((d, i) => add(t0 + i * 20e3, 2e3, 'read', d));
  for (let i = 0; i < 30; i++) add(at(14, 18, 20) + i * 11e3, 1e3, 'edit', `Edit src/screens/Payment${i % 3 ? 'Form' : ''}.tsx`);
  add(at(14, 24), 41e3, 'test', 'Run the unit tests');
  add(at(14, 25), 1e3, 'git', 'Commit the payment form');
  add(at(14, 27), 58e3, 'gate', 'Gate: test failed, rejects expired card', false);
  add(at(14, 29), 1e3, 'read', 'Read src/lib/card.ts');
  add(at(14, 30), 2e3, 'edit', 'Edit src/screens/Payment.tsx');
  add(NOW - sec(372), null, 'test', 'npx playwright test checkout.spec.ts');
  return out.sort((a, b) => b.t - a.t);
};

// The timeline: one lane per worktree, blocks as fractions of the session (from the mockup's drawing).
const lanes = from => {
  const span = NOW - from, f = x => from + x * span;
  const lane = blocks => blocks.map(([a, w, c]) => [f(a / 100), f((a + w) / 100), c]);
  return [
    { key: 'main', label: 'Main thread', sub: 'orchestrates, talks to you', lane: lane([[0, 16, 'model'], [16, 9, 'waitUser'], [25, 12, 'edit'], [37, 6, 'asleep'], [43, 14, 'model'], [57, 4, 'idle'], [61, 39, 'model']]) },
    { key: '/w/lane-a', label: 'lane-a', sub: '1 agent', who: ['Lane A unit 12: cart screen'], lane: lane([[28, 26, 'edit'], [55, 6, 'test']]) },
    { key: '/w/lane-b', label: 'lane-b', sub: '1 agent', who: ['Lane B unit 13: payment screen'], lane: [[NOW - min(20), NOW - sec(372), 'edit'], [NOW - sec(372), NOW, 'test']] },
    { key: '/w/lane-c', label: 'lane-c', sub: '1 agent', who: ['Lane C unit 14: order API'], lane: lane([[82, 18, 'edit']]) },
    { key: 'Reviews', label: 'Reviews', sub: 'verifier, screen judge', who: ['Verifier: cart screen'], lane: lane([[58, 3, 'read'], [95, 5, 'read']]) },
  ];
};

const checkout = () => {
  const commits = [{ t: NOW - min(4), sha: '9d2c41e', msg: 'merge lane-a: cart screen', who: 'Main thread' }];
  const msgs = ['wire payment route', 'checkout state machine', 'merge lane-a: cart screen tests', 'product detail screen', 'detail screen tests', 'product list screen', 'list screen tests', 'api client', 'mock server for e2e', 'proof gate setup', 'design tokens', 'shared components', 'plan for the checkout flow'];
  msgs.forEach((msg, i) => commits.push({ t: NOW - min(6 + (i + 1) * 6), sha: (0xa10f00 + i * 4097).toString(16) + '0', msg, who: 'Main thread' }));
  commits.push({ t: at(14, 25), sha: '4be91a0', msg: 'payment form', who: 'Lane B unit 13: payment screen' });
  commits.sort((a, b) => b.t - a.t);
  const done = ['Set up proof gate', 'Product list screen', 'Product detail screen', 'Cart screen'].map((subject, i) => ({ id: String(i + 1), subject, status: 'completed' }));
  return session({
    id: 'checkout', title: 'Checkout flow build', project: 'shop-app', branch: 'feat/checkout', model: 'claude-opus-5-5', start: NOW - min(102),
    status: { state: 'agents', since: NOW - sec(372), cat: 'subagent', label: '3 background agents working', agents: 3 },
    jobs: [
      { who: 'Lane B unit 13: payment screen', type: 'general-purpose', where: 'lane-b', state: 'working', since: NOW - sec(372), cat: 'test', label: 'Running e2e tests · checkout.spec.ts › pays with saved card' },
      { who: 'Lane C unit 14: order API', type: 'general-purpose', where: 'lane-c', state: 'working', since: NOW - sec(160), cat: 'edit', label: 'Editing src/api/orders.ts' },
      { who: 'Verifier: cart screen', type: 'proof:verifier', where: 'main', state: 'working', since: NOW - sec(48), cat: 'read', label: 'Reading cart.tsx and its acceptance criteria' },
    ],
    feed: laneB(),
    units: [
      { desc: 'Lane B unit 13: payment screen', type: 'general-purpose', prompt: 'Build the payment screen to mockup/app.html#payment. Acceptance criteria F13.1 to F13.4. Commit when the gate passes.', where: 'lane-b', start: NOW - min(20), end: null, running: true, commits: 2, errors: 1 },
      { desc: 'Lane C unit 14: order API', type: 'general-purpose', where: 'lane-c', start: NOW - min(14), end: null, running: true, commits: 1, errors: 0 },
      { desc: 'Lane A unit 12: cart screen', type: 'general-purpose', result: 'Cart screen is built and passes its checks; three commits on lane-a.', where: 'lane-a', start: NOW - min(52), end: NOW - min(34), running: false, commits: 3, errors: 0 },
      { desc: 'Explore: existing payment code', type: 'Explore', where: 'shop-app', start: NOW - min(97), end: NOW - min(93), running: false, commits: 0, errors: 0 },
    ],
    tasks: [...done,
      { id: '5', subject: 'Payment screen', status: 'in_progress', owner: 'Lane B' },
      { id: '6', subject: 'Order API', status: 'in_progress', owner: 'Lane C' },
      { id: '7', subject: 'Verify cart screen', status: 'in_progress', owner: 'Verifier' },
      { id: '8', subject: 'Order confirmation screen', status: 'pending' },
      { id: '9', subject: 'Full e2e pass', status: 'pending' }],
    features: { passing: 12, total: 20 },
    rows: lanes(NOW - min(102)),
    share: { model: min(26), test: min(17), typecheck: min(1), read: min(4), edit: min(8), gate: min(7), fidelity: min(5), git: min(2), shell: min(1), build: min(1), waitUser: min(23), idle: min(4), compact: min(3) },
    busyMs: min(100), parallel: 2.34,
    counts: { compactions: 2 },
    findings: {
      waitMs: min(23), e2eN: 6, e2eMs: min(14), topSpec: { name: 'checkout.spec.ts', n: 4 },
      longest: [
        { ms: sec(542), desc: 'Ask you to approve the plan', cat: 'waitUser' },
        { ms: sec(372), desc: 'npx playwright test checkout.spec.ts', cat: 'test' },
        { ms: sec(245), desc: 'pnpm install', cat: 'build' },
        { ms: sec(160), desc: 'Gate: full check before commit', cat: 'gate' },
      ],
    },
    commits,
    events: [
      { t: at(14, 27), kind: 'gateFail', text: 'checkout.spec.ts › rejects expired card', who: 'Lane B unit 13: payment screen' },
      { t: NOW - min(12), kind: 'gatePass', text: '6 checks in 2m 40s', who: 'proof gate' },
      { t: NOW - min(34), kind: 'agentDone', text: 'Agent finished: Lane A unit 12: cart screen', who: 'Lane A unit 12: cart screen' },
      { t: at(14, 22), kind: 'memory', text: 'proof memory: held back the verifier for 40s, the Mac was at 86%', who: 'Main thread' },
      { t: at(14, 12), kind: 'compact', text: 'Compacted context', who: 'Main thread' },
    ].concat(commits.map(c => ({ t: c.t, kind: 'commit', text: `${c.sha.slice(0, 7)} ${c.msg}`, who: c.who }))).sort((a, b) => b.t - a.t),
  });
};

const admin = () => {
  const since = NOW - min(2975);
  return session({
    id: 'admin', title: 'Admin access on production', project: 'eap_multi_agent_backend', branch: 'feat/langfuse-tracing', start: since - min(60),
    status: { state: 'needsInput', since, label: 'Claude asked you something' },
    events: [
      { t: since, kind: 'needsInput', text: 'Claude stopped to ask you something', who: 'Main thread' },
      { t: since - sec(1), kind: 'gateFail', text: 'proof: test still failing — Claude stopped to ask you something.', who: 'proof gate' },
      { t: since - sec(60), kind: 'memory', text: "proof memory: didn't start this test run. The Mac is at 85% and the run needs about 1.5 GB", who: 'Main thread' },
    ],
  });
};

const release = () => {
  const since = NOW - min(41);
  return session({
    id: 'release', title: 'Proof v0.4.0 release', project: 'proof', model: 'claude-opus-5-5', start: NOW - min(65),
    status: { state: 'waiting', since, label: 'Finished — waiting for your next message' },
    commits: [{ t: since - sec(2), sha: '1a27553e', msg: 'proof 0.4.0: first public release', who: 'Main thread' }],
    events: [
      { t: since - sec(2), kind: 'commit', text: '1a27553 proof 0.4.0: first public release', who: 'Main thread' },
      { t: since - sec(7), kind: 'commitBlocked', text: 'proof: commit refused — the command edits files before committing', who: 'proof gate' },
    ],
    feed: [
      { t: at(13, 51, 20), end: at(13, 51, 20) + 136364, cat: 'shell', desc: 'Wait for both CI runs to finish', ok: true, who: 'Main thread' },
      { t: at(13, 40, 2), end: at(13, 40, 2) + 83584, cat: 'shell', desc: "Wait for the tag's CI run to finish", ok: true, who: 'Main thread' },
    ],
    share: { model: min(2), shell: min(4), waitUser: min(58), idle: sec(20) },
    counts: { toolCalls: 18, commitBlocks: 1, toolErrors: 1 },
    findings: { longest: [
      { ms: 136364, desc: 'Wait for both CI runs to finish', cat: 'shell' },
      { ms: 83584, desc: "Wait for the tag's CI run to finish", cat: 'shell' },
      { ms: 11132, desc: 'Verify identical tree, re-point tag, force-push main and tag', cat: 'git' },
    ] },
  });
};

const docs = () => {
  const since = NOW - sec(1084);
  return session({
    id: 'docs', title: 'API docs refresh', project: 'shop-app', branch: 'docs/api', start: NOW - min(52),
    status: { state: 'stalled', since, label: 'No activity for a while' },
    feed: [
      { t: since - sec(8), end: since, cat: 'build', desc: 'pnpm docs:build', ok: true, who: 'Main thread' },
      { t: at(14, 18, 30), end: at(14, 18, 31), cat: 'edit', desc: 'Edit docs/api/orders.md', ok: true, who: 'Main thread' },
    ],
    commits: [{ t: at(14, 16, 5), sha: '7c1e0b29', msg: 'docs: order endpoints', who: 'Main thread' }],
    events: [{ t: at(14, 16, 5), kind: 'commit', text: '7c1e0b2 docs: order endpoints', who: 'Main thread' }],
    tasks: [
      { id: '1', subject: 'Audit endpoints against code', status: 'completed' },
      { id: '2', subject: 'Rewrite order endpoints', status: 'completed' },
      { id: '3', subject: 'Rewrite payment endpoints', status: 'pending' },
    ],
  });
};

const brief = (id, title, project, state, ago, extra = {}) => session({ id, title, project, start: NOW - ago - min(30), status: { state, since: NOW - ago, label: '' }, ...extra });
const others = () => [
  admin(),
  brief('dash', 'Dashboard UI redesign', 'proof', 'thinking', sec(9)),
  release(),
  brief('readme', 'Proof README and description improvement', 'proof', 'waiting', min(70)),
  brief('logo', 'Proof logo', 'proof', 'waiting', min(75)),
  brief('trb', 'TRB test case documents review', 'eap_multi_agent_backend', 'waiting', min(13 * 60), { events: [{ t: at(1, 33), kind: 'memory', text: 'proof memory: not able to start another agent ("Audit Tenant Onboarding readiness") now. The Mac is at 86% and this needs about 1.2 GB, past proof\'s 85% ceiling.', who: 'Main thread' }] }),
  brief('logs', 'Multi-agent API logs analysis', 'eap_multi_agent_backend', 'waiting', min(14 * 60)),
];

// The memory view: this Mac's readings on 17 Oct (85%, apps, swap), with a sample history and sample runs.
const busyMachine = () => {
  const m = machine(84.56);
  Object.assign(m.system, { usedMB: 20782, headroomMB: 2073, swapMB: 14915 });
  const pts = [62, 63, 63, 65, 64, 66, 68, 70, 69, 72, 74, 73, 76, 78, 77, 79, 80, 82, 81, 83, 84, 86, 85, 84, 85];
  const t0 = at(9, 0);
  m.samples = pts.map((p, i) => [t0 + (i / (pts.length - 1)) * (NOW - t0), p]);
  m.apps = [{ name: 'Brave Browser', mb: 3914, n: 29, claude: false }, { name: 'OrbStack', mb: 2691, n: 2, claude: false }, { name: 'Claude Code', mb: 2130, n: 17, claude: true }, { name: 'Orca', mb: 800, n: 14, claude: false }, { name: 'Visual Studio Code', mb: 544, n: 8, claude: false }, { name: 'Claude', mb: 483, n: 5, claude: false }];
  m.runs = [
    { pgid: 501, pid: 501, mb: 1434, start: NOW - sec(372), command: 'npx playwright test checkout.spec.ts', session: 'checkout', cwd: '/Users/you/code/shop-app/.worktrees/lane-b' },
    { pgid: 502, pid: 502, mb: 610, start: NOW - min(72), command: 'pnpm dev', session: 'checkout', cwd: '/Users/you/code/shop-app/.worktrees/main' },
    { pgid: 503, pid: 503, mb: 380, start: NOW - sec(40), command: 'vitest run src/api', session: 'checkout', cwd: '/Users/you/code/shop-app/.worktrees/lane-c' },
  ];
  return m;
};

const feed = (sessions, pct) => ({ version: '0.5.0', now: NOW, windowMs: 2 * 3600e3, live: false, replay: null, categories: {}, machine: machine(pct), sessions });

// ---- one fixture per screen -----------------------------------------------------------------------------------------

const fixtures = {
  'home--working': () => feed([checkout(), ...others()]),
  'home--memory-warning': () => ({ ...feed([checkout(), ...others()]), machine: busyMachine() }),
  'switcher--hidden-needs-you': () => { const o = others(); o[4] = { ...o[4], status: { state: 'approval', since: NOW - min(3), label: 'git push' } }; return feed([checkout(), ...o]); },
  'empty': () => feed([]),
  'home--stalled': () => { const o = others(); o.splice(1, 1, docs()); return feed([checkout(), o[0], o[1], ...o.slice(2)]); },
};

for (const [name, make] of Object.entries(fixtures)) writeFileSync(join(here, `${name}.json`), `${JSON.stringify(make(), null, 1)}\n`);
console.log(`wrote ${Object.keys(fixtures).length} fixture(s) to ${here}`);
