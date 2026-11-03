#!/usr/bin/env node
// proof — install into a coding agent other than Claude Code (Claude Code installs proof as a plugin).
//   node install.mjs <agent> [--global] [--project <dir>] [--data <dir>]    install
//   node install.mjs <agent> --uninstall [--global] [--project <dir>]       remove what proof wrote, nothing else
//   node install.mjs --list                                                 the agents, and what each one gets
// It writes the agent's hook config or plugin file (merged into a config that's already there), proof's skills, and
// the verifier and screen-judge as subagents where the agent has them (skills where it doesn't). What it wrote is
// recorded in ~/.config/proof/installs/, so --uninstall can put every file it touched back byte for byte.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from './agents/index.mjs';
import { renderSkill } from './agents/words.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CAP_COLUMNS = ['rules', 'gate', 'commitDeny', 'testRewrite', 'subagentNote', 'sessionStart', 'userPrompt', 'beforeTool', 'afterTool', 'turnEnd', 'waiting', 'skills', 'subagents'];
export const CAP_TITLES = {
  rules: 'rules at start', gate: 'gate at turn end', commitDeny: 'commit deny', testRewrite: 'test-command rewrite',
  subagentNote: 'subagent and browser note', sessionStart: 'session start', userPrompt: 'user prompt', beforeTool: 'before tool',
  afterTool: 'after tool', turnEnd: 'turn end', waiting: 'waiting for the user', skills: 'skills', subagents: 'subagents (verifier, screen-judge)',
};
export const INSTALLABLE = Object.keys(ADAPTERS).filter(a => a !== 'claude');
export const DOCS_LABEL = 'built from docs, not tested live';

// The shared data folder: Claude Code's plugin data folder when proof is installed there, so every agent's sessions
// land on the same dashboard; else ~/.config/proof/data.
export function resolveData(home = os.homedir()) {
  if (process.env.PROOF_DATA_DIR) return process.env.PROOF_DATA_DIR;
  const claude = join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'plugins', 'data', 'proof-proof');
  return existsSync(claude) ? claude : join(home, '.config', 'proof', 'data');
}

const sha = s => createHash('sha256').update(s).digest('hex').slice(0, 12);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const deq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Merge proof's entries into a config. Returns the merged config and exactly what was added (for uninstall).
export function merge(cur, add) {
  if (Array.isArray(add)) {
    const base = Array.isArray(cur) ? cur : [];
    const added = add.filter(x => !base.some(y => deq(x, y)));
    return { value: [...base, ...added], added };
  }
  if (isObj(add)) {
    const value = isObj(cur) ? { ...cur } : {};
    const added = {};
    for (const [k, v] of Object.entries(add)) {
      if (!(k in value)) { value[k] = v; added[k] = v; continue; }
      if (isObj(v) || Array.isArray(v)) {
        const m = merge(value[k], v);
        value[k] = m.value;
        if ((Array.isArray(m.added) && m.added.length) || (isObj(m.added) && Object.keys(m.added).length)) added[k] = m.added;
      }
    }
    return { value, added };
  }
  return { value: cur === undefined ? add : cur, added: cur === undefined ? add : undefined };
}

// Take out what merge() added, leaving everything else as the user has it now.
export function unmerge(cur, added, orig) {
  if (Array.isArray(added)) return Array.isArray(cur) ? cur.filter(x => !added.some(a => deq(a, x))) : cur;
  if (!isObj(added) || !isObj(cur)) return cur;
  const out = { ...cur };
  for (const [k, v] of Object.entries(added)) {
    if (!(k in out)) continue;
    const had = isObj(orig) && k in orig;
    if (isObj(v) || Array.isArray(v)) {
      const r = unmerge(out[k], v, had ? orig[k] : undefined);
      const empty = Array.isArray(r) ? !r.length : isObj(r) && !Object.keys(r).length;
      if (empty && !had) delete out[k]; else out[k] = r;
    } else if (!had && deq(out[k], v)) delete out[k];
  }
  return out;
}

// What each install wrote: ~/.config/proof/installs, the same whatever data folder the install used, so --uninstall
// finds it even if that folder has changed since.
const installsDir = () => process.env.PROOF_INSTALLS_DIR || join(os.homedir(), '.config', 'proof', 'installs');
const manifestPath = (agent, scope) => join(installsDir(), `${agent}-${sha(scope)}.json`);

// A file left for another install: that install takes over the folders this one created for it, so they go with it.
function handOver(path, except, dirs) {
  const dir = installsDir();
  for (const f of (() => { try { return readdirSync(dir); } catch { return []; } })()) {
    const mp = join(dir, f);
    if (mp === except) continue;
    try {
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      if (!m.files.some(x => x.path === path)) continue;
      m.dirs = [...new Set([...m.dirs, ...dirs.filter(d => path.startsWith(`${d}/`))])];
      writeFileSync(mp, JSON.stringify(m, null, 2));
    } catch {}
  }
}

