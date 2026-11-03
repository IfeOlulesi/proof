# proof for every coding agent

## Goal
proof today only works inside Claude Code. People who build with other coding agents (opencode, Gemini CLI, Codex,
Cursor, xAI's Grok Build, Google Antigravity) get none of it: no rules at session start, no gate that keeps the agent
working until the checks pass, no commit gate, no memory limits on test runs or new agents, no skills, no verifier,
no live dashboard. When this works, a user installs proof into any of those agents with one command, and the agent
behaves the way Claude does under proof: it can't say "done" or commit while a check fails, its test runs fit the
machine's memory, it uses proof's skills, and its sessions show up on the same live dashboard as Claude's, labelled
with the agent's name.

## Non-goals
- No new checks or gate behaviour. Every agent gets the same gate, rules and memory limits Claude has today, nothing more.
- No parsing of other agents' own transcript files. Their formats are undocumented or documented as unstable (Codex),
  so the dashboard reads a log proof writes itself from hooks.
- Claude Code's dashboard data stays as it is (read from its transcripts), and Claude doesn't write the event log.
- No support for agents without a hook system. They can still use proof's skills as plain instructions, but that is
  documented, not built.
- No auto-update for non-Claude installs in v1. They get the update notice proof already shows; updating is
  `git pull` in the proof checkout, then re-running the installer.
- No Windows-specific work beyond what proof already does.

## Users
- Primary: a developer who builds with one or more coding agents other than Claude Code, often several at once in
  parallel worktrees, and wants the same discipline and the same single dashboard across all of them.
- Secondary: the proof maintainer, who must be able to add the next agent by writing one adapter module and its
  fixtures, without touching the core scripts.

## Core flows
1. Get proof: `git clone https://github.com/IfeOlulesi/proof ~/.proof` (or any folder). No Claude Code needed.
2. Install: user runs `node ~/.proof/plugins/proof/scripts/install.mjs <agent>` in a project (or `--global`) →
   proof writes that agent's hook config or plugin file, its skills and its verifier/screen-judge subagents (where
   the agent has subagents), prints what it wrote, which of proof's behaviours this agent gets (from the capability
   table), and how to undo it → the next session in that agent starts with proof's rules.
3. Gate: the agent finishes a turn after changing files → the adapter runs proof's gate → if a check fails, the
   agent is told what failed and keeps working, up to proof's `maxRounds` → when checks pass, or the rounds run
   out and the agent is told to ask the user, the turn ends.
4. Commit: the agent runs `git commit` → the adapter runs the full gate → a failing check denies the command with
   the reason.
5. Memory: the agent runs a test command → the adapter rewrites it with the worker limit and fail-fast flag, as
   `wrap.mjs` does for Claude. The agent starts a subagent or a browser → the adapter adds proof's memory note, as
   `admit.mjs` does.
