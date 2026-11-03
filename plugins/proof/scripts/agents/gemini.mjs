// Google Gemini CLI: hooks in .gemini/settings.json (or ~/.gemini/settings.json with --global).
// Built from Gemini CLI's hooks docs, https://geminicli.com/docs/hooks and /docs/hooks/reference (read 2026-11-03).
// Notes from the docs that shape this adapter:
// - Turn end is AfterAgent: `decision: "deny"` with a reason sends the reason back as a new prompt (a retry), and
//   stop_hook_active marks a turn end that's part of one. Prompt submit is BeforeAgent.
// - The shell tool is run_shell_command. A deny is `decision: "deny"` + reason; a rewrite is
//   hookSpecificOutput.tool_input, merged over the model's arguments.
// - Timeouts are in milliseconds. Only exit 0, or exit 2 on purpose: other codes with plain text count as a deny.
// - Subagents are tools named after the agent; there's no SubagentStart, and the tool's arguments aren't documented.
import { BROWSER_START, TIMEOUTS, hookCommand } from './shared.mjs';

export const name = 'gemini';
export const label = 'Gemini CLI';
export const tested = 'docs';   // installed here (0.36.0) but not signed in, so not run live yet
export const source = 'https://geminicli.com/docs/hooks/reference (read 2026-11-03)';
export const words = { agent: 'Gemini', memoryFile: 'GEMINI.md', clear: 'a new session', verifier: 'the proof-verifier subagent' };

const KINDS = { SessionStart: 'sessionStart', BeforeAgent: 'userPrompt', BeforeTool: 'beforeTool', AfterTool: 'afterTool', AfterAgent: 'turnEnd' };
const HOOK_NAMES = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));
const SUBAGENTS = /^(codebase_investigator|generalist|cli_help|proof-verifier|proof-screen-judge)$/;

export function toolKind(t) {
  if (t === 'run_shell_command') return 'shell';
  if (/^(write_file|replace|edit)$/.test(t)) return 'edit';
  if (SUBAGENTS.test(t)) return 'subagent';
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
    lastMessage: raw.prompt_response ?? null,
    source: raw.source ?? null,
    prompt: raw.prompt ?? null,
  };
  if (raw.tool_name !== undefined) {
    const t = String(raw.tool_name);
    const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    ev.tool = { name: toolKind(t), raw: t, input };
  }
  return ev;
}

export function render(ev, r) {
  const out = { stdout: '', stderr: '', code: 0 };
  const msg = r.message ? { systemMessage: r.message } : {};
  if (ev.kind === 'turnEnd') {
    if (r.block) out.stdout = JSON.stringify({ decision: 'deny', reason: r.block.reason, ...msg });
    else if (r.message) out.stdout = JSON.stringify(msg);
    return out;
  }
  if (r.block) { out.stdout = JSON.stringify({ decision: 'deny', reason: r.block.reason }); return out; }
  const h = {};
  if (ev.kind === 'beforeTool' && r.updatedCommand != null) h.tool_input = { command: r.updatedCommand };
  if (r.context) h.additionalContext = r.context;
  if (Object.keys(h).length) out.stdout = JSON.stringify({ ...(ev.kind === 'beforeTool' ? { decision: 'allow' } : {}), hookSpecificOutput: { hookEventName: HOOK_NAMES[ev.kind], ...h }, ...msg });
  else if (r.message) out.stdout = JSON.stringify(msg);
  return out;
}

export const caps = {
  rules: 'yes (SessionStart)',
  gate: 'yes (AfterAgent)',
  commitDeny: 'yes (BeforeTool)',
  testRewrite: 'yes (BeforeTool)',
  subagentNote: 'unknown',
  sessionStart: 'yes (SessionStart)',
  userPrompt: 'yes (BeforeAgent)',
  beforeTool: 'yes (BeforeTool)',
  afterTool: 'yes (AfterTool)',
  turnEnd: 'yes (AfterAgent)',
  waiting: 'unknown',
  skills: 'yes (.gemini/skills)',
  subagents: 'yes (.gemini/agents)',
};
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'after-agent-block', turnEnd: 'after-agent-block', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', userPrompt: 'user-prompt', afterTool: 'tool-after' };

export function install({ root, data, node, project, home, global }) {
  const gem = global ? `${home}/.gemini` : `${project}/.gemini`;
  const c = (script, ...a) => hookCommand({ node, root, data, agent: name }, script, ...a);
  const h = (hookName, script, timeoutS, ...a) => ({ name: hookName, type: 'command', command: c(script, ...a), timeout: timeoutS * 1000 });
  return {
    files: [{
      path: `${gem}/settings.json`,
      json: {
        hooks: {
          SessionStart: [{ matcher: '*', hooks: [h('proof-rules', 'session-start.mjs', TIMEOUTS.sessionStart)] }],
          BeforeAgent: [{ matcher: '*', hooks: [h('proof-prompt', 'gate.mjs', TIMEOUTS.event, '--prompt')] }],
          BeforeTool: [
            { matcher: 'run_shell_command', hooks: [h('proof-commit-gate', 'gate.mjs', TIMEOUTS.gate, '--commit')] },
            { matcher: '.*', hooks: [h('proof-memory', 'wrap.mjs', TIMEOUTS.wrap)] },
            { matcher: '.*', hooks: [h('proof-agents', 'admit.mjs', TIMEOUTS.admit)] },   // subagents and browsers
          ],
          AfterTool: [{ matcher: '.*', hooks: [h('proof-events', 'event.mjs', TIMEOUTS.event)] }],
          AfterAgent: [{ matcher: '*', hooks: [h('proof-gate', 'gate.mjs', TIMEOUTS.gate)] }],
        },
      },
    }],
    skillsDir: `${gem}/skills`,
    agentsDir: `${gem}/agents`,
    agentFile: (n, description, body) => `---\nname: ${n}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
    notes: ['Gemini CLI asks you to trust project hooks before they run (/hooks panel).', 'Subagents are a preview feature in Gemini CLI; with them off, ask Gemini to follow the proof-verifier agent file instead.'],
  };
}