// Other installs that wrote the same file (two agents reading .agents/skills): while one remains, the file stays.
function otherOwners(path, except) {
  const dir = installsDir();
  let n = 0;
  for (const f of (() => { try { return readdirSync(dir); } catch { return []; } })()) {
    if (join(dir, f) === except) continue;
    try { if (JSON.parse(readFileSync(join(dir, f), 'utf8')).files.some(x => x.path === path)) n++; } catch {}
  }
  return n;
}

// Every file the install writes: the adapter's own (hook config, plugin file) and the rendered skills and subagents.
// `node` is the one on the PATH, as in Claude Code's hooks: an absolute path (Homebrew's versioned one) breaks on upgrade.
export function plan(agent, { project, global = false, data, home = os.homedir(), node = 'node', root = ROOT }) {
  const real = ADAPTERS[agent];
  // Skills in .agents/skills are read by several agents (Codex, Antigravity, Cursor, Gemini), so they don't name one.
  const shared = p => /[\\/]\.agents[\\/]skills$/.test(p);
  const adapter = real;
  const skillWords = { ...real, words: { ...real.words, agent: 'the agent', clear: 'a new session' } };
  const rulesText = readFileSync(join(root, 'scripts', 'rules.md'), 'utf8').trim();
  const p = adapter.install({ root, data, node, project, home, global, rulesText });
  const files = [...p.files];
  const skills = readdirSync(join(root, 'skills')).filter(n => existsSync(join(root, 'skills', n, 'SKILL.md')));
  for (const n of skills) {
    const skillDir = join(root, 'skills', n);
    const text = renderSkill(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), shared(p.skillsDir) ? skillWords : adapter, { root, skillDir, data })
      .replace(/^name: .*$/m, `name: proof-${n}`);
    files.push({ path: join(p.skillsDir, `proof-${n}`, 'SKILL.md'), text });
  }
  for (const f of readdirSync(join(root, 'agents')).filter(f => f.endsWith('.md'))) {
    const n = f.replace(/\.md$/, '');
    const src = readFileSync(join(root, 'agents', f), 'utf8');
    const description = (src.match(/^description: (.*)$/m) || [])[1] || '';
    const body = renderSkill(src.replace(/^---\n[\s\S]*?\n---\n+/, ''), adapter, { root, data });
    if (p.agentsDir && p.agentFile) files.push({ path: join(p.agentsDir, `proof-${n}.${p.agentExt || 'md'}`), text: p.agentFile(`proof-${n}`, renderSkill(description, adapter, { root, data }), body) });
    else files.push({ path: join(p.skillsDir, `proof-${n}`, 'SKILL.md'), text: `---\nname: proof-${n}\ndescription: ${renderSkill(description, adapter, { root, data })} Run it in a fresh session or context where you can, since it must not rely on what you remember of the work.\n---\n\n${body}` });
  }
  return { adapter, files, notes: p.notes || [], scope: global ? home : project };
}

export function install(agent, opts) {
  const { adapter, files, notes, scope } = plan(agent, opts);
  const mpath = manifestPath(agent, scope);
  if (existsSync(mpath)) uninstall(agent, opts, { quiet: true });   // a reinstall starts from the user's own files
  const manifest = { agent, scope, at: new Date().toISOString(), root: opts.root || ROOT, files: [], dirs: [] };
  for (const f of files) {
    const original = existsSync(f.path) ? readFileSync(f.path) : null;
    for (let d = dirname(f.path); !existsSync(d); d = dirname(d)) manifest.dirs.push(d);
    mkdirSync(dirname(f.path), { recursive: true });
    if (f.json) {
      let cur;
      try { cur = original ? JSON.parse(original.toString('utf8')) : undefined; }
      catch { throw new Error(`${f.path} isn't valid JSON, so proof can't add to it safely. Fix it and run the installer again.`); }
      const m = merge(cur, f.json);
      writeFileSync(f.path, `${JSON.stringify(m.value, null, 2)}\n`);
      manifest.files.push({ path: f.path, original: original?.toString('base64') ?? null, added: m.added ?? {} });
    } else {
      writeFileSync(f.path, f.text);
      const shared = !!original && original.toString('utf8') === f.text && otherOwners(f.path, mpath) > 0;
      manifest.files.push({ path: f.path, original: original?.toString('base64') ?? null, wrote: sha(f.text), ...(shared ? { shared } : {}) });
    }
  }
  manifest.dirs = [...new Set(manifest.dirs)];
  mkdirSync(dirname(mpath), { recursive: true });
  writeFileSync(mpath, JSON.stringify(manifest, null, 2));
  return { adapter, files, notes, manifest: mpath };
}

