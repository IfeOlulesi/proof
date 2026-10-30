// proof fit: run a test suite in the memory there is. Most runners start one worker process per CPU core (Jest and
// Vitest use cores − 1: 13 on a 14-core Mac), and each worker is a whole process with its own copy of the code under
// test. When the machine has less room than that takes, the same tests can still run in fewer workers, one batch
// after another: slower, but they run instead of waiting or being refused. This module finds the runner in a
// command, estimates what it needs at a given worker count, and rewrites the command with a worker cap.
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DEFAULT_NEED, learnedFor, peakKey } from './mem.mjs';

export const CPUS = () => Number(process.env.PROOF_CPUS) || (os.availableParallelism?.() ?? os.cpus().length);

// `word`: the runner as the command of a shell segment (the cap goes right after it, where every runner accepts
// options). `has`: a cap the command already sets. `strip`: those caps, removed before a new one goes in. `workers`:
// the runner's own default. `base`/`per`: memory for the main process and for each worker when nothing has been
// learned yet (estimates; a measured run replaces them).
const PATH = String.raw`(?:[^\s'"=]*\/)?`;
export const RUNNERS = [
  { name: 'jest', word: String.raw`${PATH}jest(?![\w.-])`, has: /--maxWorkers[= ](\d+)|(?:^|\s)-w[= ]?(\d+)|(--runInBand|(?:^|\s)-i(?=\s|$))/,
    strip: /\s(?:--maxWorkers[= ]\S+|-w[= ]?\d+)/g, flag: n => `--maxWorkers=${n}`, workers: c => c - 1, base: 300, per: 350 },
  { name: 'vitest', word: String.raw`${PATH}vitest(?![\w.-])(?:\s+(?:run|related))?`, has: /--maxWorkers[= ](\d+)|(--no-file-parallelism)/,
    strip: /\s--(?:max|min)Workers[= ]\S+/g, flag: (n, dir) => (vitestMajor(dir) < 4 ? `--minWorkers=1 --maxWorkers=${n}` : `--maxWorkers=${n}`),
    workers: c => c - 1, base: 250, per: 250 },
  { name: 'playwright', word: String.raw`${PATH}playwright\s+test\b`, has: /--workers[= ](\d+)|(?:^|\s)-j[= ]?(\d+)/,
    strip: /\s(?:--workers[= ]\S+|-j[= ]?\d+)/g, flag: n => `--workers=${n}`, workers: c => Math.max(1, Math.floor(c / 2)), base: 200, per: 450 },
  { name: 'node --test', word: String.raw`${PATH}node(?:\s+--[\w-]+(?:=\S+)?)*\s+--test(?![\w-])`, has: /--test-concurrency[= ](\d+)|(--test-isolation=none)/,
    strip: /\s--test-concurrency[= ]\S+/g, flag: n => `--test-concurrency=${n}`, workers: c => c - 1, base: 60, per: 70 },
  { name: 'go test', word: String.raw`go\s+test\b`, has: /\s-p[= ](\d+)/,
    strip: /\s-p[= ]\d+/g, flag: n => `-p=${n}`, workers: c => c, base: 200, per: 250 },
  { name: 'gradle', word: String.raw`${PATH}gradlew\b`, has: /--max-workers[= ](\d+)/,
    strip: /\s--max-workers[= ]\S+/g, flag: n => `--max-workers=${n}`, workers: c => c, base: 800, per: 500 },
];
// In command position: at the start of a segment, behind environment assignments, `time`, or a launcher.
const LEAD = String.raw`(?:^|&&|\|\||[;|&(\n])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:time|nice|caffeinate)\s+)?(?:(?:npx|bunx)\s+(?:--?[\w-]+(?:=\S+)?\s+)*|(?:pnpm|yarn)\s+(?:exec\s+|dlx\s+)?|(?:uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+)?`;
for (const r of RUNNERS) r.at = new RegExp(`${LEAD}(${r.word})`);

