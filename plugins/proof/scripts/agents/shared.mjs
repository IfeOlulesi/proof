// Pieces several adapters share.

// A browser tool that starts a new browser (Playwright, Puppeteer, Chrome DevTools MCP servers). Claude in Chrome and
// the desktop app's browser reuse one that's already open, so they don't count.
export const BROWSER_START = t => /^(mcp__|MCP:|mcp_)?/.test(t) && !/claude-in-chrome|Claude_Browser/.test(t)
  && /(playwright|puppeteer|chrome-devtools|browser)/i.test(t) && /navigate|new_page|tabs?_create|open|launch|install/i.test(t);

// A hook command line: node, the script, the agent and the shared data folder. Paths are quoted for a POSIX shell.
const q = s => (/^[\w@%+=:,./-]+$/.test(s) ? s : `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`);
export function hookCommand({ node = 'node', root, data, agent }, script, ...args) {
  return [q(node), q(`${root}/scripts/${script}`), ...args, '--agent', agent, '--data', q(data)].join(' ');
}

// proof's hook timeouts, in seconds: session start, the memory hooks, the gate.
export const TIMEOUTS = { sessionStart: 15, wrap: 240, admit: 240, gate: 900, event: 15 };

// Claude Code's hook output format, which Codex, Gemini CLI, Grok Build and Antigravity follow closely. `events` maps
// proof's event kinds to the agent's hook names, for hookSpecificOutput.hookEventName.
export function renderClaudeStyle(ev, r, events, { turnEndBlock = 'decision' } = {}) {
  const out = { stdout: '', stderr: '', code: 0 };
  const hookEventName = events[ev.kind];
  if (ev.kind === 'turnEnd') {
    if (r.block) out.stdout = JSON.stringify({ decision: 'block', reason: r.block.reason, ...(r.message ? { systemMessage: r.message } : {}) });
    else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
    return out;
  }
  if (r.block) return { ...out, stderr: r.block.reason, code: 2 };
  const h = {};
  if (ev.kind === 'beforeTool' && r.updatedCommand != null) h.updatedInput = { ...ev.tool?.input, command: r.updatedCommand };
  if (r.context) h.additionalContext = r.context;
  if (Object.keys(h).length) out.stdout = JSON.stringify({ hookSpecificOutput: { hookEventName, ...h }, ...(r.message ? { systemMessage: r.message } : {}) });
  else if (r.message) out.stdout = JSON.stringify({ systemMessage: r.message });
  return out;
}
