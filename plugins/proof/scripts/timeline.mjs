#!/usr/bin/env node
// proof timeline: reads Claude Code session logs (~/.claude/projects/<project>/<session>.jsonl, plus each session's
// subagents/ folder) and works out what happened and when: every tool call with Claude's own description of it and
// how long it took, model time, gate runs, guard stops, waits on the user, the task list, commits. The live dashboard
// (monitor.mjs) feeds it new lines as they're written; on its own it prints where a build's time went:
//   node timeline.mjs <project-dir | session.jsonl>... [--json]
import { closeSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Categories, in the order the dashboard lists them. `prio` decides which one a moment is drawn as when several
// things happen at once (higher wins).
export const CATEGORIES = {
  model: { label: 'Claude thinking & writing', prio: 2 },
  edit: { label: 'Editing code', prio: 6 },
  read: { label: 'Reading & searching', prio: 5 },
  test: { label: 'Tests', prio: 12 },
  typecheck: { label: 'Type checks & lint', prio: 11 },
  fidelity: { label: 'Screens & browser', prio: 13 },
  build: { label: 'Builds & installs', prio: 10 },
  devserver: { label: 'Dev servers & simulators', prio: 9 },
  gate: { label: 'proof gate', prio: 14 },
  hooks: { label: 'Other hooks', prio: 8 },
  git: { label: 'Git', prio: 7 },
  subagent: { label: 'Subagents', prio: 4 },
  plan: { label: 'Planning', prio: 3 },
  web: { label: 'Web lookups', prio: 6 },
  api: { label: 'API errors & retries', prio: 1 },
  compact: { label: 'Compacting context', prio: 15 },
  shell: { label: 'Other commands', prio: 5 },
  waitUser: { label: 'Waiting on you', prio: 20 },
  asleep: { label: 'Mac asleep mid-work', prio: 30 },   // live: measured by the monitor; from logs: inferred
  idle: { label: 'Stalls & gaps', prio: 0 },
};

// ---- classification -----------------------------------------------------------------------------------------------

export function classifyBash(cmd = '') {
  const c = String(cmd).replace(/\s+/g, ' ');
  if (/gate\.mjs['"]?\s+--run|check-spec|proof\/scripts\/gate/.test(c)) return 'gate';
  if (/verify-(screen|many)|extract-inventory|check-design|run-screens|screen-judge/.test(c)) return 'fidelity';
  if (/(^|[\s;&|(/])(jest|vitest|pytest|py\.test|mocha|ava|rspec|phpunit)\b|\b(npm|pnpm|yarn|bun) (run )?(tests?|e2e)\b|\bnpm t\b|\b(go|cargo|flutter|dart|deno|swift|mix|dotnet) test\b|playwright test\b|maestro (test|cloud)|xcodebuild[^;&|]* test\b|manage\.py test|-m unittest|gradlew[^;&|]*[Tt]est|\be2e\//.test(c)) return 'test';
  if (/\btsc\b|typecheck|type-check|\beslint\b|\b(npm|pnpm|yarn|bun) (run )?lint|\bdeno (check|lint)|\bprettier\b|\bbiome\b|\bruff\b|\bmypy\b|\bflutter analyze|swiftlint|ktlint/.test(c)) return 'typecheck';
  if (/playwright|chromium|puppeteer|screenshot|agent-browser|headless|lighthouse/.test(c)) return 'fidelity';
  if (/expo start|\bmetro\b|\b(npm|pnpm|yarn|bun) (run )?(dev|start|web|ios|android)\b|\bvite\b(?! build)|next dev|simctl|\bemulator\b|\badb\b|open -a Simulator|run:ios|run:android|supabase (start|functions serve)|docker (compose )?up|\blsof -i|curl[^|;&]*localhost|curl[^|;&]*127\.0\.0\.1/.test(c)) return 'devserver';
  if (/xcodebuild|eas build|gradlew|expo (export|prebuild)|pod install|\b(npm|pnpm|yarn|bun) (i|install|ci|add)\b|npx expo install|pip install|uv (sync|add|pip)|\b(npm|pnpm|yarn|bun) (run )?build\b|next build|vite build|cargo build|go build|flutter build|swift build|docker build/.test(c)) return 'build';
  if (/(^|[\s;&|(])git\s/.test(c)) return 'git';
  if (/^(cd \S+ && )?(ls|cat|head|tail|grep|rg|find|wc|sed -n|awk|tree|stat|file|jq|less|diff|sort|uniq|du|pwd|which|echo)\b/.test(c.trim())) return 'read';
  return 'shell';
}

export function classifyTool(name, input = {}) {
  if (name === 'Bash' || name === 'BashOutput') return classifyBash(input.command);
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return 'edit';
  if (/^(Read|Grep|Glob|LS|NotebookRead|ToolSearch|LSP)$/.test(name)) return 'read';
  if (/^(Task|Agent)$/.test(name)) return 'subagent';
  if (/^(TodoWrite|TaskCreate|TaskUpdate|TaskList|TaskGet|ExitPlanMode|EnterPlanMode|Skill)$/.test(name)) return 'plan';
  if (/^(WebFetch|WebSearch)$/.test(name)) return 'web';
  if (/^(AskUserQuestion)$/.test(name)) return 'waitUser';
  if (/playwright|chrome|browser|puppeteer|preview_/i.test(name)) return 'fidelity';
  if (/mobile|simulator|expo|maestro|xcode|ios|android/i.test(name)) return 'devserver';
  return 'shell';
}

export function describe(name, input = {}) {
  const tidy = s => String(s).replace(/\s+/g, ' ').trim();
  const file = p => String(p).split('/').slice(-2).join('/');
  switch (name) {
    case 'Bash': return tidy(input.description || input.command || 'Run a command').slice(0, 140);
    case 'Read': return `Read ${file(input.file_path || '')}`;
    case 'Edit': case 'MultiEdit': return `Edit ${file(input.file_path || '')}`;
    case 'Write': return `Write ${file(input.file_path || '')}`;
    case 'Grep': return `Search for ${tidy(input.pattern || '').slice(0, 60)}`;
    case 'Glob': return `Find files ${tidy(input.pattern || '').slice(0, 60)}`;
    case 'Task': case 'Agent': return `Subagent: ${tidy(input.description || input.subagent_type || '').slice(0, 100)}`;
    case 'TaskCreate': return `Plan: add "${tidy(input.subject || '').slice(0, 90)}"`;
    case 'TaskUpdate': return `Plan: task #${input.taskId} → ${input.status || 'updated'}`;
    case 'TodoWrite': return 'Plan: update the task list';
    case 'WebSearch': return `Search the web: ${tidy(input.query || '').slice(0, 80)}`;
    case 'WebFetch': return `Read ${tidy(input.url || '').slice(0, 80)}`;
    case 'Skill': return `Load skill ${input.skill || input.command || ''}`;
    case 'AskUserQuestion': return 'Ask you a question';
    case 'TaskStop': case 'KillShell': case 'KillBash': return 'Stop a background run';
    case 'TaskOutput': case 'BashOutput': return 'Wait for a background run';
    case 'ToolSearch': return 'Load more tools';
    case 'SendMessage': return `Message ${tidy(input.to || 'an agent').slice(0, 40)}`;
    case 'TaskList': case 'TaskGet': return 'Check the task list';
    case 'NotebookEdit': return `Edit ${file(input.notebook_path || '')}`;
    default: {
      const short = name.replace(/^mcp__.*?__/, '').replace(/_/g, ' ');
      const what = input.url || input.element || input.selector || input.text || input.description || '';
      return tidy(`${short} ${what}`).slice(0, 120);
    }
  }
}

// ---- reading logs incrementally -----------------------------------------------------------------------------------

// Reads whole lines appended since the last call. A partial last line waits for the next call.
export class LogReader {
  constructor(file) { this.file = file; this.pos = 0; this.rest = ''; }
  read(max = 64 * 2 ** 20) {
    let st;
    try { st = statSync(this.file); } catch { return []; }
    if (st.size < this.pos) { this.pos = 0; this.rest = ''; this.reset = true; }   // rewritten from the top
    const rows = [];
    while (st.size > this.pos) {
      const len = Math.min(st.size - this.pos, 32 * 2 ** 20, max);
      const buf = Buffer.alloc(len);
      const fd = openSync(this.file, 'r');
      try { readSync(fd, buf, 0, len, this.pos); } finally { closeSync(fd); }
      this.pos += len;
      max -= len;
      const lines = (this.rest + buf.toString('utf8')).split('\n');
      this.rest = lines.pop();
      for (const line of lines) { if (line) try { rows.push(JSON.parse(line)); } catch {} }
      if (max <= 0) break;
    }
    return rows;
  }
}

// ---- one session ---------------------------------------------------------------------------------------------------

const ts = s => (s ? Date.parse(s) : NaN);
const GAP_MS = 15 * 60e3;
const textOf = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (typeof x === 'string' ? x : x?.text || '')).join('\n') : '');

export class Session {
  constructor(file, meta = {}) {
    this.file = file;
    this.id = meta.id || basename(file, '.jsonl');
    this.agent = meta.agent || null;           // subagent logs: { agentType, description, toolUseId }
    this.cwd = null; this.branch = null; this.title = null; this.model = null;
    this.start = Infinity; this.end = -Infinity;
    this.tools = []; this.open = new Map(); this.byId = new Map();
    this.requests = new Map();                 // API request id -> { start, end }
    this.prompts = [];                         // things you typed: { t, text, waitedMs }
    this.hooks = [];                           // hook and compaction time outside tool calls: { start, end, cat }
    this.gate = [];                            // proof gate outcomes: { t, ok, text }
    this.tasks = new Map();
    this.commits = [];
    this.events = [];                          // { t, kind, text }
    this.subagents = new Map();                // agentId -> Session
    this.bg = new Map();                       // background task id -> the tool call that started it
    this.finished = new Map();                 // background agent or task id -> when it was reported finished or stopped
    this.lastT = null;                         // when the last thing happened in this conversation
    this.prevT = null;                         // timestamp of the previous log line (a model call starts there)
    this.lastKind = null;                      // prompt | assistant | result | endTurn | hook | notification
    this.turnEnd = null;                       // when Claude last finished a turn (waits on you start here)
    this.lastText = '';
    this.away = null;                          // Claude Code's latest "while you were away" summary
    this.lastGateBlock = 0;
    this.gaps = [];                            // stretches of 15+ minutes with nothing written to this log
    this.counts = { toolCalls: 0, edits: 0, testRuns: 0, gateRounds: 0, commitBlocks: 0, guardStops: 0, memoryStops: 0, compactions: 0, apiErrors: 0, interrupts: 0, approvals: 0, toolErrors: 0, agentsLaunched: 0 };
  }

  feed(r) {
    if (this.until && r.timestamp && Date.parse(r.timestamp) > this.until) return;   // replaying up to a moment
    if (this.seen && r.uuid) { if (this.seen.has(r.uuid)) return; this.seen.add(r.uuid); }
    // Older Claude Code versions write subagent turns into the main log.
    if (r.isSidechain && !this.agent) {
      const key = r.agentId || 'sidechain';
      if (!this.subagents.has(key)) this.subagents.set(key, new Session(this.file, { id: key, agent: { agentType: 'subagent', description: '' } }));
      return this.subagents.get(key).feed(r);
    }
    if (r.type === 'ai-title' && r.aiTitle) this.title = r.aiTitle;
    if (r.type === 'custom-title' && r.customTitle) this.title = r.customTitle;
    if (r.type === 'summary' && r.summary && !this.title) this.title = r.summary;
    if (r.cwd) this.cwd = r.cwd;
    if (r.gitBranch && r.gitBranch !== 'HEAD') this.branch = r.gitBranch;
    const t = ts(r.timestamp);
    if (!Number.isFinite(t)) return;
    if (t < this.start) this.start = t;
    if (t > this.end) this.end = t;
    if (r.type === 'assistant') this.onAssistant(r, t);
    else if (r.type === 'user') this.onUser(r, t);
    else if (r.type === 'system') this.onSystem(r, t);
    else if (r.type === 'attachment') this.onAttachment(r.attachment || {}, t);
    if (r.type !== 'queue-operation') {
      if (this.prevT != null && t - this.prevT > GAP_MS) this.gaps.push([this.prevT, t]);
      this.prevT = Math.max(this.prevT ?? t, t);
    }
  }

  onAssistant(r, t) {
    const m = r.message || {};
    if (m.model && !/synthetic/.test(m.model)) this.model = m.model;
    if (m.model === '<synthetic>') { this.lastT = t; return; }        // Claude Code's own notices, not a model call
    const rid = r.requestId || m.id || r.uuid;
    const req = this.requests.get(rid);
    if (!req) this.requests.set(rid, { start: Math.min(this.prevT ?? t, t), end: t });
    else if (t > req.end) req.end = t;
    for (const c of m.content || []) {
      if (c.type === 'text' && c.text?.trim()) this.lastText = c.text.slice(-3000);
      if (c.type !== 'tool_use' || this.byId.has(c.id)) continue;
      const input = c.input || {};
      const rec = { id: c.id, name: c.name, cat: classifyTool(c.name, input), desc: describe(c.name, input), start: t, end: null, ok: null };
      if (c.name === 'Bash') { rec.cmd = String(input.command || '').slice(0, 400); if (input.run_in_background) rec.background = true; }
      const fp = input.file_path || input.notebook_path || input.path;
      if (typeof fp === 'string' && fp.startsWith('/')) rec.file = fp;
      if (/^(Task|Agent)$/.test(c.name)) { rec.agentType = input.subagent_type || 'general-purpose'; rec.agentDesc = input.description || ''; if (input.run_in_background) rec.background = true; }
      // Waiting on a background task counts as whatever that task is doing.
      if (/^(TaskStop|KillShell|KillBash)$/.test(c.name) && (input.task_id || input.shell_id)) this.finished.set(String(input.task_id || input.shell_id), t);
      if (/^(TaskOutput|BashOutput)$/.test(c.name)) {
        const src = this.bg.get(String(input.task_id || input.bash_id || input.shell_id || ''));
        if (src) { rec.cat = src.cat; rec.desc = `Wait for: ${src.desc}`.slice(0, 140); }
      }
      this.open.set(c.id, rec);
      this.byId.set(c.id, rec);
      this.tools.push(rec);
      this.counts.toolCalls++;
      if (rec.cat === 'edit') this.counts.edits++;
      if (rec.cat === 'test') this.counts.testRuns++;
      this.trackTask(c.name, input, t, c.id);
    }
    if (m.stop_reason === 'end_turn' || m.stop_reason === 'stop_sequence' || m.stop_reason === 'max_tokens') {
      this.turnEnd = t;
      this.lastKind = 'endTurn';
    } else this.lastKind = 'assistant';
    this.lastT = t;
  }

  onUser(r, t) {
    const content = r.message?.content;
    const results = Array.isArray(content) ? content.filter(c => c?.type === 'tool_result') : [];
    if (results.length) {
      for (const c of results) {
        const rec = this.open.get(c.tool_use_id);
        const text = textOf(c.content);
        if (rec) {
          rec.end = t; rec.ok = !c.is_error; this.open.delete(c.tool_use_id);
          if (c.is_error) this.counts.toolErrors++;
          const pd = r.permissionDecision;
          if (pd && pd.source && !/^(config|hook)$/.test(pd.source)) { rec.approval = true; this.counts.approvals++; }
          // Background starts return at once; remember the id so a later wait on it is categorised like it.
          const bgId = (text.match(/(?:running in (?:the )?background with ID|background with id|agentId):?\s*([\w-]+)/i) || [])[1];
          if (rec.background || /Async agent launched|running in the background|in the background with ID/i.test(text)) {
            rec.background = true;
            rec.end = Math.min(t, rec.start + 2000);
            if (bgId) this.bg.set(bgId, rec);
          }
          if (rec.cat === 'subagent') this.counts.agentsLaunched++;
          if (rec.name === 'TaskCreate') {
            const id = (text.match(/Task #(\w+)/) || [])[1] || r.toolUseResult?.task?.id;
            const pending = this.tasks.get(`pending:${c.tool_use_id}`);
            if (pending) { this.tasks.delete(`pending:${c.tool_use_id}`); if (id) this.tasks.set(String(id), { ...pending, id: String(id) }); }
          }
          if (rec.name === 'Bash' && /(^|[\s;&|(])git\b[^;&|]*\bcommit\b/.test(rec.cmd || '') && !c.is_error) {
            const m = text.match(/\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,})\] ([^\n]*)/) || text.match(/^()([0-9a-f]{7,12}) ([^\n]+)$/m);
            if (m && !this.commits.some(x => x.sha === m[2])) this.commits.push({ t, sha: m[2], msg: m[3].slice(0, 120) });
          }
        }
        if (/\[proof guard\] stopped this run — (?:machine memory|the machine)/.test(text)) { this.counts.memoryStops++; this.event(t, 'memory', firstLine(text, /\[proof guard\][^\n]*/)); }
        else if (/\[proof guard\] stopped this run/.test(text)) { this.counts.guardStops++; this.event(t, 'guard', firstLine(text, /\[proof guard\][^\n]*/)); }
        if (/proof: commit (blocked|refused)/.test(text)) { this.counts.commitBlocks++; this.event(t, 'commitBlocked', firstLine(text, /proof: commit (?:blocked|refused)[^\n]*/)); }
        if (/proof memory:/.test(text)) this.event(t, 'memory', firstLine(text, /proof memory:[^\n]*/));
      }
      this.lastKind = 'result';
      this.lastT = t;
      return;
    }
    const text = textOf(content).trim();
    if (!text) return;
    if (r.origin === 'task_notification' || /^<task-notification>/.test(text)) {
      const what = (text.match(/<summary>([^<]*)<\/summary>/) || [])[1] || 'A background task finished';
      const id = (text.match(/<task-id>([\w-]+)<\/task-id>/) || [])[1];
      const status = (text.match(/<status>(\w+)<\/status>/) || [])[1] || 'completed';
      if (id && /completed|failed|killed|stopped|error/.test(status)) this.finished.set(id, t);
      this.event(t, 'agentDone', what);
      this.lastKind = 'notification'; this.lastT = t;
      return;
    }
    if (/^Stop hook feedback/.test(text) || /\bproof gate: \d+ of \d+ check/.test(text.slice(0, 600))) {
      this.gateBlocked(t, text);
      this.lastKind = 'hook'; this.lastT = t;
      return;
    }
    if (/^\[Request interrupted by user/.test(text)) {
      this.counts.interrupts++; this.event(t, 'interrupt', 'You interrupted Claude');
      this.lastT = t; this.turnEnd = t; this.lastKind = 'endTurn';
      return;
    }
    if (r.isMeta || r.isCompactSummary || r.isVisibleInTranscriptOnly) return;
    if (/^<(local-command|system-reminder|bash-|task-notification)/.test(text) || /^Caveat:/.test(text)) return;
    const cmd = text.match(/<command-name>([^<]+)<\/command-name>/);
    const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
    const shown = cmd ? `${cmd[1]} ${args ? args[1] : ''}`.trim() : text;
    const waiting = this.turnEnd != null && this.lastKind === 'endTurn';
    const from = waiting ? Math.max(this.turnEnd, this.lastT ?? 0) : t;
    this.prompts.push({ t, text: shown.replace(/\s+/g, ' ').slice(0, 240), waitedMs: Math.max(0, t - from) });
    this.turnEnd = null;
    this.lastKind = 'prompt';
    this.lastT = t;
  }

  onSystem(r, t) {
    if (r.subtype === 'stop_hook_summary') {
      for (const h of r.hookInfos || []) {
        const ms = Number(h.durationMs) || 0;
        if (ms > 0) this.hooks.push({ start: t - ms, end: t, cat: /gate\.mjs|proof/.test(h.command || '') ? 'gate' : 'hooks' });
      }
      if (this.lastKind === 'endTurn') this.turnEnd = t;           // you're waited on once the stop hooks are done
      this.lastT = Math.max(this.lastT ?? t, t);
    } else if (r.subtype === 'compact_boundary') {
      const ms = Number(r.compactMetadata?.durationMs) || 0;
      this.counts.compactions++;
      if (ms > 0) this.hooks.push({ start: t - ms, end: t, cat: 'compact' });
      this.event(t, 'compact', `Context compacted (${r.compactMetadata?.trigger || 'auto'})`);
      this.lastT = t;
    } else if (r.subtype === 'api_error') {
      this.counts.apiErrors++;
      this.hooks.push({ start: Math.min(this.prevT ?? t, t), end: t, cat: 'api' });
      this.event(t, 'error', String(r.content || r.error?.message || r.cause?.message || 'API error').slice(0, 160));
    } else if (r.subtype === 'away_summary' && r.content) {
      this.away = { t, text: String(r.content).slice(0, 600) };
    }
  }

  gateBlocked(t, text) {
    if (t - this.lastGateBlock < 3000) return;   // the same block, logged twice
    this.lastGateBlock = t;
    this.counts.gateRounds++;
    this.gate.push({ t, ok: false, text: firstLine(text, /proof gate:[^\n]*/) });
  }

  onAttachment(a, t) {
    if (a.type === 'hook_blocking_error' && a.hookEvent === 'Stop') {
      const text = String(a.blockingError?.blockingError || a.blockingError || '');
      if (/proof gate:/.test(text)) this.gateBlocked(t, text);
    }
    if (a.type === 'hook_system_message' && /^proof/.test(String(a.content || ''))) {
      const text = String(a.content);
      this.gate.push({ t, ok: /^proof ✓/.test(text), text: text.slice(0, 200), hook: a.hookEvent });
      if (/Claude stopped to ask you/.test(text)) this.event(t, 'needsInput', 'Claude stopped to ask you something');
      if (/Claude was allowed to stop — this is not done/.test(text)) this.event(t, 'gaveUp', text.slice(0, 200));
    }
    if (a.type === 'hook_success' && a.hookEvent === 'PreToolUse' && /gate\.mjs/.test(a.command || '')) {
      const rec = this.byId.get(a.toolUseID);
      const ms = Number(a.durationMs) || 0;
      if (rec && ms > 200) rec.gateMs = ms;
    }
  }

  trackTask(name, input, t, toolUseId) {
    if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      for (const k of [...this.tasks.keys()]) if (k.startsWith('todo:')) this.tasks.delete(k);
      input.todos.forEach((td, i) => this.tasks.set(`todo:${i}`, { id: `todo:${i}`, subject: td.content || td.subject || '', active: td.activeForm || '', status: td.status || 'pending', t }));
    } else if (name === 'TaskCreate') {
      this.tasks.set(`pending:${toolUseId}`, { id: null, subject: input.subject || '', active: input.activeForm || '', status: 'pending', t });
    } else if (name === 'TaskUpdate' && input.taskId != null) {
      const key = String(input.taskId);
      if (input.status === 'deleted') { this.tasks.delete(key); return; }
      const task = this.tasks.get(key) || { id: key, subject: `Task #${key}`, status: 'pending', t };
      if (input.status) task.status = input.status;
      if (input.subject) task.subject = input.subject;
      if (input.activeForm) task.active = input.activeForm;
      task.t = t;
      this.tasks.set(key, task);
    }
  }

  event(t, kind, text) { this.events.push({ t, kind, text: String(text || '').slice(0, 240) }); if (this.events.length > 400) this.events.splice(0, 100); }

  // What the session is doing at `now`.
  status(now = Date.now()) {
    const running = [...this.open.values()].filter(x => !x.background && now - x.start < 6 * 3600e3);
    if (running.length) {
      const cur = running.reduce((a, b) => (CATEGORIES[b.cat].prio > CATEGORIES[a.cat].prio ? b : a));
      return { state: cur.approval ? 'approval' : 'working', since: cur.start, cat: cur.cat, label: cur.desc, parallel: running.length };
    }
    const agents = this.activeAgents(now);
    if (this.lastKind === 'endTurn') {
      if (agents.length) return { state: 'agents', since: this.turnEnd ?? this.lastT, cat: 'subagent', label: `${agents.length} background agent${agents.length > 1 ? 's' : ''} working`, agents: agents.length };
      const asks = /NEEDS-INPUT:|\?\s*$/m.test(this.lastText.slice(-600));
      return { state: asks ? 'needsInput' : 'waiting', since: this.turnEnd ?? this.lastT, label: asks ? 'Claude asked you something' : 'Finished — waiting for your next message' };
    }
    if (now - (this.lastT ?? now) > 15 * 60e3) return { state: 'stalled', since: this.lastT, label: 'No activity for a while' };
    return { state: 'thinking', since: this.lastT, cat: 'model', label: this.lastKind === 'hook' ? 'Fixing what the gate sent back' : 'Thinking' };
  }

  // Subagents that are mid-work: something open, or active in the last 2 minutes without having finished.
  activeAgents(now = Date.now()) {
    return [...this.subagents.values()].filter(a => a.open.size ? [...a.open.values()].some(x => now - x.start < 6 * 3600e3) : (a.lastKind !== 'endTurn' && now - (a.lastT ?? 0) < 120e3));
  }
}

function firstLine(text, re) { const m = String(text).match(re); return (m ? m[0] : String(text).split('\n')[0]).slice(0, 240); }

// ---- loading -------------------------------------------------------------------------------------------------------

export function listLogs(paths) {
  const out = [];
  const walk = (p, depth) => {
    let st; try { st = statSync(p); } catch { return; }
    if (st.isDirectory()) { if (depth < 4) for (const f of readdirSync(p)) walk(join(p, f), depth + 1); }
    else if (p.endsWith('.jsonl')) out.push(p);
  };
  for (const p of paths) walk(p, 0);
  return out;
}

// Subagent logs live in <session>/subagents/agent-<id>.jsonl, with agent-<id>.meta.json beside them.
export function subagentInfo(file) {
  const m = file.match(/[\\/]([^\\/]+)[\\/]subagents[\\/]agent-([^\\/]+)\.jsonl$/);
  if (!m) return null;
  let meta = {};
  try { meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8')); } catch {}
  return { parent: m[1], id: m[2], meta };
}

export function newSession(file, seen, until) {
  const sub = subagentInfo(file);
  const s = new Session(file, sub ? { id: sub.id, agent: { agentType: sub.meta.agentType || 'subagent', description: sub.meta.description || '', toolUseId: sub.meta.toolUseId, depth: sub.meta.spawnDepth || 1 } } : {});
  s.seen = seen || null;
  s.until = until || null;
  return { s, parent: sub?.parent || null };
}

// A background agent that was reported finished or stopped is done, even if its own log ends mid-call (a stopped
// agent never gets its last result). Close what it left open at the moment it was reported.
export function closeFinished(s) {
  const fin = new Map(s.finished);
  for (const a of s.subagents.values()) for (const [k, v] of a.finished) if (!(fin.get(k) >= v)) fin.set(k, v);
  for (const a of s.subagents.values()) {
    const f = fin.get(a.id);
    if (f == null || (a.lastT ?? 0) > f) continue;
    for (const rec of a.open.values()) { rec.end = Math.max(rec.start, f); rec.ok = rec.ok ?? null; rec.stopped = true; }
    a.open.clear();
    a.lastKind = 'endTurn';
    if (!a.turnEnd || a.turnEnd < f) a.turnEnd = f;
  }
}

// A session is keyed by its log's folder and id: <project>/<id>.jsonl, with subagents in <project>/<id>/subagents/.
export const sessionKey = (file, parent) => (parent ? join(dirname(dirname(dirname(file))), parent) : join(dirname(file), basename(file, '.jsonl')));

// First timestamp in a log, from its first few KB.
function firstTime(file) {
  try {
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0); closeSync(fd);
    const m = buf.subarray(0, n).toString('utf8').match(/"timestamp":"([^"]+)"/);
    return m ? Date.parse(m[1]) : Infinity;
  } catch { return Infinity; }
}

// Load every session under `paths`. A resumed or forked session repeats lines from the one it continues; those are
// read once (by uuid), in the order the sessions began.
export function loadSessions(paths, { until = null } = {}) {
  const seen = new Set();
  const files = listLogs(paths).map(f => ({ f, t: firstTime(f), size: (() => { try { return statSync(f).size; } catch { return 0; } })() }))
    .sort((a, b) => a.t - b.t || b.size - a.size);
  const main = new Map(), subs = [];
  for (const { f } of files) {
    const { s, parent } = newSession(f, seen, until);
    for (const r of new LogReader(f).read(Infinity)) s.feed(r);
    if (parent) subs.push([sessionKey(f, parent), s]); else main.set(sessionKey(f), s);
  }
  for (const [key, s] of subs) if (Number.isFinite(s.start)) main.get(key)?.subagents.set(s.id, s);
  const out = [...main.values()].filter(s => Number.isFinite(s.start)).sort((a, b) => a.start - b.start);
  for (const s of out) { closeFinished(s); s.asleep = silentWindows(s); }
  return out;
}

// ---- where the time went -------------------------------------------------------------------------------------------

// Stretches where every log in a session family went quiet for 15+ minutes while a command was still in flight:
// the machine was asleep (or everything was frozen). Each log's activity is its span minus its own quiet gaps.
export function silentWindows(s, minMs = 15 * 60e3) {
  const logs = [s, ...s.subagents.values()].filter(x => Number.isFinite(x.start));
  let cand = [];
  for (const L of logs) cand.push(...L.gaps);
  cand.sort((a, b) => a[0] - b[0]);
  const activity = L => {
    const out = []; let t = L.start;
    for (const [a, b] of L.gaps) { if (a > t) out.push([t, a]); t = b; }
    if (L.end > t) out.push([t, L.end]);
    return out;
  };
  for (const L of logs) {
    const act = activity(L);
    cand = cand.flatMap(([a, b]) => {
      let parts = [[a, b]];
      for (const [x, y] of act) parts = parts.flatMap(([p, q]) => (y <= p || x >= q) ? [[p, q]] : [[p, Math.min(q, x)], [Math.max(p, y), q]].filter(([u, v]) => v - u > 0));
      return parts;
    });
  }
  // merge, keep long ones with a command in flight across them
  cand.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const w of cand) { const last = merged[merged.length - 1]; if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]); else merged.push([...w]); }
  // The signature of a sleeping machine: commands that were running when everything went quiet finish within
  // minutes of activity resuming.
  // A single long command could just be slow, so one alone only counts for an hour or more of silence.
  const calls = logs.flatMap(L => L.tools.filter(t => !t.background && t.end != null && !t.stopped));
  return merged.filter(([a, b]) => {
    if (b - a < minMs) return false;
    const n = calls.filter(t => t.start <= a && t.end >= b && t.end - b <= 10 * 60e3).length;
    return n >= 2 || (n === 1 && b - a >= 60 * 60e3);
  });
}

