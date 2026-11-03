// Checks for proof in agents other than Claude Code, run by tests/agents.sh inside its throwaway folder:
//   node agents-check.mjs <case> <scratch folder> <repo>
// Cases: table, rules, install, session, quick. Prints one "ok"/"FAIL" line per check; exits 1 on any failure.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const P = join(here, '..', 'plugins', 'proof');
const S = join(P, 'scripts');
const { ADAPTERS } = await import(join(S, 'agents', 'index.mjs'));
const { CLAUDE_ONLY, renderRules } = await import(join(S, 'agents', 'words.mjs'));
const { CAP_COLUMNS, DOCS_LABEL, INSTALLABLE, capTable, install, plan, uninstall } = await import(join(S, 'install.mjs'));
const [, , which, T, R] = process.argv;

let failed = 0;
const check = (name, ok, why = '') => { if (!ok) failed++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || !why ? '' : ` — ${why}`}`); };
const claudeOnly = text => CLAUDE_ONLY.map(re => (text.match(re) || [])[0]).filter(Boolean);
const tree = dir => {
  const out = {};
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { out[`${relative(dir, p)}/`] = ''; walk(p); } else out[relative(dir, p)] = readFileSync(p, 'base64'); } };
  if (existsSync(dir)) walk(dir);
  return out;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The capability table: in docs/agents.md as the modules say, one row per agent, valid cells, a fixture for each "yes".
if (which === 'table') {
  const doc = readFileSync(join(P, 'docs', 'agents.md'), 'utf8');
  const m = doc.match(/<!-- capability table: generated -->\n([\s\S]*?)\n<!-- end of capability table -->/);
  check('docs/agents.md holds the capability table', !!m);
  check('the table in the docs matches the adapter modules (node scripts/install.mjs --table)', m && m[1].trim() === capTable().trim(), 'run it and paste the output');
  for (const a of Object.values(ADAPTERS)) {
    check(`${a.name}: a row in the table`, !!m && m[1].includes(`| ${a.label} |`));
    const bad = CAP_COLUMNS.filter(k => !/^(yes \(.+\)|no|unknown)$/.test(a.caps?.[k] || ''));
    check(`${a.name}: every cell is "yes (hook)", "no" or "unknown"`, !bad.length, bad.join(', '));
    const missing = CAP_COLUMNS.filter(k => /^yes/.test(a.caps[k]) && !['skills', 'subagents'].includes(k))
      .filter(k => !a.fixtureCaps?.[k] || !existsSync(join(here, 'fixtures', 'agents', a.name, `${a.fixtureCaps[k]}.json`)));
    check(`${a.name}: each "yes" has a fixture exercising it`, !missing.length, missing.join(', '));
  }
  check('every installable agent has a row', INSTALLABLE.every(n => m?.[1].includes(`| ${ADAPTERS[n].label} |`)));
}

// The rules: Claude's render is what it always was; no other agent's names a Claude-only tool.
if (which === 'rules') {
  const src = readFileSync(join(S, 'rules.md'), 'utf8').trim();
  const before = readFileSync(join(here, 'fixtures', 'rules-claude.md'), 'utf8').trim();
  check('Claude Code gets the rules word for word as before', renderRules(src, ADAPTERS.claude) === before);
  for (const n of INSTALLABLE) {
    const text = renderRules(src, ADAPTERS[n]);
    const found = claudeOnly(text);
    check(`${n}: no Claude-only names in its rules`, !found.length && !/\{\{/.test(text), found.join(', ') || 'a placeholder left');
  }
}

// Install and uninstall: into an empty project and into one with its own config; skills without Claude-only names;
// hook timeouts; the "built from docs" label.
if (which === 'install') {
  const data = join(T, 'install-data');
  const TIMEOUT = { 'session-start.mjs': 15, 'wrap.mjs': 240, 'admit.mjs': 240, 'gate.mjs': 900, 'gate.mjs --prompt': 15, 'event.mjs': 15 };
  const hookName = c => `${c.match(/(\w[\w-]*\.mjs)/)[1]}${/ --prompt\b/.test(c) ? ' --prompt' : ''}`;
  for (const n of INSTALLABLE) {
    const a = ADAPTERS[n];
    // 1. An empty project.
    const empty = join(T, `empty-${n}`); mkdirSync(empty, { recursive: true });
    const before = tree(empty);
    const r = install(n, { project: empty, data });
    const texts = r.files.filter(f => f.text && /\.(md|toml)$/.test(f.path)).map(f => [f.path, readFileSync(f.path, 'utf8')]);
    const dirty = texts.map(([p, t]) => [relative(empty, p), claudeOnly(t)]).filter(([, f]) => f.length);
    check(`${n}: installed skills and subagents name no Claude-only tool`, texts.length >= 7 && !dirty.length, dirty.map(([p, f]) => `${p}: ${f.join(', ')}`).join('; ') || `${texts.length} files`);
    check(`${n}: the verifier and screen-judge are installed`, ['proof-verifier', 'proof-screen-judge'].every(x => r.files.some(f => f.path.includes(x))));
    // Hook timeouts: every proof command in the generated config has proof's limit (Gemini counts milliseconds).
    for (const f of r.files.filter(f => f.json)) {
      const hooks = [];
      const walk = o => { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === 'object') { if (typeof o.command === 'string' && /proof[\\/]scripts|scripts[\\/]\w+\.mjs/.test(o.command)) hooks.push(o); Object.values(o).forEach(walk); } };
      walk(f.json);
      const unit = n === 'gemini' ? 1000 : 1;
      const wrong = hooks.filter(h => h.timeout !== TIMEOUT[hookName(h.command)] * unit).map(h => `${hookName(h.command)}: ${h.timeout}`);
      check(`${n}: hook timeouts are proof's (${hooks.length} hooks)`, hooks.length > 0 && !wrong.length, wrong.join(', '));
      const data2 = hooks.every(h => h.command.includes(`--data ${data}`) || h.command.includes(`--data "${data}"`));
      check(`${n}: every hook names the shared data folder`, data2);
      if (n === 'cursor') {
        const commit = f.json.hooks.beforeShellExecution[0], stop = f.json.hooks.stop[0];
        check('cursor: a killed commit gate fails closed, and Cursor\'s own loop cap is a backstop above maxRounds', commit.failClosed === true && stop.loop_limit === a.LOOP_LIMIT && a.LOOP_LIMIT > 5);
      }
    }
    const lp = join(T, `label-${n}`); mkdirSync(lp, { recursive: true });
    const out = spawnSync(process.execPath, [join(S, 'install.mjs'), n, '--data', data], { encoding: 'utf8', cwd: lp }).stdout;
    check(`${n}: the installer says whether it was tested live`, a.tested === 'docs' ? out.includes(DOCS_LABEL) : !out.includes(DOCS_LABEL));
    const undo = (out.match(/^To undo: (.*)$/m) || [])[1];
    if (undo) execFileSync('/bin/sh', ['-c', undo], { cwd: lp, encoding: 'utf8' });
    check(`${n}: the undo command it prints takes proof out again`, !!undo && !Object.keys(tree(lp)).length, Object.keys(tree(lp)).join(', '));
    const u = uninstall(n, { project: empty, data });
    check(`${n}: uninstall from an empty project leaves it empty`, same(tree(empty), before), JSON.stringify(u));

    // 2. A project with its own config for this agent, and a file of its own beside proof's.
    const full = join(T, `full-${n}`); mkdirSync(full, { recursive: true });
    const p = plan(n, { project: full, data });
    for (const f of p.files.filter(f => f.json)) {
      mkdirSync(dirname(f.path), { recursive: true });
      const mine = n === 'antigravity' ? { 'my-hook': { Stop: [{ type: 'command', command: 'echo mine' }] } } : n === 'cursor' ? { version: 1, hooks: { stop: [{ command: 'echo mine' }] } } : { theme: 'dark', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
      writeFileSync(f.path, JSON.stringify(mine, null, 4));   // their own formatting, which must come back exactly
    }
    const other = join(dirname(p.files[0].path), 'mine.txt');
    mkdirSync(dirname(other), { recursive: true }); writeFileSync(other, 'not proof\'s');
    const before2 = tree(full);
    install(n, { project: full, data });
    const merged = p.files.filter(f => f.json).every(f => { const j = readFileSync(f.path, 'utf8'); return j.includes('echo mine') && j.includes('gate.mjs'); });
    check(`${n}: install keeps the project's own hooks and adds proof's`, merged);
    uninstall(n, { project: full, data });
    const after2 = tree(full);
    check(`${n}: uninstall puts the project's files back byte for byte`, same(after2, before2), Object.keys(after2).filter(k => after2[k] !== before2[k]).join(', '));
    // 3. A hook the user added after the install stays.
    install(n, { project: full, data });
    const cfg = p.files.find(f => f.json)?.path;
    if (cfg) {
      const j = JSON.parse(readFileSync(cfg, 'utf8'));
      j.later = 'added after proof';
      writeFileSync(cfg, JSON.stringify(j, null, 2));
      uninstall(n, { project: full, data });
      const left = readFileSync(cfg, 'utf8');
      check(`${n}: uninstall takes out only proof's entries from a file changed since`, left.includes('added after proof') && left.includes('echo mine') && !left.includes('gate.mjs'));
    } else uninstall(n, { project: full, data });
  }
  // Two agents that share .agents/skills (Codex, Antigravity): the files stay while either is installed.
  const both = join(T, 'shared'); mkdirSync(both, { recursive: true });
  install('codex', { project: both, data }); install('antigravity', { project: both, data });
  const skill = join(both, '.agents', 'skills', 'proof-build', 'SKILL.md');
  uninstall('codex', { project: both, data });
  check('shared skills stay while another agent still uses them', existsSync(skill));
  uninstall('antigravity', { project: both, data });
  check('and go when the last one is uninstalled', !existsSync(skill) && !Object.keys(tree(both)).length, Object.keys(tree(both)).join(', '));
}

