# proof

**Nothing is done until it's proven.**

[![tests](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml/badge.svg)](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin that makes Claude prove its work before it calls it done, and keeps long, multi-agent builds fast and inside your machine's memory. One install covers every session on your machine, whatever phase you're in: every Orca or Conductor worktree, every terminal session and every IDE session.

Claude starts each session with a short set of rules. Phase skills take an idea to a spec, a design to a mockup that is also a test, and a build through one proven unit at a time. Hooks enforce the rest: the relevant checks run after each reply and the full suite before each commit, and failures go back to Claude instead of to you. Test runs and builds run under time and memory limits, and the machine stays under a memory ceiling.

## Install

In Claude Code:

```
/plugin marketplace add IfeOlulesi/proof
/plugin install proof@proof
```

Or from a terminal:

```bash
claude plugin marketplace add IfeOlulesi/proof
claude plugin install proof@proof
```

It installs at user scope, so it covers every project and every worktree. Start a new session, or run `/reload-plugins` in an open one. `claude plugin details proof` shows the version and its hooks.

**You need** Node.js 20 or later on your `PATH` (the hooks are Node scripts, and Claude Code's native installer doesn't bring Node) and git. proof runs on macOS and Linux; keep-awake is macOS only. Windows isn't supported.

The gate stays off in a repo until you give it checks: see [Turn the gate on in a project](#turn-the-gate-on-in-a-project).

## What's in it

| Piece | What it does |
|---|---|
| Session rules (SessionStart hook) | At startup, `/clear`, resume and after compaction, Claude gets 15 short rules plus this project's status: whether the gate is on, which checks it runs, which state files exist, memory now, and the dashboard's address. |
| `/proof:discover` | Takes an idea to a decision, then to a `SPEC.md` where every acceptance criterion says how it will be verified, then to `features.json` with every item `passes: false`. Checked by `check-spec`. |
| `/proof:design` | Builds a mockup that is also a test: tokens, every screen and state, final copy, `data-testid` on everything, and `mockup/interactions.json`. `check-design` fails on untagged elements, contrast, touch targets, placeholder copy and unspecced interactions, and writes screenshots. |
| `/proof:build` | One unit at a time: make it fail (and record it), make it pass, run the app, verify, commit. For mockup-to-app work it adds the fidelity kit (inventory, compare, freeze). For long builds: one agent per worktree, isolated state per lane, an orchestrator that never blocks. |
| `/proof:quick` | Small, clear fixes (copy, styling, a contained bug, up to 3 files and 100 lines) without the full ceremony, still proven. If the change grows past that, or touches auth, payments, migrations, CI or the checks, the gate switches the session back to the full process. |
| `/proof:watch` | Opens the live dashboard (below). |
| Completion gate (Stop hook) | After a reply that changed files, the relevant checks run, using fast variants (changed files, related tests) where configured. Failures go back to Claude. After 5 rounds, or 2 rounds without progress, Claude is allowed to stop and you're told what still fails. |
| Commit gate (PreToolUse hook) | Before `git commit`, every relevant check runs in full. A failure blocks the commit. |
| Speed | Checks run in parallel, as memory allows. A pass is cached against the exact content of the code, so identical code is never checked twice. |
| Guard (`scripts/guard.mjs`) | Gate checks, and the test runs, end-to-end runs, builds and wait loops Claude starts itself, run under a time limit and two memory ceilings: one for the whole run and one for any single process. A breach kills the whole process group and is reported as a loop or leak, not a test failure. A wait loop (`until grep …; do sleep …`) stops after 5 minutes with a note to check the run it waits on. A separate watcher enforces the limits, so they hold even if the gate or the guard is killed, and they also cover runs left in the background. |
| Memory budget | The machine stays under a ceiling (85% by default; warning at 75%). Heavy runs and new agents wait their turn when there isn't room, then are refused with what's using memory: Claude's own processes it can stop, and your apps that would free the most, framed by the speed it buys. If the machine reaches the ceiling anyway, the newest run Claude started is stopped first. Claude never closes your apps. `node <plugin>/scripts/mem.mjs` prints the picture. |
| Keep awake | While any session or agent is working, the Mac doesn't idle-sleep (`caffeinate -i`); when everything is waiting on you, it may. Closing the lid still sleeps it. |
| Live dashboard (`scripts/monitor.mjs`) | `http://127.0.0.1:47331/`, for every session on the machine: what each session and agent is doing right now and for how long, a timeline per worktree, the plan, where the time went, memory, and events. It refreshes every 2 seconds and opens on its own once a build has run for 45 minutes. What it shows is specified in [`docs/dashboard-spec.md`](plugins/proof/docs/dashboard-spec.md). |
| Check protection | If a session changes `.claude/proof.json`, `.claude/settings.json` or the fidelity kit, or deletes `proof.json`, Claude has to stop and ask you before it can finish or commit. |
| `proof:verifier` agent | Fresh-context, read-only review once per unit. It reuses existing evidence (cached checks, the recorded failing-first run) before producing new evidence. |
| `proof:screen-judge` agent | Compares mockup and app captures item by item. |

`<plugin>` is the plugin's folder; Claude knows its path. The skills load only when a phase is relevant, so their descriptions are the only standing cost (about 700 tokens per session). The gate is a no-op in chats, in repos without `.claude/proof.json`, and when nothing changed.

## Turn the gate on in a project

Add `.claude/proof.json`; the build skill offers to create it from the project's own scripts.

```json
{
  "checks": [
    { "name": "types", "run": "npx tsc --noEmit", "when": ["src/", "app/"] },
    { "name": "test", "run": "npx --no-install jest --ci",
      "fast": "npx --no-install jest --ci --passWithNoTests --findRelatedTests {files}",
      "files": ["src/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"], "fullWhen": ["jest.config.js", "package.json"],
      "when": ["src/", "app/", "jest.config.js", "package.json"], "timeout": 600 }
  ],
  "maxRounds": 5
}
```

- `run`: the full command. It runs before every commit, and after each reply when there's no `fast` variant.
- `fast`: the command after each reply. `{files}` becomes the changed files matching `files`, as quoted absolute paths.
- `fullWhen`: changes that force the full command anyway. Deleted files and changes over 200 files force it too.
- `when`: relevance globs. Without it, the check runs whenever the session changed any file.
- `cache: false` for checks that depend on more than the code (a running app, the network).
- `concurrency`: how many checks run at once, default 4. They also take turns for memory.
- `maxMemoryMB` / `maxProcessMemoryMB`: memory ceilings for a run's processes together and for any one process. They default to half and a quarter of RAM (12 GB and 6 GB on a 24 GB Mac). Set them at the top level or per check.
- `testRunTimeout` (default 900), `buildTimeout` (1800), `waitTimeout` (300): seconds allowed for test and end-to-end runs, builds, and wait loops Claude starts itself.
- `quick`: `{ "maxFiles": 3, "maxLines": 100 }`, the size of a quick fix.

Run every check by hand with `node <plugin>/scripts/gate.mjs --run`. Add `--no-cache` to force fresh runs.

## Machine settings

Optional, in `~/.config/proof/machine.json`:

```json
{
  "memoryWarnPercent": 75,
  "memoryCeilingPercent": 85,
  "keepAwake": true,
  "dashboardPort": 47331,
  "autoOpenDashboard": true,
  "autoOpenAfterMinutes": 45,
  "admitWaitSeconds": 180
}
```

## Update

```bash
claude plugin marketplace update proof
claude plugin update proof@proof
```

Then start new sessions. In each repo that has a `fidelity/` folder, also run `node <plugin>/skills/build/fidelity-kit/install.mjs --upgrade` once, on your main branch. It updates the kit files, keeps your app URL, commits only the kit, and moves the `contract` tag, but only when the mockup and inventories haven't changed since the contract. Merge main into any worktree that's mid-screen, so its kit matches the contract.

## What it touches on your machine

- **Nothing leaves it.** proof makes no network calls. The dashboard listens on 127.0.0.1 and refuses requests addressed to any other host name.
- **It reads Claude Code's own logs** (`~/.claude/projects`, `~/.claude/tasks`) to draw the dashboard. Its state lives in the plugin's data folder and `~/.config/proof/machine.json`.
- **It stops only what Claude started:** runs past their limits and, when the machine stays over its memory ceiling, the newest processes Claude started. It never closes your apps; it tells Claude which of them would free the most, and Claude asks you.
- **On macOS it keeps the machine awake** (`caffeinate -i`) while work is in flight, and lets go a few minutes after.

## Limits

- **Memory readings are approximate.** Per-process memory comes from `ps` (resident memory), which undercounts once macOS compresses memory; the machine total uses the same figures as Activity Monitor. Learned per-command memory needs settle after a few runs; until then proof uses defaults per kind of run.
- **Keep-awake covers idle sleep only**, and only on macOS. Closing a MacBook's lid still sleeps it unless it's on power with an external display.
- **The ceiling stops Claude's runs, not yours.** If your own apps push the machine over, proof stops the newest run Claude started and tells Claude which of your apps would free the most; it never touches them.
- **The dashboard reads Claude Code's logs**, whose format can change between Claude Code versions. Anything it can't parse is skipped.
- **Guard ceilings are per run.** The machine-wide ceiling sits above them.
- **Stack traces depend on the runner.** pytest prints every thread's stack for a test that passes 60s. A JS runner stuck in a synchronous loop shows only the last test file it started.
- **`cd` doesn't carry over from wrapped commands.** A wrapped test, build or wait command runs in its own shell, so a `cd` inside it doesn't carry over to Claude's next command.
- **Cloud sessions** (claude.ai/code, or cloud sessions started from the mobile app) don't load plugins, including ones a repo's settings declare. To cover a repo there, its `.claude/` folder needs committed copies of the skills, agents and hooks.
- **Git required:** the gate uses git to see what a session changed. Outside a git repo it stays off. It reads `.claude/proof.json` from the repo root.
- **The cache** is keyed on tracked and untracked files. A check that depends on ignored files (such as `.env`) or on a running service should set `cache: false`. Cached passes expire after 12 hours.
- **Partial fidelity coverage:** the fidelity kit's numeric checks cover anything that renders in a browser, including Expo web. For Flutter or native sign-off it relies on reference screenshots and the screen judge, plus the platform element-tree tools listed in [`fidelity.md`](plugins/proof/skills/build/references/fidelity.md).

## Develop

```bash
git clone https://github.com/IfeOlulesi/proof.git
claude plugin marketplace add ./proof
claude plugin install proof@proof
```

A plugin installed from a local folder is read from that folder, so your edits take effect at the next session start or after `/reload-plugins`.

```bash
bash tests/run.sh
```

That checks syntax and the manifests, then runs the scenario suites: the gate, the guard, memory turn-taking, quick mode, the monitor, and a read of this machine's real memory. They run in throwaway git repos with a throwaway home folder, so your own setup is never touched; memory pressure is simulated. They take about three minutes and leave nothing running. CI runs them on Linux and macOS.

Issues and pull requests are welcome. If you change what the dashboard shows, update [`docs/dashboard-spec.md`](plugins/proof/docs/dashboard-spec.md) too.

## License

[MIT](LICENSE)
