#!/usr/bin/env node
// proof — PreToolUse hook for Bash.
//  1. Test runs (unit and end-to-end), heavy builds and wait loops run under the proof guard: a time limit and memory
//     ceilings that also cover background runs. The command is rewritten; anything else passes through untouched.
//  2. Heavy runs fit the memory there is. If starting one would take the machine past its ceiling (90% by default) and
//     its test runner can be capped (fit.mjs), it runs with as many workers as fit. Otherwise the hook waits for
//     Claude's other guarded runs to finish (up to 3 minutes); if not even one worker fits by then, it refuses and
//     says what is using memory, including the user's apps that would free the most.
//  3. Memory stops proof made since this session's last command are passed on to Claude.
// Limits come from .claude/proof.json when it has them: testRunTimeout (default 900s), buildTimeout (1800s),
// waitTimeout (300s), maxMemoryMB (whole run, default half of RAM), maxProcessMemoryMB (any one process, a quarter).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRoot, loadConfig, readStdin } from './lib.mjs';
import { planRun } from './fit.mjs';
import { MACHINE, admit, advice, dataDir, gb, hold, liveRuns, machineConfig, recentEvents, snapshot } from './mem.mjs';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'guard.mjs');

// A command in command position: at the start, or after && || ; | & ( $( or a newline, optionally behind environment
// assignments, `time`, or a launcher such as npx, uv run or python -m. Mentions inside arguments (a commit message,
// a grep pattern, a file name) don't count.
const SEG = String.raw`(?:^|&&|\|\||[;|&(\n]|\$\()\s*`;
const PRE = String.raw`(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:time|nice|caffeinate|timeout\s+\S+)\s+(?:-\S+\s+)*)?`;
const VIA = String.raw`(?:(?:npx|bunx)\s+(?:--?[\w-]+(?:=\S+)?\s+)*|(?:pnpm|yarn)\s+(?:exec\s+|dlx\s+)?|(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+|(?:\S*\/)?python[\d.]*\s+-m\s+|(?:\S*\/)?node\s+)?`;
const TOK = String.raw`(?:[^\s;&|]+\s+)*`;   // more words in the same command, never past a separator
const SCRIPT = String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?)`;
const TESTS = [
  String.raw`(?:\S*\/)?(?:pytest|py\.test|jest|vitest|mocha|ava|rspec|phpunit|tox|nox)(?![\w.-])`,
  String.raw`${SCRIPT}(?:tests?|e2e)(?::[\w:-]+)?(?![\w-])|npm\s+t\b`,
  String.raw`(?:go|cargo|flutter|dart|deno|bun|swift|mix|dotnet)\s+test\b`,
  String.raw`playwright\s+test\b|maestro\s+test\b|detox\s+test\b|cypress\s+run\b`,
  String.raw`(?:\S*\/)?gradlew\s+${TOK}\S*[Tt]est`,
  String.raw`xcodebuild\b[^;&|\n]*\stest\b`,
  String.raw`(?:\S*\/)?(?:make|just)\s+${TOK}test`,
  String.raw`(?:\S*\/)?python[\d.]*\s+${TOK}(?:manage\.py\s+test|-m\s+unittest)\b`,
].join('|');
const BUILDS = [
  String.raw`xcodebuild\b(?![^;&|\n]*\stest\b)`,
  String.raw`eas\s+build\b[^;&|\n]*--local`,
  String.raw`(?:\S*\/)?gradlew\s+${TOK}\S*(?:assemble|bundle)\S*`,
  String.raw`${SCRIPT}build(?::[\w:-]+)?(?![\w-])`,
  String.raw`next\s+build\b|vite\s+build\b|expo\s+export\b|flutter\s+build\b|cargo\s+build\b|swift\s+build\b|docker\s+(?:compose\s+)?build\b`,
].join('|');
export const TEST_RUN = new RegExp(`${SEG}${PRE}${VIA}(?:${TESTS})`);
export const BUILD_RUN = new RegExp(`${SEG}${PRE}${VIA}(?:${BUILDS})`);
export const E2E = /\be2e\b|playwright\s+test|maestro\s+test|detox\s+test|cypress\s+run/;
// A loop that polls until something happens: until/while … ; do … sleep … ; done.
export const WAIT_LOOP = /(?:^|[;&|(\n]\s*)(?:until|while)\s[^\n]*?;\s*do\b[^\n]*?\bsleep\s/;

export function kindOf(cmd) {
  if (typeof cmd !== 'string' || cmd.includes('guard.mjs')) return null;
  if (TEST_RUN.test(cmd)) return E2E.test(cmd) ? 'e2e' : 'test';
  if (BUILD_RUN.test(cmd)) return 'build';
  if (WAIT_LOOP.test(cmd)) return 'wait';
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

async function main() {
  const input = readStdin();
  const ti = input.tool_input || {};
  const cmd = ti.command;
  if ((input.tool_name && input.tool_name !== 'Bash') || typeof cmd !== 'string') return;
  const notes = [relay(input.session_id)].filter(Boolean);
  const kind = kindOf(cmd);
  if (!kind) return notes.length ? emit({ additionalContext: notes.join('\n') }) : undefined;

  const cwd = input.cwd || process.cwd();
  const root = gitRoot(cwd) || cwd;
  const { config } = loadConfig(root);
  const ramMB = os.totalmem() / 2 ** 20;
  const timeout = kind === 'wait' ? Number(config?.waitTimeout) || 300 : kind === 'build' ? Number(config?.buildTimeout) || 1800 : Number(config?.testRunTimeout) || 900;
  const memLimit = Number(config?.maxMemoryMB) || Math.round(ramMB / 2);
  const procLimit = Number(config?.maxProcessMemoryMB) || Math.round(ramMB / 4);

  // Heavy runs fit the room there is: as written if it fits, else with fewer workers (the same tests, run in smaller
  // batches), else they wait while Claude's other guarded runs finish, and are refused only if not even one worker
  // fits by then.
  let run = cmd, need = 0;
  if (kind !== 'wait') {
    const plan = planRun(cmd, root, kind, cwd);
    let capped = null;
    need = plan.need;
    const t0 = Date.now();
    const waitS = machineConfig().admitWaitS;
    let a = admit(need);
    for (;;) {
      if (a.ok) break;
      const f = a.system.pressure === 'critical' ? null : plan.fit(a.roomMB);
      if (f) { capped = f; need = f.need; a = admit(need); break; }
      if (!liveRuns().length || Date.now() - t0 >= waitS * 1000) break;
      await new Promise(r => setTimeout(r, 3000));
      a = admit(need);
    }
    let cappedNote = null;
    if (capped && a.ok) {
      run = capped.cmd;
      cappedNote = (`proof memory: only ${gb(Math.max(0, a.roomMB))} is free under the ${a.system.ceilingPct}% ceiling, and this run needs about ${gb(plan.need)} with ${plan.workers} workers, so proof capped it at ${capped.workers} worker${capped.workers > 1 ? 's' : ''} (about ${gb(capped.need)}). The same tests run, in smaller batches: slower, not skipped.`);
    }
    const waited = Math.round((Date.now() - t0) / 1000);
    if (!a.ok) {
      const least = plan.least();
      const adv = advice(snapshot({ env: true }), need);
      process.stderr.write([
        `proof memory: not starting this ${kind === 'e2e' ? 'end-to-end' : kind} run. The ${MACHINE} is at ${a.system.pct.toFixed(0)}% (${gb(a.system.usedMB)} of ${gb(a.system.totalMB)}) and this run needs about ${gb(need)}${least ? ` (${gb(least.need)} even capped at one worker)` : ''}, ${a.critical ? `under proof's ${a.system.ceilingPct}% ceiling, but macOS reports critical memory pressure.` : `which would take it past proof's ${a.system.ceilingPct}% ceiling.`}${waited > 2 ? ` Waited ${waited}s for other runs to free room.` : ''}`,
        adv.text,
        'Free room first: stop your own processes you no longer need, or run a narrower command (one test file or spec). If the user\'s apps hold the memory, tell them what closing them would free and end your message with a line starting NEEDS-INPUT:.',
      ].join('\n'));
      process.exit(2);
    }
    if (waited > 2) notes.push(...[cappedNote].filter(Boolean), `proof memory: this run waited ${waited}s for memory to free up (the ${MACHINE} is at ${a.system.pct.toFixed(0)}%).`);
    else if ((cappedNote || a.warn) && warnDue(input.session_id)) notes.push(...[cappedNote].filter(Boolean), ...(a.warn ? [`proof memory: the ${MACHINE} is at ${a.system.pct.toFixed(0)}% (${gb(a.system.usedMB)} of ${gb(a.system.totalMB)}); proof keeps it under ${a.system.ceilingPct}%.${a.system.strain ? ` ${a.system.strain}` : ''} Run heavy jobs one at a time and stop dev servers, simulators and browsers you no longer need. \`node "${join(dirname(GUARD), 'mem.mjs')}"\` shows what is using it.`] : []));
  }

  const command = `${shq(process.execPath)} ${shq(GUARD)} --timeout ${timeout} --mem ${memLimit} --proc-mem ${procLimit} --kind ${kind}${kind !== 'wait' ? ` --need ${Math.round(need)} --hold ${hold(need)}` : ''} --data ${shq(dataDir())} -- ${shq(run)}`;
  emit({ updatedInput: { ...ti, command }, additionalContext: notes.join('\n') || undefined });
}

