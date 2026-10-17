# Dashboard v1 build: progress

Design: `mockup/app.html` (tag `design-v1`), interactions in `mockup/interactions.json`.
Contract: one inventory per mockup frame in `fidelity/inventory/`, checked with `fidelity/verify-screen.mjs <screen>` against
`http://127.0.0.1:47400` (a static server at the worktree root: `python3 -m http.server 47400 --bind 127.0.0.1`).
Fixtures: `node tests/fixtures/dashboard/make.mjs` writes the feeds the inventory routes read.

## Units

| # | Unit | Screens | State |
|---|---|---|---|
| 1 | Foundation and session home, working | home--working, home--working--dark | done |
| 2 | Needs you, finished, stalled | home--needs-you, home--finished, home--stalled (+ dark) | done |
| 3 | Memory: banner and memory view | home--memory-warning, memory (+ dark) | done |
| 4 | Agent drill-down | job (+ dark) | done |
| 5 | Drawers | drawer--timeline, drawer--time, drawer--log (+ dark) | done |
| 6 | Switcher menu | switcher--menu, switcher--menu-search, switcher--hidden-needs-you (+ dark) | done |
| 7 | Loading, offline, empty | loading, offline, empty (+ dark) | done |
| 8 | Data fixes in the feed | ExitPlanMode counted as waiting on you; an open question is needsInput, not stalled; template text in memory events; task owner | done |
| 9 | Interactions | every entry in mockup/interactions.json | done |

## 1. Foundation and session home, working

- `plugins/proof/scripts/dashboard.html` rewritten as one self-contained file: fonts embedded, htm + Preact inline, the mockup's
  tokens and styles verbatim, the app at the bottom. Keeps `proof · live`, `/*__PROOF_DATA__*/` and the `data.json` poll.
- Live: polls every 2 s, timers tick, "Not live" banner and grey logo dot when a fetch fails. Frozen: `?data=` or an
  embedded feed. Replay pages from `dashboard.mjs --out` show a replay banner.
- Red: `fidelity/verify-screen.mjs home--working` before the page existed: every item `missing`.
- Checks run: `verify-screen.mjs home--working` and `home--working--dark`: ALL PASS. `bash tests/run.sh memory-quick-dashboard`:
  45 passed. Real feed snapshot (12 sessions, every state): renders, no page errors.
- Beyond the mockup, from real data: a session with no agents lists the main thread's recent steps in the run panel; the
  top bar lets tabs shrink so it never overflows.
- Not verified yet: hover and keyboard behaviour (unit 9).

## Contract changes (mockup sample data made consistent, so a real feed can produce it)

Approved design unchanged; only sample copy and times. Re-tagged `contract` after each.
- needs you: the subline reads "The gate found a failing check, so Claude stopped to ask you"; event times match "waiting 49h 35m".
- finished: event times match "Idle 41m"; the third row is the tool step's own description ("Wait for both CI runs to finish").
- stalled: rows are the last steps as the feed names them, at times that match "18 minutes"; commands and paths in code.
- memory warning: the verifier card keeps its timer row like the other cards.
- memory: the stop list is newest first, at times that match the other screens.

## 2. Needs you, finished, stalled

- Needs you: coral card with where to answer, "What led here" from the session's events. Gate-failure count in the
  drawer bar counts failures since the last pass and is left out while the card already says the session needs you.
- Finished: what happened (events and steps over a minute), totals, the three-part time bar, longest steps.
- Stalled: how long nothing has run, the last step, last activity, plan.
- Checks: verify-screen ALL PASS for all six frames. Screen judge: 14 notes, all three causes handled (the tab-dot
  "ring" is the pulse animation caught mid-frame in the reference, not a difference; command and path fonts fixed).
  The kit's per-element reference crops are offset on this mockup (page wider than the viewport), so the judge used
  the full captures.

## 3. Memory

- Banner past the warning line (warnPct) on session screens; the run graph and plan fold to fit under it.
- Memory view: usage, facts, gauge, history chart with warning and ceiling lines, Claude's runs, top apps, advice,
  what proof stopped or held back (memory events that were stops, newest first).
- Checks: verify-screen ALL PASS for home--memory-warning and memory (light and dark). Real feed: renders, no errors.

## 4. Agent drill-down

- Current step against the 10-minute limit, steps (consecutive tool calls of one kind), every tool call, the launch
  prompt (new `units[].prompt` in the feed), output. Works for the main thread too; long histories show the latest 12 steps.
- Checks: verify-screen ALL PASS (job, light and dark). Real feed: main-thread drill-down for 6 sessions, no errors.

## 5. Drawers

- Timeline (lanes per worktree, commit and gate-failure marks, hover tooltip, 1h to 24h), where the time went (three
  buckets, working-time breakdown with hover detail, what slowed it down, longest steps, session or last 6 h), log
  (events and running calls by default; gate, commits, problems, every tool call).
- Feed: `rows[].who` names a lane's agents.
- Checks: verify-screen ALL PASS for all six frames. Real feed: five sessions × three drawers, no errors.

## 6–7. Menu, loading, offline, empty

- Menu grouped by project, needs-you pinned, search, arrows/Enter/Esc, Ctrl/Cmd+K. More-button badge when a session
  that needs you is hidden. Loading skeleton, not-live banner with the last update dimmed, empty state.
- Checks: verify-screen ALL PASS for all twelve frames.

## 8. Data fixes

- `ExitPlanMode` waits on you (category `waitUser`, "Ask you to approve the plan"), no longer counted as planning.
- An open question or plan approval makes the session `needsInput` however long ago it was asked (was `stalled`).
- Memory events only from notices that start a line, never from code that quotes them.
- Task `owner` read from the task files.
- Red then green: `bash tests/dashboard.sh` (new suite, in tests/run.sh): 7 failing before, 11 passed after.

## 9. Interactions

- `node tests/dashboard-page.mjs` (Playwright, static server on 47400; not in tests/run.sh, which has no browser):
  tabs and 1–4, the menu (Ctrl+K, filter, arrows, Enter, Esc), T/W/L and Esc, hover tooltips on the time rows and
  timeline blocks, log filters, drill-down and back, memory view, theme toggle and memory of it, live polling every
  2 s, ticking timers, not-live on a failed poll and recovery, reduced motion. 24 passed, 3 runs in a row.
- Esc now decides what to close from the latest state (a press right after opening the menu used to miss).

## State at the end of this session

- All 32 mockup frames: ALL PASS. `bash tests/run.sh`: all passed (5 suites). Interaction test: 24 passed.
- Not verified: motion timings against interactions.json beyond reduced motion; Linux and other browsers.
- Before merging to main: drop `fidelity/refs` (14 MB) from the merge (squash), keep the inventories.
