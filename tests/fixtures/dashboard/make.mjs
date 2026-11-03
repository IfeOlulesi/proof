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
const NOW = at(14, 34);
const min = m => m * 60e3, sec = s => s * 1e3;

// ---- the mockup's seeded sample data, ported verbatim (mockup/app.html), so charts draw the same segments -----------
// The calls must stay in the mockup's order: each one moves the seed.
const H = 3600e3, M = 60e3;
let seed = 7; const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = w => { let r = rnd() * Object.values(w).reduce((a, b) => a + b, 0); for (const [k, v] of Object.entries(w)) { if ((r -= v) <= 0) return k; } return Object.keys(w)[0]; };
function fill(a, b, w, min = 15e3, max = 150e3) { const out = []; let t = a; while (t < b) { const d = Math.min(b - t, min + rnd() * (max - min)); out.push([t, t + d, pick(w)]); t += d + (rnd() < .25 ? 4e3 + rnd() * 20e3 : 0); } return out; }
const W_BUILD = { think: 4, work: 3, check: 2, cmd: 1 }, W_TEST = { think: 2, work: 2, check: 5, cmd: 1 }, W_READ = { think: 3, work: 6, cmd: 1 };
const CK = { start: at(12, 52) };
CK.main = [...fill(at(12, 52), at(13, 5), W_READ), [at(13, 5), at(13, 14, 2), 'you'], ...fill(at(13, 14, 2), at(13, 30), W_BUILD), [at(13, 30), at(13, 37), 'you'], ...fill(at(13, 37), at(13, 58), W_BUILD), [at(13, 58), at(14, 4), 'you'], ...fill(at(14, 4), at(14, 14), W_BUILD), [at(14, 14), at(14, 17), 'idle'], ...fill(at(14, 17), at(14, 31), W_BUILD), [at(14, 31), NOW, 'cmd']];
CK.agents = [
  { id: 'explore', start: at(13, 16), end: at(13, 20), w: W_READ },
  { id: 'lane-a', start: at(13, 20), end: at(13, 38), w: W_BUILD },
  { id: 'lane-b', start: at(14, 14), end: null, w: W_BUILD, tail: 'check' },
  { id: 'lane-c', start: at(14, 31, 20), end: null, w: W_BUILD },
  { id: 'verifier', start: at(14, 33, 12), end: null, w: W_READ },
];
for (const a of CK.agents) { a.segs = fill(a.start, (a.end || NOW) - (a.tail ? 6 * M + 12e3 : 0), a.w, 10e3, 90e3); if (a.tail) a.segs.push([NOW - 6 * M - 12e3, NOW, a.tail]); }
const segsOf = id => CK.agents.find(a => a.id === id).segs;
CK.gates = [[at(13, 12), 1, 'types, lint, test'], [at(13, 31), 1, 'types, lint, test'], [at(13, 38), 1, '6 checks'], [at(13, 52), 1, '6 checks'], [at(14, 5), 1, '6 checks'], [at(14, 22), 1, '6 checks in 2m 40s'], [at(14, 25), 1, '6 checks in 2m 40s'], [at(14, 27), 0, 'checkout.spec.ts › rejects expired card']];
CK.commits = [at(13, 24), at(13, 29), at(13, 36), at(13, 40), at(13, 47), at(13, 55), at(14, 2), at(14, 9), at(14, 13), at(14, 19), at(14, 25), at(14, 25, 30), at(14, 29), at(14, 33)];
const memSeries = (base, end) => { const out = []; let v = base; for (let t = NOW - 6 * H; t <= NOW; t += 2 * M) { v += (rnd() - .5) * 2.2 + (end - v) * .012; out.push([t, Math.max(40, Math.min(95, v))]); } out[out.length - 1][1] = end; return out; };
const MEM_OK = memSeries(58, 68), MEM_HI = memSeries(70, 85);
const AD = { start: at(12, 31) - 49 * H, ask: NOW - (49 * H + 35 * M) };
AD.segs = [...fill(AD.ask - 52 * M, AD.ask - 12 * M, W_BUILD), ...fill(AD.ask - 12 * M, AD.ask - 2 * M, W_TEST), [AD.ask - 2 * M, AD.ask, 'check'], [AD.ask, AD.ask + 8 * M, 'you']];
const RL = { start: NOW - 65 * M, end: NOW - 41 * M };
RL.segs = [...fill(RL.start, RL.start + 3 * M, W_READ), [RL.start + 3 * M, RL.start + 30 * M, 'you'], ...fill(RL.start + 30 * M, RL.end - 8 * M, W_BUILD), [RL.end - 8 * M, RL.end - 5 * M + 16e3, 'cmd'], [RL.end - 5 * M + 16e3, RL.end - 3 * M, 'cmd'], ...fill(RL.end - 3 * M, RL.end, W_BUILD), [RL.end, NOW, 'you']];
const DC = { start: NOW - 52 * M, last: NOW - 18 * M - 4e3 };
DC.segs = [...fill(DC.start, DC.last - 2 * M, { think: 3, work: 6, cmd: 1 }), [DC.last - 2 * M, DC.last, 'cmd'], [DC.last, NOW, 'idle']];
// The mockup's six activity groups as feed categories (the page groups them back the same way).
const FEED_CAT = { think: 'model', work: 'edit', cmd: 'shell', check: 'test', you: 'waitUser', idle: 'idle' };
const asBlocks = segs => segs.map(([a, b, c]) => [a, b, FEED_CAT[c]]);