// Memory stops since this session last heard about them.
function relay(sessionId) {
  if (!sessionId) return null;
  const file = join(dataDir(), 'sessions', `relay-${String(sessionId).replace(/[^\w.-]/g, '_')}.txt`);
  let since = 0;
  try { since = Number(readFileSync(file, 'utf8')) || 0; } catch { since = Date.now() - 60e3; }
  const evs = recentEvents(since).filter(e => e.kind === 'memoryStop');
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, String(Date.now())); } catch {}
  if (!evs.length) return null;
  return evs.map(e => `proof memory: the ${MACHINE} reached ${e.pct}% of its memory, so proof stopped ${e.guarded ? 'the newest guarded run' : 'a process Claude started'}: ${String(e.command || '').slice(0, 120)} (${e.mb} MB${e.cwd ? `, in ${String(e.cwd).split('/').pop()}` : ''}). If you still need it, restart it once there's room.`).join('\n');
}

// Memory warnings at most every 10 minutes per session.
function warnDue(sessionId) {
  const file = join(dataDir(), 'sessions', `warned-${String(sessionId || 'none').replace(/[^\w.-]/g, '_')}.txt`);
  let last = 0;
  try { last = Number(readFileSync(file, 'utf8')) || 0; } catch {}
  if (Date.now() - last < 10 * 60e3) return false;
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, String(Date.now())); } catch {}
  return true;
}

function emit(out) {
  const h = { hookEventName: 'PreToolUse', ...out };
  if (!h.additionalContext) delete h.additionalContext;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: h }));
}

function shq(s) { return `'${String(s).replace(/'/g, `'\\''`)}'`; }
