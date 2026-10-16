---
name: watch
description: Open the live proof dashboard in the browser — what every Claude Code session and agent is doing right now, a timeline per worktree, progress, where the time went, and memory. Use when the user asks to see progress, what Claude is doing, or the dashboard, and at the start of work expected to take more than an hour.
---

# Watch: the live dashboard

!`PROOF_DATA_DIR="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/monitor.mjs" --open`

The line above starts proof's monitor if it isn't running and opens the dashboard in the browser. If it shows the command itself rather than a URL, run it once.

Tell the user in one line that it's open, and where: http://127.0.0.1:47331/, or the port set in `~/.config/proof/machine.json`.

What it shows, refreshed every 2 seconds:
- what each session and agent is doing right now, with how long it has been at it
- a timeline per worktree
- the plan, from your task list
- commits, gate results and guard stops
- where the time went
- memory, including the user's apps holding the most of it

So it stays useful during long work:
- Keep your task list current: one item per unit, marked in progress and completed as you go. The dashboard shows it as the plan; without it, the agents you launched stand in.
- Give agents short, specific descriptions ("Lane B unit 13: profile screen"). They are the labels the user sees.
