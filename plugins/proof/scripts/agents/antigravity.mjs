// Google Antigravity CLI (`agy`): hooks in .agents/hooks.json (or ~/.gemini/config/hooks.json with --global), under
// one named group, "proof". Built from Antigravity's hooks docs, https://antigravity.google/docs/hooks, and its
// changelog, read 2026-11-03; not tested live. Its format is its own, not Claude Code's:
// - Fields are camelCase: conversationId, workspacePaths; a tool call is toolCall { name, args }.
// - The shell tool is run_command, with the command in args.CommandLine. A deny is `decision: "deny"` + reason; a
//   rewrite is `overwrite`, merged into the arguments (the model is told which changed). PreToolUse always names a
//   decision: a reply without one may block the tool.
// - SessionStart adds context with injectSteps. Stop keeps the agent working with `decision: "continue"`; there is no
//   loop flag, so proof counts the rounds itself.
// - There is no prompt-submit event. PreInvocation (before each model call) carries lastUserInput (CLI 1.4.7+);
//   proof treats a lastUserInput it hasn't seen as a new prompt.
import { BROWSER_START, TIMEOUTS, hookCommand } from './shared.mjs';

export const name = 'antigravity';
export const label = 'Antigravity';
export const tested = 'docs';
export const source = 'https://antigravity.google/docs/hooks and https://antigravity.google/docs/changelog (read 2026-11-03)';
export const words = { agent: 'Antigravity', memoryFile: 'AGENTS.md', clear: 'a new conversation', verifier: 'the proof-verifier subagent' };

export function toolKind(t) {
  if (t === 'run_command') return 'shell';
  if (/^(write_to_file|replace_file_content|multi_replace_file_content|edit_file|write_file)$/.test(t)) return 'edit';
  if (t === 'invoke_subagent') return 'subagent';
  if (BROWSER_START(t)) return 'browser';
  return 'other';
}

// Which hook this is: the installer names it on the command line (`--hook <event>`), since the input doesn't say.
const HOOK = (() => { const i = process.argv.indexOf('--hook'); return i >= 0 ? process.argv[i + 1] : null; })();
const KINDS = { SessionStart: 'sessionStart', PreInvocation: 'userPrompt', PreToolUse: 'beforeTool', PostToolUse: 'afterTool', Stop: 'turnEnd' };

export function parse(raw, kind, hook = HOOK) {
  const ev = {
    agent: name,
    kind: KINDS[hook] || (raw.toolCall ? kind : raw.terminationReason !== undefined ? 'turnEnd' : kind),
    hook: hook ?? null,
    session: raw.conversationId ?? null,
    turn: null,
    continuation: null,
    round: null,
    cwd: raw.workspacePaths?.[0] ?? null,
    lastMessage: null,
    source: null,
    prompt: typeof raw.lastUserInput === 'string' ? raw.lastUserInput : raw.lastUserInput?.text ?? null,
  };
  if (ev.kind === 'turnEnd' && raw.terminationReason && raw.terminationReason !== 'model_stop') ev.skip = true;   // an error or the step limit, not a finished turn
  if (raw.toolCall) {
    const t = String(raw.toolCall.name || '');
    const args = raw.toolCall.args && typeof raw.toolCall.args === 'object' ? raw.toolCall.args : {};
    const input = { ...args };
    if (t === 'run_command') input.command = args.CommandLine;
    if (t === 'invoke_subagent') input.description = (args.Subagents || []).map(s => s.Role || s.TypeName || String(s.Prompt || '').slice(0, 60)).join(', ');
    ev.tool = { name: toolKind(t), raw: t, input };
  }
  return ev;
}

export function render(ev, r) {
  const out = { stdout: '', stderr: '', code: 0 };
  if (ev.kind === 'turnEnd') { out.stdout = JSON.stringify(r.block ? { decision: 'continue', reason: r.block.reason } : { decision: 'allow' }); return out; }
  if (ev.kind === 'sessionStart' || ev.kind === 'userPrompt') {
    if (r.context) out.stdout = JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: r.context } }] });
    return out;
  }
  if (ev.kind === 'beforeTool') {
    if (r.block) { out.stdout = JSON.stringify({ decision: 'deny', reason: r.block.reason }); return out; }
    const o = { decision: 'allow' };
    if (r.updatedCommand != null && ev.tool?.raw === 'run_command') o.overwrite = { CommandLine: r.updatedCommand };
    if (r.context) o.reason = r.context;
    out.stdout = JSON.stringify(o);
  }
  return out;
}

export const caps = {
  rules: 'yes (SessionStart)',
  gate: 'yes (Stop)',
  commitDeny: 'yes (PreToolUse)',
  testRewrite: 'yes (PreToolUse)',
  subagentNote: 'unknown',
  sessionStart: 'yes (SessionStart)',
  userPrompt: 'yes (PreInvocation)',
  beforeTool: 'yes (PreToolUse)',
  afterTool: 'yes (PostToolUse)',
  turnEnd: 'yes (Stop)',
  waiting: 'no',
  skills: 'yes (.agents/skills)',
  subagents: 'yes (.agents/agents)',
};
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'stop-continue', turnEnd: 'stop-continue', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', userPrompt: 'user-prompt', afterTool: 'tool-after' };

export function install({ root, data, node, project, home, global }) {
  const hooksFile = global ? `${home}/.gemini/config/hooks.json` : `${project}/.agents/hooks.json`;
  const c = (hook, script, ...a) => hookCommand({ node, root, data, agent: name }, script, ...a, '--hook', hook);
  const h = (hook, script, timeout, ...a) => ({ type: 'command', command: c(hook, script, ...a), timeout });
  return {
    files: [{
      path: hooksFile,
      json: {
        proof: {
          SessionStart: [h('SessionStart', 'session-start.mjs', TIMEOUTS.sessionStart)],
          PreInvocation: [h('PreInvocation', 'gate.mjs', TIMEOUTS.event, '--prompt')],
          PreToolUse: [
            { matcher: 'run_command', hooks: [h('PreToolUse', 'gate.mjs', TIMEOUTS.gate, '--commit')] },
            { matcher: '.*', hooks: [h('PreToolUse', 'wrap.mjs', TIMEOUTS.wrap)] },
            { matcher: '.*', hooks: [h('PreToolUse', 'admit.mjs', TIMEOUTS.admit)] },   // subagents and browsers
          ],
          PostToolUse: [{ matcher: '.*', hooks: [h('PostToolUse', 'event.mjs', TIMEOUTS.event)] }],
          Stop: [h('Stop', 'gate.mjs', TIMEOUTS.gate)],
        },
      },
    }],
    skillsDir: global ? `${home}/.gemini/config/skills` : `${project}/.agents/skills`,
    agentsDir: global ? `${home}/.gemini/config/agents` : `${project}/.agents/agents`,
    agentFile: (n, description, body) => `---\nname: ${n}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}`,
    notes: ['Antigravity doesn\'t show proof\'s "still failing" message at the end of a turn (its Stop hook has no field for one).', 'Antigravity caps how many times in a row a Stop hook can keep the agent working; past that cap the turn ends whatever proof\'s maxRounds says.'],
  };
}
