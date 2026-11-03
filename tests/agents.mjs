// Checks every agent adapter against its fixtures (tests/fixtures/agents/<agent>/*.json). Each fixture is one hook call:
//   { "source": where the input shape comes from, "kind": the event the script handles,
//     "input": the agent's raw hook input, "event": fields the normalised event must have,
//     "result": a normalised result, "output": { stdout, stderr, code } the adapter must produce for it }
// Prints one line per fixture; exits 1 on any failure.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { ADAPTERS } = await import(join(here, '..', 'plugins', 'proof', 'scripts', 'agents', 'index.mjs'));
const dir = process.argv[2] || join(here, 'fixtures', 'agents');

const KINDS = ['sessionStart', 'userPrompt', 'beforeTool', 'afterTool', 'turnEnd'];
const TOOLS = ['shell', 'edit', 'subagent', 'browser', 'other'];
const strOrNull = v => v === null || typeof v === 'string';

// The normalised event, as docs/agents.md describes it.
export function shapeErrors(ev) {
  const e = [];
  if (typeof ev?.agent !== 'string') e.push('agent must be a string');
  if (!KINDS.includes(ev?.kind)) e.push(`kind must be one of ${KINDS.join(', ')}`);
  for (const k of ['session', 'turn', 'cwd', 'lastMessage', 'source']) if (!strOrNull(ev?.[k])) e.push(`${k} must be a string or null`);
  if (!(ev?.continuation === null || typeof ev?.continuation === 'boolean')) e.push('continuation must be true, false or null');
  if (!(ev?.round === null || Number.isInteger(ev?.round))) e.push('round must be an integer or null');
  if (ev?.tool !== undefined) {
    if (!TOOLS.includes(ev.tool?.name)) e.push(`tool.name must be one of ${TOOLS.join(', ')}`);
    if (!ev.tool?.input || typeof ev.tool.input !== 'object') e.push('tool.input must be an object');
  }
  return e;
}

let failed = 0, n = 0;
const fail = (id, why) => { failed++; console.log(`  FAIL  ${id}: ${why}`); };
for (const agent of readdirSync(dir).sort()) {
  const adapter = ADAPTERS[agent];
  for (const f of readdirSync(join(dir, agent)).filter(x => x.endsWith('.json')).sort()) {
    n++;
    const id = `${agent}/${f}`;
    let fx;
    try { fx = JSON.parse(readFileSync(join(dir, agent, f), 'utf8')); } catch (e) { fail(id, `bad JSON: ${e.message}`); continue; }
    if (typeof fx.source !== 'string' || !fx.source.trim()) { fail(id, 'no source: say where this input shape comes from (docs URL and date, or "captured live from <agent> <version>")'); continue; }
    if (!adapter) { fail(id, `no adapter named ${agent}`); continue; }
    const ev = adapter.parse(fx.input, fx.kind);
    const errs = shapeErrors(ev);
    if (errs.length) { fail(id, `event shape: ${errs.join('; ')}`); continue; }
    const wrong = Object.entries(fx.event || {}).filter(([k, v]) => !isDeepStrictEqual(ev[k], v));
    if (wrong.length) { fail(id, `event: ${wrong.map(([k, v]) => `${k} is ${JSON.stringify(ev[k])}, want ${JSON.stringify(v)}`).join('; ')}`); continue; }
    if (fx.output) {
      const out = adapter.render(ev, fx.result || {});
      const want = { stdout: '', stderr: '', code: 0, ...fx.output };
      if (typeof want.stdout === 'object') want.stdout = JSON.stringify(want.stdout);
      if (!isDeepStrictEqual(out, want)) { fail(id, `output is ${JSON.stringify(out)}, want ${JSON.stringify(want)}`); continue; }
    }
    console.log(`  ok    ${id}`);
  }
}
console.log(`\n${n - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
