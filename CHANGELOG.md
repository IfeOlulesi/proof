# Changelog

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
