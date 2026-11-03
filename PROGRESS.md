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
| 5 | Agent drill-down | job (+ dark) | done |
| 6 | Drawers as a bottom sheet: timeline, time, log | 3 × 2 | done (2 copy items for sign-off) |
| 7 | Switcher (command palette), hidden needs-you | 3 × 2 | done (1 contract item for sign-off) |
| 8 | Loading, offline, empty | 3 × 2 | done |
| 9 | Interactions | every entry in mockup/interactions.json | done |

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

## v2 unit 5. Agent drill-down

- Page: `Job` for an agent or the main thread: current step against the 10-minute limit, commits, errors (with gate
  failures named), worktree, start, steps (consecutive calls of one kind, the last 12), every tool call with Show N
  earlier (+40), the brief and result. The running call is the agent's current step, so it's timed from the step's
  start (`now[].since`).
- Fixture: lane B's calls spaced so its steps are the mockup's (reading 1m, editing 5m); the running e2e call sits at
  its 14:31 label (the mockup's v1 clock again; its time comes from the step).
- Checks: verify-screen ALL PASS for job and job--dark; home--working still ALL PASS. Playwright: show earlier (6 → 40
  rows), main-thread drill-down ("Waiting on 3 agents"), a finished agent, a review agent with no unit; no errors.
- Not run for this unit: the verifier and the screen judge (skipped to save time).

## v2 unit 6. Drawers as a bottom sheet

- Page: `Sheet` over the session's home (scrim, grab bar, T/W/L tabs, Close; scrim click, Esc or the current tab
  closes it). Timeline: one lane per worktree from `rows` (blocks by activity, commits on the main lane, gate
  failures on the failing agent's lane, a now line, 1h/2h/6h/24h window), lane cards (busy, commits, state), and the
  pinned tooltip for `?pin=wf-tip`. Where the time went: on the clock, work done in parallel, biggest drag, the split
  (session or last 6 h), working time by kind with the e2e breakdown, what slowed it down. Log: events (plus running
  calls), gate, commits, problems, every tool call; 10 rows, then 40 more per click.
- Fixture: the checkout session's commits after 14:12 are the five the mockup's log draws (sha, message, who); the
  generator's 14:29 commit and 14:22 gate pass, which that log doesn't show, sit earlier. Still 14 commits and 8 rounds.
- Checks: verify-screen ALL PASS for drawer--time (light and dark); drawer--timeline and drawer--log pass every item
  except the copy below. Playwright: every log tab, show earlier, sheet tab switching, block tooltip, window range,
  last-6h split, close by tab, scrim and Esc, a needs-you session's log; no page errors.
- Contract copy for sign-off: 4. timeline `lane-reviews-state` "verifier reading cart.tsx" shortens the agent's step
  label ("Reading cart.tsx and its acceptance criteria"); the page shows the label (the card ellipsizes it).
  5. log `log-count` "Showing 10 of 21" and `log-more` "Show 11 earlier": with the mockup's own 14 commits and 8 gate
  rounds the events tab holds 26, so the page says "of 26" and "Show 16 earlier".
- Not run for this unit: the verifier and the screen judge.

## v2 unit 7. Switcher and hidden needs-you

- Page: `Palette` (Ctrl/Cmd+K or "+N more"): needs-you first, then projects (a project with a session that needs you
  first, then feed order) with their session counts; when-labels (open now, asked 49h ago, thinking, working, no
  activity for 18m, finished 41m ago); search over titles and projects with the match marked; arrows, Enter, Esc
  (clears the query, then closes); scrim click closes. Tabs no longer pin a session that needs you: tabs are the first
  four in feed order plus the selected one, and a hidden needs-you shows on "+4 more · 1 needs you".
- Fixture: switcher--hidden-needs-you puts the needs-you session fifth (tabs: checkout, dashboard, release, docs).
- Checks: verify-screen ALL PASS for switcher--menu-search and switcher--hidden-needs-you (light and dark); home
  screens still pass. Playwright: open with focus, filter, arrows + Enter (the session takes the last tab slot), no
  match, Esc twice, the hidden needs-you first in the menu; no page errors.
- Contract item for sign-off: 6. switcher--menu lists 9 sessions (with "API docs refresh" in shop-app) while the same
  frame's top bar says "+4 more" (8 sessions). The fixture keeps 8, so the menu has no "API docs refresh" row and
  items 5–9 shift.
- Not run for this unit: the verifier and the screen judge.

## v2 unit 8. Loading, offline, empty

- Page: `Loading2` (top bar without tabs, skeletons, "Reading session logs…"), `OfflineAlert` over the dimmed last
  update (grey "Last update 14:34" badge, "Last update 3m ago" in the footer, Copy /proof:watch), `Empty2` (6 h / 24 h).
- Checks: verify-screen ALL PASS for loading, offline and empty (light and dark).

## v2 unit 9. Interactions and clean-up

- Every view is on v2, so the v1 views, the v1 styles scoped to `.v1` and their helpers are gone; the v2 styles sit in
  `@scope (.app)`. The replay banner is a grey alert.
- `node tests/dashboard-page.mjs` rewritten for v2 (still outside tests/run.sh, which has no browser): tabs and 1–4,
  the palette (Ctrl+K focus, filter, arrows + Enter, Esc, hidden needs-you), range tabs, tooltips, the sheet (W, T,
  block tooltip, log filters, close by tab, Esc and scrim), drill-down (show earlier, Backspace, main thread, back),
  memory pill, copy path, Open in full, theme toggle remembered, live polling every 2 s, ticking timers, rings drawing
  in live, Not live on a failed poll and recovery, reduced motion. 35 passed.
- Found by it and fixed: a copy button threw an unhandled rejection when the clipboard was denied.
- Not verified: motion timings against interactions.json beyond reduced motion and the ring animation; Linux and
  other browsers.

## State at the end of the v2 build (2026-11-03)

- All 32 frames checked with verify-screen: 20 ALL PASS. The other 12 are the six contract-copy items below, each in
  light and dark; every other item in them passes.
- Contract items for sign-off (mockup and inventories unchanged; each needs the user's OK to re-extract or re-tag):
  1. finished `kpi-errors-value` "a CI wait timed out once" (the feed doesn't describe tool errors).
  2. event clock labels on needs-you, finished, stalled kept from v1's clock (3 minutes off their waits).
  3. memory `meta` "Real memory · sample history and runs" (describes the fixture, not the feed).
  4. timeline `lane-reviews-state` "verifier reading cart.tsx" (a shortened step label).
  5. log "Showing 10 of 21" / "Show 11 earlier" (the mockup's own commits and gate rounds make 26).
  6. switcher--menu lists 9 sessions while its top bar says "+4 more" (8).
- Verifier and screen judge ran for units 1–3; units 4–9 were checked with verify-screen and Playwright only.

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

# proof for every coding agent: progress

Spec: `SPEC.md`, units in `features.json`. Branch `multi-agent`.

## F20–F22. Ledger of gate runs, turn receipt, backfill (done)

- `scripts/ledger.mjs`: every gate run that ran or reused a check appends one line to `~/.config/proof/ledger.jsonl`
  (or `PROOF_LEDGER`); no check output. `tally()` counts catches (fail, then pass on different code, same session and
  repo), flaky (fail, then pass on the same code), blocked commits, handed back, time in the gate. A failure the user was
  shown (gave up / asked) or reverted to the committed code (a `clean` line) is never counted as caught later; checks
  stopped for low machine memory are skipped.
- `gate.mjs`: logs each run; after a turn that caught something, the passing message adds a receipt
  ("caught 1 failure this turn before you saw it (unit) · this session: …"). Clean turns keep today's message.
- `scripts/recap.mjs`: totals for 7 days, `--since`, `--session`, `--json`, `--backfill`.
- `scripts/backfill.mjs`: reads past gate runs from Claude's session logs once (session start, in the background, with
  a lock that a dead run's successor takes over), de-duplicated across resumed/forked session files by record uuid.
  Transcripts have no fingerprint, so a file edit (or subagent call) between failure and pass stands in for it.
- Red runs: `tests/ledger.sh` "ledger file created under ~/.config/proof" failed before ledger.mjs existed; each
  verifier finding got a failing case first (asked-user, revert, odd lines, resumed copies, space in path, stale lock).
- Checks: `bash tests/ledger.sh` 45 passed (3 runs); `bash tests/run.sh` all passed. Two verifier passes; all findings fixed.
- Measured on this machine (scratch ledger): 929 gate runs from 64 sessions in 3.8 s; 16 caught, 11 commits blocked,
  51 handed back, 24 flaky, 4h 5m in checks.
- Not verified: the receipt as Claude Code renders it in a live session (only the hook's JSON output is tested).
- Not done: weekly recap view on the dashboard (needs a mockup; the dashboard design is locked).
- Next: F1, the normalised hook event and the Claude adapter.

## F1. Normalised hook event and the Claude adapter (done)

- `scripts/agents/index.mjs` (`hookInput(kind)` → `{ ev, reply }`; agent from `--agent`, `PROOF_AGENT`, else Claude;
  an unknown name falls back to Claude with a note) and `scripts/agents/claude.mjs` (parse + render). The event and
  result are documented in `plugins/proof/docs/agents.md`.
- gate, wrap, admit and session-start read through `hookInput` and answer with `reply()`; hooks.json is unchanged.
- Red: `tests/agents.sh` "gate.mjs reads its input through hookInput, not readStdin" (×4) and "the event is
  documented" failed before the change; "an unknown PROOF_AGENT falls back to Claude" failed (exit 1) before the fix.
- Checks: `bash tests/agents.sh` 8 passed; `bash tests/run.sh` all passed, no existing test edited. Verifier: PASS,
  every output path matches HEAD byte for byte.

## F2. Spike (opencode done, Gemini waiting)

- opencode 1.18.18: system prompt, command rewrite and continue-after-idle all work live (continue only when opencode
  runs as a server, as the TUI does; not under one-shot `opencode run`). Details in SPEC.md's decision log.
- Gemini CLI 0.36.0: not signed in here; needs the user to log in, or it gets built from docs.

## F3–F9, F12, F14–F19. Every agent: adapters, installer, event log, dashboard data (done, not committed)

- Round counting (F3): the gate remembers it sent the agent back (`sentBack`) when the agent doesn't say, and
  `gate.mjs --prompt` (each agent's prompt hook) resets it; a prompt that is proof's own follow-up (Cursor) or the
  same one reported again (Antigravity) is skipped. Red: `tests/rounds.sh` case 1 sent turn end 2 as round 1.
- Adapters (`scripts/agents/`): opencode (plugin file), gemini, codex, cursor, grok, antigravity, each with its
  `caps`, `fixtureCaps`, `words` and `install()`; 46 new fixtures, each citing the docs page read 2026-11-03 (research
  notes in the session scratchpad). Shared bits in `agents/shared.mjs`; rules and skill wording in `agents/words.mjs`
  (rules.md now has placeholders; Claude's render is byte-identical to the old file, `tests/fixtures/rules-claude.md`).
- Installer (`scripts/install.mjs`): merges into existing configs, records a manifest in `<data>/installs/`, uninstall
  restores byte for byte; skills shared through `.agents/skills` stay while any agent uses them. Red: the shared-skills
  case left empty folders behind until ownership was handed over.
- Event log (`agents/events.mjs`) and `EventSession` in timeline.mjs; the monitor reads `<data>/events/*/*.jsonl`;
  views carry `agent` and `agentLabel`. Gate messages name the agent ("sent back to Cursor").
- Live: opencode 1.18.18, all six SPEC steps (features.json F12). It showed blocked commits had no tool-start event
  (the plugin ran the commit gate before wrap.mjs); fixed and re-run live: all six steps pass again, and the blocked
  commit is now a step in the log.
- Verifier: FAIL with 9 findings, all fixed with a test each (written after the fix, not red first): Cursor gated
  aborted turns; Cursor had no loop backstop (loop_limit now 20); labels hardcoded in timeline.mjs; browser memory
  note unwired for other agents; the printed undo command did nothing (install records now in ~/.config/proof/installs);
  Grok lost the update notice; a killed gate wasn't shown as timed out; the quick-mode message named proof:build;
  F14/F15 criteria contradicted the build. opencode subagent sessions are no longer gated (the follow-up would land
  in the subagent). F17's "only its own files" criterion is recorded as not met.
- Checks after the fixes: tests/agents.sh 128, tests/dashboard.sh 20, tests/rounds.sh 20 passed.
- Checks: `bash tests/agents.sh` 120 passed, `bash tests/rounds.sh` 20 passed, `bash tests/dashboard.sh` 19 passed.
- Not verified: Gemini CLI, Codex, Cursor, Grok Build and Antigravity live (built from docs, labelled so).
- Spec changes (decision log): Codex via `.codex/hooks.json` rather than a plugin; the rewrite is guard + worker limit
  (no fail-fast flag, same as Claude); Grok's rules in a rules file.
- Next: F10 (agent label + recap card mockup on the v2 dashboard) awaits the user's approval; F11 builds it after
  this branch merges `main` (v2 dashboard, 0.7.0).

## F11. Agent badge and recap card on the dashboard

- Design approved 2026-11-03 (decision log): `mockup/app.html` and `mockup/interactions.json` replaced with the approved
  versions. 24 inventories re-extracted (12 screens × light/dark: home--working, home--memory-warning, home--needs-you,
  home--finished, home--stalled, switcher--menu, switcher--menu-search, switcher--hidden-needs-you, drawer--timeline,
  drawer--time, drawer--log, offline), routes kept. Re-extracting the old mockup first gave byte-identical inventories,
  so nothing in them was hand-edited and no item was dropped; the new ones only add items or change copy/positions.
  empty, job, loading and memory are unchanged. The `contract` tag is not moved (nothing committed), so
  `fidelity/verify-screen.sh` stops at its contract check; the screens were checked with `fidelity/verify-screen.mjs`.
- Data: `board()` adds `recap` (all time with catches per week for 12 weeks; 7 calendar days with catches per day;
  `reading: {done, total}` while the first backfill runs) and `sessions[].recap` (this session), from the ledger's
  `tally()`. Cached: the ledger is read and tallied at most every 30 s (about 10 ms on this Mac's 400 KB ledger).
  `backfill.mjs` writes `backfill.progress.json` (transcript files read of total); "reading" means no marker and a lock
  under 10 minutes old, so a disabled or dead backfill never leaves the card spinning.
- Page: neutral agent badge after the title on every session home and in switcher rows (`data-agent`, agent column);
  "Claude working / asked you / stopped to ask you / isn't waiting on you" read the session's `agentLabel`. Home while
  working: activity (legend below) beside "What proof caught" (range tabs, default all time, remembered per browser;
  This session shows the gate tracker; grey 0 when nothing was caught; tight under the memory banner; reading state).
- Fixtures: `make.mjs` gives each sample session its agent (opencode, Gemini CLI, Codex, Cursor, Grok Build,
  Antigravity, Claude) and the mockup's recap numbers; new `recap--reading` and `recap--none` feeds for the page test.
- Checks: verify-screen.mjs ALL PASS for 20 of the 24 changed frames; the other 4 screens (8 frames: drawer--log,
  drawer--timeline, home--finished, switcher--menu, light and dark) fail only on the pre-existing contract-copy items 1,
  4, 5 and 6 above, exactly as before the change (baseline run with the old inventories). Every new item (agent-badge,
  recap-*, switcher rows 1–4 with badges) passes there too. `node tests/dashboard-page.mjs` 50 passed (15 new: badge,
  agent copy, switcher agent, recap ranges, tooltips, remembered range, reading, nothing caught, tight).
  `bash tests/dashboard.sh` 35 passed (11 new recap cases on a known ledger via PROOF_LEDGER: all time, 7 days,
  this session, weekly and daily bars, 30 s cache, reading/dead lock/done). `bash tests/ledger.sh` 46 passed (1 new:
  backfill progress file). `bash tests/agents.sh` 128 passed. The new tests were written after the code, not red first.
- Screen judge (3 runs, 15 frames): every new element matches (agent badge, agent column in the switcher, agent copy,
  recap card and its tight variant). Its 6 findings all predate this change and sit in parts it didn't touch (the
  fixtures only gained fields): the dark stall hatch (the mockup's shared SVG pattern id, unit 3 above) on
  home--working, home--memory-warning and home--stalled dark; home--finished commit/block cells in slot 3 not 6;
  drawer--timeline commit dots (the 14:29 commit placed at 14:06, see make.mjs).
- Real data: a replay of this project's logs (`dashboard.mjs --logs … --json`) renders with this Mac's ledger
  (18 caught, 66 sessions), no page errors.
- Not verified / open: the recap--states spec frame has no inventory (it is a spec sheet of five cards, not an app
  screen); its states are covered by the page test. With both the replay banner and the memory banner (replay pages
  only), the card's last row is cut off. "0 failures caught. No gate runs yet" (a range with no gate runs at all) is
  copy the mockup doesn't have; needs the user's OK. Not checked in a live monitor session.