// A scripted session through each adapter: the event log has every step, in the documented schema.
if (which === 'session') {
  const KINDS = { sessionStart: 'session-start.mjs', userPrompt: 'gate.mjs', beforeTool: 'wrap.mjs', afterTool: 'event.mjs', turnEnd: 'gate.mjs' };
  const SCHEMA = { sessionStart: [], userPrompt: ['prompt'], toolStart: ['tool'], toolEnd: ['tool'], turnEnd: [], gate: ['mode', 'outcome', 'checks'] };
  const data = process.env.PROOF_DATA_DIR;
  for (const n of INSTALLABLE) {
    const fx = name => { const p = join(here, 'fixtures', 'agents', n, `${name}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
    const a = ADAPTERS[n];
    const sid = `${n}-scripted`;
    // The fixture inputs, pointed at this repo and a session of our own.
    const point = input => JSON.parse(JSON.stringify(input).replaceAll('"/repo', `"${R}`).replace(/"(c1|k1|g1|ses_1|x1|ec33)"/g, `"${sid}"`));
    const steps = [['sessionStart', fx('session-start')], ['userPrompt', fx('user-prompt')], ['beforeTool', fx('test-command-rewritten')], ['afterTool', fx('tool-after')],
      ['turnEnd', fx(Object.values(a.fixtureCaps).find(x => /stop|idle|after-agent/.test(x)))]];
    for (const [kind, f] of steps) {
      if (!f) continue;
      const args = [join(S, KINDS[kind]), ...(kind === 'userPrompt' ? ['--prompt'] : []), '--agent', n, ...(n === 'antigravity' ? ['--hook', { sessionStart: 'SessionStart', userPrompt: 'PreInvocation', beforeTool: 'PreToolUse', afterTool: 'PostToolUse', turnEnd: 'Stop' }[kind]] : [])];
      spawnSync(process.execPath, args, { input: JSON.stringify(point(f.input)), encoding: 'utf8', cwd: R, env: { ...process.env, PROOF_DATA_DIR: data } });
    }
    const file = join(data, 'events', n, `${sid}.jsonl`);
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
    const kinds = lines.map(l => l.kind);
    const want = ['sessionStart', 'userPrompt', 'toolStart', 'toolEnd', 'turnEnd'];
    check(`${n}: the event log has session start, prompt, tool start and end, turn end`, want.every(k => kinds.includes(k)), kinds.join(' '));
    const bad = lines.filter(l => l.v !== 1 || typeof l.t !== 'number' || l.agent !== n || l.session !== sid || !(l.kind in SCHEMA) || !('cwd' in l) || SCHEMA[l.kind].some(k => !(k in l)));
    check(`${n}: every line matches the schema`, lines.length && !bad.length, JSON.stringify(bad[0] || {}));
    check(`${n}: no Claude Code session writes the log`, !existsSync(join(data, 'events', 'claude')));
  }
}

// Quick mode through an agent whose skill can't put the session id in the command: the shell hook adds it.
if (which === 'quick') {
  const sid = 'codex-quick';
  const cmd = `node "${join(S, 'gate.mjs')}" --quick`;
  const input = { session_id: sid, cwd: R, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'q1', tool_input: { command: cmd } };
  const out = spawnSync(process.execPath, [join(S, 'wrap.mjs'), '--agent', 'codex'], { input: JSON.stringify(input), encoding: 'utf8', cwd: R }).stdout;
  let rewritten = null;
  try { rewritten = JSON.parse(out).hookSpecificOutput.updatedInput.command; } catch {}
  check('the shell hook adds the session id to gate.mjs --quick', rewritten?.endsWith(`'${sid}'`), out);
  const said = rewritten ? execFileSync('/bin/sh', ['-c', rewritten], { cwd: R, encoding: 'utf8' }) : '';
  check('and quick mode turns on for that session', /Quick mode is on/.test(said), said.slice(0, 120));
}

// Rounds through each adapter, the way each agent reports a fix round (tests/rounds.sh sets up a check that keeps
// failing with fewer failures each time, maxRounds 3): rounds 1..3 are sent back, the 4th turn end is let through,
// and a new prompt from the user starts the count again.
if (which === 'rounds') {
  const MAX = 3;
  const sent = { claude: /"decision":"block"/, codex: /"decision":"block"/, grok: /"decision":"block"/, gemini: /"decision":"deny"/, cursor: /followup_message/, antigravity: /"decision":"continue"/, opencode: /"block"/ };
  // [turn end input for round r, prompt input (or null), the prompt hook's script args]
  const io = (n, sid, r, prompt, lastReason) => ({
    claude: { stop: { session_id: sid, cwd: R, hook_event_name: 'Stop', prompt_id: prompt, stop_hook_active: r > 1 }, prompt: null },
    codex: { stop: { session_id: sid, cwd: R, hook_event_name: 'Stop', turn_id: `t${r}`, stop_hook_active: r > 1 }, prompt: { session_id: sid, cwd: R, hook_event_name: 'UserPromptSubmit', prompt } },
    gemini: { stop: { session_id: sid, cwd: R, hook_event_name: 'AfterAgent', stop_hook_active: r > 1 }, prompt: { session_id: sid, cwd: R, hook_event_name: 'BeforeAgent', prompt } },
    grok: { stop: { sessionId: sid, cwd: R, hook_event_name: 'Stop', promptId: prompt, reason: 'end_turn', stopHookActive: r > 1 }, prompt: { sessionId: sid, cwd: R, hook_event_name: 'UserPromptSubmit', promptId: prompt, prompt } },
    // Cursor sends proof's follow-up as the next user message, so its prompt hook sees that text after each round.
    cursor: { stop: { conversation_id: sid, workspace_roots: [R], hook_event_name: 'stop', status: 'completed', loop_count: r - 1 }, prompt: { conversation_id: sid, workspace_roots: [R], hook_event_name: 'beforeSubmitPrompt', prompt: lastReason ?? prompt } },
    // Antigravity reports the last thing the user typed before every model call: the same text all through the turn.
    antigravity: { stop: { conversationId: sid, workspacePaths: [R], terminationReason: 'model_stop', executionNum: r }, prompt: { conversationId: sid, workspacePaths: [R], invocationNum: r, lastUserInput: prompt } },
    opencode: { stop: { hook: 'turnEnd', sessionID: sid, cwd: R, continuation: r > 1 }, prompt: { hook: 'userPrompt', sessionID: sid, cwd: R, prompt } },
  })[n];
  const run = (n, script, args, input, hook) => spawnSync(process.execPath, [join(S, script), ...args, '--agent', n, ...(n === 'antigravity' ? ['--hook', hook] : [])],
    { input: JSON.stringify(input), encoding: 'utf8', cwd: R }).stdout;
  let k = 0;
  for (const n of Object.keys(ADAPTERS)) {
    const sid = `rounds-${n}`;
    writeFileSync(process.env.CNT, '20');
    writeFileSync(join(R, 'src', 'a.ts'), `export const a = ${100 + k++}\n`);
    let prompt = 'first prompt', last = null, got = [];
    for (let r = 1; r <= MAX + 1; r++) {
      const x = io(n, sid, r, prompt, last);
      if (x.prompt && (r === 1 || n === 'cursor' || n === 'antigravity')) run(n, 'gate.mjs', ['--prompt'], x.prompt, 'PreInvocation');
      const out = run(n, 'gate.mjs', [], x.stop, 'Stop');
      got.push(sent[n].test(out) ? (out.match(/round (\d+) of \d+/) || ['', 'sent back'])[1] : 'let through');
      if (sent[n].test(out)) { try { const j = JSON.parse(out); last = j.reason ?? j.followup_message ?? j.block?.reason; } catch {} }
    }
    check(`${n}: rounds 1–${MAX} are sent back, turn end ${MAX + 1} is let through`, got.join(',') === '1,2,3,let through', got.join(', '));
    // A new prompt from the user starts again at round 1.
    writeFileSync(join(R, 'src', 'a.ts'), `export const a = ${100 + k++}\n`);
    writeFileSync(process.env.CNT, '20');
    prompt = 'second prompt';
    const x = io(n, sid, 1, n === 'claude' || n === 'grok' ? 'p2' : prompt, null);
    if (n === 'claude') x.stop.prompt_id = 'p2';
    if (x.prompt) run(n, 'gate.mjs', ['--prompt'], x.prompt, 'PreInvocation');
    const out = run(n, 'gate.mjs', [], x.stop, 'Stop');
    check(`${n}: a new prompt starts the count again`, sent[n].test(out) && /round 1 of /.test(out), out.slice(0, 160));
  }
}

process.exitCode = failed ? 1 : 0;
