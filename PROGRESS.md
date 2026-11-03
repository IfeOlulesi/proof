# Dashboard v2 build ("Pulse"): progress

Design: `mockup/app.html` (tag `design-v2`; v1 "Calm" is at `design-v1`), interactions in `mockup/interactions.json`.
Look: shadcn/ui base (zinc tokens, Geist and Geist Mono, card, badge, tabs, command, table, alert) with Tremor data
pieces (progress rings, tracker, category bar, bar list, spark area, stacked bar chart). 1440×900, light and dark.
Contract: 32 inventories in `fidelity/inventory/` (16 screens × 2 themes; the status--all spec sheet isn't an app
screen), checked with `fidelity/verify-screen.mjs <screen>` against `http://127.0.0.1:47400` as in v1.
Colour rules: green while Claude works; coral only for a session that needs you now; amber only for memory;
"waiting on you" is neutral grey in charts. Activity hues validated for colour-blind separation in stack order
thinking → reading/editing → commands → checks.

| # | Unit | Screens | State |
|---|---|---|---|
| 0 | Contract: mockup, inventories, routes, tags | - | done |
| 1 | Foundation: tokens, Geist fonts embedded, top bar, footer bar, card/badge/tabs/kbd | - | done |
| 2 | Home, working: rings, agent graph, KPI cards, activity chart | home--working (+ dark) | done |
| 3 | Needs you, finished, stalled | 3 × 2 | done (1 copy item for sign-off) |
| 4 | Memory banner and memory view | 2 × 2 | done (1 copy item for sign-off) |
| 5 | Agent drill-down | job (+ dark) | |
| 6 | Drawers as a bottom sheet: timeline, time, log | 3 × 2 | |
| 7 | Switcher (command palette), hidden needs-you | 3 × 2 | |
| 8 | Loading, offline, empty | 3 × 2 | |
| 9 | Interactions | every entry in mockup/interactions.json | |

Fixtures: the v2 mockup's sample data is generated in its script (seeded, "now" 14:34 on 17 Oct 2026); the fixture
feeds in `tests/fixtures/dashboard/` must produce the same numbers. Port the generator to `make.mjs` in unit 1/2.
Playwright: `npm i --no-save --no-package-lock playwright@1.56.1` (matches the cached headless shell 1194).

## v2 unit 1. Foundation

- `dashboard.html`: Geist and Geist Mono embedded (the latin variable files Google Fonts serves the mockup, so widths
  match); the mockup's tokens and styles verbatim, light on `:root`, dark by toggle or by the system; `.frame` became
  `.app` (full window). New top bar (logo, tabs with state dots, "+N more", memory pill with spark, theme) and footer
  bar (T/W/L drawer buttons with kbd, gate-failure badge, updated). Primitives (card, badge, btn, tabs, kbd) are the
  mockup's CSS classes.
- Views not yet on v2 still render, inside `<div class="v1">`: v1 styles are nested under `.v1`, and the v2 styles sit
  in `@scope (.app) to (.v1)` so neither leaks into the other. Each unit deletes the v1 view and CSS it ports; the
  last one deletes the `.v1` block and the `@scope` wrapper.
- Test IDs changed to the v2 inventory's (`logo`, `more`, `mem-pill`, `theme`, `drawer-*`), so `tests/dashboard-page.mjs`
  (v1 interactions, not in tests/run.sh) is out of date until unit 9 rewrites it.
- Red: `verify-screen.mjs home--working` on the v1 page: `logo: missing`, `tab-1: font "Plus Jakarta Sans" 600 14px`.
- Green (top bar and footer items only: logo, tab-1..4, more, mem-pill, theme, drawer-*, foot-gate, updated):
  home--working, home--working--dark, home--memory-warning (+ dark), home--stalled, empty: PASS.
  switcher--hidden-needs-you fails (tabs 2-4, more x): v2 leaves a needs-you session hidden behind "+4 more", while
  the v1 tab logic always gives it a tab, and its fixture is v1's. Unit 7 (that screen).
- Used in Playwright: tab click, drawer buttons and T/Esc, more (menu), memory pill, theme toggle, loading, offline;
  no page errors.
- Not done: the memory pill's spark is empty because the v1 fixtures carry no samples. Porting the mockup's seeded
  generator (now 14:34, MEM_OK series) to make.mjs moves to unit 2, where the home screen needs it.
- Verifier: two gaps, both fixed and re-checked in Playwright. A footer drawer button did nothing on the memory or
  agent view (it now clears the view, as T/W/L do), and the v1 views had lost `box-sizing: border-box` (menu 488 wide,
  now 470; loading bar 61, now 60).

## v2 unit 2. Home, working

- Fixtures: the mockup's seeded generator is ported verbatim into `make.mjs` (now 14:34; CK main and agent segments,
  gate rounds, 14 commit times, MEM_OK/MEM_HI memory history). Timeline rows carry its segments as feed categories
  (think→model, work→edit, cmd→shell, check→test, you→waitUser, idle→idle). Checked: running the mockup's own lines
  in node gives the same main, lane-b and reviews segments, memory samples and `now` as the fixture.
- Page: `HomeWorking` for a session that is working, thinking or has agents running (other states stay on the v1
  home until unit 3). Status card with rings (Claude working = thinking, reading/editing, commands and checks; waiting
  on you; tasks done, or agents done with no task list), the run graph (running agents from `now`, done ones from
  `units`, oldest first; test ids from the agent's name, e.g. `node-lane-b`), KPI cards (tasks, features, gate rounds
  with the failing worktree, memory with a spark and the ceiling line), activity chart (all lanes, 10-minute bars,
  5 for the last hour or a session under an hour), hover tooltips from `data-tip`.