const machine = (pct = 68) => ({
  system: { platform: 'darwin', totalMB: 24576, usedMB: 24576 * pct / 100, pct, warnPct: 75, ceilingPct: 93, headroomMB: 24576 * (93 - pct) / 100, pressure: pct >= 75 ? 'warn' : 'normal', swapMB: 14915 },
  samples: pct >= 75 ? MEM_HI : MEM_OK, apps: [], runs: [],
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
  // Steps as the mockup draws them: reading 1m, editing 5m, then tests, a commit, the gate, a fix and the e2e run.
  ['Read mockup/app.html', 'Read SPEC.md', 'Search for the card form', 'Read src/screens/Cart.tsx'].forEach((d, i) => add(t0 + i * (58e3 / 3), 2e3, 'read', d));
  for (let i = 0; i < 30; i++) add(at(14, 18, 20) + i * (299e3 / 29), 1e3, 'edit', `Edit src/screens/Payment${i % 3 ? 'Form' : ''}.tsx`);
  add(at(14, 24), 41e3, 'test', 'Run the unit tests');
  add(at(14, 25), 1e3, 'git', 'Commit the payment form');
  add(at(14, 27), 58e3, 'gate', 'Gate: test failed, rejects expired card', false);
  add(at(14, 29), 1e3, 'read', 'Read src/lib/card.ts');
  add(at(14, 30), 2e3, 'edit', 'Edit src/screens/Payment.tsx');
  add(at(14, 31), null, 'test', 'npx playwright test checkout.spec.ts');   // labelled 14:31 in the mockup; timed from the step's start (6:12)
  return out.sort((a, b) => b.t - a.t);
};

// The timeline: one lane per worktree, from the mockup's seeded segments.
const lanes = () => [
  { key: 'main', label: 'Main thread', sub: 'orchestrates, talks to you', lane: asBlocks(CK.main) },
  { key: '/w/lane-a', label: 'lane-a', sub: '1 agent', who: ['Lane A unit 12: cart screen'], lane: asBlocks(segsOf('lane-a')) },
  { key: '/w/lane-b', label: 'lane-b', sub: '1 agent', who: ['Lane B unit 13: payment screen'], lane: asBlocks(segsOf('lane-b')) },
  { key: '/w/lane-c', label: 'lane-c', sub: '1 agent', who: ['Lane C unit 14: order API'], lane: asBlocks(segsOf('lane-c')) },
  { key: 'Reviews', label: 'Reviews', sub: 'explore, verifier', who: ['Explore: existing payment code', 'Verifier: cart screen'], lane: asBlocks([...segsOf('explore'), ...segsOf('verifier')]) },
];

const checkout = () => {
  // The mockup's 14 commit times, oldest first, with who made each.
  const LA = 'Lane A unit 12: cart screen', LB = 'Lane B unit 13: payment screen', LC = 'Lane C unit 14: order API', MT = 'Main thread';
  const made = [[MT, 'plan for the checkout flow'], [LA, 'cart screen'], [LA, 'cart screen tests'], [LA, 'cart totals and empty state'], [MT, 'merge lane-a: cart screen'],
    [MT, 'checkout state machine'], [MT, 'wire payment route'], [MT, 'mock server for e2e'], [MT, 'api client for orders'], [MT, 'design tokens for payment'],
    [LB, 'payment form'], [LB, 'payment form validation'], [MT, 'order summary component'], [LC, 'order API types']];
  const commits = CK.commits.map((t, i) => ({ t, sha: (0xa10f00 + i * 40961).toString(16).slice(0, 7) + '0', msg: made[i][1], who: made[i][0] }));
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
      { desc: 'Lane C unit 14: order API', type: 'general-purpose', where: 'lane-c', start: at(14, 31, 20), end: null, running: true, commits: 1, errors: 0 },
      { desc: 'Lane A unit 12: cart screen', type: 'general-purpose', result: 'Cart screen is built and passes its checks; three commits on lane-a.', where: 'lane-a', start: at(13, 20), end: at(13, 38), running: false, commits: 3, errors: 0 },
      { desc: 'Explore: existing payment code', type: 'Explore', where: 'shop-app', start: at(13, 16), end: at(13, 20), running: false, commits: 0, errors: 0 },
    ],
    tasks: [...done,
      { id: '5', subject: 'Payment screen', status: 'in_progress', owner: 'Lane B' },
      { id: '6', subject: 'Order API', status: 'in_progress', owner: 'Lane C' },
      { id: '7', subject: 'Verify cart screen', status: 'in_progress', owner: 'Verifier' },
      { id: '8', subject: 'Order confirmation screen', status: 'pending' },
      { id: '9', subject: 'Full e2e pass', status: 'pending' }],
    features: { passing: 12, total: 20 },
    rows: lanes(),
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
      ...CK.gates.map(([t, ok, text]) => (ok ? { t, kind: 'gatePass', text, who: 'proof gate' } : { t, kind: 'gateFail', text, who: LB })),
      { t: at(13, 38), kind: 'agentDone', text: 'Agent finished: Lane A unit 12: cart screen', who: 'Lane A unit 12: cart screen' },
      { t: at(14, 22), kind: 'memory', text: 'proof memory: held back the verifier for 40s, the Mac was at 86%', who: 'Main thread' },
      { t: at(14, 12), kind: 'compact', text: 'Compacted context', who: 'Main thread' },
    ].concat(commits.map(c => ({ t: c.t, kind: 'commit', text: `${c.sha.slice(0, 7)} ${c.msg}`, who: c.who }))).sort((a, b) => b.t - a.t),
  });
};

