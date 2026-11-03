# proof and coding agents

proof's hook scripts (`session-start`, `gate`, `wrap`, `admit`) don't read any agent's hook input directly. Each agent
has an adapter in `scripts/agents/<agent>.mjs` that turns its hook input into one **event**, and one **result** back
into that agent's output. `scripts/agents/index.mjs` picks the adapter: `--agent <name>` on the hook's command line,
else `PROOF_AGENT`, else Claude Code.

Adding an agent: write its adapter module, its fixtures in `tests/fixtures/agents/<agent>/` (each with a `source`),
and add it to `ADAPTERS` in `scripts/agents/index.mjs`. The module holds everything about that agent:
`parse` and `render`, its `caps` (its row in the table below) and `fixtureCaps` (the fixture that proves each "yes"),
the `words` its rules and skills use, and `install()`, which returns the config files it needs (merged into any that
already exist), where its skills and subagents go and how a subagent file looks. `bash tests/agents.sh` checks every
adapter against its fixtures, the table against the modules, and an install and uninstall for every agent.

Install proof into an agent with `node scripts/install.mjs <agent>` in a project (or `--global`); undo it with
`--uninstall`, which puts back every file proof touched byte for byte and deletes only what it created.

## The event

| field | type | meaning |
|---|---|---|
| `agent` | string | the adapter's name (`claude`, …) |
| `kind` | `sessionStart` · `userPrompt` · `beforeTool` · `afterTool` · `turnEnd` | what happened |
| `session` | string or null | the agent's session id |
| `turn` | string or null | the user prompt this belongs to, where the agent has one (Claude: `prompt_id`) |
| `continuation` | true · false · null | at `turnEnd`: whether this turn end follows a fix round proof asked for (Claude: `stop_hook_active`); null when the agent doesn't say |
| `round` | integer or null | the agent's own count of follow-ups, where it reports one (Cursor: `loop_count`) |
| `cwd` | string or null | the folder the agent is working in |
| `lastMessage` | string or null | the agent's last reply text, at `turnEnd` |
| `source` | string or null | at `sessionStart`: startup, resume, clear, compact … |
| `tool` | object, at `beforeTool` / `afterTool` | `{ name, raw, input }` |
| `tool.name` | `shell` · `edit` · `subagent` · `browser` · `other` | `browser` means a tool that opens a new browser; reusing an open one is `other` |
| `tool.raw` | string or null | the agent's own tool name |
| `tool.input` | object | the tool's arguments as the agent sent them; a shell command is `input.command` |
| `prompt` | string or null | at `userPrompt`: the user's prompt, where the agent passes it |
| `skip` | true, or absent | the agent fired this hook for something proof ignores (Grok's Stop as the session closes) |

proof decides itself whether a turn end is a fix round or a new prompt: a new `turn`, or without turn ids,
`continuation` not true, starts a fresh count of rounds. When the agent doesn't say (`continuation` is null), proof
treats the turn end after one it sent back as the fix round, until the user sends a new prompt: an adapter whose agent
has a user-prompt hook runs `gate.mjs --prompt` there. Without one, every turn end after a send-back counts as a fix
round, which `maxRounds` still bounds.

## The result

Every field is optional. An empty result means no output.

| field | meaning | Claude Code |
|---|---|---|
| `context` | text added to the agent's context | `hookSpecificOutput.additionalContext` |
| `message` | a line shown to the user | `systemMessage` |
| `block.reason` | at `turnEnd`: keep working, with this reason; before a tool: don't run it | `turnEnd`: `decision: "block"` + `reason`; before a tool: the reason on stderr, exit code 2 |
| `updatedCommand` | before a shell command: run this instead | `hookSpecificOutput.updatedInput.command` (other arguments kept) |

## What each agent gets

`node scripts/install.mjs --table` prints this table from the adapter modules; `tests/agents.sh` fails if it drifts.
"Yes" names the hook it comes from, "no" means the agent has no way to do it, "unknown" means its docs don't say.

<!-- capability table: generated -->
| agent | tested | rules at start | gate at turn end | commit deny | test-command rewrite | subagent and browser note | session start | user prompt | before tool | after tool | turn end | waiting for the user | skills | subagents (verifier, screen-judge) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Claude | live (Claude Code is proof's home) | yes (SessionStart) | yes (Stop) | yes (PreToolUse) | yes (PreToolUse) | yes (PreToolUse) | yes (SessionStart) | no | yes (PreToolUse) | no | yes (Stop) | no | yes (plugin skills/) | yes (plugin agents/) |
| opencode | live | yes (experimental.chat.system.transform) | yes (session.idle + session.promptAsync) | yes (tool.execute.before) | yes (tool.execute.before) | yes (tool.execute.before) | yes (experimental.chat.system.transform) | yes (chat.message) | yes (tool.execute.before) | yes (tool.execute.after) | yes (session.idle) | no | yes (.opencode/skills) | yes (.opencode/agents) |
| Gemini CLI | built from docs, not tested live | yes (SessionStart) | yes (AfterAgent) | yes (BeforeTool) | yes (BeforeTool) | unknown | yes (SessionStart) | yes (BeforeAgent) | yes (BeforeTool) | yes (AfterTool) | yes (AfterAgent) | unknown | yes (.gemini/skills) | yes (.gemini/agents) |
| Codex | built from docs, not tested live | yes (SessionStart) | yes (Stop) | yes (PreToolUse) | yes (PreToolUse) | yes (PreToolUse) | yes (SessionStart) | yes (UserPromptSubmit) | yes (PreToolUse) | yes (PostToolUse) | yes (Stop) | no | yes (.agents/skills) | yes (.codex/agents) |
| Cursor | built from docs, not tested live | yes (sessionStart) | yes (stop) | yes (beforeShellExecution) | yes (preToolUse) | no | yes (sessionStart) | yes (beforeSubmitPrompt) | yes (preToolUse) | yes (postToolUse) | yes (stop) | no | yes (.cursor/skills) | yes (.cursor/agents) |
| Grok Build | built from docs, not tested live | yes (.grok/rules/proof.md) | yes (Stop) | yes (PreToolUse) | yes (PreToolUse) | yes (PreToolUse) | yes (SessionStart) | yes (UserPromptSubmit) | yes (PreToolUse) | yes (PostToolUse) | yes (Stop) | no | yes (.grok/skills) | yes (.grok/agents) |
| Antigravity | built from docs, not tested live | yes (SessionStart) | yes (Stop) | yes (PreToolUse) | yes (PreToolUse) | unknown | yes (SessionStart) | yes (PreInvocation) | yes (PreToolUse) | yes (PostToolUse) | yes (Stop) | no | yes (.agents/skills) | yes (.agents/agents) |
<!-- end of capability table -->

Notes per agent, from their docs (each adapter module has the details):
- **opencode** runs proof as a plugin. The gate keeps it working through `session.promptAsync`, which needs opencode
  running as a server (the TUI, `opencode serve`); one-shot `opencode run` exits at the first idle.
- **Gemini CLI**, **Codex** and **Grok Build** ask the user to trust new hooks before they run.
- **Cursor** reads no output from a permission hook as a refusal, so proof always answers those. proof's `maxRounds`
  decides when the gate gives up; Cursor's own follow-up limit (`loop_limit`) is set to 20 as a backstop. A stop after
  a turn the user aborted isn't gated. Cursor's and Antigravity's turn-end hooks have no field for a message to the
  user, so proof's "still failing" line isn't shown there. Cursor (and Grok) also run Claude Code's hooks from
  `.claude/settings.json`.
- **Grok Build**'s session-start hook can't add context for the model, so its rules go in `.grok/rules/proof.md`, and
  the update notice is shown to the user instead.
  Grok ends a turn after 8 send-backs whatever `maxRounds` says.
- **Antigravity** has no prompt-submit hook: proof reads `lastUserInput` before each model call and counts one it
  hasn't seen as a new prompt. A failing or killed hook lets the action through in every agent except Cursor, where
  the commit gate is set to fail closed.

## The event log

Claude Code's sessions are read from its own transcripts. For every other agent, proof's hooks append what happened to
`<data folder>/events/<agent>/<session>.jsonl`, one JSON object per line, and the dashboard reads that
(`timeline.mjs`, `EventSession`). The data folder is `PROOF_DATA_DIR`, which the installer writes into each agent's hook
commands as `--data`: Claude Code's plugin data folder when proof is installed there, else `~/.config/proof/data`, so
every agent's sessions show on one dashboard.

Every line has `v` (1), `t` (milliseconds since 1970), `agent`, `session`, `kind` and `cwd`. By kind:

| kind | written by | more fields |
|---|---|---|
| `sessionStart` | `session-start.mjs` | `source` |
| `userPrompt` | `gate.mjs --prompt`, only for a prompt that's new (not proof's own follow-up, not the same one reported again) | `prompt` (first 300 characters) |
| `toolStart` | `wrap.mjs`, which every tool call goes through | `tool`: `{ name, raw, summary, id? }`; `summary` is the command, file or subagent description |
| `toolEnd` | `event.mjs` | `tool`, `ok` where the agent says |
| `turnEnd` | `gate.mjs` at the turn end, before the checks run | `turn` where the agent has one |
| `gate` | `gate.mjs`, after each run | `mode` (stop, commit), `outcome` (pass, block, gaveUp, askedUser, commitAllowed, commitBlocked), `round`, `ms`, `checks`: `[{ name, ok }]` |
| `waiting` | `gate.mjs`, when it hands the turn to the user | `reason` (gaveUp, askedUser) |

The capability table says which of these each agent can write: an agent without an after-tool hook has no `toolEnd`,
and its tool calls end at the next turn end. A session with no event for 10 minutes and no gate running counts as
stopped, so a hook that dies without a turn end doesn't keep the Mac awake.
