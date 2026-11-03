// xAI Grok Build CLI (`grok`): hooks in .grok/hooks/proof.json (or ~/.grok/hooks/ with --global), Claude Code's format
// with Grok's tool names. Built from xAI's docs, https://docs.x.ai/build/features/hooks and the user guide that ships
// with grok 1.0.70 (10-hooks.md), read 2026-11-03; not tested live. Notes from the docs that shape this adapter:
// - SessionStart reads only a top-level systemMessage, so it can't give the model proof's rules. The installer writes
//   them to .grok/rules/proof.md, which Grok loads every session; the hook still runs to record where the session began.
// - Stop's `decision: "block"` keeps the agent working "in the same turn" (promptId stays), with stopHookActive set.
//   A second Stop fires when the session closes (reason "channel_closed" or "shutdown"); proof ignores it.
// - A deny is `decision: "deny"` + reason; a rewrite is hookSpecificOutput.updatedInput, which replaces the whole input.
// - Grok also reads Claude Code's hooks and plugins: with proof installed in Claude Code too, its hooks may run twice.
import { BROWSER_START, TIMEOUTS, hookCommand } from './shared.mjs';
import { renderRules } from './words.mjs';

export const name = 'grok';
export const label = 'Grok Build';
export const tested = 'docs';
export const source = 'https://docs.x.ai/build/features/hooks and the grok 1.0.70 user guide 10-hooks.md (read 2026-11-03)';
export const words = { agent: 'Grok', memoryFile: 'AGENTS.md', clear: 'a new session (/new)', verifier: 'the proof-verifier subagent' };

const KINDS = { SessionStart: 'sessionStart', UserPromptSubmit: 'userPrompt', PreToolUse: 'beforeTool', PostToolUse: 'afterTool', Stop: 'turnEnd' };
const SNAKE = { session_start: 'SessionStart', user_prompt_submit: 'UserPromptSubmit', pre_tool_use: 'PreToolUse', post_tool_use: 'PostToolUse', stop: 'Stop' };
const HOOK_NAMES = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));

export function toolKind(t) {
  if (t === 'run_terminal_command' || t === 'Bash') return 'shell';
  if (/^(edit_file|write_file|create_file|search_replace|apply_patch|Edit|Write)$/.test(t)) return 'edit';
  if (t === 'spawn_subagent' || t === 'Task') return 'subagent';
  if (BROWSER_START(t)) return 'browser';
  return 'other';
}

export function parse(raw, kind) {
  const hook = raw.hook_event_name || SNAKE[raw.hookEventName];
  const flag = raw.stopHookActive ?? raw.stop_hook_active;
  const ev = {
    agent: name,
    kind: KINDS[hook] || kind,
    session: raw.sessionId ?? raw.session_id ?? null,
    turn: raw.promptId ?? null,
    continuation: typeof flag === 'boolean' ? flag : null,
    round: null,
    cwd: raw.cwd ?? raw.workspaceRoot ?? null,
    lastMessage: raw.lastAssistantMessage ?? raw.last_assistant_message ?? null,
    source: raw.source ?? null,
    prompt: raw.prompt ?? null,
  };
  if (ev.kind === 'turnEnd' && raw.reason && raw.reason !== 'end_turn') ev.skip = true;   // the session closing, not a turn
  const t = raw.toolName ?? raw.tool_name;
  if (t !== undefined) {
    const input = raw.toolInput ?? raw.tool_input;
    ev.tool = { name: toolKind(String(t)), raw: t, input: input && typeof input === 'object' ? input : {}, ...(raw.toolUseId ? { id: raw.toolUseId } : {}) };
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
  // Only a systemMessage (for the user) is read at session start; the rules file carries the rules. The update notice
  // goes to the user that way.
  if (ev.kind === 'sessionStart') { if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message }); return out; }
  if (r.block) { out.stdout = JSON.stringify({ decision: 'deny', reason: r.block.reason }); return out; }
  const h = {};
  if (ev.kind === 'beforeTool' && r.updatedCommand != null) h.updatedInput = { ...ev.tool?.input, command: r.updatedCommand };
  if (r.context) h.additionalContext = r.context;
  if (Object.keys(h).length) out.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_NAMES[ev.kind], ...h }, ...(r.message ? { systemMessage: r.message } : {}) });
  else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
  return out;
}

export const caps = {
  rules: 'yes (.grok/rules/proof.md)',
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
  skills: 'yes (.grok/skills)',
  subagents: 'yes (.grok/agents)',
};
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'stop-block', turnEnd: 'stop-block', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', subagentNote: 'subagent-note', userPrompt: 'user-prompt', afterTool: 'tool-after' };

export function install({ root, data, node, project, home, global, rulesText }) {
  const base = global ? `${home}/.grok` : `${project}/.grok`;
  const c = (script, ...a) => hookCommand({ node, root, data, agent: name }, script, ...a);
  const h = (script, timeout, ...a) => ({ type: 'command', command: c(script, ...a), timeout });
  return {
    files: [
      {
        path: `${base}/hooks/proof.json`,
        json: {
          hooks: {
            SessionStart: [{ hooks: [h('session-start.mjs', TIMEOUTS.sessionStart)] }],
            UserPromptSubmit: [{ hooks: [h('gate.mjs', TIMEOUTS.event, '--prompt')] }],
            PreToolUse: [
              { matcher: 'run_terminal_command', hooks: [h('gate.mjs', TIMEOUTS.gate, '--commit')] },
              { hooks: [h('wrap.mjs', TIMEOUTS.wrap)] },
              { hooks: [h('admit.mjs', TIMEOUTS.admit)] },   // subagents (spawn_subagent) and browsers
            ],
            PostToolUse: [{ hooks: [h('event.mjs', TIMEOUTS.event)] }],
            Stop: [{ hooks: [h('gate.mjs', TIMEOUTS.gate)] }],
          },
        },
      },
      { path: `${base}/rules/proof.md`, text: `${renderRules(rulesText, { name, words })}\n` },
    ],
    skillsDir: `${base}/skills`,
    agentsDir: `${base}/agents`,
    agentFile: (n, description, body) => `---\nname: ${n}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
    notes: [
      'Grok runs project hooks only in a trusted folder: run /hooks-trust in Grok, or start it with --trust.',
      'Grok also reads Claude Code\'s hooks and plugins. If proof is installed in Claude Code too, turn off Claude Code compatibility for hooks in Grok, or its gate will run twice.',
      'Grok ends a turn after 8 gate send-backs whatever proof\'s maxRounds says.',
    ],
  };
}