// Quotes open before `index`: a runner named inside a string (a commit message, a script argument) isn't run.
const quoted = (cmd, index) => {
  let q = null;
  for (let i = 0; i < index; i++) { const c = cmd[i]; if (q) { if (c === q && cmd[i - 1] !== '\\') q = null; } else if (c === '"' || c === "'") q = c; }
  return q !== null;
};

// Where one shell command ends: && || ; | newline, a subshell's parentheses, or a lone & (not the one in 2>&1).
const SEP = /&&|\|\||[;|\n()]|(?<![>&<])&(?![&>\d])/g;

// The segment of a shell command around `index`: [start, end) between separators.
function segmentOf(cmd, index) {
  const starts = [...cmd.slice(0, index).matchAll(SEP)];
  const last = starts[starts.length - 1];
  const start = last ? last.index + last[0].length : 0;
  SEP.lastIndex = 0;
  const rest = cmd.slice(index).search(SEP);
  return [start, rest < 0 ? cmd.length : index + rest];
}

// The folder a segment runs in: `dir`, moved by every `cd` before it (`cd app && npm test` reads app/package.json).
function dirAt(cmd, index, dir) {
  for (const m of cmd.slice(0, index).matchAll(/(?:^|&&|[;\n(])\s*cd\s+("[^"]*"|'[^']*'|[^\s;&|)]+)/g)) {
    const to = m[1].replace(/^["']|["']$/g, '');
    dir = to === '~' || to.startsWith('~/') ? to : resolve(dir, to);
  }
  return dir;
}

// The runner a command starts, directly or through a package.json script that is a single runner command
// (`npm test` → "jest"). Null when it isn't one proof knows how to cap. `dir` is the folder the command starts in.
export function findRunner(cmd, dir) {
  if (typeof cmd !== 'string') return null;
  for (const r of RUNNERS) {
    const m = r.at.exec(cmd);
    if (!m) continue;
    const at = m.index + m[0].length - m[1].length;
    if (quoted(cmd, at)) continue;
    return { runner: r, insertAt: m.index + m[0].length, segment: segmentOf(cmd, at), dir: dirAt(cmd, at, dir), viaScript: null };
  }
  // `bun test` is Bun's own runner, never a script; only `bun run <script>` is.
  const s = /(?:^|&&|\|\||[;|\n(])\s*(?:(npm|pnpm|yarn)\s+(?:run\s+)?|(bun)\s+run\s+)((?:test|e2e)(?::[\w:-]+)?|t(?=\s|$))(?![\w:-])/.exec(cmd);
  if (!s || quoted(cmd, s.index + s[0].length)) return null;
  const tool = s[1] || s[2];
  if (s[3] === 't' && tool !== 'npm') return null;
  const at = s.index + s[0].length;
  const d = dirAt(cmd, at, dir);
  const body = scriptBody(d, s[3] === 't' ? 'test' : s[3]);
  if (!body || /&&|\|\||[;|]/.test(body)) return null;          // a script that runs several things: leave it alone
  const r = RUNNERS.find(x => x.at.test(body));
  if (!r) return null;
  return { runner: r, insertAt: at, segment: segmentOf(cmd, at), dir: d, viaScript: { tool, body } };
}

function scriptBody(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts?.[name] ?? null; } catch { return null; }
}

// The installed Vitest's major version, looking up from `dir` (a monorepo may hoist it to the root). Unknown: 4.
function vitestMajor(dir) {
  for (let d = dir; d && d !== dirname(d); d = dirname(d)) {
    try { return Number(JSON.parse(readFileSync(join(d, 'node_modules', 'vitest', 'package.json'), 'utf8')).version.split('.')[0]) || 4; } catch {}
  }
  return 4;
}

// How many workers the command runs as written: its own cap, or the runner's default.
export function workersOf(found, cmd) {
  const { runner } = found;
  const text = found.viaScript ? `${found.viaScript.body} ${cmd}` : cmd.slice(...found.segment);
  const m = runner.has.exec(text);
  const def = Math.max(1, runner.workers(CPUS()));
  if (!m) return def;
  const n = Number(m.slice(1).find(v => v && /^\d+$/.test(v)));
  return n > 0 ? Math.min(n, def) : 1;                         // --runInBand and the like: one
}

// The command with a cap of `n` workers, in place of any cap it had. The flag goes right after the runner, or right
// after a script's name, ahead of the user's own arguments: npm needs `--` to pass it on (`npm test -- --maxWorkers=4`,
// or just after the user's `--`), while pnpm, yarn and bun pass on what follows the name.
export function capCommand(found, cmd, n, dir) {
  const [s0, s1] = found.segment;
  const seg = cmd.slice(s0, s1);
  const clean = seg.replace(found.runner.strip, '');
  if (clean !== seg) {
    cmd = cmd.slice(0, s0) + clean + cmd.slice(s1);
    found = findRunner(cmd, dir);
  }
  const flag = found.runner.flag(n, found.dir);
  let at = found.insertAt, lead = '';
  if (found.viaScript?.tool === 'npm') {
    const own = /^((?:\s+(?!--(?:\s|$))\S+)*?)\s+--(?=\s|$)/.exec(cmd.slice(at, found.segment[1]));
    if (own) at += own[0].length; else lead = ' --';
  }
  return `${cmd.slice(0, at)}${lead} ${flag}${cmd.slice(at)}`;
}

// Memory a run needs at `n` workers, from the recent runs of the same command: each one's peak scaled by the workers
// it had (the main process counted as one more), so a run measured at 13 workers predicts the same tests at 4. The
// largest of those, plus 10%. Nothing measured yet: the runner's estimate, or the default for the kind of run.
export function needAt(found, n, learned, kind) {
  if (learned?.runs?.length) {
    // Scaled down, never below a run actually measured at n workers or fewer: a suite with fewer test files than
    // workers never started them all, so its peak doesn't shrink with the cap.
    const floor = Math.max(0, ...learned.runs.filter(r => r.w && r.w <= n).map(r => r.mb));
    const scaled = learned.runs.map(r => (found && r.w ? Math.max((r.mb * (n + 1)) / (r.w + 1), floor) : r.mb));
    return Math.round(Math.max(...scaled) * 1.1);
  }
  if (found) return found.runner.base + n * found.runner.per;
  return DEFAULT_NEED[kind] ?? 1000;
}

// Everything the hooks need to decide whether, and how, a heavy command runs: its runner (if proof can cap it), the
// workers it would start, what that needs, and how to make it fit in less.
export function planRun(cmd, root, kind, cwd = root) {
  const found = findRunner(cmd, cwd);
  const key = peakKey(root, cmd);
  const learned = learnedFor(key);
  const workers = found ? workersOf(found, cmd) : 0;
  // A run of a few files or one test name starts a worker or two, not one per core (Jest runs a single file in band).
  const targeted = key.endsWith(' (targeted)') && !learned;
  return {
    found, key, workers,
    need: needAt(found, targeted ? Math.min(workers, 2) : workers, learned, kind),
    // The most workers below what the command would start whose need fits in `roomMB`: { cmd, workers, need }, or
    // null when the runner can't be capped or not even one worker fits.
    fit(roomMB) {
      if (!found) return null;
      for (let n = workers - 1; n >= 1; n--) {
        const need = needAt(found, n, learned, kind);
        if (need <= roomMB) return { cmd: capCommand(found, cmd, n, cwd), workers: n, need };
      }
      return null;
    },
    // The smallest run this command can be made into: one worker (or itself, when it can't be capped).
    least() {
      return found && workers > 1 ? { cmd: capCommand(found, cmd, 1, cwd), workers: 1, need: needAt(found, 1, learned, kind) } : null;
    },
  };
}
