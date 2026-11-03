// opencode: proof runs as an opencode plugin (a JS file in .opencode/plugins/, or ~/.config/opencode/plugins/ with
// --global). The plugin, written by the installer from pluginSource() below, calls proof's hook scripts with a JSON
// event of its own on stdin, and reads proof's result back as JSON. So the "hook input" this adapter parses is the
// plugin's, defined here, and its output is proof's result unchanged.
// Plugin API: https://opencode.ai/docs/plugins/ ; checked live against opencode 1.18.18 (SPEC decision log, F2).
import { BROWSER_START } from './shared.mjs';

export const name = 'opencode';
export const label = 'opencode';
export const tested = 'live';   // opencode 1.18.18
export const words = { agent: 'opencode', memoryFile: 'AGENTS.md', clear: 'a new session (/new)', verifier: 'the proof-verifier subagent (@proof-verifier)' };

const KINDS = { sessionStart: 'sessionStart', userPrompt: 'userPrompt', beforeTool: 'beforeTool', afterTool: 'afterTool', turnEnd: 'turnEnd' };

export function toolKind(t) {
  if (t === 'bash') return 'shell';
  if (/^(edit|write|patch|multiedit|apply_patch)$/.test(t)) return 'edit';
  if (t === 'task') return 'subagent';
  if (BROWSER_START(t)) return 'browser';
  return 'other';
}

export function parse(raw, kind) {
  const ev = {
    agent: name,
    kind: KINDS[raw.hook] || kind,
    session: raw.sessionID ?? null,
    turn: null,
    continuation: typeof raw.continuation === 'boolean' ? raw.continuation : null,
    round: null,
    cwd: raw.cwd ?? null,
    lastMessage: null,
    source: raw.source ?? null,
    prompt: raw.prompt ?? null,
  };
  if (raw.tool !== undefined) {
    const input = raw.args && typeof raw.args === 'object' ? raw.args : {};
    ev.tool = { name: toolKind(String(raw.tool || '')), raw: raw.tool ?? null, input, ...(raw.callID ? { id: raw.callID } : {}) };
    if (typeof raw.ok === 'boolean') ev.tool.ok = raw.ok;
  }
  return ev;
}

// The plugin reads proof's result as it is.
export function render(ev, r) {
  const keep = Object.fromEntries(Object.entries(r).filter(([, v]) => v != null && v !== ''));
  return { stdout: Object.keys(keep).length ? JSON.stringify(keep) : '', stderr: '', code: 0 };
}

export const caps = {
  rules: 'yes (experimental.chat.system.transform)',
  gate: 'yes (session.idle + session.promptAsync)',
  commitDeny: 'yes (tool.execute.before)',
  testRewrite: 'yes (tool.execute.before)',
  subagentNote: 'yes (tool.execute.before)',
  sessionStart: 'yes (experimental.chat.system.transform)',
  userPrompt: 'yes (chat.message)',
  beforeTool: 'yes (tool.execute.before)',
  afterTool: 'yes (tool.execute.after)',
  turnEnd: 'yes (session.idle)',
  waiting: 'no',
  skills: 'yes (.opencode/skills)',
  subagents: 'yes (.opencode/agents)',
};

// Which caps the fixtures exercise (tests/agents.sh checks every "yes" has one).
export const fixtureCaps = { rules: 'session-start', sessionStart: 'session-start', gate: 'idle-block', turnEnd: 'idle-block', commitDeny: 'commit-denied', testRewrite: 'test-command-rewritten', beforeTool: 'test-command-rewritten', subagentNote: 'task-note', userPrompt: 'user-prompt', afterTool: 'tool-after' };

// Where proof's files go. `dir` is the project (or the user's opencode config folder with --global).
export function install({ root, data, node, project, home, global }) {
  const base = global ? `${home}/.config/opencode` : `${project}/.opencode`;
  return {
    files: [{ path: `${base}/plugins/proof.js`, text: pluginSource({ root, data, node }) }],
    skillsDir: `${base}/skills`,
    agentsDir: `${base}/agents`,
    agentFile: (n, description, body) => `---\ndescription: ${description}\nmode: subagent\n---\n\n${body}`,
    notes: ['The gate keeps opencode working on a failing check in the TUI and `opencode serve`; one-shot `opencode run` exits at the first idle, so there it only reports the failure.'],
  };
}

