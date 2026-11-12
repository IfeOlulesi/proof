#!/usr/bin/env node
// proof — finds the checks a project already runs (type check, lint, tests) and writes them to .claude/proof.json.
//   node detect-checks.mjs [dir]           print the checks found and the proof.json they would make
//   node detect-checks.mjs [dir] --write   write .claude/proof.json; checks already listed are kept as they are
// Only commands the project already defines are proposed. Nothing is guessed: a project with no lint script gets no lint check.
// A per-reply `fast` command is written only for jest and vitest, where a per-file filter is reliable. Scripts that would
// hang the gate (watch mode) or edit files during a check (--fix) are skipped, with a note.
// Node stdlib only.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const write = args.includes('--write');
const dirArg = args.find(a => !a.startsWith('--'));
const cwd = resolve(dirArg || process.cwd());
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };

let root;
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { die('Not a git repository, so proof has no commit to gate. Run this inside the project\'s repo.'); }

const has = f => existsSync(join(root, f));
const read = f => { try { return readFileSync(join(root, f), 'utf8'); } catch { return ''; } };
const found = []; // { kind: 'types'|'lint'|'test', name, run, source, ...optional fast/files/fullWhen/when }
const notes = [];  // things skipped on purpose, shown to the user

// Source and config files a type check or linter reads. Used as `when` so unrelated edits skip the check.
const JS_WHEN = ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,vue,svelte}', '**/tsconfig*.json', 'package.json'];
const PY_WHEN = ['**/*.py', 'pyproject.toml', 'setup.cfg', 'requirements*.txt'];
const watchMode = s => /(^|\s)(--watch|-w)(\s|=|$)/.test(s);
const fixMode = s => /(^|\s)--fix(\s|=|$)/.test(s);
// The tools a command runs, of those whose check would otherwise run twice under two names. A tool counts as a word
// of its own or as node_modules/.bin/<tool>, not as a folder name (tools/ruff).
const TOOLS = ['jest', 'vitest', 'mocha', 'ava', 'tsc', 'eslint', 'biome', 'oxlint', 'mypy', 'ruff', 'pytest'];
const toolsOf = s => TOOLS.filter(t => new RegExp(`(^|[\\s;&|(]|\\.bin/)${t}(\\s|$|[;&|)])`).test(s || ''));

// ---- Node (package.json scripts) ----
if (has('package.json')) {
  let pkg = {};
  try { pkg = JSON.parse(read('package.json')); } catch { die('package.json is not valid JSON; fix it, then run this again.'); }
  const scripts = pkg.scripts || {};
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn'
    : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
  const lockfile = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock', 'package-lock.json'].find(has);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const exec = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
  const runScript = s => `${pm} run ${s}`;
  const realTest = s => s && !/no test specified/i.test(s);
  const pick = (names, ok = () => true) => names.find(n => typeof scripts[n] === 'string' && ok(scripts[n]));

  const types = pick(['typecheck', 'type-check', 'check:types', 'types', 'tsc']);
  if (types) found.push({ kind: 'types', name: 'types', run: runScript(types), tools: toolsOf(scripts[types]), source: `package.json "${types}"`, when: JS_WHEN });
  else if (has('tsconfig.json') && deps.typescript) {
    found.push({ kind: 'types', name: 'types', run: `${exec} tsc --noEmit`, source: 'tsconfig.json + typescript', when: JS_WHEN });
  }

  const lintName = pick(['lint', 'lint:check']);
  if (lintName) {
    if (fixMode(scripts[lintName])) notes.push(`skipped lint script "${lintName}": it passes --fix, so it edits files during the check.`);
    else found.push({ kind: 'lint', name: 'lint', run: runScript(lintName), tools: toolsOf(scripts[lintName]), source: `package.json "${lintName}"`, when: JS_WHEN });
  }

  const testName = pick(['test', 'test:ci'], realTest);
  if (testName) {
    const s = scripts[testName];
    if (watchMode(s)) notes.push(`skipped test script "${testName}": it runs in watch mode (${s}), so the gate would hang.`);
    else {
      const entry = { kind: 'test', name: 'test', run: runScript(testName), tools: toolsOf(s), source: `package.json "${testName}"` };
      const filesGlob = ['**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}'];
      const fullWhen = ['package.json', 'jest.config.*', 'vitest.config.*', ...(lockfile ? [lockfile] : [])];
      if (/\bjest\b/.test(s)) Object.assign(entry, { fast: `${exec} jest --ci --passWithNoTests --findRelatedTests {files}`, files: filesGlob, fullWhen });
      else if (/\bvitest\b/.test(s)) Object.assign(entry, { fast: `${exec} vitest related --run {files}`, files: filesGlob, fullWhen });
      found.push(entry);
    }
  }
}

// ---- Python ----
const py = [has('pyproject.toml') && read('pyproject.toml'), has('setup.cfg') && read('setup.cfg'),
  has('requirements.txt') && read('requirements.txt'), has('requirements-dev.txt') && read('requirements-dev.txt')]
  .filter(Boolean).join('\n');