// Everything that took time in a session, including its subagents' own work. Waiting on a subagent whose log we
// have is replaced by what that subagent was doing.
export function intervals(s, now = Date.now(), logged = null) {
  logged ||= new Set([...s.subagents.values()].map(a => a.agent?.toolUseId).filter(Boolean));
  const iv = [];
  for (const m of s.requests.values()) if (m.end > m.start) iv.push([m.start, m.end, 'model']);
  for (const tl of s.tools) {
    if (tl.cat === 'subagent' && logged.has(tl.id)) continue;
    const end = tl.end ?? (now - tl.start < 6 * 3600e3 ? now : tl.start);
    if (!(end > tl.start)) continue;
    if (tl.approval) { iv.push([tl.start, end, 'waitUser']); continue; }
    if (tl.gateMs) {
      const g = Math.min(tl.start + tl.gateMs, end);
      iv.push([tl.start, g, 'gate']);
      if (end > g) iv.push([g, end, tl.cat]);
    } else iv.push([tl.start, end, tl.cat]);
  }
  for (const p of s.prompts) if (p.waitedMs > 0) iv.push([p.t - p.waitedMs, p.t, 'waitUser']);
  for (const h of s.hooks) if (h.end > h.start) iv.push([h.start, h.end, h.cat]);
  if (!s.agent) {
    for (const a of s.subagents.values()) for (const x of intervals(a, now, logged)) iv.push(x);
    for (const [a, b] of s.asleep || []) iv.push([a, b, 'asleep']);
  }
  return iv;
}

