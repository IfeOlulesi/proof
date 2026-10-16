# proof dashboard: feature spec

What the dashboard is for, the information it gets, and what's planned. The page shipped in 0.4 (`scripts/dashboard.html`) is a working first version; a redesign only has to read the data feed described here.

## Job

Answer at a glance, for every Claude Code session on this machine:
1. What is Claude doing right now, in each session and agent, and for how long? Is anything stuck?
2. How far along is the work, and what's left?
3. Where did the time go, and what's slowing it down?
4. Is memory safe, and what is using it?

It runs at `http://127.0.0.1:47331/`; the port comes from `~/.config/proof/machine.json`, `dashboardPort`. `/proof:watch` opens it. It also opens on its own, once, when a build has been running for 45 minutes and nobody is watching.

## Where the information comes from

| Source | What it gives | Read by |
|---|---|---|
| Claude Code session logs, `~/.claude/projects/<project>/<session>.jsonl` | prompts, model calls, every tool call with Claude's description, results and errors, hook output (gate results), compactions, task notifications, "while you were away" summaries | `timeline.mjs` |
| Subagent logs, `<session>/subagents/agent-<id>.jsonl` and `.meta.json` | each agent's own activity; its type, description, the tool call that launched it, depth | `timeline.mjs` |
| Task list, `~/.claude/tasks/<session>/<id>.json` | Claude's plan: subject, status, active form | `monitor.mjs` |
| Gate live file, `<data>/live/gate-<session>.json` | the checks the gate is running right now, during a Stop or commit hook (hooks write nothing to the log until they finish) | `monitor.mjs` |
| Memory readings: `vm_stat`, `sysctl` (macOS), `/proc/meminfo` (Linux), every 2 s | used / total / %, warn and ceiling, headroom, pressure, swap | `mem.mjs` |
| Process table: `ps`, `lsof` | memory by app; Claude's sessions and the processes they started; worktree of each | `mem.mjs` |
| Guard registry, `<data>/runs/` | guarded runs in flight (tests, e2e, builds, wait loops) | `mem.mjs` |
| Memory events, `<data>/memory-events.jsonl` | runs proof stopped at the ceiling | `mem.mjs` |
| `features.json` in the session's folder | items passing / total | `monitor.mjs` |

`<data>` is the plugin's data folder (`CLAUDE_PLUGIN_DATA`).

## The data feed

`GET /data.json?hours=6`. The window is between 0.25 and 24 hours. The page polls it every 2 seconds. Times are epoch milliseconds; sizes are MB.

```
{
  version, now, windowMs, live: true, replay: null | { at, source },
  categories: { <key>: <label> },
  machine: Machine,
  sessions: [SessionView]          // busy sessions first, then most recently active
}
```

### Machine

| Field | Meaning |
|---|---|
| `system` | `{ platform, totalMB, usedMB, pct, warnPct, ceilingPct, headroomMB, pressure, swapMB }`. On macOS, used = app memory + wired + compressed, as Activity Monitor counts it. |
| `samples` | `[[t, pct], …]`: up to 600 points over the window |
| `apps` | `[{ name, mb, n, claude }]`: top 8 apps by memory; `claude` marks Claude Code and anything it started |
| `runs` | `[{ pgid, pid, mb, start, command, session, cwd }]`: process groups Claude started through its shell, newest first. These are the ones it may stop. |
| `advice` | `{ text, userApps: [{ name, mb }] }`: what to close and what it would free, framed as speed |
| `keepAwake` | `{ on, enabled }` on macOS: whether proof is holding the no-idle-sleep assertion now |
| `asleep` | `[[from, to], …]`: measured windows when the Mac slept |

### SessionView

