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