6. Dashboard: any agent's session works → its hooks append events to proof's event log in the shared data
   folder → the user opens the dashboard from the agent (proof's watch skill) or by hand
   (`node ~/.proof/plugins/proof/scripts/monitor.mjs --open`) → it lists the session next to Claude sessions,
   with the agent's name, its steps, its gate runs and its time breakdown.
7. Uninstall: user runs `install.mjs <agent> --uninstall` → only what proof wrote is removed, everything else in
   those files is untouched.

## Acceptance criteria

**Core (agent-neutral)**
- [ ] One normalised hook event is defined and documented in `plugins/proof/docs/agents.md`: event kind (session
  start, user prompt, before tool, after tool, turn end), session id, turn id, a continuation flag (is this turn
  end a fix round proof asked for), round number where the agent reports one, cwd, tool name (normalised to
  shell / edit / subagent / browser / other) and tool input. verify: `tests/agents.sh` validates every adapter's
  translated fixtures against the documented shape.
- [ ] `session-start`, `gate`, `wrap` and `admit` read the normalised event and write a normalised result; one
  adapter module per agent translates that agent's stdin and stdout (or plugin calls) to and from it. verify:
  `tests/agents.sh` runs each adapter against fixtures and compares the translated output with the expected output.
- [ ] proof counts gate rounds itself for every agent, from the normalised turn id and continuation flag, and is the
  only round limit that decides: after `maxRounds` failing rounds the turn ends with the "ask the user" message.
  Where the agent has its own loop cap (Cursor's `loop_limit`), the installer sets it above `maxRounds`.
  verify: `tests/agents.sh` drives `maxRounds + 1` failing turn ends through each adapter and checks rounds
  1..maxRounds continue and the next one stops; a fresh user prompt resets the count.
- [ ] Claude Code behaves exactly as before: same hook outputs for the same inputs. verify: `bash tests/run.sh`
  passes with no existing test edited.
- [ ] Adding an agent needs one adapter module, its fixtures, its capability-table row and one entry in the
  installer's agent list; the agent config files it generates (`hooks.json`, a plugin manifest, a plugin JS file)
  are produced by that module. No core script changes. verify: on the last adapter unit, `git diff --stat` for that
  unit shows only those files, checked by proof:verifier.
- [ ] Every fixture records its source (docs URL and date, or "captured live from <agent> <version>"). verify:
  `tests/agents.sh` fails on any fixture, live or from docs, without a `source` field.
- [ ] Hook timeouts: the installer sets each agent's hook timeout to proof's (15 s session start, 240 s wrap/admit,
  900 s gate) where the agent allows it, and the capability table records the cap where it doesn't. A killed commit
  gate fails closed where the agent supports it (Cursor `failClosed`); a killed stop gate lets the turn end and the
  dashboard shows the gate as timed out. verify: `tests/agents.sh` checks each generated config's timeout fields
  and fail-closed flag.

**Capability table**
- [ ] `plugins/proof/docs/agents.md` holds one table: agent × rules at start / gate at turn end / commit deny /
  test-command rewrite / subagent and browser note / each event kind / skills / subagents (verifier, screen-judge)
  / tested live or built from docs. Each cell is "yes (hook name)", "no" or "unknown". verify: `tests/agents.sh`
  checks the table has a row per agent in the installer's list and every cell is one of those three forms, and that
  each "yes" has a fixture exercising that hook.

**Rules, skills and subagents**
- [ ] The rules text names no Claude-only tool. Where a rule depends on a tool (`TaskOutput`, the verifier agent,
  skills), each agent gets its own wording, or the rule is left out where the agent has no such tool. verify:
  `tests/agents.sh` renders the rules for every agent and fails on any Claude-only name in a non-Claude render.
- [ ] proof's skills are rendered for each agent and installed where it looks for them (as AGENTS.md or rules text
  where it has no skills): paths resolved to the install folder, no `${CLAUDE_*}` variables, no `` !`…` `` command
  injection (replaced by a step telling the agent to run the command), no `TaskOutput` or `claude -p`. Quick mode
  gets its session id from the normalised event, not `${CLAUDE_SESSION_ID}`. verify: `tests/agents.sh` installs
  for each agent into a scratch folder and fails if any installed skill file contains `CLAUDE_`, `` !` ``,
  `TaskOutput` or `claude -p`; a test turns quick mode on through one non-Claude adapter and checks the gate sees it.
- [ ] The verifier and screen-judge are installed as subagents for agents that have them, and as skills the agent
  runs in its own context where they don't (marked so in the capability table). verify: `tests/agents.sh` checks the
  installed paths for each agent.

**Event log and dashboard**
- [ ] Every proof process, whichever agent started it, uses one data folder: `PROOF_DATA_DIR` if set, else the
  folder the installer resolved (the Claude plugin's data folder when proof is installed in Claude, else
  `~/.config/proof/data`), written into each agent's generated config. verify: `tests/dashboard.sh` case starting a
  Claude fixture session and an opencode fixture session from separate processes with no shared env, and both
  appear in the same monitor's `data.json`.
- [ ] Adapters append one event per session start, user prompt, tool start, tool end, turn end, gate run, and wait
  for the user to `<data folder>/events/<agent>/<session>.jsonl`, in one schema documented in
  `plugins/proof/docs/agents.md`. The capability table names the hook each event comes from per agent, or "no"
  where the agent has none (most have no "waiting for the user" hook). verify: `tests/agents.sh` runs a scripted
  session through each adapter and checks the event file line by line against the schema.
- [ ] The timeline turns an event log into the same session model a Claude transcript produces (steps, categories,
  gate runs, waiting on the user, idle). verify: an event-log fixture hand-built from the existing Claude transcript
  fixture of the same session is fed to the timeline, and the two models are compared field by field, allowing only
  the fields the event log can't know (token counts, the model's own thinking).
- [ ] The monitor picks up event logs written in the last day alongside Claude logs, and keeps the Mac awake while
  any agent's session is working. A session with no event for 10 minutes and no live gate run counts as stopped, so
  a hook that dies without a turn-end event doesn't keep the Mac awake. verify: `tests/dashboard.sh` cases: one
  Claude and one opencode fixture session both in `data.json`; a truncated opencode log older than 10 minutes shows
  as stopped and doesn't count as working.
- [ ] The dashboard shows which agent each session belongs to, in the session header and the switcher, and the
  thinking category reads "<Agent> thinking & writing". verify: `fidelity/verify-screen.mjs` passes for the new and
  updated screens in the updated mockup, light and dark.
- [ ] The design for the agent label is mocked up and approved before it's built. verify: the user approves the
  mockup frames (manual, recorded in the decision log).

**Agents tested live (installed on this machine: Claude Code, opencode 1.18.18, Gemini CLI 0.36.0)**
- [ ] opencode: a plugin file adds proof's rules to the system prompt, runs the gate when the session goes idle and
  sends a follow-up prompt when it fails, denies a failing `git commit`, rewrites test commands, adds the memory
  note before a subagent, and writes events. verify: manual steps in a scratch project whose check is `exit 1` and
  whose test command is `npx vitest run` — 1) `install.mjs opencode`; 2) start opencode and ask "what does proof's
  rule 4 say?", confirm it quotes it; 3) ask for a file change, confirm it receives the gate failure and keeps
  working, and stops after `maxRounds`; 4) ask it to commit, confirm the commit is denied; 5) ask it to run the
  tests, confirm the event log shows the command with the worker limit and fail-fast flag; 6) open the dashboard,
  confirm the session is listed as opencode with its steps. Plus `tests/agents.sh` fixtures captured from that run.
- [ ] Gemini CLI: the same behaviours through its hooks in `.gemini/settings.json` (SessionStart, AfterAgent,
  BeforeTool). verify: the same six manual steps with `gemini`, plus fixtures captured from that run.

**Agents built from their docs, not tested live (not installed here)**
- [ ] Codex: proof ships as a Codex plugin (`.codex-plugin/plugin.json` plus `hooks/hooks.json`): SessionStart adds
  the rules, Stop `decision: block` keeps the turn going on a failing gate, PreToolUse denies a failing commit and
  rewrites test commands with `updatedInput`, and the subagent note uses SubagentStart where it fits. verify:
  `tests/agents.sh` fixtures from the Codex hooks docs for each of those behaviours.
- [ ] Cursor: `.cursor/hooks.json` with `sessionStart.additional_context` for the rules, `stop.followup_message`
  for the gate, `beforeShellExecution` deny for commits, `preToolUse.updated_input` for test commands,
  `subagentStart` for the memory note. verify: `tests/agents.sh` fixtures from the Cursor hooks docs for each.
- [ ] Grok Build: hook files in `.grok/hooks/` that add the rules at session start, block the end of a turn on a
  failing gate (Stop), deny a failing commit and rewrite test commands (PreToolUse), with "unknown" in the
  capability table for any of those the docs don't confirm. verify: `tests/agents.sh` fixtures from xAI's Grok
  Build docs for each behaviour marked "yes".
- [ ] Antigravity (`agy` CLI): `.agents/hooks.json` that adds the rules, blocks the end of a turn on a failing gate,
  denies a failing commit and rewrites test commands, skills in `.agents/skills/`, with "unknown" for anything the
  docs don't confirm. verify: `tests/agents.sh` fixtures from Google's Antigravity docs for each behaviour marked
  "yes".
- [ ] Every agent not tested live is marked "built from docs, not tested live" in the README and in `install.mjs`'s
  output. verify: `tests/agents.sh` greps the README and the installer output for the label for each such agent.

**History and receipts**
- [ ] Every gate run that ran or reused a check appends one line to a permanent ledger
  (`~/.config/proof/ledger.jsonl`, or `PROOF_LEDGER`), never pruned: time, agent, session, prompt, project root,
  branch, HEAD, mode (stop / commit / manual), the code fingerprint, the outcome (pass, sent back, gave up, asked the
  user, commit allowed, commit blocked) and each check's name, tier, pass/fail, cached, duration and guard stop. No
  check output is stored. verify: `tests/ledger.sh` drives stop, commit and manual runs and checks each ledger line.
- [ ] A "catch" is counted only when a check failed and then passed in the same session on different code. A check
  that fails and then passes on the same code counts as flaky, not caught. Blocked commits, gave-up turns and time
  spent in checks are counted too. verify: `tests/ledger.sh` cases: fail → edit → pass is 1 catch; fail → pass with
  no change is 1 flaky and 0 catches; two failing rounds before a pass are 1 catch.
- [ ] When a turn ends with the checks passing after proof caught something in that turn, the gate's message adds a
  receipt: what was caught this turn, plus the session's totals (caught, commits blocked, time in checks). Turns
  where nothing was caught keep today's message. verify: `tests/ledger.sh` checks the receipt appears after
  fail → fix → pass and is absent after a clean pass.
- [ ] `node scripts/recap.mjs` prints the totals for the last 7 days (or `--since`, `--session <id>`, `--json`).
  verify: `tests/ledger.sh` runs it over a known ledger and compares the numbers.
- [ ] Past gate runs are backfilled from the Claude transcripts on disk once (`recap.mjs --backfill`, started in the
  background by session start the first time), marked as from transcripts, never counted twice, and a catch from a
  transcript needs a file edit between the failure and the pass. verify: `tests/ledger.sh` backfills a transcript
  fixture twice and checks the counts once; a manual run on this machine's transcripts reports its totals.

**Install and docs**
- [ ] `install.mjs <agent>` merges only proof's entries into files that already exist and creates the files and
  folders that don't; `--uninstall` restores every pre-existing file byte for byte and deletes only the files and
  folders proof created. verify: `tests/agents.sh` round trips for every agent, once into a config that already has
  other hooks and once into a project with no config at all.
- [ ] Non-Claude sessions get proof's update notice at session start, as Claude sessions do. verify:
  `tests/agents.sh` runs session start through one non-Claude adapter with a newer version stubbed and checks the
  notice is in the rules output.
- [ ] The README has one short section per agent: install command, what works, what doesn't (from the capability
  table). verify: proof:verifier checks each section against that agent's row in `plugins/proof/docs/agents.md`.

## Risks and assumptions
- opencode can make the agent keep working after `session.idle` by sending a prompt through `client.session.prompt`.
  The plugin docs don't confirm it. — cheapest test: a 10-line plugin that sends one prompt on idle, in a scratch
  project (F2). Blocks the opencode adapter.
- Gemini CLI's AfterAgent hook can make the agent retry, and BeforeTool can rewrite a shell command's input, as the
  docs say. — cheapest test: hooks that block once and rewrite one command, live in a scratch project (F2).
- Neither opencode nor Gemini carries Claude's `prompt_id` / `stop_hook_active`. Assumption: proof can tell a fix
  round from a new prompt by recording the follow-up it sent and matching the next user-prompt event against it.
  — cheapest test: part of the F2 spike.
- Docs for Codex, Cursor, Grok Build and Antigravity are accurate. The Grok and Antigravity details come from
  third-party guides. — cheapest test: none on this machine; the fixtures cite their source, the capability table
  marks unconfirmed cells "unknown", and the README says they aren't tested live.
- Cursor's hooks have had regressions (forum reports, 2025–2026). — mitigation: the README says which Cursor version
  the fixtures follow.
- Hooks alone can tell when the agent is thinking only as the gap between tool calls. The time breakdown for
  non-Claude agents will be coarser than Claude's. Assumption: that is good enough for the dashboard.

## Decision log
- 2026-11-03 — Core scripts stay; one adapter per agent translates its hooks, because every target agent now has a
  hook system that maps onto Claude Code's (Codex nearly one to one). Revisit if an agent's hooks can't block the
  end of a turn.
- 2026-11-03 — The dashboard reads a log proof writes from hooks instead of each agent's transcripts, because those
  formats are undocumented or unstable. Revisit if an agent documents a stable transcript format with richer data.
- 2026-11-03 — opencode and Gemini CLI are tested live (installed here); Codex, Cursor, Grok Build and Antigravity are
  built from docs and labelled as such, because the user has only Claude Code and opencode (Gemini CLI was found on
  the machine). Revisit when one becomes available to test.
- 2026-11-03 — Grok means xAI's official Grok Build CLI (`grok`), not the community `superagent-ai/grok-cli`
  (confirmed by the user).
- 2026-11-03 — proof's own round count decides when the gate gives up, for every agent, so behaviour is the same
  everywhere.
- 2026-11-03 — Work happens on branch `multi-agent` in `.claude/worktrees/multi-agent`, cut from local `main` (0.6.0).

## Open questions
- Antigravity: only the `agy` CLI is in scope, because hooks are documented for the CLI and the desktop IDE's
  "hooks" appear to be rules only. Is that OK, or does the IDE matter to you? — owner: user
- Should one install command set up proof for every detected agent at once, or one agent at a time? Assumed one at a
  time for v1. — owner: user
- Does the site (proof.ifeolulesi.com) change to say "for every coding agent"? Not in this spec. — owner: user