| Field | Meaning |
|---|---|
| `id, title, cwd, project, branch, model` | identity; `title` is Claude Code's title for the session |
| `start, last, from, to` | session start, last activity (agents included), window shown |
| `status` | `{ state, since, cat, label, parallel, agents }`. `state` is one of: `working`, `thinking`, `agents` (main thread waiting for background agents), `approval`, `waiting` (on you), `needsInput`, `stalled`. While the gate runs it shows `working` with `cat: 'gate'`. |
| `now` | `[{ who, type, where, state, since, cat, label }]`: the main thread first, then every agent mid-work; `where` is its worktree |
| `rows` | `[{ key, label, sub, agents, lane: [[from, to, cat], …] }]`: timeline rows (main thread, one per worktree, reviews), each drawn by category |
| `asleep` | sleep windows inside this session |
| `share` | `{ <cat>: ms }`: whole session; parallel work splits a moment's time, and waiting on you counts only when nothing else runs |
| `windowShare` | the same, for the window only |
| `busyMs`, `parallel` | time anything was running; average number of things running at once |
| `tasks` | `[{ id, subject, status, active }]`: Claude's task list |
| `units` | `[{ desc, type, where, start, end, running, commits, errors }]`: agents as work items (used when there's no task list) |
| `unitsDone` | how many agents have finished |
| `features` | `{ passing, total }` from features.json, or null |
| `commits` | `[{ t, sha, msg, who }]`: up to 40, main thread and agents |
| `events` | `[{ t, kind, text, who }]`: `kind` is one of `commit`, `gatePass`, `gateFail`, `commitBlocked`, `guard`, `memory`, `compact`, `needsInput`, `gaveUp`, `interrupt`, `agentDone`, `error` |
| `feed` | `[{ t, end, cat, desc, ok, who, bg }]`: up to 120 newest tool calls. `end: null` means it's running; `bg` means it was started in the background. |
| `prompts` | last 6 things you typed |
| `away` | Claude Code's latest "while you were away" summary |
| `agents` | `{ total, active, byType }` |
| `counts` | `toolCalls, edits, testRuns, gateRounds, commitBlocks, guardStops, memoryStops, compactions, apiErrors, interrupts, approvals, toolErrors, agentsLaunched` |
| `stuck` | calls running longer than 5 minutes |
| `findings` | `{ asleepMs, asleepN, waitMs, ceilingN, ceilingMs, pollN, pollMs, e2eN, e2eMs, topSpec, longest }`: the patterns that cost the most in past builds (sleep, waits on you, commands that hit the 10-minute limit, polling loops, end-to-end runs) |

Categories (`cat`) and their meaning:

| Key | Meaning |
|---|---|
| `model` | Claude thinking and writing |
| `edit` / `read` / `plan` / `web` | editing code / reading and searching / the task list / web lookups |
| `test` / `typecheck` | unit and end-to-end tests / type checks and lint |
| `gate` | proof's completion and commit checks |
| `fidelity` | screens and browser |
| `build` / `devserver` | builds and installs / dev servers and simulators |
| `git` / `shell` / `hooks` | git / other commands / other hooks |
| `subagent` | waiting on an agent whose own log is missing |
| `api` | API errors and retries |
| `compact` | compacting context |
| `waitUser` | waiting on you (questions, approvals, end of turn) |
| `asleep` | the Mac asleep with work in flight |
| `idle` | unexplained gaps |

## Panels in 0.4

| Panel | Uses |
|---|---|
| Top bar | `now`, session count, `machine.keepAwake`, memory bar (`system.pct`, warn/ceiling ticks), window switch |
| Session hero | `title`, `project`, `branch`, `start`, `status`, KPIs (`tasks` done, `commits`, `agents.total`, `counts.gateRounds`, `stuck`), progress bar |
| Right now | `now`. Timers tick between refreshes, turn amber at 5 min and red at 10, with a bar against the 10-minute limit |
| Timeline | `rows`, `asleep` (hatched), `from`/`to`, hover for category and duration |
| Recent activity | `feed` (15, then "show more") |
| Plan / Work items | `tasks`, else `units` |
| Where the time went | `share` grouped into 10 colours, `parallel`, `findings` |
| Memory | `machine.system`, `samples` (with warn and ceiling lines), `apps`, `advice` |
| Events | `events` (gate passes omitted) |

## Planned

1. **Playwright, step by step.** Make an e2e run visible while it runs:
   - Add a proof reporter for Playwright (`scripts/pw-reporter.mjs`). It appends test and step events (`onTestBegin`, `onStepBegin`, `onStepEnd`, `onTestEnd`) to `<data>/live/pw-<pid>.jsonl`. The wrap hook adds it to guarded e2e runs with `--reporter=list,<path>`, which keeps the list output Claude reads.
   - In the feed, `now[].steps` holds `{ test, step, since, status }`. The "Right now" row shows it as e.g. "S1 › click 'Save' › expect URL".
   - Link the trace for each test. Keep traces with `trace: 'on'` while proof watches; the monitor serves the files so the trace viewer can open them.
   - Optional screenshot or video thumbnail per failed step.
2. **Agent drill-down.** Open an agent to see its full activity, the prompt it was given (its description), its result, errors and commits.
3. **Gate history.** Each Stop and commit gate run, with per-check duration, whether the run was fast, full or cached, and failures over time. This needs `gate.mjs` to append a record per run.
4. **Units from the project.** Items from `features.json` and `PROGRESS.md`, with the evidence command for each passing item.
5. **Notifications.** A macOS notification when a session needs your input, the guard stops a run, memory reaches the warning line, or a build finishes.
6. **Estimate to finish.** Units done per hour, labelled as an estimate.
7. **Tokens and cost per session** from the usage recorded in the logs.
8. **All sessions on one screen.** A compact strip per session above the detail view.
9. **Controls.** Stop a run, open a trace, open the worktree in the editor. Each action needs the monitor's token, so a web page can't trigger it.
