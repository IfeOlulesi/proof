// What proof's rules and skills call things, per agent. rules.md and the skills are written for Claude Code; for
// other agents the placeholders in rules.md and the Claude-only names in the skills are reworded here.

// Claude Code: the words rules.md has always used.
export const CLAUDE = {
  agent: 'Claude',
  skill: n => `skill proof:${n}`,
  name: n => `proof:${n}`,
  verifier: 'the proof:verifier agent',
  memoryFile: 'CLAUDE.md',
  clear: '/clear',
  wait: 'Wait for a background run with TaskOutput (it returns when the run exits)',
};

// Any other agent. Adapters override what differs in their `words` (the agent's name, how it names skills and
// subagents, its memory file).
export const GENERIC = {
  agent: 'the agent',
  skill: n => `skill proof-${n}`,
  name: n => `proof-${n}`,
  verifier: 'the proof-verifier subagent',
  memoryFile: 'AGENTS.md',
  clear: 'a fresh session',
  wait: 'Run a long test or build in the foreground and let it finish (proof gives test runs up to 15 minutes)',
};

export function wordsFor(adapter) {
  return adapter?.name === 'claude' ? CLAUDE : { ...GENERIC, ...(adapter?.words || {}) };
}

// Fill rules.md's {{…}} placeholders.
export function renderRules(text, adapter) {
  const w = wordsFor(adapter);
  return text
    .replace(/\{\{skill:([\w-]+)\}\}/g, (_, n) => w.skill(n))
    .replace(/\{\{name:([\w-]+)\}\}/g, (_, n) => w.name(n))
    .replace(/\{\{(agent|verifier|memoryFile|clear|wait)\}\}/g, (_, k) => w[k]);
}

// Names that only exist in Claude Code. None may appear in what another agent is given.
export const CLAUDE_ONLY = [/CLAUDE_\w*/, /!`/, /\bTaskOutput\b/, /claude -p/, /CLAUDE\.md/, /\bproof:[\w-]+/, /\/clear\b/, /\bClaude\b/];

// A skill or subagent file written for Claude Code, reworded for another agent. `root` is proof's plugin folder,
// `skillDir` the skill's own folder in it (its references, scripts and templates stay there), `data` the data folder.
export function renderSkill(text, adapter, { root, skillDir = root, data }) {
  const w = wordsFor(adapter);
  return text
    .replace(/^!`(.*)`\s*$/gm, (_, cmd) => `Run this first: \`${cmd}\``)
    .replace(/^If the line above shows the command itself.*\n?/gm, '')
    .replace(/The line above starts/g, 'That command starts')
    .replace(/ If it shows the command itself rather than a (URL|result), run it once\./g, '')
    .replace(/PROOF_DATA_DIR="\$\{CLAUDE_PLUGIN_DATA\}" /g, `PROOF_DATA_DIR="${data}" `)
    .replace(/ ?\$\{CLAUDE_SESSION_ID\}/g, '')
    .replace(/\$\{CLAUDE_SKILL_DIR\}/g, skillDir)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, root)
    .replace(/\$CLAUDE_PLUGIN_ROOT/g, '$PROOF_ROOT')
    .replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, data)
    .replace(/process\.env\.CLAUDE_PLUGIN_DATA/g, 'process.env.PROOF_DATA_DIR')
    .replace(/start it in the background and wait on it with TaskOutput, which returns when the run exits\./g, `${w.wait.replace(/^Run/, 'run')}.`)
    .replace(/\bproof:verifier( agent)?\b/g, w.verifier)
    .replace(/\bproof:([\w-]+)/g, (_, n) => w.name(n))
    .replace(/\(`CLAUDECODE`, `AI_AGENT` and similar, which Claude Code sets\)/g, '(`AI_AGENT` and similar, which coding agents set)')
    .replace(/\bClaude Code session/g, 'coding-agent session')
    .replace(/\bClaude Code\b/g, 'your coding agent')
    .replace(/\bCLAUDE\.md\b/g, w.memoryFile)
    .replace(/\/clear\b/g, w.clear)
    .replace(/\bClaude\b/g, w.agent);
}