- Judgment calls: "Room for N more runs" assumes about 2 GB per run (a guess, in `RUN_MB`). "Last hour" draws the
  rings from the main thread's timeline lane over the last hour, since the feed's `windowShare` covers the data window
  (6 h), not one hour.
- Red: `verify-screen.mjs home--working` before: every body item missing (v1 home). Green: home--working and
  home--working--dark ALL PASS.
- Used in Playwright: range tabs (Last hour: 5-minute bars, rings 46m / 9m; Session back to 1h 12m), chart, node and
  gate tooltips, node click opens the drill-down, memory-warning variant (rings 150); no page errors.
- Verifier: 7 gaps, all fixed. Feed (`dashboard.mjs`): an agent's own gate rounds are now events named for the
  agent (the "failing in lane-b" badge was fixture-only), and `now[]` agents carry `start` (a review agent, which has
  no unit, was timed from its current step). Red then green: `bash tests/dashboard.sh`, 2 new tests failing, then
  15 passed. Page: the graph shows as many nodes as fit (running first, newest done, then "+N more"; 43 agents
  overlapped before); "Last hour" also scopes the gate KPI; rings draw in from 0 once (off under reduced motion);
  the session chart starts at the data window (a 30 h session drew 180 bars, now 11) and its labels keep 48 px apart;
  a stalled session with leftover agents isn't shown as working; "Room for N" never goes negative.
- Screen judge: 0 fails, light and dark.

## v2 unit 3. Needs you, finished, stalled

- Fixtures: the mockup's AD, RL and DC seeded segments ported in order (checked equal to the mockup's own lines).
  Admin, release and docs sessions carry rows, share, gate rounds, steps and events for their screens.
- Page: `HomeNeedsYou` (coral card, rings, where to answer with Copy path → "Copied" for 1.5 s, what led here, gate
  and memory KPIs, the hour of work before it stopped), `HomeFinished` (rings, what happened = recent events, steps
  over 2 minutes and answers you gave, four KPI cards with per-10-minute bars, where the time went, longest steps,
  activity), `HomeStalled` (timer, last step, a one-hour heartbeat, last activity, plan, stalled share, memory,
  activity with the hatched stall). Event rows share one `rowOf`; commands and paths read as code.
- Feed: a plan with a heading is named by it ("# Release plan" → "Ask you to approve the release plan"), so an answered
  approval reads "You approved the release plan". Red then green in `tests/dashboard.sh` (15 → 16 passed).
- Rules chosen: "the gate found a failing check" is anchored on the gate's "Claude stopped to ask you" notice (within
  2 minutes), not the question's start; the gate badge reads "N failing in <worktree>" for an agent's failure, "Last
  round failed" for the main thread's; activity uses 5-minute bars under 90 minutes. Rings animate in on the live page
  only: frozen pages (fixtures, replays) draw them at their value, because the kit captures the instant the page shows.
  Checked with document.getAnimations(): live 3, frozen 0, reduced motion 0.
- Checks: verify-screen ALL PASS for home--needs-you and home--stalled (light and dark), and home--working still ALL
  PASS. home--finished (light and dark): every item passes except `kpi-errors-value`.
- Screen judge: needs-you passes; time-bar stall cap fixed (bars now in whole minutes, at least one). Left as they
  are, with reasons: the finished commit and block bars sit in the slot of their real time (13:56, the time the
  mockup's own "What happened" list shows); the mockup's dark stall hatch is light because its light and dark frames
  share one SVG pattern id, so dark borrows the light pattern; the app draws it with dark tokens.
- Contract copy that a real feed can't produce (for the user's sign-off; the mockup and inventories are unchanged):
  1. finished `kpi-errors-value` "a CI wait timed out once": the feed counts tool errors but doesn't describe them;
     the page says "<failed step> failed once" ("check the CI run failed once" in the fixture).
  2. Event clock labels on needs-you (13:02), finished (13:56) and stalled (14:16) were kept from v1's clock (14:37),
     so they sit 3 minutes off the waits shown beside them. The fixture places each at its label.
- Used in Playwright: tab switching into each state, copy path and its reset, time-open opens the time drawer,
  tooltips on the time bar and heartbeat, range tabs on stalled; no page errors.
- Verifier: 4 gaps, all fixed. The plan-name rule only takes a first-line heading of the form "<name> plan"
  (markdown stripped, acronyms keep their case; everything else is "the plan"; red then green, 17 passed); a
  turned-down plan reads "You turned down the release plan" and isn't a tool error; the finished bars keep to 12
  slots, the last 2 hours of a long session (a 49 h session drew 294 invisible bars); longest steps leave out waits on
  you and whole subagent runs.

## v2 unit 4. Memory banner and memory view

- Page: `MemAlert` (the amber banner past warnPct, with what closing the two biggest apps frees) and `Memory` (gauge,
  headroom, swap, pressure, 6-hour chart with warning and ceiling lines, apps, advice, Claude's runs, what proof
  stopped or held back). The run graph now fits nodes at 4 px gaps (5 in the banner's 168 px, as drawn).
- Rules chosen: the stop list is ordered by memory needed, largest first (the mockup's list isn't "newest first", and
  its order only holds that way); swap counts as swapping from 512 MB.
- Checks: verify-screen ALL PASS for home--memory-warning (light and dark), home--working still ALL PASS; memory
  (light and dark) passes every item except `meta`.
- Contract copy for sign-off: 3. memory `meta` "Real memory · sample history and runs" describes where the fixture's
  numbers came from, which the feed can't know. The page says "Measured on this Mac · history every 2 minutes", or
  "Sample figures · old logs carry no memory readings" for a replay's example machine.
- Used in Playwright: banner → memory view (banner hides), chart tooltip, back, Esc; no page errors.
- Not run for this unit: the verifier and the screen judge (skipped to save time, at the user's request).

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