// The mockup's event clock labels (13:02, 13:56, 14:16) were kept from v1's clock (now 14:37), so they sit a few
// minutes off the waits the same screens show ("waiting 49h 35m", "Idle 41m", "18:04"). The fixture places each
// event at its label and each status at its wait.
const twoDaysAgo = (h, m, s = 0) => at(h, m, s) - 48 * H;
const admin = () => session({
  id: 'admin', title: 'Admin access on production', project: 'eap_multi_agent_backend', branch: 'feat/langfuse-tracing', start: AD.start,
  status: { state: 'needsInput', since: AD.ask, label: 'Claude asked you something' },
  rows: [{ key: 'main', label: 'Main thread', sub: 'orchestrates, talks to you', lane: asBlocks(AD.segs) }],
  share: { model: min(20), edit: min(18), test: min(12), shell: min(8), waitUser: 49 * H + 35 * M },
  events: [
    { t: twoDaysAgo(13, 2, 20), kind: 'needsInput', text: 'Claude stopped to ask you something', who: 'Main thread' },
    { t: twoDaysAgo(13, 2, 10), kind: 'gateFail', text: 'proof: test still failing — Claude stopped to ask you something.', who: 'proof gate' },
    { t: twoDaysAgo(13, 1, 20), kind: 'memory', text: "proof memory: didn't start this test run. The Mac is at 85% and the run needs about 1.5 GB", who: 'Main thread' },
    { t: AD.ask - 14 * M, kind: 'gatePass', text: 'proof ✓ types, lint, test', who: 'proof gate' },
    { t: AD.ask - 25 * M, kind: 'gatePass', text: 'proof ✓ types, lint, test', who: 'proof gate' },
    { t: AD.ask - 40 * M, kind: 'gatePass', text: 'proof ✓ types, lint', who: 'proof gate' },
  ],
});

