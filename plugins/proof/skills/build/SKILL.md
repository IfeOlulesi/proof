---
name: build
description: Engineering work of any kind — implementing features, fixing bugs, refactoring, and implementing a design or mockup in an app (web, React Native/Expo, Flutter, native iOS/Android). Use for every code change. Works one unit at a time, proves each one with checks, and sets up the project's completion gate in .claude/proof.json.
---

# Build: ship code that is proven to work

## Start of every session

1. **Read the state.** Read SPEC.md, features.json and PROGRESS.md (whichever exist), and `git log --oneline -15`.
2. **Make sure the gate exists.** `.claude/proof.json` lists the commands that prove this project works.
   - If it's missing, create it from the project's real scripts (package.json, Makefile, pubspec.yaml, Gradle, Cargo) and run each command once.
   - Changing this file is flagged to the user, so end your message with `NEEDS-INPUT:` asking them to confirm it.
3. **Check the baseline.** Run every check before changing anything: `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" --run`.
   - Checks that already passed on this exact code are reused, so this is cheap on a commit that's been checked before.
   - If something already fails, tell the user and fix or record it first. Don't build on a red baseline.

## How the gate runs checks

- **After each reply that changed files**, the checks whose `when` globs match run. Where a check has a `fast` variant, that runs instead.
- **Before each `git commit`**, every relevant check runs in full, and a failure blocks the commit.
- Independent checks run in parallel. A pass is cached against the exact content of the code.

```json
{
  "checks": [
    { "name": "types", "run": "npx tsc --noEmit", "when": ["src/", "app/", "tsconfig.json"] },
    { "name": "lint", "run": "npm run --silent lint",
      "fast": "npx --no-install eslint --cache --cache-location node_modules/.cache/eslint/ {files}",
      "files": ["src/**/*.{ts,tsx,js,jsx}", "app/**/*.{ts,tsx,js,jsx}"],
      "fullWhen": ["eslint.config.js", "package.json"], "when": ["src/", "app/", "eslint.config.js"] },
    { "name": "test", "run": "npx --no-install jest --ci",
      "fast": "npx --no-install jest --ci --passWithNoTests --findRelatedTests {files}",
      "files": ["src/**/*.{ts,tsx,js,jsx}", "app/**/*.{ts,tsx,js,jsx}"],
      "fullWhen": ["jest.config.js", "babel.config.js", "package.json", "jest/"],
      "when": ["src/", "app/", "jest/", "jest.config.js", "package.json"], "timeout": 600 }
  ],
  "maxRounds": 5
}
```

The fields:
- `run`: the full command. It runs from the repo root and runs before every commit.
- `when`: optional globs. The check runs only if a file this session changed matches one.
- `fast`: optional cheaper command for after each reply. `{files}` becomes the changed files that match `files`, as quoted absolute paths.
- `fullWhen`: changes that force the full command even after a reply, such as config files.
- Deleted files and changes over 200 files also force the full command.
- `cache: false`: for checks that depend on things outside the code, like a running server.
- `timeout`: seconds, default 300.
- `maxMemoryMB` / `maxProcessMemoryMB`: memory ceilings for a run's processes together and for any one process. They default to half and a quarter of RAM, and can be set at the top level or per check. A check that breaches one is stopped and reported as a leak or loop.
- `testRunTimeout`: seconds allowed for test runs you start yourself, default 900. Those runs are wrapped in the same guard automatically.
- `concurrency`: how many checks run at once, default 4.
- `maxRounds`: how many times the gate sends you back before handing the decision to the user.
- Fast forms for other stacks:
  - Flutter: `flutter test` on the changed `test/` files
  - Python: `pytest -q` on the changed test files
  - Go: `go test` on the changed packages
- Never use watch modes.

## One unit at a time

4. **Pick one feature, bug or screen.** Take the first features.json item with `passes: false` unless the user said otherwise. If it's more than about an hour of focused work, split it and say so.
5. **Make it fail first (red).** Write or extend the test or check for this unit, run just that test, and watch it fail. For UI, the check is the rendered screen compared with its reference (see below).
   - Stop the red run at the first failure: `--max-failures=1` (Playwright), `--bail` (Jest, Vitest), `-x` (pytest). It only has to show the test fails for the right reason; a whole failing spec waits out every assertion's timeout.
   - Record it under the unit in PROGRESS.md: the test name and the failure line.
   - The verifier relies on this record, so it doesn't re-prove the test.
