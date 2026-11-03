// OpenAI Codex CLI: hooks in .codex/hooks.json (or ~/.codex/hooks.json with --global), Claude Code's format.
// Built from Codex's hooks docs, https://learn.chatgpt.com/docs/hooks (was developers.openai.com/codex/hooks), read
// 2026-11-03; not tested live. Notes from the docs that shape this adapter:
// - A PreToolUse reply may only carry hookSpecificOutput and systemMessage; `continue`, `stopReason` and the like make
//   the hook fail and the tool run anyway. A rewrite needs permissionDecision "allow" with updatedInput.command.
// - Exit code 2 blocks only with a reason on stderr.
// - Stop's `decision: "block"` sends the reason as a new prompt; stop_hook_active says this turn was continued so.
//   turn_id isn't used: whether a continuation gets a new one isn't documented.
// - Codex asks the user to trust new or changed hooks (/hooks) before they run.
import { BROWSER_START, TIMEOUTS, hookCommand } from './shared.mjs';

export const name = 'codex';
export const label = 'Codex';
export const tested = 'docs';
export const source = 'https://learn.chatgpt.com/docs/hooks (read 2026-11-03)';
export const words = { agent: 'Codex', memoryFile: 'AGENTS.md', clear: 'a new session (/new)', verifier: 'the proof-verifier subagent' };

const KINDS = { SessionStart: 'sessionStart', UserPromptSubmit: 'userPrompt', PreToolUse: 'beforeTool', PostToolUse: 'afterTool', Stop: 'turnEnd' };
const HOOK_NAMES = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));

export function toolKind(t) {
  if (t === 'Bash' || t === 'exec_command' || t === 'shell') return 'shell';
  if (/^(apply_patch|Edit|Write)$/.test(t)) return 'edit';
  if (t === 'spawn_agent' || t === 'Agent') return 'subagent';
  if (BROWSER_START(t)) return 'browser';
  return 'other';
}

export function parse(raw, kind) {
  const ev = {
    agent: name,
    kind: KINDS[raw.hook_event_name] || kind,
    session: raw.session_id ?? null,
    turn: null,
    continuation: typeof raw.stop_hook_active === 'boolean' ? raw.stop_hook_active : null,
    round: null,
    cwd: raw.cwd ?? null,
    lastMessage: raw.last_assistant_message ?? null,
    source: raw.source ?? null,
    prompt: raw.prompt ?? null,
  };
  if (raw.tool_name !== undefined) {
    const t = String(raw.tool_name);
    const input = raw.tool_input && typeof raw.tool_input === 'object' ? { ...raw.tool_input } : {};
    if (toolKind(t) === 'subagent' && input.description == null) input.description = input.task_name || input.message;
    ev.tool = { name: toolKind(t), raw: t, input, ...(raw.tool_use_id ? { id: raw.tool_use_id } : {}) };
  }
  return ev;
}

export function render(ev, r) {
  const out = { stdout: '', stderr: '', code: 0 };
  if (ev.kind === 'turnEnd') {
    if (r.block) out.stdout = JSON.stringify({ decision: 'block', reason: r.block.reason, ...(r.message ? { systemMessage: r.message } : {}) });
    else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
    return out;
  }
  if (r.block) return { ...out, stderr: r.block.reason, code: 2 };
  const h = {};
  if (ev.kind === 'beforeTool' && r.updatedCommand != null) Object.assign(h, { permissionDecision: 'allow', updatedInput: { ...ev.tool?.input, command: r.updatedCommand } });
  if (r.context) h.additionalContext = r.context;
  if (Object.keys(h).length) out.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_NAMES[ev.kind], ...h }, ...(r.message ? { systemMessage: r.message } : {}) });
  else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
  return out;
}

export const caps = {
  rules: 'yes (SessionStart)',
  gate: 'yes (Stop)',
  commitDeny: 'yes (PreToolUse)',
  testRewrite: 'yes (PreToolUse)',
  subagentNote: 'yes (PreToolUse)',
  sessionStart: 'yes (SessionStart)',
  userPrompt: 'yes (UserPromptSubmit)',
  beforeTool: 'yes (PreToolUse)',
  afterTool: 'yes (PostToolUse)',
  turnEnd: 'yes (Stop)',
  waiting: 'no',
  skills: 'yes (.agents/skills)',
  subagents: 'yes (.codex/agents)',
};
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'stop-block', turnEnd: 'stop-block', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', subagentNote: 'subagent-note', userPrompt: 'user-prompt', afterTool: 'tool-after' };

const toml = s => JSON.stringify(String(s));   // a TOML basic string has JSON's escapes

export function install({ root, data, node, project, home, global }) {
  const codex = global ? `${home}/.codex` : `${project}/.codex`;
  const agents = global ? home : project;
  const c = (script, ...a) => hookCommand({ node, root, data, agent: name }, script, ...a);
  const h = (script, timeout, ...a) => ({ type: 'command', command: c(script, ...a), timeout });
  return {
    files: [{
      path: `${codex}/hooks.json`,
      json: {
        hooks: {
          SessionStart: [{ hooks: [{ ...h('session-start.mjs', TIMEOUTS.sessionStart), additionalContextLimit: 0 }] }],
          UserPromptSubmit: [{ hooks: [h('gate.mjs', TIMEOUTS.event, '--prompt')] }],
          PreToolUse: [
            { matcher: '^Bash$', hooks: [h('gate.mjs', TIMEOUTS.gate, '--commit')] },
            { hooks: [h('wrap.mjs', TIMEOUTS.wrap)] },
            { hooks: [h('admit.mjs', TIMEOUTS.admit)] },   // subagents (spawn_agent) and browsers
          ],
          PostToolUse: [{ hooks: [h('event.mjs', TIMEOUTS.event)] }],
          Stop: [{ hooks: [h('gate.mjs', TIMEOUTS.gate)] }],
        },
      },
    }],
    skillsDir: `${agents}/.agents/skills`,
    agentsDir: `${codex}/agents`,
    agentExt: 'toml',
    agentFile: (n, description, body) => `# proof's ${n} subagent, written by proof's installer.\nname = ${toml(n)}\ndescription = ${toml(description)}\ndeveloper_instructions = ${toml(body)}\n`,
    notes: ['Codex asks you to review and trust new hooks before they run: open /hooks in Codex and trust proof\'s.', 'A failing or timed-out hook lets the action through in Codex (it has no fail-closed option), so a killed commit gate allows the commit.'],
  };
}
