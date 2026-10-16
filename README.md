# <picture><source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg"><img src="assets/logo.svg" alt="proof" height="56"></picture>

### Quit babysitting Claude.

Make it check its own work.

[![tests](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml/badge.svg)](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code plugin that gives Claude a check to run at every step of building software, from the first spec to the commit, so it can tell for itself whether the work is right.

## Why

Anthropic's [Claude Code best practices](https://code.claude.com/docs/en/best-practices#give-claude-a-way-to-verify-its-work) put this first:

> Claude stops when the work looks done. Without a check it can run, "looks done" is the only signal available, and you become the verification loop: every mistake waits for you to notice it. Give Claude something that produces a pass or fail, and the loop closes on its own.

Boris Cherny, who created Claude Code, [said the same in January 2026](https://venturebeat.com/technology/the-creator-of-claude-code-just-revealed-his-workflow-and-developers-are): give Claude a way to verify its work, and that feedback loop makes the result 2 to 3 times better.

Tests already do this for code. They don't cover most of the rest: is the spec complete, does every requirement say how it'll be proven, does the mockup cover every state, does the screen match the mockup down to the copy and the spacing, did Claude actually run the app. Those are where "Claude missed it" usually comes from, and you end up checking them by eye.

proof turns each of those into a command that passes or fails, and uses hooks so Claude can't finish a reply or make a commit while one is failing.

## What becomes checkable

### Idea and spec (`/proof:discover`)

| What | How it's checked |
|---|---|
| Every acceptance criterion says how it will be proven | `check-spec` fails on any criterion without a `verify:` line (a test, a script, a render against a reference, a measurement, or numbered manual steps). |
| The spec is finished | `check-spec` fails on missing sections and leftover template or placeholder text. |
| The work is split into buildable units | `features.json`: one item per unit of about an hour, each with an id, a title and how it's verified. Duplicate ids fail. |
| Nothing is marked done without proof | An item can only have `passes: true` if its `evidence` names the check that passed. |
| The spec matches what you asked for | The `proof:verifier` agent, in a fresh context, reads the spec against your stated goal and reports missing flows, untestable criteria and contradictions. |

### Design (`/proof:design`)

The mockup is written as HTML so it can be tested, and engineering is later checked against it.

| What | How it's checked |
|---|---|
| Every element can be found by a test | `check-design` fails on visible text, controls or media without a `data-testid`, and on duplicate ids within a screen. |
| Every screen and state exists | Each state (empty, loading, error, disabled, long content…) is its own `data-screen` frame; the verifier checks every flow in the spec has one. |
| Screens render at device size | Frames that don't render at the device width (default 393×852) fail. |
| Real copy | Placeholder and lorem ipsum text fails. |
| Accessibility basics | Text below WCAG AA contrast fails. Touch targets under 44×44 fail. |
| Every interaction is specified | Each interactive element needs an entry in `mockup/interactions.json`: trigger, states, effect, duration, easing. |
| It looks right | `check-design` writes a screenshot of every screen to `.proof/design/`, and the skill has Claude open and fix them before calling the design done. |

### Build (`/proof:build`)

| What | How it's checked |
|---|---|
| The test really tests the change | Each unit starts with a test that fails for the right reason. The failing run is recorded in `PROGRESS.md`. |
| The change works | Your project's own checks (types, lint, tests, whatever you list in `.claude/proof.json`) run after every reply that changed files. A failure goes back to Claude, not to you. |
| Nothing else broke | Before `git commit`, every relevant check runs in full. A failure blocks the commit. |
| The feature works in the app, not just in tests | The skill has Claude run the app and use the feature, through a browser or a simulator, before the unit counts as done. |
| The screen matches the mockup | The fidelity kit extracts every tagged element from the mockup and checks the app for each one: present, exact copy, position and size within 2px, font, colour, background, radius, shadow. The `proof:screen-judge` agent then compares screenshots item by item. |
| The mockup didn't drift | The approved mockup and its inventories are frozen with a git tag. The check fails if they change without your sign-off. |
| Animations match the spec | Timing tests against the numbers in `interactions.json`, a screenshot per state, and a scripted flow. |
| It does what the unit asked | The `proof:verifier` agent reviews each unit against its acceptance criteria before it's committed. It only reports correctness and missing requirements, not taste. |
| A hung test isn't mistaken for a failing one | Test runs, builds and wait loops run under time and memory limits. A breach is reported as a loop, leak or hang. |
| Claude didn't weaken the checks to pass them | Changes to `.claude/proof.json`, `.claude/settings.json` or the fidelity kit make Claude stop and ask you before it can finish or commit. |

### Small fixes (`/proof:quick`)

For a copy change, a styling fix or a contained bug (up to 3 files and 100 lines), most of the process is skipped, but the change is still proven with the narrowest check and the commit gate still runs. If the change grows, or touches auth, payments, migrations, CI or the checks, the gate moves it back to the full build process.

Deployment isn't covered yet. proof stops at the commit; your CI takes it from there.

## Also in the box

These came out of running long, parallel builds with it.

**Memory management.** Several Claude sessions, each with test runners, dev servers and simulators, can run a laptop out of memory. proof keeps the machine under a ceiling (85% by default). Heavy runs and new agents wait for room. If the machine hits the ceiling anyway, the newest run Claude started is stopped first. It never closes your apps; it tells Claude which ones are using the most, and Claude asks you. `node <plugin>/scripts/mem.mjs` shows the picture.

**A live dashboard.** `/proof:watch` opens `http://127.0.0.1:47331/`, which shows every session on the machine: what each session and agent is doing right now and for how long, a timeline per worktree, the plan, gate results, where the time went, and memory. It refreshes every 2 seconds. What it shows is specified in [`docs/dashboard-spec.md`](plugins/proof/docs/dashboard-spec.md).

**Session rules.** At the start of each session (and after `/clear` or compaction) Claude gets a short list of rules plus this project's status: whether the gate is on, which checks it runs, memory, and the dashboard's address.

**Speed.** Checks run in parallel. A pass is cached against the exact content of the code, so the same code is never checked twice. After a reply, only checks relevant to the changed files run, and you can give each a faster variant (related tests only, changed files only).

**Keep awake.** On macOS, the machine doesn't idle-sleep while a session is working.

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

It installs at user scope, so it covers every project, worktree and session on the machine. Start a new session, or run `/reload-plugins` in an open one. `claude plugin details proof` shows the version and its hooks.

You need Node.js 20 or later on your `PATH` (the hooks are Node scripts, and Claude Code's native installer doesn't include Node) and git. It runs on macOS and Linux; keep-awake is macOS only. Windows isn't supported.

The gate stays off in a repo until you give it checks. The skills load only when a phase is relevant, so the standing cost is their descriptions, about 700 tokens per session.

## Turn the gate on in a project

Add `.claude/proof.json`. The build skill offers to create it from the project's own scripts.

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
- `maxRounds`: how many times the gate sends Claude back after a reply. After that many rounds, or 2 rounds without progress, Claude may stop and you're told what still fails.

To add the spec and design checks to the gate, see the [discover](plugins/proof/skills/discover/SKILL.md#check) and [design](plugins/proof/skills/design/SKILL.md#check) skills.

Run every check by hand with `node <plugin>/scripts/gate.mjs --run`. Add `--no-cache` to force fresh runs. `<plugin>` is the plugin's folder; Claude knows its path.

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

## What it does on your machine

- It makes no network calls. The dashboard listens on 127.0.0.1 and refuses requests addressed to any other host name.
- It reads Claude Code's own logs (`~/.claude/projects`, `~/.claude/tasks`) to draw the dashboard. Its state lives in the plugin's data folder and `~/.config/proof/machine.json`.
- It only stops processes Claude started: runs past their limits and, when the machine stays over its memory ceiling, the newest of Claude's runs.
- On macOS it holds a no-idle-sleep assertion (`caffeinate -i`) while work is in flight, and lets go a few minutes after.

## Limits

- Memory readings are approximate. Per-process memory comes from `ps` (resident memory), which undercounts once macOS compresses memory; the machine total uses the same figures as Activity Monitor. Learned per-command memory needs settle after a few runs.
- Keep-awake covers idle sleep only. Closing a MacBook's lid still sleeps it unless it's on power with an external display.
- If your own apps push the machine over the ceiling, proof stops the newest run Claude started. It never touches your apps.
- The dashboard reads Claude Code's logs, whose format can change between versions. Anything it can't parse is skipped.
- Stack traces from a hung run depend on the runner. pytest prints every thread's stack; a JS runner stuck in a synchronous loop shows only the last test file it started.
- A wrapped test, build or wait command runs in its own shell, so a `cd` inside it doesn't carry over to Claude's next command.
- Cloud sessions (claude.ai/code, or cloud sessions started from the mobile app) don't load plugins. To cover a repo there, its `.claude/` folder needs committed copies of the skills, agents and hooks.
- The gate uses git to see what changed, so it stays off outside a git repo. It reads `.claude/proof.json` from the repo root.
- The cache is keyed on tracked and untracked files. A check that depends on ignored files (such as `.env`) or on a running service should set `cache: false`. Cached passes expire after 12 hours.
- The fidelity kit's numeric checks cover anything that renders in a browser, including Expo web. For Flutter or native sign-off it relies on reference screenshots, the screen judge, and the platform element-tree tools listed in [`fidelity.md`](plugins/proof/skills/build/references/fidelity.md).

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

That checks syntax and the manifests, then runs the scenario suites: the gate, the guard, memory turn-taking, quick mode, the monitor, and a read of this machine's real memory. They run in throwaway git repos with a throwaway home folder, so your own setup is never touched, and memory pressure is simulated. They take about three minutes and leave nothing running. CI runs them on Linux and macOS.

Issues and pull requests are welcome. If you change what the dashboard shows, update [`docs/dashboard-spec.md`](plugins/proof/docs/dashboard-spec.md) too.

## License

[MIT](LICENSE)