6. **Make it pass (green), then use it.**
   - While iterating, run only the failing test or file. The gate runs the rest.
   - If the proof guard stops a run for memory or time, it's a loop, a leak or a hang, not a flaky test. Find the cause (the output shows where it was) before running it again. If it says the *machine* ran short of memory, the run may be fine: free memory, then run it again.
   - For a run that takes minutes, start it in the background and wait on it with TaskOutput, which returns when the run exits. Never poll its log with `until grep …` or wait with `pgrep`: a line that never comes, or another session's run that matches, holds you until the limit. proof stops wait loops after 5 minutes.
   - Then run the app and use the feature: in the browser through Playwright or Chrome, or on a simulator through the platform tools. "Tests pass" is not the end.
7. **Review.** For anything non-trivial, ask the proof:verifier agent to review the change against the unit's acceptance criteria. Do this once per unit, before committing. Fix the real gaps; ignore taste.
8. **Commit and record.**
   - Commit one unit per commit. The commit runs the full checks; if they fail, fix the cause and commit again.
   - Add to PROGRESS.md: what changed, the checks that ran, what is still unverified, and what's next.
   - Set `passes: true` in features.json only with `evidence` naming the command that passed.

## Long builds and parallel agents

- **Show progress.** For work longer than an hour, open the dashboard (proof:watch) at the start.
  - Keep your task list current: one item per unit, in progress and completed as you go.
  - Give agents short, specific descriptions ("Lane B unit 13: profile screen"). The user sees them.
- **One agent per worktree.** Agents sharing a worktree fail on each other's uncommitted changes.
- **Each lane gets its own state.**
  - Tests that reset data need their own database and ports per worktree. Lanes sharing one database their tests reset have to run end-to-end tests one at a time, or they break each other's runs.
  - Supabase local: give each worktree its own `project_id` and its own ports in `supabase/config.toml`. Leave out services the tests don't use with `supabase start -x <services>` (`supabase start --help` lists them), and check `docker stats` for what each stack really takes.
  - Point each lane's app and e2e config at its own stack.
- **Memory decides how many lanes fit.**
  - proof keeps the machine under its ceiling: heavy runs and new agents wait their turn, and the newest run is stopped if the machine gets there.
  - Stop dev servers, simulators and browsers when a lane is done with them.
  - If the user's apps hold the memory, tell them what closing them would free; don't close them yourself.
- **The orchestrator never blocks.** Hand a lane's re-verification to a background proof:verifier and keep dispatching. Don't re-run a lane's end-to-end suite in the main thread; the verifier and the commit gate cover it.
- **The Mac stays awake while work is in flight** (proof holds a no-idle-sleep assertion). Closing the lid still sleeps it, so say so if the user is about to leave a long build running.

## Implementing a mockup or design

Never implement every screen in one go. Read `${CLAUDE_SKILL_DIR}/references/fidelity.md` and follow it:
- design tokens and shared components first
- then one screen per fresh session
- each screen gated by an inventory check extracted from the mockup's HTML

Install the kit it uses from the repo root: `node "${CLAUDE_SKILL_DIR}/fidelity-kit/install.mjs" --app-url <the app's dev URL>`.

## Upgrading a repo set up with proof 0.1

- **Fidelity kit:** if the repo has a `fidelity/` folder, run `node "${CLAUDE_SKILL_DIR}/fidelity-kit/install.mjs" --upgrade`. It updates the kit and keeps the app URL. When the mockup and inventories are unchanged, it also commits the kit and moves the `contract` tag.
- **Fast variants:** add `fast` forms for slow checks (test runners, linters) as shown above, using the project's real tools. Then end your message with `NEEDS-INPUT:` so the user confirms the change.

## Before you finish

9. **Every check passes.** The gate enforces this after each reply, and the commit enforces the full set. If a check is genuinely wrong, explain why and end your message with `NEEDS-INPUT:` and your question.
10. **Report** what changed, which checks ran and passed, and what you did not verify.

## Never

- Edit or delete tests, inventories, specs or `.claude/proof.json` to make a failure go away.
- Mark something done because the code looks right.
- Ship auth, payments, balances or shared state without server-side validation, access rules and a test of the abuse case.
- Keep correcting the same problem past the second attempt. Stop, write a sharper prompt, and recommend `/clear`.
- Delete folders with `rm -rf`. Scratch work goes in a fresh `mktemp -d`.
