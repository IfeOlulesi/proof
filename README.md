<div align="center">

<picture><source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg"><img src="assets/logo.svg" alt="proof" height="56"></picture>

### Quit babysitting Claude. Make it check its own work.

[![tests](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml/badge.svg)](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Install](#install) · [Turn it on](#turn-it-on-in-a-project) · [Phases](#working-in-phases) · [Config](#configuration)

</div>

<br>

proof is a Claude Code plugin. It runs your project's checks (types, lint, tests) every time Claude finishes a reply and before every `git commit`. If a check fails, Claude gets the error and keeps working. You stop being the person who catches the mistakes.

It also adds checks for the parts tests usually miss: whether a spec is complete, whether a mockup covers every state, and whether a screen matches its mockup.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/dashboard-dark.png">
  <img src="assets/dashboard.png" alt="The proof dashboard: one session with three agents running, their progress, and the plan">
</picture>

<p align="center"><sub>The live dashboard (<code>/proof:watch</code>), showing a session with three agents at work. Sample data.</sub></p>

## What it catches

| ❌ Without proof | ✅ With proof |
|---|---|
| **Claude says "done"**<br><sub>…and the tests fail when you run them.</sub> | Checks run after every reply that changes files. Claude sees the failure and fixes it before handing back. |
| **A failing check gets switched off**<br><sub>…so the work "passes".</sub> | Editing `proof.json`, `settings.json` or the fidelity kit makes Claude stop and ask you first. |
| **The screen is *almost* the design**<br><sub>Wrong copy, a few pixels off, the wrong grey.</sub> | Every tagged element is checked against the mockup: exact copy, position and size within 2px, font, colour. |
| **The empty state never got built**<br><sub>The spec didn't mention it.</sub> | Every state needs its own mockup frame, and every requirement says how it'll be verified. |
| **A test run hangs**<br><sub>Claude waits forever.</sub> | Test runs and builds have time limits. A breach is reported as a hang. |
| **Your laptop freezes**<br><sub>Three agents and a simulator at once.</sub> | Heavy runs wait for memory. If the machine goes over the ceiling, the newest run is stopped. |
| **You come back after an hour**<br><sub>No idea what happened.</sub> | The dashboard shows every session: what's running, for how long, the plan and the check results. |

## Install

Open Claude Code and paste this:

```
Install the proof plugin (github.com/IfeOlulesi/proof).

1. It needs git and Node.js 20 or later on my PATH. Check both first. If either is
   missing or too old, tell me and offer to install it.
2. Run `claude plugin marketplace add IfeOlulesi/proof`, then
   `claude plugin install proof@proof`. Check `claude plugin list` shows
   proof@proof as enabled.
3. Turn on auto-update for it: in ~/.claude/settings.json, add
   "proof": { "source": { "source": "github", "repo": "IfeOlulesi/proof" },
   "autoUpdate": true } under "extraKnownMarketplaces". If you can't edit that
   file, tell me to do it in /plugin → Marketplaces → proof → Enable auto-update.
4. If we're in a git repo, turn proof on here: write .claude/proof.json
   (format: github.com/IfeOlulesi/proof#turn-it-on-in-a-project) with checks for
   the type check, lint and tests this project already uses. Run each one once
   and show me which pass and which fail.
5. Finally, tell me to run /reload-plugins.
```

Claude checks for git and Node.js, asks before installing anything, installs proof with auto-update on, and sets it up in the project you're in.

> [!TIP]
> When it's done, run `/reload-plugins` (or restart Claude Code) to load proof.

<details>
<summary>Install by hand instead</summary>

You need git and Node.js 20+ on your `PATH`. Then, in a terminal:

```bash
claude plugin marketplace add IfeOlulesi/proof && claude plugin install proof@proof
```

Restart Claude Code. `claude plugin list` should show `proof@proof` as enabled. Then turn on auto-update: `/plugin` → Marketplaces → proof → Enable auto-update.

</details>

> [!NOTE]
> Tested on macOS and Linux.

## Other coding agents

proof also runs in opencode, Gemini CLI, Codex, Cursor, Grok Build and Antigravity. They get the same gate, rules,
memory limits and skills, and their sessions show on the same dashboard as Claude's. You need git and Node.js 20+.

```bash
git clone https://github.com/IfeOlulesi/proof ~/.proof
cd your-project
node ~/.proof/plugins/proof/scripts/install.mjs <agent>      # opencode, gemini, codex, cursor, grok, antigravity
```

Add `--global` to install for every project, and `--uninstall` to take proof out again: it puts back every file it
touched exactly as it was and deletes only what it created. `install.mjs --list` shows what each agent gets. To
update, `git -C ~/.proof pull` and run the installer again; proof says at session start when a newer version is out.
The full table of what each agent can do, hook by hook, is in [docs/agents.md](plugins/proof/docs/agents.md).

<details>
<summary>opencode (tested live)</summary>

`install.mjs opencode` writes a plugin to `.opencode/plugins/proof.js`, proof's skills to `.opencode/skills/`, and the
verifier and screen-judge as subagents in `.opencode/agents/`.
- **Works:** rules in the system prompt, the gate at the end of each turn (it sends opencode back with what failed,
  up to `maxRounds`), the commit gate, test runs under proof's memory and time limits, the memory note before a
  subagent, and the dashboard.
- **Doesn't:** the gate can only send opencode back while it runs as a server (the TUI or `opencode serve`).
  One-shot `opencode run` exits at the first idle, so there the gate only reports.
</details>

<details>
<summary>Gemini CLI (built from docs, not tested live)</summary>

`install.mjs gemini` adds proof's hooks to `.gemini/settings.json`, skills to `.gemini/skills/`, and the verifier and
screen-judge to `.gemini/agents/`.
- **Works:** rules at session start, the gate after each turn (AfterAgent), the commit gate and test-run limits
  (BeforeTool), and the dashboard.
- **Doesn't, or isn't known:** Gemini's docs don't say what a subagent call looks like to a hook, so the memory note
  before subagents may not fire. Subagents are a preview feature in Gemini CLI. Trust proof's hooks in `/hooks` the
  first time.
</details>

<details>
<summary>Codex (built from docs, not tested live)</summary>

`install.mjs codex` adds proof's hooks to `.codex/hooks.json`, skills to `.agents/skills/`, and the verifier and
screen-judge to `.codex/agents/`.
- **Works:** rules at session start, the gate after each turn (Stop), the commit gate and test-run limits
  (PreToolUse), the memory note before a subagent, and the dashboard.
- **Doesn't:** Codex lets an action through when a hook fails or times out, so a commit gate that's killed allows the
  commit. Codex asks you to trust new hooks in `/hooks` before they run.
</details>

<details>
<summary>Cursor (built from docs, not tested live)</summary>

`install.mjs cursor` adds proof's hooks to `.cursor/hooks.json`, skills to `.cursor/skills/`, and the verifier and
screen-judge to `.cursor/agents/`.
- **Works:** rules at session start, the gate at the end of each turn (stop, as a follow-up message), the commit gate
  (it fails closed if killed), test-run limits, and the dashboard.
- **Doesn't:** Cursor's subagent hook can refuse a subagent but not add proof's memory note to it. When the gate gives
  up after `maxRounds`, Cursor doesn't show proof's "still failing" message (its stop hook has no field for one), and
  it stops proof's follow-ups after 20 in a row. Cursor also runs Claude Code's hooks from `.claude/settings.json`; if
  proof is set up there too, it runs twice.
</details>

<details>
<summary>Grok Build (built from docs, not tested live)</summary>

`install.mjs grok` writes proof's hooks to `.grok/hooks/proof.json`, its rules to `.grok/rules/proof.md`, skills to
`.grok/skills/` and the verifier and screen-judge to `.grok/agents/`.
- **Works:** rules (from the rules file), the gate after each turn (Stop), the commit gate and test-run limits, the
  memory note before a subagent, and the dashboard.
- **Doesn't:** Grok's session-start hook can't add to the model's context, so the project's live status (which checks
  are on, memory) isn't in its rules. Grok ends a turn after 8 send-backs whatever `maxRounds` says. Trust the folder
  (`/hooks-trust`) the first time. Grok also reads Claude Code's hooks and plugins, so with proof installed in both, turn
  off Grok's Claude Code compatibility for hooks.
