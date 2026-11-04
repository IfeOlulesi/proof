---
name: init-proof
description: Turn proof on in this project. Finds the type check, lint and test commands the project already defines, writes them to .claude/proof.json (keeping any checks already there), runs each one once and reports which pass and which fail. Use when the user asks to set up or turn on proof, or when the completion gate is OFF in a git repo.
---

# Init proof

What the project has, found by the detector:

!`node "${CLAUDE_PLUGIN_ROOT}/skills/init-proof/scripts/detect-checks.mjs"`

If the block above shows the command itself rather than a result, run `node "${CLAUDE_PLUGIN_ROOT}/skills/init-proof/scripts/detect-checks.mjs"` once.

## Steps

1. **Stop if there is nothing to set up.** If the output says it is not a git repository, or that no type check, lint or test command was found, say so in one line and ask the user for the commands to run. Do not invent commands.
2. **Write the file.** Run `node "${CLAUDE_PLUGIN_ROOT}/skills/init-proof/scripts/detect-checks.mjs" --write`. It only adds checks. A check already in `.claude/proof.json` is kept exactly as it is, and an unreadable file is left alone (the script refuses; report that and stop).
3. **Run every check once** with `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" --run`. It prints a line per check, ✓ or ✗.
4. **Report.** Give one line per check: pass or fail. For each failure, show the last lines of its output and the cause if it is clear. Do not change tests, lint rules or `.claude/proof.json` to make a check pass. Setting proof up is the job here; fixing the project's failures is a separate task, and the user decides whether to do it now.

## Notes

- The file is `.claude/proof.json`, read by the completion gate. The gate runs the checks before Claude stops after a change, and in full before each `git commit`.
- Checks are only proposed from commands the project already defines (package.json scripts, a Makefile target, or the tool's config). A placeholder `test` script that only prints "no test specified" is skipped.
- To add a check by hand, append `{ "name": "...", "run": "..." }` to `checks` in `.claude/proof.json`.
