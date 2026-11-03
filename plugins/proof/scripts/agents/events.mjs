// The event log: what a non-Claude session did, written by proof's hooks, read by the dashboard (timeline.mjs).
// Claude Code sessions don't write one; the dashboard reads Claude's own transcripts. One file per session:
// <data folder>/events/<agent>/<session>.jsonl, one JSON object per line. The schema is in docs/agents.md.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../lib.mjs';

export const EVENT_KINDS = ['sessionStart', 'userPrompt', 'toolStart', 'toolEnd', 'turnEnd', 'gate', 'waiting'];
const FROM_HOOK = { sessionStart: 'sessionStart', userPrompt: 'userPrompt', beforeTool: 'toolStart', afterTool: 'toolEnd', turnEnd: 'turnEnd' };

export const eventFile = (agent, session) =>
  join(dataDir(), 'events', String(agent).replace(/[^\w.-]/g, '_'), `${String(session || 'none').replace(/[^\w.-]/g, '_')}.jsonl`);

// What a tool was asked to do, in a line: the command, the file, or the subagent's description.
export function toolSummary(input = {}) {
  const s = input.command ?? input.file_path ?? input.filePath ?? input.path ?? input.description ?? input.prompt ?? input.url ?? '';
  return String(s).replace(/\s+/g, ' ').slice(0, 300);
}

// The log entry for a normalised hook event, or null for events the log doesn't keep.
export function fromHook(ev) {
  const kind = FROM_HOOK[ev.kind];
  if (!kind) return null;
  const e = { kind, cwd: ev.cwd ?? null };
  if (ev.turn) e.turn = ev.turn;
  if (kind === 'sessionStart' && ev.source) e.source = ev.source;
  if (kind === 'userPrompt' && ev.prompt) e.prompt = String(ev.prompt).slice(0, 300);
  if (ev.tool) e.tool = { name: ev.tool.name, raw: ev.tool.raw ?? null, summary: toolSummary(ev.tool.input), ...(ev.tool.id ? { id: ev.tool.id } : {}) };
  if (kind === 'toolEnd' && ev.tool?.ok != null) e.ok = ev.tool.ok;
  return e;
}

// Append one entry. Never throws: the log is for the dashboard, and a hook must not fail over it.
export function logEvent(agent, session, entry) {
  if (!agent || agent === 'claude' || !session) return;
  try {
    const f = eventFile(agent, session);
    mkdirSync(join(f, '..'), { recursive: true });
    appendFileSync(f, `${JSON.stringify({ v: 1, t: Date.now(), agent, session, ...entry })}\n`);
  } catch {}
}
