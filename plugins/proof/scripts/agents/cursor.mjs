// Cursor (desktop agent and the `agent` CLI): hooks in .cursor/hooks.json (or ~/.cursor/hooks.json with --global).
// Built from Cursor's hooks docs, https://cursor.com/docs/hooks (read 2026-11-03); not tested live.
// Notes from the docs that shape this adapter:
// - Permission hooks (preToolUse, beforeShellExecution, subagentStart) block the action on empty or invalid output,
//   so every reply to them is a JSON object, `{"permission":"allow"}` when proof has nothing to say.
// - Only preToolUse can rewrite a command (updated_input); beforeShellExecution can only allow or deny. The commit
//   gate runs on beforeShellExecution with failClosed, and the test-command rewrite on preToolUse (Shell).
// - stop continues the turn by sending `followup_message` as the next user message. proof's maxRounds decides when
//   to stop; Cursor's own cap (loop_limit) stays on, set to LOOP_LIMIT, as a backstop in case a follow-up ever reaches
//   the prompt hook changed and so looks like a new prompt. A stop after an aborted or failed turn isn't gated.
// - subagentStart can deny but not add a note, so the memory note for subagents is "no" here.
import { BROWSER_START, TIMEOUTS, hookCommand } from './shared.mjs';

export const name = 'cursor';
export const LOOP_LIMIT = 20;   // above any sensible maxRounds (default 5)
export const label = 'Cursor';
export const tested = 'docs';
export const source = 'https://cursor.com/docs/hooks (read 2026-11-03)';
export const words = { agent: 'Cursor', memoryFile: 'AGENTS.md (or a rule in .cursor/rules)', clear: 'a new chat' };

const KINDS = { sessionStart: 'sessionStart', beforeSubmitPrompt: 'userPrompt', preToolUse: 'beforeTool', beforeShellExecution: 'beforeTool', subagentStart: 'beforeTool', postToolUse: 'afterTool', stop: 'turnEnd' };
const PERMISSION = new Set(['preToolUse', 'beforeShellExecution', 'subagentStart']);

export function toolKind(t) {
  if (t === 'Shell') return 'shell';
  if (/^(Write|Delete|Edit|MultiEdit|StrReplace)$/.test(t)) return 'edit';
  if (t === 'Task') return 'subagent';
  if (BROWSER_START(t)) return 'browser';
  return 'other';
}

export function parse(raw, kind) {
  const hook = raw.hook_event_name;
  const ev = {
    agent: name,
    kind: KINDS[hook] || kind,
    hook: hook ?? null,
    session: raw.conversation_id ?? raw.session_id ?? null,
    turn: null,   // generation_id changes with proof's own follow-ups too, so it can't tell a fix round from a new prompt
    continuation: null,
    round: Number.isInteger(raw.loop_count) ? raw.loop_count : null,
    cwd: raw.cwd ?? raw.workspace_roots?.[0] ?? process.env.CURSOR_PROJECT_DIR ?? null,
    lastMessage: null,
    source: raw.composer_mode ? 'startup' : null,
    prompt: raw.prompt ?? null,
  };
  if (hook === 'stop' && raw.status && raw.status !== 'completed') ev.skip = true;   // the user stopped it, or it errored
  if (hook === 'beforeShellExecution') ev.tool = { name: 'shell', raw: 'Shell', input: { command: raw.command, cwd: raw.cwd } };
  else if (hook === 'subagentStart') ev.tool = { name: 'subagent', raw: 'Task', input: { description: raw.task, subagent_type: raw.subagent_type }, ...(raw.tool_call_id ? { id: raw.tool_call_id } : {}) };
  else if (raw.tool_name !== undefined) {
    const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    ev.tool = { name: toolKind(String(raw.tool_name)), raw: raw.tool_name, input, ...(raw.tool_use_id ? { id: raw.tool_use_id } : {}) };
  }
  return ev;
}

export function render(ev, r) {
  const out = { stdout: '', stderr: '', code: 0 };
  if (ev.kind === 'turnEnd') {
    if (r.block) out.stdout = JSON.stringify({ followup_message: r.block.reason });
    return out;
  }
  if (ev.kind === 'sessionStart') {
    if (r.context) out.stdout = JSON.stringify({ additional_context: r.context });
    return out;
  }
  if (ev.kind === 'userPrompt') { out.stdout = JSON.stringify({ continue: true }); return out; }
  if (PERMISSION.has(ev.hook)) {
    if (r.block) { out.stdout = JSON.stringify({ permission: 'deny', user_message: r.block.reason, ...(ev.hook !== 'subagentStart' ? { agent_message: r.block.reason } : {}) }); return out; }
    const o = { permission: 'allow' };
    if (ev.hook === 'preToolUse' && r.updatedCommand != null) o.updated_input = { ...ev.tool?.input, command: r.updatedCommand };
    if (r.context && ev.hook !== 'subagentStart') o.agent_message = r.context;
    out.stdout = JSON.stringify(o);
    return out;
  }
  if (ev.kind === 'afterTool' && r.context) out.stdout = JSON.stringify({ additional_context: r.context });
  return out;
}

export const caps = {
  rules: 'yes (sessionStart)',
  gate: 'yes (stop)',
  commitDeny: 'yes (beforeShellExecution)',
  testRewrite: 'yes (preToolUse)',
  subagentNote: 'no',
  sessionStart: 'yes (sessionStart)',
  userPrompt: 'yes (beforeSubmitPrompt)',
  beforeTool: 'yes (preToolUse)',
  afterTool: 'yes (postToolUse)',
  turnEnd: 'yes (stop)',
  waiting: 'no',
  skills: 'yes (.cursor/skills)',
  subagents: 'yes (.cursor/agents)',
};
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'stop-block', turnEnd: 'stop-block', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', userPrompt: 'user-prompt', afterTool: 'tool-after' };

export function install({ root, data, node, project, home, global }) {
  const base = global ? `${home}/.cursor` : `${project}/.cursor`;
  const c = (script, ...a) => hookCommand({ node, root, data, agent: name }, script, ...a);
  return {
    files: [{
      path: `${base}/hooks.json`,
      json: {
        version: 1,
        hooks: {
          sessionStart: [{ command: c('session-start.mjs'), timeout: TIMEOUTS.sessionStart }],
          beforeSubmitPrompt: [{ command: c('gate.mjs', '--prompt'), timeout: TIMEOUTS.event }],
          beforeShellExecution: [{ command: c('gate.mjs', '--commit'), matcher: '\\bgit\\b', timeout: TIMEOUTS.gate, failClosed: true }],
          preToolUse: [{ command: c('wrap.mjs'), timeout: TIMEOUTS.wrap }],
          subagentStart: [{ command: c('admit.mjs'), timeout: TIMEOUTS.admit }],
          postToolUse: [{ command: c('event.mjs'), timeout: TIMEOUTS.event }],
          stop: [{ command: c('gate.mjs'), timeout: TIMEOUTS.gate, loop_limit: LOOP_LIMIT }],
        },
      },
    }],
    skillsDir: `${base}/skills`,
    agentsDir: `${base}/agents`,
    agentFile: (n, description, body) => `---\nname: ${n}\ndescription: ${description}\nmodel: inherit\n---\n\n${body}`,
    notes: [`Cursor stops sending proof's follow-ups after ${LOOP_LIMIT} in a row whatever maxRounds says, and doesn't show proof's "still failing" message (its stop hook has no field for one).`, 'Cursor also runs hooks from .claude/settings.json; if proof is set up there for Claude Code, its hooks would run twice in Cursor.'],
  };
}
