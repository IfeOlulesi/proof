#!/usr/bin/env node
// proof:discover check — is this spec buildable and verifiable?
// Usage: node check-spec.mjs [SPEC.md] [features.json]     Exit 0 pass, 1 fail.
import { existsSync, readFileSync } from 'node:fs';

const [specPath = 'SPEC.md', featPath = 'features.json'] = process.argv.slice(2);
const fails = [];

if (!existsSync(specPath)) {
  console.log(`FAIL spec: ${specPath} not found — start from the discover skill's templates/SPEC.md`);
  process.exit(1);
}
const lines = readFileSync(specPath, 'utf8').split('\n');

// Sections by heading.
const sections = [];
lines.forEach((l, i) => { const m = l.match(/^#{1,4}\s+(.+?)\s*$/); if (m) sections.push({ title: m[1].toLowerCase(), start: i }); });
sections.forEach((s, i) => { s.end = i + 1 < sections.length ? sections[i + 1].start : lines.length; });
const find = rx => sections.find(s => rx.test(s.title));

const REQUIRED = [
  ['Goal', /^(the )?goals?\b|^problem|^why\b/],
  ['Non-goals', /non[- ]?goals?|out of scope/],
  ['Users', /^(target |primary )?users\b|who it'?s for|audience|personas?/],
  ['Core flows', /flows?\b|journeys?|scenarios|use cases/],
  ['Acceptance criteria', /acceptance|criteria|definition of done/],
  ['Risks and assumptions', /risks?|assumptions?/],
  ['Open questions', /open questions|unknowns/],
];
for (const [label, rx] of REQUIRED) if (!find(rx)) fails.push(`spec: missing section "${label}"`);

// Every acceptance criterion needs "verify:" (on its line or an indented continuation line).
const ac = find(/acceptance|criteria|definition of done/);
let criteria = 0;
if (ac) {
  const body = lines.slice(ac.start + 1, ac.end);
  const items = [];
  let topIndent = null;
  body.forEach((l, k) => {
    const m = l.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (m && (topIndent === null || m[1].length <= topIndent)) {
      topIndent ??= m[1].length;
      items.push({ line: ac.start + 2 + k, text: m[2], all: m[2] });
    } else if (items.length && l.trim()) items[items.length - 1].all += ` ${l.trim()}`;
  });
  criteria = items.length;
  if (!items.length) fails.push('spec: "Acceptance criteria" has no list items');
  for (const it of items) if (!/verify:\s*\S/i.test(it.all)) fails.push(`spec:${it.line} criterion has no "verify:" — ${it.text.slice(0, 70)}`);
}

// Leftover template tokens and placeholders (open questions may legitimately say TBD).
const oq = find(/open questions|unknowns/);
lines.forEach((l, i) => {
  if (oq && i > oq.start && i < oq.end) return;
  if (/\{\{.*?\}\}/.test(l)) fails.push(`spec:${i + 1} template text left in — ${l.trim().slice(0, 70)}`);
  else if (/\b(TBD|TODO|FIXME|XXX)\b|lorem ipsum/i.test(l)) fails.push(`spec:${i + 1} placeholder — ${l.trim().slice(0, 70)}`);
});

// features.json
let features = [];
if (!existsSync(featPath)) fails.push(`features: ${featPath} not found — list buildable units with "passes": false`);
else {
  let j = null;
  try { j = JSON.parse(readFileSync(featPath, 'utf8')); } catch (e) { fails.push(`features: invalid JSON (${e.message})`); }
  if (j) {
    features = Array.isArray(j) ? j : Array.isArray(j.features) ? j.features : null;
    if (!features) { fails.push('features: expected {"features": [...]} or an array'); features = []; }
    if (j && !features.length) fails.push('features: no entries');
    const seen = new Set();
    features.forEach((f, i) => {
      const at = `features[${i}]${f?.id ? ` (${f.id})` : ''}`;
      if (!f || typeof f !== 'object') return fails.push(`${at}: not an object`);
      if (!f.id) fails.push(`${at}: missing id`);
      else if (seen.has(f.id)) fails.push(`${at}: duplicate id`);
      else seen.add(f.id);
      if (!f.title && !f.description) fails.push(`${at}: missing title`);
      if (typeof f.verify !== 'string' || !f.verify.trim()) fails.push(`${at}: missing "verify" (how it will be proven)`);
      if (typeof f.passes !== 'boolean') fails.push(`${at}: "passes" must be true or false`);
      if (f.passes === true && !(typeof f.evidence === 'string' && f.evidence.trim())) fails.push(`${at}: passes is true but "evidence" is empty`);
    });
  }
}

for (const f of fails) console.log(`FAIL ${f}`);
const passing = features.filter(f => f && f.passes === true).length;
console.log(fails.length
  ? `\n${fails.length} issue(s).`
  : `PASS spec: ${criteria} acceptance criteria, all with verify:; ${features.length} features (${passing} passing).`);
process.exit(fails.length ? 1 : 0);
