# <picture><source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg"><img src="assets/logo.svg" alt="proof" height="56"></picture>

### Quit babysitting Claude. Make it check its own work.

[![tests](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml/badge.svg)](https://github.com/IfeOlulesi/proof/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

proof is a Claude Code plugin. It runs your project's checks (types, lint, tests) every time Claude finishes a reply and before every `git commit`. If a check fails, Claude gets the error and keeps working. You stop being the person who catches the mistakes.

It also adds checks for the parts tests usually miss: whether a spec is complete, whether a mockup covers every state, and whether a screen matches its mockup.

## Install

```
/plugin marketplace add IfeOlulesi/proof
/plugin install proof@proof
```

Then start a new session, or run `/reload-plugins`.

You need git and Node.js 20+ on your `PATH`. Tested on macOS and Linux.

## Turn it on in a project

The gate stays off until a repo has a `.claude/proof.json` listing its checks. Ask Claude to set it up (the build skill writes it from the project's own scripts), or write it yourself:

```json
{
  "checks": [
    { "name": "types", "run": "npx tsc --noEmit" },
    { "name": "test",  "run": "npx jest --ci" }
  ]
}
```

That's it. From now on:

- **After each reply that changed files**, the checks run. A failure goes back to Claude, not to you.
- **Before each `git commit`**, every relevant check runs its full command. A failure blocks the commit.
- **If Claude edits the checks** (`.claude/proof.json`, `.claude/settings.json`, the fidelity kit), it has to stop and ask you first. It can't loosen a check to get past it.

Run them yourself any time with `node <plugin>/scripts/gate.mjs --run` (`<plugin>` is the plugin's folder; Claude knows its path).

## Working in phases

proof splits work into phases. Claude loads the right one on its own, or you can call it:

| Command | Use it for | What it makes checkable |
|---|---|---|
| `/proof:discover` | An idea → a spec | Every acceptance criterion says how it will be verified. No placeholder text. The work is split into units in `features.json`, and a unit can't be marked done without evidence. |
| `/proof:design` | A spec → an HTML mockup | Every screen and state exists. Every element has a `data-testid`. Real copy, WCAG AA contrast, 44px touch targets, and a spec for every interaction. |
| `/proof:build` | Any code change | Each unit starts with a failing test. Claude runs the app and uses the feature before calling it done. Screens are compared with the mockup: copy, position, size, font, colour. |
| `/proof:quick` | A small fix (up to 3 files) | Skips the process but still runs the narrowest check and the commit gate. |
| `/proof:watch` | Long or parallel work | Opens a live dashboard of every session on the machine. |

Before each unit is committed, a separate `proof:verifier` agent reviews it against what was asked, in a fresh context.

## Running several sessions at once

Parallel sessions with test runners, dev servers and simulators can run a laptop out of memory. proof keeps the machine under a ceiling (85% by default): heavy runs and new agents wait until there's room, and if the machine goes over anyway, the newest run Claude started is stopped. It never closes your apps. It tells you which ones are using the most.

On macOS it also keeps the machine from idle-sleeping while Claude is working.

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
  "admitWaitSeconds": 180
}
```

</details>

## Update

```bash
claude plugin marketplace update proof
claude plugin update proof@proof
```

If a repo has a `fidelity/` folder, also run `node <plugin>/skills/build/fidelity-kit/install.mjs --upgrade` once on its main branch.

## Privacy

proof makes no network calls. The dashboard listens on 127.0.0.1 only. It reads Claude Code's own logs in `~/.claude` to draw the dashboard, and only ever stops processes Claude started.

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