// The plugin file. Absolute paths are baked in, so it works from any project.
export function pluginSource({ root, data, node }) {
  return `// proof for opencode — written by proof's installer (${root}/scripts/install.mjs opencode).
// Don't edit it: re-run the installer, or remove proof with --uninstall.
import { spawn } from 'node:child_process';

const NODE = ${JSON.stringify(node)};
const SCRIPTS = ${JSON.stringify(`${root}/scripts`)};
const DATA = ${JSON.stringify(data)};

// Run one of proof's hook scripts with an event on stdin; resolve with its result (an object, maybe empty).
function call(script, args, event, timeoutS) {
  return new Promise(done => {
    let out = '';
    const p = spawn(NODE, [\`\${SCRIPTS}/\${script}\`, ...args, '--agent', 'opencode', '--data', DATA], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => p.kill('SIGTERM'), timeoutS * 1000);
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => { clearTimeout(timer); done({}); });
    p.on('close', () => { clearTimeout(timer); try { done(out.trim() ? JSON.parse(out) : {}); } catch { done({}); } });
    p.stdin.end(JSON.stringify(event));
  });
}

export const Proof = async ({ client, directory }) => {
  const rules = new Map();        // session → proof's rules, added to every system prompt
  const notes = new Map();        // tool call → a note proof adds to that tool's result
  const sentByProof = new Set();  // follow-up prompts proof sent, so they aren't taken for the user's
  const fixRound = new Map();     // session → is the turn running now one proof asked for
  const gating = new Set();       // sessions whose gate is running
  const parents = new Map();      // session → is it a subagent's
  const text = parts => (parts || []).filter(p => p.type === 'text' && !p.synthetic).map(p => p.text).join('\\n').trim();
  const toast = (message, variant) => client.tui?.showToast?.({ body: { message, variant } }).catch(() => {});

  return {
    'experimental.chat.system.transform': async (input, output) => {
      const id = input.sessionID;
      if (!id) return;
      if (!rules.has(id)) rules.set(id, (await call('session-start.mjs', [], { hook: 'sessionStart', sessionID: id, cwd: directory, source: 'startup' }, 15)).context || '');
      if (rules.get(id)) output.system.push(rules.get(id));
    },
    'chat.message': async (input, output) => {
      const prompt = text(output.parts);
      const ours = sentByProof.has(prompt);
      fixRound.set(input.sessionID, ours);
      if (!ours) await call('gate.mjs', ['--prompt'], { hook: 'userPrompt', sessionID: input.sessionID, cwd: directory, prompt }, 15);
    },
    'tool.execute.before': async (input, output) => {
      const event = { hook: 'beforeTool', sessionID: input.sessionID, cwd: directory, tool: input.tool, callID: input.callID, args: output.args };
      // wrap.mjs first: it sees every tool call, so the dashboard's log has the step even when the gate refuses it.
      const r = await call('wrap.mjs', [], event, 240);
      if (r.block) throw new Error(r.block.reason);
      const a = await call('admit.mjs', [], event, 240);   // subagents and browsers; it passes everything else at once
      if (a.block) throw new Error(a.block.reason);
      if (input.tool === 'bash' && /\\bgit\\b/.test(output.args?.command || '')) {
        const c = await call('gate.mjs', ['--commit'], event, 900);
        if (c.block) throw new Error(c.block.reason);
      }
      if (r.updatedCommand) output.args.command = r.updatedCommand;
      const note = [a.context, r.context].filter(Boolean).join('\\n');
      if (note) notes.set(input.callID, note);
    },
    'tool.execute.after': async (input, output) => {
      call('event.mjs', [], { hook: 'afterTool', sessionID: input.sessionID, cwd: directory, tool: input.tool, callID: input.callID, args: input.args }, 15);
      const note = notes.get(input.callID);
      if (note) { notes.delete(input.callID); output.output = \`\${output.output ?? ''}\\n\\n\${note}\`; }
    },
    event: async ({ event }) => {
      if (event.type !== 'session.idle') return;
      const id = event.properties?.sessionID;
      if (!id || gating.has(id)) return;
      // A subagent's session (one with a parent) isn't gated: its follow-up would land in the subagent, not the user's.
      if (!parents.has(id)) parents.set(id, !!(await client.session.get({ path: { id } }).catch(() => ({}))).data?.parentID);
      if (parents.get(id)) return;
      gating.add(id);
      try {
        const r = await call('gate.mjs', [], { hook: 'turnEnd', sessionID: id, cwd: directory, continuation: fixRound.get(id) === true }, 900);
        if (r.message) toast(r.message, r.block ? 'warning' : /✗|failing/.test(r.message) ? 'error' : 'success');
        if (r.block) {
          sentByProof.add(r.block.reason.trim());
          await client.session.promptAsync({ path: { id }, body: { parts: [{ type: 'text', text: r.block.reason }] } });
        }
      } catch {} finally { gating.delete(id); }
    },
  };
};
`;
}