// One sweep over all intervals. `share`: how each moment's time splits across what was happening (parallel work
// shares it). Waiting on you only counts when nothing else is happening. `lane`: one category per moment, by
// priority, for drawing. `busy`: how many things were running at once, on average, while anything was.
export function sweep(iv, from, to) {
  const ev = [];
  for (const [a, b, c] of iv) {
    const x = Math.max(a, from), y = Math.min(b, to);
    if (y > x) { ev.push([x, 1, c]); ev.push([y, -1, c]); }
  }
  ev.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const active = Object.create(null);
  const share = Object.create(null);
  const lane = [];
  let total = 0, t = from, busyMs = 0, busyWeighted = 0;
  const flush = until => {
    const d = until - t;
    if (d <= 0) return;
    let cat = 'idle';
    const work = total - (active.waitUser || 0) - (active.asleep || 0);
    if (active.asleep > 0) { share.asleep = (share.asleep || 0) + d; cat = 'asleep'; }
    else if (work > 0) {
      let best = -1;
      for (const k in active) {
        if (!active[k] || k === 'waitUser' || k === 'asleep') continue;
        share[k] = (share[k] || 0) + (d * active[k]) / work;
        if (CATEGORIES[k].prio > best) { best = CATEGORIES[k].prio; cat = k; }
      }
      busyMs += d; busyWeighted += d * work;
    } else if (active.waitUser > 0) { share.waitUser = (share.waitUser || 0) + d; cat = 'waitUser'; }
    else share.idle = (share.idle || 0) + d;
    const last = lane[lane.length - 1];
    if (last && last[2] === cat && last[1] === t) last[1] = until; else lane.push([t, until, cat]);
  };
  for (const [x, dir, c] of ev) {
    flush(x);
    t = Math.max(t, x);
    active[c] = (active[c] || 0) + dir;
    total += dir;
  }
  flush(to);
  return { share, lane, busyMs, parallel: busyMs ? busyWeighted / busyMs : 0 };
}

