#!/usr/bin/env node
// proof backfill: adds the gate runs already in Claude Code's session logs (~/.claude/projects/*/*.jsonl, kept about
// 30 days) to the ledger, so the first recap isn't empty. Lines it adds carry src: "transcript". It never counts a
// run twice: a session already in the ledger from a transcript is skipped, and for a session the gate has logged live
// only what came before its first live line is added. The logs have no code fingerprint, so a file edit between a
// failure and the pass stands in for "the code changed" (`tree` is the session's edit count).
//   node backfill.mjs [--quiet]       session start runs it once, in the background
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gitRoot } from './lib.mjs';
import { ledgerPath, readLedger, record } from './ledger.mjs';

export const markerPath = () => join(dirname(ledgerPath()), 'backfill.json');

// Subagents log their edits in their own files, so a subagent call stands in for them.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Agent', 'Task']);
// Shell commands that can change files. Read-only commands between a failure and a pass don't make it a catch.
// Output sent to /dev/null or a temp folder doesn't count, and a script only counts when its code is inline.
const WRITES = /\bsed\s+-i|\bperl\s+-[a-z]*i|\btee\s+(?!\/dev\/null|\/tmp\/)\S|(^|[^0-9&>])>{1,2}\s*(?!\/dev\/null|&|\/tmp\/|\/private\/tmp\/|\$TMPDIR)[^\s&|]|\bpython3?\s+(-c\b|-\s|-$|<<)|\bnode\s+-e|\b(mv|cp|patch|git\s+(apply|checkout|restore|revert|cherry-pick|merge|rebase|stash))\b/;

// The gate's own messages, newest wording first.
function parseMessage(text) {
  let m;
  const list = s => s.split(', ').map(x => x.trim()).filter(Boolean);
  const passed = s => list(s.split(' · ')[0].replace(/ passed$/, '')).map(n => {   // older wording ended "… passed"
    const cached = / \(cached\)/.test(n);
    return { name: n.replace(/ \((cached|fast|\d+ workers?, to fit memory)\)/g, ''), ok: true, ...(cached ? { cached } : {}) };
  });
  if ((m = /^proof ✓ full checks passed — commit allowed: (.*)$/s.exec(text))) return { mode: 'commit', outcome: 'commitAllowed', checks: passed(m[1]) };
  if ((m = /^proof ✓ (.*)$/s.exec(text))) return { mode: 'stop', outcome: 'pass', checks: passed(m[1]) };
  if ((m = /^proof: (.+?) failing — sent back to Claude \(round (\d+)\/\d+\)/.exec(text))) return { mode: 'stop', outcome: 'block', round: Number(m[2]), checks: list(m[1]).map(name => ({ name, ok: false })) };
  if ((m = /^proof ✗ (.+?) still failing after (\d+) fix round/.exec(text))) return { mode: 'stop', outcome: 'gaveUp', round: Number(m[2]), checks: list(m[1]).map(name => ({ name, ok: false })) };
  if ((m = /^proof: (.+?) still failing — Claude stopped to ask you/.exec(text))) return { mode: 'stop', outcome: 'askedUser', checks: list(m[1]).map(name => ({ name, ok: false })) };
  return null;
}

function parseBlockedCommit(text) {
  if (!/^[^\n]{0,400}proof: commit blocked — /.test(text)) return null;
  const checks = [...text.matchAll(/^✗ (.+?) — /gm)].map(m => ({ name: m[1], ok: false }));
  return { mode: 'commit', outcome: 'commitBlocked', checks };
}

// The logs record the folder Claude was in; the gate records the repo root. Match them (a deleted worktree keeps its folder).
const roots = new Map();
const rootOf = cwd => {
  if (!cwd) return null;
  if (!roots.has(cwd)) roots.set(cwd, (existsSync(cwd) && gitRoot(cwd)) || cwd);
  return roots.get(cwd);
};