if (py) {
  if (/\[tool\.mypy\]|^mypy\b/mi.test(py)) found.push({ kind: 'types', name: 'mypy', run: 'mypy .', source: 'mypy config', when: PY_WHEN });
  if (/\[tool\.ruff|^ruff\b/mi.test(py)) found.push({ kind: 'lint', name: 'ruff', run: 'ruff check .', source: 'ruff config', when: PY_WHEN });
  // pytest only when it is configured or listed as a dependency, not merely because a tests/ folder exists.
  if (/\[tool\.pytest|^pytest\b/mi.test(py) || has('pytest.ini'))
    found.push({ kind: 'test', name: 'pytest', run: 'pytest', source: 'pytest config or dependency' });
}

// ---- Rust / Go ----
if (has('Cargo.toml')) {
  found.push({ kind: 'types', name: 'cargo-check', run: 'cargo check', source: 'Cargo.toml' });
  found.push({ kind: 'test', name: 'cargo-test', run: 'cargo test', source: 'Cargo.toml' });
}
if (has('go.mod')) {
  found.push({ kind: 'types', name: 'go-vet', run: 'go vet ./...', source: 'go.mod' });
  found.push({ kind: 'test', name: 'go-test', run: 'go test ./...', source: 'go.mod' });
  if (has('.golangci.yml') || has('.golangci.yaml')) found.push({ kind: 'lint', name: 'golangci', run: 'golangci-lint run', source: '.golangci config' });
}

// ---- Makefile (only fills a kind nothing above found) ----
if (has('Makefile')) {
  const targets = new Set([...read('Makefile').matchAll(/^([a-zA-Z][\w-]*):/gm)].map(m => m[1]));
  for (const kind of ['types', 'lint', 'test']) {
    const t = { types: ['typecheck', 'type-check'], lint: ['lint'], test: ['test'] }[kind].find(x => targets.has(x));
    if (t && !found.some(f => f.kind === kind)) found.push({ kind, name: kind, run: `make ${t}`, source: `Makefile "${t}"` });
  }
}

// Unique names: keep the plain kind name when it is free, otherwise suffix it.
const used = new Map();
for (const f of found) {
  const n = used.get(f.name) || 0; used.set(f.name, n + 1);
  if (n) f.name = `${f.name}-${n + 1}`;
}

// ---- proof.json: keep what is there, add what is missing ----
const cfgPath = join(root, '.claude', 'proof.json');
let config = { checks: [] };
const existed = existsSync(cfgPath);
if (existed) {
  try { config = JSON.parse(readFileSync(cfgPath, 'utf8')); }
  catch (e) { die(`.claude/proof.json exists but is not valid JSON (${e.message}). Fix or remove it, then run this again. Nothing was written.`, 2); }
  if (!Array.isArray(config.checks)) die('.claude/proof.json has no "checks" list. Nothing was written.', 2);
}
// A check is already covered when proof.json has one with the same command or name, or when every tool it runs is
// already run by a check there (an existing `npx jest` covers a detected `npm run test` that runs jest), so a suite
// never runs twice.
const existing = config.checks.map(c => (typeof c === 'string' ? { name: c, run: c } : c || {}));
const coveredBy = f => {
  const same = existing.find(c => c.run === f.run || c.name === f.name);
  if (same) return same.name || same.run;
  const tools = f.tools || toolsOf(f.run), by = tools.map(t => existing.find(c => toolsOf(c.run).includes(t)));
  return tools.length && by.every(Boolean) ? [...new Set(by.map(c => c.name || c.run))].join('", "') : null;
};
// Only the fields the gate reads go into proof.json; `kind` and `source` stay in the printout.
const CHECK_FIELDS = ['name', 'run', 'fast', 'files', 'fullWhen', 'when'];
const toEntry = f => Object.fromEntries(CHECK_FIELDS.filter(k => f[k] !== undefined).map(k => [k, f[k]]));
const additions = found.filter(f => !coveredBy(f)).map(toEntry);
const proposed = { ...config, checks: [...config.checks, ...additions] };

console.log(`Project: ${root}`);
if (!found.length) console.log('No type check, lint or test command found in this project.');
for (const f of found) {
  const extra = f.fast ? ', per-reply filter for changed files' : '';
  const by = coveredBy(f);
  console.log(`  ${f.kind.padEnd(5)} ${f.run}   (from ${f.source}${by ? `, already covered by "${by}" in proof.json` : extra})`);
}
for (const n of notes) console.log(`  note: ${n}`);
console.log(existed ? '.claude/proof.json exists.' : '.claude/proof.json does not exist yet.');

if (write) {
  if (!additions.length && existed) { console.log('Nothing to add. .claude/proof.json left as it is.'); process.exit(0); }
  if (!proposed.checks.length) die('No checks to write. Add commands to .claude/proof.json by hand, or tell proof which ones to run.', 3);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(proposed, null, 2) + '\n');
  console.log(`Wrote .claude/proof.json with ${proposed.checks.length} check(s).`);
} else {
  console.log('\nProposed .claude/proof.json (run with --write to save it):');
  console.log(JSON.stringify(proposed, null, 2));
}
