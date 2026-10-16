#!/usr/bin/env node
// proof — PreToolUse hook for starting subagents and browsers. A new agent usually runs tests, builds or a browser
// of its own, and a fresh Playwright browser takes several hundred MB, so neither starts when the machine has no
// room under its memory ceiling. Like heavy commands, they wait (up to 3 minutes) for Claude's guarded runs to
// finish first, then are refused with what is using memory. Claude in Chrome and the desktop app's browser use
// browsers that are already open, so they always pass.
import { readStdin } from './lib.mjs';
import { DEFAULT_NEED, MACHINE, admit, advice, gb, liveRuns, machineConfig, snapshot } from './mem.mjs';

const input = readStdin();
const tool = String(input.tool_name || '');
const isAgent = /^(Agent|Task)$/.test(tool);
const isBrowserStart = /^mcp__/.test(tool) && !/claude-in-chrome|Claude_Browser/.test(tool) && /(playwright|puppeteer|chrome-devtools|browser)/i.test(tool) && /navigate|new_page|tabs?_create|open|launch|install/i.test(tool);
if (!isAgent && !isBrowserStart) process.exit(0);

const need = isAgent ? DEFAULT_NEED.subagent : DEFAULT_NEED.browser;
const t0 = Date.now();
let a = admit(need);
while (!a.ok && liveRuns().length && Date.now() - t0 < machineConfig().admitWaitS * 1000) {
  await new Promise(r => setTimeout(r, 3000));
  a = admit(need);
}
if (!a.ok) {
  const what = isAgent ? `start another agent ("${String(input.tool_input?.description || '').slice(0, 80)}")` : 'open a new browser';
  process.stderr.write([
    `proof memory: not able to ${what} now. The ${MACHINE} is at ${a.system.pct.toFixed(0)}% (${gb(a.system.usedMB)} of ${gb(a.system.totalMB)}) and this needs about ${gb(need)}, past proof's ${a.system.ceilingPct}% ceiling.`,
    advice(snapshot({ env: true }), need).text,
    isAgent ? 'Let running agents finish first, or do this work in an agent that is already running. If the user\'s apps hold the memory, tell them what closing them would free and end your message with a line starting NEEDS-INPUT:.' : 'Reuse a browser that is already open, or free memory first.',
  ].join('\n'));
  process.exit(2);
}
if (a.warn && isAgent) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: `proof memory: the ${MACHINE} is at ${a.system.pct.toFixed(0)}% (${gb(a.system.headroomMB)} left under the ${a.system.ceilingPct}% ceiling). Keep parallel agents to what memory allows; heavy commands will take turns.` } }));
}
