#!/usr/bin/env node
// proof monitor: one small background process per machine. It
//   - serves the live dashboard at http://127.0.0.1:47331 (port: ~/.config/proof/machine.json "dashboardPort"),
//     built from every Claude Code session log written in the last day;
//   - samples memory every 2 seconds, notices when the Mac slept, and lists what is using memory;
//   - keeps the Mac awake (caffeinate -i) while any session or agent is working, and lets it sleep otherwise;
//   - stops the newest process Claude started if the machine stays over its memory ceiling and no guarded run is
//     left to stop (guarded runs stop themselves first);
//   - opens the dashboard once when a build has been running for 45 minutes and nobody is watching.
// It exits on its own after 30 idle minutes. The SessionStart hook starts it.
//   node monitor.mjs --ensure     start it if it isn't running, print the URL
//   node monitor.mjs --open       the same, then open the dashboard in the browser
//   node monitor.mjs --stop       stop it
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { board, VERSION } from './dashboard.mjs';
import { IS_MAC, advice, dataDir, logEvent, liveRuns, machineConfig, readSystem, snapshot } from './mem.mjs';
import { LogReader, closeFinished, newSession, sessionKey } from './timeline.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = machineConfig();
const PORT = cfg.port;
const BASE = `http://127.0.0.1:${PORT}/`;
const argv = process.argv.slice(2);
const DAY = 24 * 3600e3;

if (argv.includes('--ensure') || argv.includes('--open')) { console.log(await ensure(argv.includes('--open'))); process.exit(0); }
else if (argv.includes('--stop')) { await stopRunning(); process.exit(0); }
else if (argv.includes('--daemon')) serve();
else { console.error('usage: node monitor.mjs --ensure | --open | --stop'); process.exit(2); }

// ---- client side: start, open, stop ---------------------------------------------------------------------------------

