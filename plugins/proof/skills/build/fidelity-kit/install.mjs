#!/usr/bin/env node
// proof fidelity kit installer. Run from inside the app's git repo:
//   node install.mjs [--app-url http://localhost:8081] [--force]   install (or reinstall) the kit
//   node install.mjs --upgrade [--app-url …]                        update a repo set up with an earlier version
// Copies the kit into ./fidelity, sets the `fidelity` check in .claude/proof.json, and updates .gitignore.
// --upgrade also commits the new kit files and moves the `contract` tag to that commit, but only when the frozen
// mockup, inventories and references are unchanged since the contract. Otherwise it leaves the tag for you.
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const upgrade = args.includes('--upgrade');
const force = upgrade || args.includes('--force');
const urlArg = args.includes('--app-url') ? args[args.indexOf('--app-url') + 1] : null;
const KIT = ['extract-inventory.mjs', 'verify-screen.mjs', 'verify-screen.sh', 'run-screens.sh'];
const DATA = ['mockup/', 'fidelity/inventory/', 'fidelity/refs/'];

let root;
try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
catch { console.error("Run this inside the app's git repository."); process.exit(1); }
const git = a => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const quiet = a => { try { git(a); return true; } catch { return false; } };   // for `git diff --quiet` and friends

// 1. Kit files.
const dest = join(root, 'fidelity');
mkdirSync(dest, { recursive: true });
for (const f of KIT) {
  const to = join(dest, f);
  const existed = existsSync(to);
  if (existed && !force) { console.log(`kept    fidelity/${f} (exists; --force replaces it)`); continue; }
  if (!existed || !readFileSync(to).equals(readFileSync(join(here, f)))) {
    copyFileSync(join(here, f), to);
    console.log(`${existed ? 'updated' : 'added  '} fidelity/${f}`);
  }
  if (f.endsWith('.sh')) chmodSync(to, 0o755);
}

// 2. The fidelity check. It keeps the app URL you set before, unless --app-url gives a new one.
const cfgPath = join(root, '.claude', 'proof.json');
mkdirSync(dirname(cfgPath), { recursive: true });
let cfg = { checks: [] };
if (existsSync(cfgPath)) {
  try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); }
  catch (e) { console.error(`.claude/proof.json is not valid JSON (${e.message}); fix it and re-run.`); process.exit(1); }
}
if (!Array.isArray(cfg.checks)) cfg.checks = [];
const i = cfg.checks.findIndex(c => c && c.name === 'fidelity');
const oldRun = i >= 0 ? String(cfg.checks[i].run || '') : '';
const keptUrl = (oldRun.match(/\$\{APP_URL:-([^}]+)\}/) || oldRun.match(/APP_URL=([^\s"]+)\s+fidelity\//) || [])[1];
const fallback = urlArg || keptUrl || 'http://localhost:8081';
// URL precedence: fidelity/.app-url (per worktree, untracked) > $APP_URL > the URL above.
const run = `test ! -f fidelity/.current-screen || APP_URL="$(cat fidelity/.app-url 2>/dev/null || echo "\${APP_URL:-${fallback}}")" fidelity/verify-screen.sh "$(cat fidelity/.current-screen)"`;
// cache: false — the result depends on the running app and the current screen, not just the code.
const entry = { ...(i >= 0 ? cfg.checks[i] : {}), name: 'fidelity', run, timeout: (i >= 0 && cfg.checks[i].timeout) || 300, cache: false };
const before = JSON.stringify(cfg);
if (i >= 0) cfg.checks[i] = entry; else cfg.checks.push(entry);
if (JSON.stringify(cfg) !== before) {
  writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`);
  console.log(`${i >= 0 ? 'updated' : 'added  '} the fidelity check in .claude/proof.json (app URL ${fallback})`);
}

// 3. .gitignore
const gi = join(root, '.gitignore');
const have = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
const need = ['fidelity/shots/', 'fidelity/ledger/', 'fidelity/.current-screen', 'fidelity/.app-url', '.proof/']
  .filter(l => !have.split('\n').includes(l));
if (need.length) {
  appendFileSync(gi, `${have && !have.endsWith('\n') ? '\n' : ''}${need.join('\n')}\n`);
  console.log(`added   ${need.join(', ')} to .gitignore`);
}

// 4. Upgrade: re-freeze the contract on the new kit, if nothing else in it changed.
if (upgrade) {
  if (!quiet(['rev-parse', '-q', '--verify', 'refs/tags/contract'])) {
    console.log('\nNo contract tag yet, so there is nothing to re-freeze.');
  } else if (!quiet(['diff', '--quiet', 'contract', '--', ...DATA]) || !quiet(['diff', '--quiet', 'contract', 'HEAD', '--', ...DATA])) {
    console.log('\nThe mockup, inventories or references differ from the contract, so the tag was left alone.');
    console.log('Review those changes, then: git add -A && git commit -m "fidelity contract" && git tag -f contract');
  } else {
    const kit = KIT.map(f => `fidelity/${f}`);
    try {
      git(['add', '--', ...kit]);
      if (!quiet(['diff', '--cached', '--quiet', 'HEAD', '--', ...kit])) {
        git(['commit', '-m', 'proof: upgrade fidelity kit', '--only', '--', ...kit]);
        console.log('\ncommitted the new kit files (nothing else)');
      }
      git(['tag', '-f', 'contract']);
      console.log(`contract → ${git(['rev-parse', '--short', 'HEAD'])} (the mockup, inventories and references are unchanged)`);
      console.log('Worktrees on other branches: merge this branch into them so their kit matches the contract.');
    } catch (e) {
      console.error(`\nCouldn't commit the kit or move the tag: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
      console.error('Commit the fidelity/ kit files yourself, then: git tag -f contract');
      process.exit(1);
    }
  }
}

if (!upgrade) {
  console.log('\nNext: make sure Playwright is installed (npm i -D playwright && npx playwright install --only-shell chromium), put the approved mockup in mockup/, then extract each screen (fidelity.md, step 0.3).');
}
