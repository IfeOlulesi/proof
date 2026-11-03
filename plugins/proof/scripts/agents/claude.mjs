// Claude Code: hook input on stdin, output as JSON on stdout, a blocking reason on stderr with exit code 2.
// https://code.claude.com/docs/en/hooks
export const name = 'claude';
export const label = 'Claude';

const KINDS = { SessionStart: 'sessionStart', UserPromptSubmit: 'userPrompt', PreToolUse: 'beforeTool', PostToolUse: 'afterTool', Stop: 'turnEnd' };
const HOOK_NAMES = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k]));

// Claude in Chrome and the desktop app's browser reuse a browser that's already open; only these start a new one.
const BROWSER_START = t => /^mcp__/.test(t) && !/claude-in-chrome|Claude_Browser/.test(t) && /(playwright|puppeteer|chrome-devtools|browser)/i.test(t) && /navigate|new_page|tabs?_create|open|launch|install/i.test(t);

export function toolKind(t) {
  if (t === 'Bash') return 'shell';
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) return 'edit';
  if (/^(Agent|Task)$/.test(t)) return 'subagent';
  if (BROWSER_START(t)) return 'browser';
  return 'other';
}

export function parse(raw, kind) {
  const ev = {
    agent: name,
    kind: KINDS[raw.hook_event_name] || kind,
    session: raw.session_id ?? null,
    turn: raw.prompt_id ?? null,
    continuation: typeof raw.stop_hook_active === 'boolean' ? raw.stop_hook_active : null,
    round: null,
    cwd: raw.cwd ?? null,
    lastMessage: raw.last_assistant_message ?? null,
    source: raw.source ?? null,
    prompt: raw.prompt ?? null,
  };
  if (raw.tool_name !== undefined || raw.tool_input !== undefined) {
    const input = raw.tool_input && typeof raw.tool_input === 'object' ? raw.tool_input : {};
    ev.tool = { name: toolKind(String(raw.tool_name || '')), raw: raw.tool_name ?? null, input };
  }
  return ev;
}

// A result: { context, message, block: { reason }, updatedCommand }. Every field is optional; nothing means no output.
export function render(ev, r) {
  const out = { stdout: '', stderr: '', code: 0 };
  if (ev.kind === 'turnEnd') {
    if (r.block) out.stdout = JSON.stringify({ decision: 'block', reason: r.block.reason, ...(r.message ? { systemMessage: r.message } : {}) });
    else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
    return out;
  }
  if (r.block) return { ...out, stderr: r.block.reason, code: 2 };
  if (ev.kind === 'beforeTool' && (r.updatedCommand != null || r.context)) {
    const h = { hookEventName: HOOK_NAMES[ev.kind] };
    if (r.updatedCommand != null) h.updatedInput = { ...ev.tool?.input, command: r.updatedCommand };
    if (r.context) h.additionalContext = r.context;
    out.stdout = JSON.stringify({ hookSpecificOutput: h });
    return out;
  }
  if (r.context) out.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName: HOOK_NAMES[ev.kind], additionalContext: r.context } });
  else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
  return out;
}

// What the rules and skills call things in this agent.
export const words = { agent: 'Claude' };
export const tested = 'live';

// Claude Code gets proof as a plugin (hooks/hooks.json), not from install.mjs.
export const caps = {
  rules: 'yes (SessionStart)',
  gate: 'yes (Stop)',
  commitDeny: 'yes (PreToolUse)',
  testRewrite: 'yes (PreToolUse)',
  subagentNote: 'yes (PreToolUse)',
  sessionStart: 'yes (SessionStart)',
  userPrompt: 'no',
  beforeTool: 'yes (PreToolUse)',
  afterTool: 'no',
  turnEnd: 'yes (Stop)',
  waiting: 'no',
  skills: 'yes (plugin skills/)',
  subagents: 'yes (plugin agents/)',
};
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'stop-block', turnEnd: 'stop-block', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', subagentNote: 'subagent-note' };