// The status code of a page, or 0 when nothing answers.
function status(path, timeout = 1000) {
  return new Promise(resolve => {
    const req = http.get(`${BASE}${path}`, { timeout, headers: { host: `127.0.0.1:${PORT}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.on('error', () => resolve(0));
  });
}

function get(path, timeout = 500) {
  return new Promise(resolve => {
    const req = http.get(`${BASE}${path}`, { timeout, headers: { host: `127.0.0.1:${PORT}` } }, res => {
      let body = ''; res.on('data', d => { body += d; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

export async function ensure(open = false) {
  let h = await get('health');
  // A monitor started from a plugin folder that has since moved (an update, or the old install sent to the Trash)
  // still answers /health but can't serve the page. Replace it.
  if (h?.proof && await status('') !== 200) {
    try { process.kill(h.pid, 'SIGTERM'); } catch {}
    for (let i = 0; i < 20 && h?.proof; i++) { await new Promise(r => setTimeout(r, 150)); h = await get('health', 300); }
  }
  if (!h?.proof) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--daemon'], { detached: true, stdio: 'ignore', env: { ...process.env, PROOF_DATA_DIR: dataDir() } });
    child.unref();
    for (let i = 0; i < 20 && !h?.proof; i++) { await new Promise(r => setTimeout(r, 150)); h = await get('health', 300); }
  }
  if (open && h?.proof) openUrl(BASE);
  return h?.proof ? BASE : `proof monitor did not start (port ${PORT} may be taken; set "dashboardPort" in ~/.config/proof/machine.json)`;
}

async function stopRunning() {
  let token = '';
  try { token = JSON.parse(readFileSync(join(dataDir(), 'monitor.json'), 'utf8')).token; } catch {}
  await get(`stop?token=${encodeURIComponent(token)}`);
}

function openUrl(url) {
  const cmd = IS_MAC ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.on('error', () => {}); c.unref(); } catch {}
}

// ---- the daemon -----------------------------------------------------------------------------------------------------

function serve() {
  const projects = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'projects');
  const tasksDir = join(process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), '.claude'), 'tasks');
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { mkdirSync(dataDir(), { recursive: true }); writeFileSync(join(dataDir(), 'monitor.json'), JSON.stringify({ pid: process.pid, port: PORT, token, started: Date.now() }), { mode: 0o600 }); } catch {}

  const st = {
    files: new Map(),          // log path -> { reader, s, parentKey, key }
    seen: new Set(),           // log line uuids, so a resumed session's copied lines count once
    samples: [], asleep: loadAsleep(), snap: null, lastReq: 0, lastTick: Date.now(), lastScanDirs: 0,
    caffeinate: null, lastBusy: 0, over: 0, lastStop: 0, startedAt: Date.now(), lastClaudeSeen: Date.now(),
    autoOpened: loadJSON('auto-opened.json', {}), lastAutoOpen: 0, cache: new Map(),
  };

  // Memory every 2 seconds; a long gap between ticks means the machine was asleep.
  const tickMemory = () => {
    const now = Date.now();
    if (now - st.lastTick > 20e3) { st.asleep.push([st.lastTick, now]); saveAsleep(st.asleep); }
    st.lastTick = now;
    let sys;
    try { sys = readSystem(); } catch { return; }
    st.samples.push([now, Math.round(sys.pct * 10) / 10]);
    try { writeFileSync(join(dataDir(), 'memory-now.json'), JSON.stringify({ t: now, pct: sys.pct, usedMB: sys.usedMB, totalMB: sys.totalMB, ceilingPct: sys.ceilingPct, warnPct: sys.warnPct, headroomMB: sys.headroomMB, pressure: sys.pressure, swapMB: sys.swapMB })); } catch {}
    if (st.samples.length > 21600) st.samples.splice(0, st.samples.length - 21600);   // 12 hours
    st.system = sys;
    enforceCeiling(sys, now);
  };

  // Above the ceiling for 6 seconds with no guarded run left to stop itself: stop the newest process group Claude
  // started through its shell. Never Claude Code itself, its MCP servers, or anything Claude didn't start.
  const enforceCeiling = (sys, now) => {
    st.over = sys.pct >= sys.ceilingPct ? st.over + 1 : 0;
    if (st.over < 3 || now - st.lastStop < 15e3 || process.env.PROOF_ENFORCE === '0') return;
    if (liveRuns().length) return;                       // the guard stops the newest guarded run first
    const snap = snapshot();
    st.snap = snap;
    const target = snap.runs.find(r => r.mb >= 150 && r.pgid !== process.pid);
    if (!target) return;
    st.lastStop = now;
    try { process.kill(-target.pgid, 'SIGTERM'); } catch { try { process.kill(target.pid, 'SIGTERM'); } catch {} }
    setTimeout(() => { try { process.kill(-target.pgid, 'SIGKILL'); } catch {} }, 5000).unref();
    logEvent({ kind: 'memoryStop', pid: target.pid, command: target.command.slice(0, 200), mb: Math.round(target.mb), pct: Math.round(sys.pct), cwd: target.cwd });
  };

  // Logs: re-list folders every 30 seconds (new sessions, new agents), read new lines every 3.
  const scan = () => {
    const now = Date.now();
    if (now - st.lastScanDirs > 30e3) {
      st.lastScanDirs = now;
      for (const proj of safeList(projects)) {
        const pdir = join(projects, proj);
        for (const e of safeList(pdir)) {
          const p = join(pdir, e);
          if (e.endsWith('.jsonl')) track(p, now);
          else for (const f of safeList(join(p, 'subagents'))) if (f.endsWith('.jsonl')) track(join(p, 'subagents', f), now);
        }
      }
    }
    for (const [file, t] of st.files) {
      const rows = t.reader.read();
      if (t.reader.reset) { t.reader.reset = false; const fresh = newSession(file, null); t.s = fresh.s; }
      for (const r of rows) t.s.feed(r);
    }
    // Attach agents to their sessions; drop sessions idle for more than a day.
    for (const t of st.files.values()) if (t.parentKey) { const p = st.files.get(`${t.parentKey}.jsonl`); if (p) p.s.subagents.set(t.s.id, t.s); }
    for (const [file, t] of st.files) if (!t.parentKey && Number.isFinite(t.s.end) && now - t.s.end > DAY && !t.s.open.size) st.files.delete(file);
    for (const t of st.files.values()) if (!t.parentKey) closeFinished(t.s);
    keepAwake(now);
    autoOpen(now);
  };

  const track = (file, now) => {
    if (st.files.has(file)) return;
    let mtime = 0;
    try { mtime = statSync(file).mtimeMs; } catch { return; }
    if (now - mtime > DAY) return;
    const { s, parent } = newSession(file, st.seen);
    st.files.set(file, { reader: new LogReader(file), s, parentKey: parent ? sessionKey(file, parent) : null });
  };

  const mainSessions = () => [...st.files.values()].filter(t => !t.parentKey && Number.isFinite(t.s.start)).map(t => t.s);

  const busyNow = now => mainSessions().some(s => {
    if (now - Math.max(s.end, ...[...s.subagents.values()].map(a => a.end)) > 30 * 60e3 && !s.open.size) return false;
    return /working|thinking|agents/.test(s.status(now).state);
  }) || liveRuns().length > 0;

  // Hold a "don't idle-sleep" assertion while anything is working; release it 3 minutes after the last of it.
  const keepAwake = now => {
    if (!IS_MAC || !cfg.keepAwake) return;
    if (busyNow(now)) st.lastBusy = now;
    const want = now - st.lastBusy < 3 * 60e3;
    if (want && !st.caffeinate) {
      try {
        st.caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
        st.caffeinate.on('error', () => { st.caffeinate = null; });
        st.caffeinate.on('exit', () => { st.caffeinate = null; });
      } catch { st.caffeinate = null; }
    } else if (!want && st.caffeinate) { st.caffeinate.kill(); st.caffeinate = null; }
  };

  // Open the dashboard once for a long build nobody is watching.
  const autoOpen = now => {
    if (!cfg.autoOpen || now - st.lastReq < 10 * 60e3 || now - st.lastAutoOpen < 30 * 60e3) return;
    for (const s of mainSessions()) {
      if (st.autoOpened[s.id] || now - s.start < cfg.autoOpenAfterMin * 60e3) continue;
      if (!/working|thinking|agents/.test(s.status(now).state)) continue;
      st.autoOpened[s.id] = now; st.lastAutoOpen = now;
      saveJSON('auto-opened.json', st.autoOpened);
      openUrl(`${BASE}#s=${encodeURIComponent(s.id)}`);
      break;
    }
  };

  // Task lists Claude keeps on disk: ~/.claude/tasks/<session>/<id>.json.
  const diskTasks = id => {
    const dir = join(tasksDir, id);
    const out = [];
    for (const f of safeList(dir)) {
      if (!f.endsWith('.json')) continue;
      try { const t = JSON.parse(readFileSync(join(dir, f), 'utf8')); if (t && t.subject && t.status !== 'deleted') out.push({ id: String(t.id), subject: t.subject, status: t.status, active: t.activeForm, owner: t.owner || '' }); } catch {}
    }
    return out;
  };

  const data = hours => {
    const now = Date.now();
    const key = String(hours);
    const hit = st.cache.get(key);
    if (hit && now - hit.at < 1500) return hit.body;
    const windowMs = Math.min(Math.max(hours, 0.25), 24) * 3600e3;
    const sessions = mainSessions().filter(s => now - Math.max(s.end, ...[...s.subagents.values()].map(a => a.end)) < windowMs || s.open.size);
    for (const s of sessions) s.asleep = st.asleep.filter(([a, b]) => b > s.start && a < now);
    const snap = st.snap && now - st.snap.at < 15e3 ? st.snap : (st.snap = snapshot());
    const from = now - windowMs;
    const step = Math.max(1, Math.ceil(st.samples.filter(x => x[0] >= from).length / 600));
    const samples = st.samples.filter(x => x[0] >= from).filter((_, i) => i % step === 0);
    const sys = st.system || snap.system;
    const machine = {
      system: sys, samples, apps: snap.apps.slice(0, 8), runs: snap.runs.slice(0, 6),
      advice: (() => { const a = advice(snap); return { text: a.text, userApps: a.userApps.map(x => ({ name: x.name, mb: x.mb })) }; })(),
      keepAwake: IS_MAC ? { on: !!st.caffeinate, enabled: cfg.keepAwake } : null,
      asleep: st.asleep.filter(([, b]) => b > from),
    };
    const out = board(sessions, { now, windowMs, machine, live: true });
    for (const v of out.sessions) {
      const t = diskTasks(v.id);
      if (t.length) v.tasks = t;
      v.features = features(v.cwd);
      // The gate runs inside a hook, which writes nothing to the log until it finishes; its live file says what it's doing.
      const g = liveGate(v.id);
      if (g) {
        const done = g.checks.filter(c => c.state === 'passed' || c.state === 'failed').length;
        const runningNames = g.checks.filter(c => c.state === 'running').map(c => c.name).join(', ');
        const status = { state: 'working', cat: 'gate', since: g.start, label: `proof gate${g.mode === 'commit' ? ' before commit' : ''}: ${runningNames || 'waiting for memory'} (${done} of ${g.checks.length} done)` };
        v.status = status;
        if (v.now[0]) v.now[0] = { ...v.now[0], ...status };
      }
    }
    const body = JSON.stringify(out);
    st.cache.set(key, { at: now, body });
    return body;
  };

  // Read the page now too, so it is still served if the plugin folder moves while the monitor runs.
  const pagePath = join(here, 'dashboard.html');
  let page = null;
  try { page = readFileSync(pagePath, 'utf8'); } catch {}

  const server = http.createServer((req, res) => {
    // Only this machine, and only under our own host name (no DNS rebinding).
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) { res.writeHead(403); return res.end(); }
    const url = new URL(req.url, BASE);
    if (url.pathname === '/health') return send(res, 200, 'application/json', JSON.stringify({ proof: true, version: VERSION, pid: process.pid, port: PORT }));
    if (url.pathname === '/stop') {
      if (url.searchParams.get('token') !== token) { res.writeHead(403); return res.end(); }
      send(res, 200, 'application/json', '{"stopping":true}');
      return shutdown();
    }
    st.lastReq = Date.now();
    if (url.pathname === '/' || url.pathname === '/index.html') {
      try { page = readFileSync(pagePath, 'utf8'); } catch {}
      if (page == null) { res.writeHead(500); return res.end(); }
      return send(res, 200, 'text/html; charset=utf-8', page);
    }
    if (url.pathname === '/data.json') {
      try { return send(res, 200, 'application/json', data(Number(url.searchParams.get('hours')) || 6)); }
      catch (e) { return send(res, 500, 'application/json', JSON.stringify({ error: String(e.message || e) })); }
    }
    res.writeHead(404); res.end();
  });
  server.on('error', e => { if (e.code === 'EADDRINUSE') process.exit(0); process.exit(1); });
  server.listen(PORT, '127.0.0.1');

  const shutdown = () => { try { st.caffeinate?.kill(); } catch {} setTimeout(() => process.exit(0), 50); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

  // Exit after 30 quiet minutes: nothing working, nobody watching, no Claude Code running.
  const housekeeping = () => {
    const now = Date.now();
    try { st.snap = snapshot(); if (st.snap.sessions.length) st.lastClaudeSeen = now; } catch {}
    if (busyNow(now)) st.lastClaudeSeen = now;
    if (now - st.lastClaudeSeen > 30 * 60e3 && now - st.lastReq > 30 * 60e3) shutdown();
  };

  tickMemory(); scan(); housekeeping();
  setInterval(tickMemory, 2000);
  setInterval(scan, 3000);
  setInterval(housekeeping, 60e3);
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

function send(res, code, type, body) { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); }
function safeList(dir) { try { return readdirSync(dir); } catch { return []; } }
function loadJSON(name, d) { try { return JSON.parse(readFileSync(join(dataDir(), name), 'utf8')); } catch { return d; } }
function saveJSON(name, v) { try { mkdirSync(dataDir(), { recursive: true }); writeFileSync(join(dataDir(), name), JSON.stringify(v)); } catch {} }
function loadAsleep() { return loadJSON('asleep.json', []).filter(([, b]) => Date.now() - b < 3 * DAY); }
function saveAsleep(list) { saveJSON('asleep.json', list.filter(([, b]) => Date.now() - b < 3 * DAY)); }

// The gate's live file for a session, if the gate is running now.
function liveGate(id) {
  try {
    const g = JSON.parse(readFileSync(join(dataDir(), 'live', `gate-${String(id).replace(/[^\w.-]/g, '_')}.json`), 'utf8'));
    process.kill(g.pid, 0);
    return g;
  } catch { return null; }
}

// features.json at the session's folder: how many items pass.
function features(cwd) {
  if (!cwd) return null;
  for (const p of [join(cwd, 'features.json')]) {
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      const list = Array.isArray(j) ? j : Array.isArray(j.features) ? j.features : [];
      return { passing: list.filter(x => x && x.passes === true).length, total: list.length };
    } catch { return null; }
  }
  return null;
}