// Gate runs in one session log, in order: { t, session, prompt, root, branch, tree, mode, outcome, checks }.
// `seen` is shared across files: a resumed or forked session's file repeats the earlier records (same uuids).
export async function readTranscript(file, seenRecords = new Set()) {
  const runs = [];
  const seen = new Set();   // a hook's message is logged more than once (system message, hook output); count it once
  let edits = 0;
  const took = new Map();   // hook call -> how long the gate took (logged with the hook's output, just before its message)
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('proof') && !line.includes('gate.mjs') && !line.includes('"tool_use"')) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.uuid) { if (seenRecords.has(r.uuid)) continue; seenRecords.add(r.uuid); }
    const t = Date.parse(r.timestamp);
    if (!t) continue;
    const at = { t, session: r.sessionId || r.session_id || null, prompt: r.promptId || null, root: rootOf(r.cwd), branch: r.gitBranch || null };
    const content = Array.isArray(r.message?.content) ? r.message.content : [];
    for (const c of content) {
      if (c.type === 'tool_use' && (EDIT_TOOLS.has(c.name) || (c.name === 'Bash' && WRITES.test(String(c.input?.command || ''))))) edits++;
      if (c.type === 'tool_result') {
        const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map(x => x.text || '').join('\n') : '';
        const run = parseBlockedCommit(text.replace(/^PreToolUse:Bash hook error: \[[^\]]*\]: /, ''));
        if (run && !seen.has(c.tool_use_id)) { seen.add(c.tool_use_id); runs.push({ ...at, tree: `edits:${edits}`, ...run }); }
      }
    }
    const a = r.attachment;
    if (a?.type === 'hook_success' && /gate\.mjs/.test(a.command || '') && a.durationMs > 0) took.set(a.toolUseID, a.durationMs);
    if (a?.type === 'hook_system_message' && typeof a.content === 'string') {
      const run = parseMessage(a.content);
      const key = `${a.toolUseID}:${a.content.slice(0, 80)}`;
      if (run && !seen.has(key)) { seen.add(key); runs.push({ ...at, tree: `edits:${edits}`, ...(took.has(a.toolUseID) ? { ms: took.get(a.toolUseID) } : {}), ...run }); }
    }
  }
  return runs;
}

export function transcriptFiles(dir = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'projects')) {
  const out = [];
  let projects = [];
  try { projects = readdirSync(dir); } catch { return out; }
  for (const p of projects) {
    let files = [];
    try { files = readdirSync(join(dir, p)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(join(dir, p, f));
  }
  return out;
}

export async function backfill({ files = transcriptFiles(), now = Date.now() } = {}) {
  const ledger = readLedger();
  const fromTranscripts = new Set(ledger.filter(e => e.src === 'transcript').map(e => e.session));
  const firstLive = new Map();
  for (const e of ledger) if (e.src !== 'transcript' && e.session && !firstLive.has(e.session)) firstLive.set(e.session, e.t);
  let added = 0, sessions = 0;
  const seenRecords = new Set();
  const born = f => { try { const s = statSync(f); return s.birthtimeMs || s.mtimeMs; } catch { return 0; } };
  for (const f of [...files].sort((a, b) => born(a) - born(b))) {   // oldest first: the original keeps its records
    let runs;
    try { runs = await readTranscript(f, seenRecords); } catch { continue; }
    const bySession = new Map();
    for (const r of runs) {
      if (!r.session || fromTranscripts.has(r.session)) continue;
      if (r.t >= (firstLive.get(r.session) ?? now)) continue;
      if (!bySession.has(r.session)) bySession.set(r.session, []);
      bySession.get(r.session).push(r);
    }
    for (const [session, list] of bySession) {
      fromTranscripts.add(session);
      sessions++;
      record(...list.map(({ t, ...rest }) => ({ src: 'transcript', ...rest, t })));
      added += list.length;
    }
  }
  try { mkdirSync(dirname(markerPath()), { recursive: true }); writeFileSync(markerPath(), JSON.stringify({ at: now, added, sessions })); } catch {}
  return { added, sessions };
}

export async function backfillCli(quiet) {
  const { added, sessions } = await backfill();
  if (!quiet) console.log(`proof backfill: ${added} gate run${added === 1 ? '' : 's'} from ${sessions} session${sessions === 1 ? '' : 's'} added to ${ledgerPath()}`);
}

export const backfillDone = () => existsSync(markerPath());

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await backfillCli(process.argv.includes('--quiet'));