export function uninstall(agent, opts, { quiet = false } = {}) {
  const scope = opts.global ? (opts.home || os.homedir()) : opts.project;
  const mpath = manifestPath(agent, scope);
  if (!existsSync(mpath)) return { removed: [], restored: [], kept: [], missing: true };
  const m = JSON.parse(readFileSync(mpath, 'utf8'));
  const removed = [], restored = [], kept = [];
  for (const f of [...m.files].reverse()) {
    const original = f.original != null ? Buffer.from(f.original, 'base64') : null;
    if (!existsSync(f.path)) continue;
    if (f.added) {
      let cur;
      try { cur = JSON.parse(readFileSync(f.path, 'utf8')); } catch { kept.push(f.path); continue; }
      const orig = original ? JSON.parse(original.toString('utf8')) : undefined;
      const left = unmerge(cur, f.added, orig);
      if (original && deq(left, orig)) { writeFileSync(f.path, original); restored.push(f.path); }
      else if (!original && isObj(left) && !Object.keys(left).length) { unlinkSync(f.path); removed.push(f.path); }
      else { writeFileSync(f.path, `${JSON.stringify(left, null, 2)}\n`); kept.push(f.path); }
    } else if (otherOwners(f.path, mpath)) { kept.push(f.path); handOver(f.path, mpath, m.dirs); }   // another agent's install still uses it
    else if (original && !f.shared) { writeFileSync(f.path, original); restored.push(f.path); }
    else if (sha(readFileSync(f.path, 'utf8')) === f.wrote) { unlinkSync(f.path); removed.push(f.path); }
    else kept.push(f.path);   // changed since proof wrote it: the user's now
  }
  for (const d of [...m.dirs].sort((a, b) => b.length - a.length)) { try { rmdirSync(d); } catch {} }   // only if empty
  unlinkSync(mpath);
  return { removed, restored, kept, quiet };
}

// The capability table in docs/agents.md: one row per agent. `node install.mjs --table` prints it.
export function capTable() {
  const head = ['agent', 'tested', ...CAP_COLUMNS.map(k => CAP_TITLES[k])];
  const rows = Object.values(ADAPTERS).map(a => [a.label, a.name === 'claude' ? 'live (Claude Code is proof\'s home)' : a.tested === 'live' ? 'live' : DOCS_LABEL, ...CAP_COLUMNS.map(k => a.caps?.[k] || 'unknown')]);
  return [head, head.map(() => '---'), ...rows].map(r => `| ${r.join(' | ')} |`).join('\n');
}

export function capsLine(adapter) {
  return CAP_COLUMNS.map(k => `  ${CAP_TITLES[k]}: ${adapter.caps?.[k] || 'unknown'}`).join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const agent = argv.find(a => !a.startsWith('--') && a !== opt('--project') && a !== opt('--data'));
  if (argv.includes('--table')) { console.log(capTable()); return; }
  if (argv.includes('--list') || !agent) {
    console.log(`Agents proof installs into: ${INSTALLABLE.join(', ')}.\nUsage: node "${fileURLToPath(import.meta.url)}" <agent> [--global] [--uninstall]\n(Claude Code: install proof as a plugin instead, see the README.)`);
    for (const a of INSTALLABLE) console.log(`\n${ADAPTERS[a].label}${ADAPTERS[a].tested === 'docs' ? ` (${DOCS_LABEL})` : ''}\n${capsLine(ADAPTERS[a])}`);
    return;
  }
  if (agent === 'claude') { console.log('Claude Code installs proof as a plugin: /plugin marketplace add IfeOlulesi/proof, then /plugin install proof@proof.'); return; }
  if (!ADAPTERS[agent]) { console.error(`proof doesn't know the agent "${agent}". Known: ${INSTALLABLE.join(', ')}.`); process.exitCode = 1; return; }
  const opts = { project: resolve(opt('--project') || process.cwd()), global: argv.includes('--global'), data: opt('--data') || resolveData() };
  const a = ADAPTERS[agent];
  if (argv.includes('--uninstall')) {
    const r = uninstall(agent, opts);
    if (r.missing) { console.log(`proof isn't installed for ${a.label} ${opts.global ? 'globally' : `in ${opts.project}`} (nothing recorded), so nothing was changed.`); return; }
    for (const p of r.restored) console.log(`  restored ${p}`);
    for (const p of r.removed) console.log(`  removed  ${p}`);
    for (const p of r.kept) console.log(`  kept     ${p} (changed since proof wrote it; proof's entries taken out)`);
    console.log(`proof is uninstalled from ${a.label}.`);
    return;
  }
  const r = install(agent, opts);
  console.log(`proof is installed for ${a.label}${a.tested === 'docs' ? ` (${DOCS_LABEL})` : ''}, ${opts.global ? 'for every project' : `in ${opts.project}`}.`);
  console.log('Wrote:');
  for (const f of r.files) console.log(`  ${f.path}`);
  console.log(`Shared data folder (dashboard, state): ${opts.data}`);
  console.log(`What ${a.label} gets:\n${capsLine(a)}`);
  for (const n of r.notes) console.log(`Note: ${n}`);
  console.log(`To undo: node "${fileURLToPath(import.meta.url)}" ${agent} --uninstall${opts.global ? ' --global' : opt('--project') ? ` --project "${opts.project}"` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