const release = () => {
  const since = RL.end, slot = i => RL.start + i * 10 * M;
  // 18 tool calls, as the mockup's bars spread them over the session: 3, 5, 2, 4, 1, 3 per 10 minutes.
  const named = [
    { t: at(13, 51, 20), end: at(13, 51, 20) + 136364, cat: 'shell', desc: 'Wait for both CI runs to finish', ok: true, who: 'Main thread' },
    { t: at(13, 40, 2), end: at(13, 40, 2) + 83584, cat: 'shell', desc: "Wait for the tag's CI run to finish", ok: true, who: 'Main thread' },
    { t: at(13, 29, 20), end: at(13, 31, 10), cat: 'waitUser', desc: 'Ask you to approve the release plan', ok: true, who: 'Main thread' },
  ];
  const per = [3, 5, 2, 4, 1, 3], fill18 = [];
  per.forEach((n, i) => { const have = named.filter(f => f.t >= slot(i) && f.t < slot(i + 1)).length; for (let k = have; k < n; k++) fill18.push({ t: slot(i) + 60e3 + k * 50e3, end: slot(i) + 60e3 + k * 50e3 + 4e3, cat: i === 4 ? 'shell' : 'read', desc: i === 4 ? 'Check the CI run' : 'Read CHANGELOG.md', ok: i !== 4, who: 'Main thread' }); });
  return session({
    id: 'release', title: 'Proof v0.4.0 release', project: 'proof', model: 'claude-opus-5-5', start: RL.start,
    status: { state: 'waiting', since, label: 'Finished — waiting for your next message' },
    rows: [{ key: 'main', label: 'Main thread', sub: 'orchestrates, talks to you', lane: asBlocks(RL.segs) }],
    commits: [{ t: at(13, 56, 10), sha: '1a27553e', msg: 'proof 0.4.0: first public release', who: 'Main thread' }],
    events: [
      { t: at(13, 56, 10), kind: 'commit', text: '1a27553 proof 0.4.0: first public release', who: 'Main thread' },
      { t: at(13, 56, 5), kind: 'commitBlocked', text: 'proof: commit refused — the command edits files before committing', who: 'proof gate' },
    ],
    feed: [...named, ...fill18].sort((a, b) => b.t - a.t),
    share: { model: min(2), shell: min(4), waitUser: min(58), idle: sec(20) },
    counts: { toolCalls: 18, commitBlocks: 1, toolErrors: 1 },
    findings: { longest: [
      { ms: 136364, desc: 'Wait for both CI runs to finish', cat: 'shell' },
      { ms: 83584, desc: "Wait for the tag's CI run to finish", cat: 'shell' },
      { ms: 11132, desc: 'Verify identical tree, re-point tag, force-push main and tag', cat: 'git' },
    ] },
  });
};

const docs = () => session({
  id: 'docs', title: 'API docs refresh', project: 'shop-app', branch: 'docs/api', start: DC.start,
  status: { state: 'stalled', since: DC.last, label: 'No activity for a while' },
  rows: [{ key: 'main', label: 'Main thread', sub: 'orchestrates, talks to you', lane: asBlocks(DC.segs) }],
  share: { model: min(12), edit: min(19), shell: min(3), idle: min(18) },
  feed: [
    { t: at(14, 16), end: at(14, 16), cat: 'build', desc: 'pnpm docs:build', ok: true, who: 'Main thread' },
    { t: at(14, 15, 30), end: at(14, 15, 31), cat: 'edit', desc: 'Edit docs/api/orders.md', ok: true, who: 'Main thread' },
  ],
  commits: [{ t: at(14, 13, 5), sha: '7c1e0b29', msg: 'docs: order endpoints', who: 'Main thread' }],
  events: [{ t: at(14, 13, 5), kind: 'commit', text: '7c1e0b2 docs: order endpoints', who: 'Main thread' }],
  tasks: [
    { id: '1', subject: 'Audit endpoints against code', status: 'completed' },
    { id: '2', subject: 'Rewrite order endpoints', status: 'completed' },
    { id: '3', subject: 'Rewrite payment endpoints', status: 'pending' },
  ],
});

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
  m.samples = MEM_HI;
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
