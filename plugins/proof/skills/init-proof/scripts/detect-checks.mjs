#!/usr/bin/env node
// proof — finds the checks a project already runs (type check, lint, tests) and writes them to .claude/proof.json.
//   node detect-checks.mjs [dir]           print the checks found and the proof.json they would make
//   node detect-checks.mjs [dir] --write   write .claude/proof.json; checks already listed are kept as they are
// Only commands the project already defines are proposed. Nothing is guessed: a project with no lint script gets no lint check.
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
const found = []; // { kind: 'types'|'lint'|'test', name, run, source }

// ---- Node (package.json scripts) ----
if (has('package.json')) {
  let pkg = {};
  try { pkg = JSON.parse(read('package.json')); } catch { die('package.json is not valid JSON; fix it, then run this again.'); }
  const scripts = pkg.scripts || {};
  const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn'
    : (has('bun.lockb') || has('bun.lock')) ? 'bun' : 'npm';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const runScript = s => `${pm} run ${s}`;
  const realTest = s => s && !/no test specified/i.test(s);
  const pick = (names, ok = () => true) => names.find(n => typeof scripts[n] === 'string' && ok(scripts[n]));

  const types = pick(['typecheck', 'type-check', 'check:types', 'types', 'tsc']);
  if (types) found.push({ kind: 'types', name: 'types', run: runScript(types), source: `package.json "${types}"` });
  else if (has('tsconfig.json') && deps.typescript) {
    const exec = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' }[pm];
    found.push({ kind: 'types', name: 'types', run: `${exec} tsc --noEmit`, source: 'tsconfig.json + typescript' });
  }

  const lint = pick(['lint', 'lint:check']);
  if (lint) found.push({ kind: 'lint', name: 'lint', run: runScript(lint), source: `package.json "${lint}"` });

  const test = pick(['test', 'test:ci'], realTest);
  if (test) found.push({ kind: 'test', name: 'test', run: runScript(test), source: `package.json "${test}"` });
}

// ---- Python ----
const py = [has('pyproject.toml') && read('pyproject.toml'), has('setup.cfg') && read('setup.cfg'),
  has('requirements.txt') && read('requirements.txt'), has('requirements-dev.txt') && read('requirements-dev.txt')]
  .filter(Boolean).join('\n');
if (py) {
  if (/\[tool\.mypy\]|^mypy\b/mi.test(py)) found.push({ kind: 'types', name: 'mypy', run: 'mypy .', source: 'mypy config' });
  if (/\[tool\.ruff|^ruff\b/mi.test(py)) found.push({ kind: 'lint', name: 'ruff', run: 'ruff check .', source: 'ruff config' });
  if (/\[tool\.pytest|^pytest\b/mi.test(py) || has('tests') || has('pytest.ini'))
    found.push({ kind: 'test', name: 'pytest', run: 'pytest', source: 'pytest config or tests/' });
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
const existingRuns = new Set(config.checks.map(c => (typeof c === 'string' ? c : c?.run)));
const additions = found.filter(f => !existingRuns.has(f.run)).map(({ name, run }) => ({ name, run }));
const proposed = { ...config, checks: [...config.checks, ...additions] };

console.log(`Project: ${root}`);
if (!found.length) console.log('No type check, lint or test command found in this project.');
for (const f of found) console.log(`  ${f.kind.padEnd(5)} ${f.run}   (from ${f.source}${existingRuns.has(f.run) ? ', already in proof.json' : ''})`);
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