</details>

<details>
<summary>Antigravity (built from docs, not tested live)</summary>

`install.mjs antigravity` adds a `proof` group to `.agents/hooks.json` (the `agy` CLI), skills to `.agents/skills/`,
and the verifier and screen-judge to `.agents/agents/`.
- **Works:** rules at session start, the gate after each turn (Stop), the commit gate and test-run limits, and the
  dashboard.
- **Doesn't, or isn't known:** Antigravity has no hook for a new prompt; proof counts the last thing you typed, sent
  before each model call (CLI 1.4.7 or later), as one. Its docs don't say how to add a note before a subagent. It caps
  how many times in a row the gate can send it back, and doesn't show proof's "still failing" message when the gate
  gives up.
</details>

## Turn it on in a project

The gate only runs in a repo that has a `.claude/proof.json` listing its checks. The install prompt writes it for the project you installed from. For any other project, open Claude Code there and paste:

```
Set up proof in this repo: write .claude/proof.json with checks for the type
check, lint and tests this project already uses. Then run every check once and
show me which pass and which fail.
```

Or write the file yourself:

```json
{
  "checks": [
    { "name": "types", "run": "npx tsc --noEmit" },
    { "name": "test",  "run": "npx jest --ci" }
  ]
}
```

From then on, this is what happens:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/how-it-works-dark.png">
  <img src="assets/how-it-works.png" alt="How proof works. After every reply that changes files, proof runs your checks: on a pass the reply reaches you, on a fail proof sends the error back to Claude, which fixes it. Before every commit, proof runs the full checks: on a pass the commit goes through, on a fail proof blocks it. If Claude edits proof.json, proof stops Claude to ask you, and you approve or say no.">