// Merge slivers shorter than `minMs` into the segment before them, so a day-long lane stays drawable.
export function simplify(lane, minMs) {
  const out = [];
  for (const seg of lane) {
    const last = out[out.length - 1];
    if (last && last[1] === seg[0] && (last[2] === seg[2] || seg[1] - seg[0] < minMs)) { last[1] = seg[1]; continue; }
    out.push([...seg]);
  }
  return out;
}

// When a session's activity ends: its last line, its subagents' last lines, or now if something is still running.
export function sessionEnd(s, now) {
  let end = s.end;
  for (const a of s.subagents.values()) if (a.end > end) end = a.end;
  const live = x => [...x.open.values()].some(o => !o.background && now - o.start < 6 * 3600e3);
  if (live(s) || [...s.subagents.values()].some(live)) end = Math.max(end, now);
  return Math.min(end, now);
}

const allTools = s => [...s.tools.map(t => ({ ...t, session: s.id, agent: null })), ...[...s.subagents.values()].flatMap(a => a.tools.map(t => ({ ...t, session: s.id, agent: a.agent?.description || a.id })))];

export function summarize(sessions, now = Date.now()) {
  const totals = Object.create(null);
  let span = 0;
  const per = [];
  for (const s of sessions) {
    const to = sessionEnd(s, now);
    const { share, parallel, busyMs } = sweep(intervals(s, now), s.start, to);
    for (const [k, v] of Object.entries(share)) totals[k] = (totals[k] || 0) + v;
    span += Math.max(0, to - s.start);
    per.push({ id: s.id, title: s.title, cwd: s.cwd, branch: s.branch, start: s.start, end: to, share, parallel, busyMs, counts: s.counts, commits: s.commits.length, prompts: s.prompts.length, subagents: s.subagents.size });
  }
  const tools = sessions.flatMap(allTools).filter(t => t.end).map(t => ({ ...t, ms: t.end - t.start }));
  const longest = [...tools].sort((a, b) => b.ms - a.ms).slice(0, 40).map(t => ({ ms: t.ms, cat: t.cat, desc: t.desc, cmd: t.cmd, session: t.session, agent: t.agent, start: t.start, ok: t.ok, approval: t.approval, gateMs: t.gateMs }));
  const byCmd = new Map();
  for (const t of tools) {
    if (t.name !== 'Bash') continue;
    const k = normCmd(t.cmd);
    const e = byCmd.get(k) || { cmd: k, n: 0, ms: 0, fails: 0, cat: t.cat };
    e.n++; e.ms += t.ms; if (t.ok === false) e.fails++;
    byCmd.set(k, e);
  }
  const repeated = [...byCmd.values()].filter(e => e.n >= 3).sort((a, b) => b.ms - a.ms).slice(0, 30);
  const byCat = Object.create(null);
  for (const t of tools) { const e = (byCat[t.cat] ||= { n: 0, ms: 0, fails: 0 }); e.n++; e.ms += t.ms; if (t.ok === false) e.fails++; }
  const everyone = sessions.flatMap(s => [s, ...s.subagents.values()]);
  const sum = k => everyone.reduce((n, s) => n + (s.counts[k] || 0), 0);
  const counts = Object.fromEntries(Object.keys(new Session('x').counts).map(k => [k, sum(k)]));
  return {
    sessions: sessions.length, spanMs: span, totals, per, longest, repeated, byCat, counts,
    commits: everyone.reduce((n, s) => n + s.commits.length, 0),
    prompts: sessions.reduce((n, s) => n + s.prompts.length, 0),
    subagents: sessions.reduce((n, s) => n + s.subagents.size, 0),
  };
}

export function normCmd(cmd = '') {
  return String(cmd).replace(/\s+/g, ' ').replace(/'[^']*'|"[^"]*"/g, '…').replace(/\b[0-9a-f]{7,40}\b/g, '<sha>').replace(/\d{2,}/g, 'N').slice(0, 110);
}

// ---- CLI -----------------------------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const sessions = loadSessions(args.length ? args : ['.']);
  const last = sessions.length ? Math.max(...sessions.map(s => s.end)) : Date.now();
  const sum = summarize(sessions, last);
  if (process.argv.includes('--json')) { console.log(JSON.stringify(sum, null, 2)); process.exit(0); }
  const h = ms => `${(ms / 3600e3).toFixed(2)}h`;
  console.log(`${sessions.length} sessions (${sum.subagents} subagents), ${h(sum.spanMs)} of session time, ${sum.prompts} prompts, ${sum.commits} commits`);
  console.log('counts', JSON.stringify(sum.counts));
  for (const [k, v] of Object.entries(sum.totals).sort((a, b) => b[1] - a[1])) console.log(`  ${(CATEGORIES[k]?.label || k).padEnd(28)} ${h(v).padStart(8)}  ${((v / sum.spanMs) * 100).toFixed(1)}%`);
}
