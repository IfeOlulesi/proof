#!/usr/bin/env node
// Writes job--nested.json: a build where the main thread launches Lane A and a verifier, and Lane A launches two units of
// its own, so the agent tree has three levels. The feed is made by the real pipeline (timeline.mjs, dashboard.mjs) from
// session logs written here, so it has the shape the page gets from a real build. It keeps the machine readings of
// home--working.json, so the page draws the same chrome. Re-run after editing:
//   node tests/fixtures/dashboard/make-nested.mjs
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSessions } from '../../../plugins/proof/scripts/timeline.mjs';
import { board } from '../../../plugins/proof/scripts/dashboard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.now();
const root = mkdtempSync(join(tmpdir(), 'proof-nested-'));
const proj = join(root, 'proj'), main = join(proj, 's1.jsonl'), subs = join(proj, 's1', 'subagents');
mkdirSync(subs, { recursive: true });

// One record per line, stamped minutes before NOW.
let n = 0;
const write = (file, ago, rec) => appendFileSync(file, JSON.stringify({ ...rec, timestamp: new Date(NOW - ago * 60e3).toISOString(), uuid: `u${++n}`, sessionId: 's1', cwd: '/tmp/app' }) + '\n');
const ask = (file, ago, text) => write(file, ago, { type: 'user', message: { role: 'user', content: text } });
const call = (file, ago, name, id, input) => write(file, ago, { type: 'assistant', message: { id: `m${n}`, role: 'assistant', content: [{ type: 'tool_use', id: `t${id}`, name, input }] } });
const result = (file, ago, id, text) => write(file, ago, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${id}`, content: text }] } });
const agent = (id, ago, description, toolUseId, spawnDepth, agentType = 'general-purpose') => writeFileSync(join(subs, `agent-${id}.meta.json`), JSON.stringify({ agentType, description, toolUseId, spawnDepth }));

// The main thread: builds the checkout, launches Lane A and a verifier.
ask(main, 30, 'build the checkout');
call(main, 29, 'Agent', 1, { description: 'Lane A: cart and checkout', subagent_type: 'general-purpose', prompt: 'Build the cart and the checkout.', run_in_background: true });
result(main, 29, 1, 'Async agent launched');
call(main, 28, 'Agent', 2, { description: 'Verifier: checkout screen', subagent_type: 'verifier', prompt: 'Check the checkout screen against the mockup.', run_in_background: true });
result(main, 28, 2, 'Async agent launched');

// Lane A: launches unit 2 (still running) and unit 3 (done).
const laneA = join(subs, 'agent-a1.jsonl');
agent('a1', 29, 'Lane A: cart and checkout', 't1', 1);
call(laneA, 27, 'Agent', 3, { description: 'Lane A unit 2: cart', subagent_type: 'general-purpose', prompt: 'Build the cart page.', run_in_background: true });
result(laneA, 27, 3, 'Async agent launched');
call(laneA, 26, 'Agent', 4, { description: 'Lane A unit 3: address form', subagent_type: 'general-purpose', prompt: 'Build the address form.', run_in_background: true });
result(laneA, 26, 4, 'Async agent launched');

// Unit 2 is still at work; unit 3 has finished.
const unit2 = join(subs, 'agent-a2.jsonl'), unit3 = join(subs, 'agent-a3.jsonl');
agent('a2', 27, 'Lane A unit 2: cart', 't3', 2);
call(unit2, 3, 'Edit', 5, { file_path: '/tmp/app/src/cart.tsx' });
agent('a3', 26, 'Lane A unit 3: address form', 't4', 2);
call(unit3, 20, 'Edit', 6, { file_path: '/tmp/app/src/address.tsx' });
result(unit3, 19, 6, 'ok');
write(unit3, 19, { type: 'assistant', message: { id: `m${n}`, role: 'assistant', content: [{ type: 'text', text: 'Address form done; the form validates and saves.' }] } });

// The verifier, launched by the main thread, is a review agent: it's in the tree but not in the units list.
const verifier = join(subs, 'agent-v1.jsonl');
agent('v1', 28, 'Verifier: checkout screen', 't2', 1, 'verifier');
call(verifier, 2, 'Read', 7, { file_path: '/tmp/app/src/checkout.tsx' });

const sessions = loadSessions([proj]);
const view = board(sessions, { now: NOW, windowMs: 6 * 3600e3 });
const base = JSON.parse(readFileSync(join(here, 'home--working.json'), 'utf8'));
const feed = { ...view, live: false, replay: null, categories: base.categories, machine: base.machine };
writeFileSync(join(here, 'job--nested.json'), `${JSON.stringify(feed, null, 1)}\n`);
console.log(`wrote ${join(here, 'job--nested.json')}: ${feed.sessions.length} session(s), ${feed.sessions[0].tree.length} tree node(s)`);
