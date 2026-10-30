# Changelog

## 0.5.0 (2026-10-30)

- **Test runs fit the memory there is.** When a test suite doesn't fit under the memory ceiling, proof runs it with fewer workers instead of refusing it: the same tests, in smaller batches, slower but never skipped. This works for Jest, Vitest, Playwright, `node --test`, `go test` and Gradle, called directly or through a `package.json` script, both for Claude's own runs and for the gate's checks. A run is refused only when not even one worker fits.
- **Less defensive memory estimates.** A run of one file is no longer costed as the whole suite, and a command proof hasn't seen yet no longer inherits the worst run ever recorded in the repo. On macOS, runs are measured the way Activity Monitor counts memory, not with shared memory counted once per process (which overcounted 8 workers by 57%). Only the last 6 runs count, so one unusual run fades. A new agent is costed at 400 MB (was 1.2 GB).
- **Runs started together don't double-book memory.** A run that was just admitted holds its room until it has started up.
- **No more "please review proof.json".** Setting up and adding checks is Claude's job; it tells you in one line what now checks your work. Only weakening a check stops for your OK: removing it, changing its command, narrowing when it runs, deleting `proof.json`, or touching `.claude/settings.json` or the fidelity kit.
- **Replies that changed nothing skip the checks**, and say what is still failing.
- **Test tools guide.** The build skill sets up the lightest test runner for the stack when a project has none, and knows which tools built for agents to suggest (`playwright-cli`, agent-browser, Maestro, mobile MCP servers and more). Playwright installs fetch only the headless shell (`--only-shell`), about 165 MB less disk.

## 0.4.1 (2026-10-21)

- **Higher memory ceiling.** The default ceiling is now 90% (was 85%), so heavy runs and new agents are held back less often. The warning stays at 75%. To set your own, put `{ "memoryCeilingPercent": 85 }` in `~/.config/proof/machine.json`.

## 0.4.0 (2026-10-15)

First public release.

- **Memory budget.** The machine stays under a memory ceiling (85% by default, warning at 75%). Heavy runs and new agents wait for room, then are refused with what's using memory and what closing your apps would free. If the machine reaches the ceiling anyway, the newest run Claude started is stopped first. proof never closes your apps.
- **Keep awake.** On macOS, no idle sleep while any session or agent is working.
- **Wait limits.** End-to-end runs are guarded like other test runs, and wait loops stop after 5 minutes with a note to check the run they wait on.
- **Quick mode** (`/proof:quick`) for small fixes, with a tripwire back to the full process when the change grows or touches sensitive code.
- **Live dashboard** (`/proof:watch`) of every session, agent and worktree, with memory. Its data feed is specified in [`docs/dashboard-spec.md`](plugins/proof/docs/dashboard-spec.md).
- **Build skill.** Guidance for long builds and parallel agents: one agent per worktree, isolated state per lane, an orchestrator that never blocks, and failing-first runs that stop at the first failure.

## Earlier versions (private)

- **0.3:** the guard. Time and memory limits for the gate's checks and for the test runs and builds Claude starts, enforced by a detached watcher.
- **0.2:** the two-tier gate. Fast checks after each reply, the full suite before each commit, checks in parallel, and passes cached against the exact code.
- **0.1:** session rules, the discover, design and build skills, the verifier and screen-judge agents, the fidelity kit, and the first completion gate.
