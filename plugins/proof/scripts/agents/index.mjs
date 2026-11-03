// proof's hook scripts talk to every coding agent through one event and one result (docs/agents.md). Each agent has
// an adapter here that turns its hook input into the event and the result into its output.
//   const { ev, reply } = hookInput('turnEnd');   ...   reply({ block: { reason }, message });
// The agent is `--agent <name>` on the hook's command line, else PROOF_AGENT, else Claude Code. `--data <folder>`
// (written into each agent's hook config by the installer) is the shared data folder, as PROOF_DATA_DIR.
import { writeSync } from 'node:fs';
import { readStdin } from '../lib.mjs';
import { fromHook, logEvent } from './events.mjs';
import * as claude from './claude.mjs';
import * as codex from './codex.mjs';
import * as cursor from './cursor.mjs';
import * as gemini from './gemini.mjs';
import * as grok from './grok.mjs';
import * as antigravity from './antigravity.mjs';
import * as opencode from './opencode.mjs';

export const ADAPTERS = { claude, opencode, gemini, codex, cursor, grok, antigravity };

const arg = (argv, flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
if (arg(process.argv, '--data')) process.env.PROOF_DATA_DIR = arg(process.argv, '--data');

export function agentName(argv = process.argv) {
  return arg(argv, '--agent') || process.env.PROOF_AGENT || 'claude';
}

// An agent proof doesn't know falls back to Claude Code's format, with a note, rather than breaking every hook.
export function adapterFor(name = agentName()) {
  const a = ADAPTERS[name];
  if (a) return a;
  process.stderr.write(`proof: no adapter for agent "${name}" (known: ${Object.keys(ADAPTERS).join(', ')}); using Claude Code's.\n`);
  return claude;
}

// Read this hook's input. `kind` is the event the script handles, used when the input doesn't say. The event goes to
// the session's event log unless `log` is false (a second hook on the same event, such as the commit gate).
export function hookInput(kind, { raw = readStdin(), adapter = adapterFor(), log = true } = {}) {
  const ev = adapter.parse(raw, kind);
  process.env.PROOF_AGENT = adapter.name;   // the ledger and anything this hook starts record which agent it was
  if (log) { const e = fromHook(ev); if (e) logEvent(adapter.name, ev.session, e); }
  let sent = false;
  // Written synchronously, so a reply made as the process exits still goes out.
  const reply = (result = {}) => {
    if (sent) return;
    sent = true;
    const out = adapter.render(ev, result);
    if (out.stdout) writeSync(1, out.stdout);
    if (out.stderr) writeSync(2, out.stderr);
    if (out.code) process.exitCode = out.code;
  };
  // A hook that ends without replying still answers: some agents read no output as a failure (Cursor blocks the tool).
  process.on('exit', () => reply({}));
  return { ev, reply, adapter };
}