</picture>

Claude can't loosen a check to get past it: if it edits `.claude/proof.json`, `.claude/settings.json` or the fidelity kit, it has to stop and ask you first.

Run the checks yourself any time with `node <plugin>/scripts/gate.mjs --run` (`<plugin>` is the plugin's folder; Claude knows its path).

## Working in phases

Claude picks the right phase on its own, or you can call one:

| Command | For | Checks that |
|---|---|---|
| [`/proof:discover`](plugins/proof/skills/discover/SKILL.md) | Idea → spec | Every requirement says how it's verified |
| [`/proof:design`](plugins/proof/skills/design/SKILL.md) | Spec → HTML mockup | Every screen, state and test ID exists |
| [`/proof:build`](plugins/proof/skills/build/SKILL.md) | Any code change | Tests come first, the app is run, screens match the mockup |
| [`/proof:quick`](plugins/proof/skills/quick/SKILL.md) | Fixes up to 3 files | The narrowest check passes, then the commit gate |
| [`/proof:watch`](plugins/proof/skills/watch/SKILL.md) | Long or parallel work | Opens the live dashboard |

Before each unit of work is committed, a separate `proof:verifier` agent reviews it against what was asked, in a fresh context.

## Running several sessions at once

Parallel sessions with test runners, dev servers and simulators can run a laptop out of memory. proof keeps the machine under a ceiling (90% by default):

- **Heavy runs and new agents wait** until there's room.
- **If the machine goes over anyway**, the newest run Claude started is stopped.
- **Your apps are never closed.** proof tells you which ones are using the most.

On macOS it also keeps the machine from idle-sleeping while Claude is working.

## Roadmap

- **Live tests in more agents.** Gemini CLI, Codex, Cursor, Grok Build and Antigravity are built from their docs; each gets tested live as it becomes available.
- **Checks in CI.** A GitHub Action that runs the same `.claude/proof.json`, for cloud sessions and pull requests that didn't come from Claude.
- **Setup that writes `proof.json` for you.** Suggests checks from `package.json`, `pyproject.toml` or `Cargo.toml`.
- **Notifications when Claude needs you.** A desktop or phone alert when a session stops on a question or runs out of rounds.
- **Accessibility checks** in the design gate: contrast and basic rules on every screen.
- **Closer comparison for Flutter and native apps**, beyond screenshots.
- **Linux and Windows parity** for keep-awake and memory pressure.
- **History on the dashboard.** Check results over time and how long each unit took.

<br>

---

# Reference

## Configuration

<details>
<summary>All <code>.claude/proof.json</code> options</summary>

```json
{
  "checks": [
    { "name": "test", "run": "npx jest --ci",
      "fast": "npx jest --ci --passWithNoTests --findRelatedTests {files}",
      "files": ["src/**/*.{ts,tsx}"], "fullWhen": ["jest.config.js", "package.json"],
      "when": ["src/", "jest.config.js", "package.json"], "timeout": 600 }
  ],
  "maxRounds": 5
}
```

Per check:

- `run`: the full command. Runs before every commit, and after each reply when there's no `fast`.
- `fast`: a quicker command for after each reply. `{files}` becomes the changed files that match `files`.
- `fullWhen`: changed files that force the full command anyway.
- `when`: only run the check when files under these paths changed.
- `cache: false`: for checks that depend on more than the code, like a running app. Otherwise a pass is cached against the exact code for 12 hours.
- `timeout`: seconds.

Top level:

- `maxRounds` (5): how many times Claude is sent back after a reply before you're told what still fails.
- `concurrency` (4): how many checks run at once.
- `maxMemoryMB` / `maxProcessMemoryMB`: memory limits for a run and for one process. Default: half and a quarter of RAM.
- `testRunTimeout` (900), `buildTimeout` (1800), `waitTimeout` (300): seconds before a run Claude started is treated as hung.
- `quick`: `{ "maxFiles": 3, "maxLines": 100 }`, the size limit for `/proof:quick`.

To add the spec and design checks to the gate, see the [discover](plugins/proof/skills/discover/SKILL.md#check) and [design](plugins/proof/skills/design/SKILL.md#check) skills.

</details>

<details>
<summary>Machine settings: <code>~/.config/proof/machine.json</code></summary>

```json
{
  "memoryWarnPercent": 75,
  "memoryCeilingPercent": 85,
  "keepAwake": true,
  "dashboardPort": 47331,
  "autoOpenDashboard": true,
  "autoOpenAfterMinutes": 45,
  "admitWaitSeconds": 180,
  "updateCheck": true
}
```

</details>

## Update

Claude Code updates plugins on its own only for marketplaces with auto-update on, and it's off for third-party marketplaces like this one until you turn it on: `/plugin` → Marketplaces → proof → Enable auto-update. The install prompt above does this for you.

Without it, proof tells Claude when a newer version is out, at the start of a session, and Claude offers to update. To update by hand:

```bash
claude plugin marketplace update proof
claude plugin update proof@proof
```

If a repo has a `fidelity/` folder, also run `node <plugin>/skills/build/fidelity-kit/install.mjs --upgrade` once on its main branch.

## What proof caught

Every gate run is added to a history in `~/.config/proof/ledger.jsonl` (names, results and timings, never check
output), and proof fills it once from your past Claude Code sessions. After a turn where proof caught a failure before
you saw it, the gate's message says so, with the session's totals. For any stretch of time:

```bash
node <plugin>/scripts/recap.mjs              # the last 7 days
node <plugin>/scripts/recap.mjs --since 30d  # or 12h, 4w; --json for the numbers
```

It counts failures caught (a check that failed, then passed on changed code), commits blocked, failures handed back to
you, flaky checks (failed, then passed on the same code) and time spent in checks.

## Privacy

proof makes one network call: at most once a day, in the background, it reads the released version number from GitHub (`raw.githubusercontent.com`) to tell you about updates. Nothing is sent. Turn it off with `"updateCheck": false` in `~/.config/proof/machine.json`. The dashboard listens on 127.0.0.1 only. It reads Claude Code's own logs in `~/.claude` to draw the dashboard (for other agents, a log proof's hooks write in its data folder), and only ever stops processes Claude started.

## Limits

- The gate needs a git repo.
- Cloud sessions (claude.ai/code) don't load plugins.
- Checks that depend on ignored files (like `.env`) or a running service should set `cache: false`.
- The mockup comparison measures anything that renders in a browser, including Expo web. Flutter and native apps are checked with screenshots instead.

## Develop

```bash
git clone https://github.com/IfeOlulesi/proof.git
claude plugin marketplace add ./proof
claude plugin install proof@proof
bash tests/run.sh
```

Edits take effect at the next session or after `/reload-plugins`. The tests run in throwaway repos and a throwaway home folder, take about three minutes, and run in CI on Linux and macOS. If you change the dashboard, update [`docs/dashboard-spec.md`](plugins/proof/docs/dashboard-spec.md).

## License

[MIT](LICENSE)
