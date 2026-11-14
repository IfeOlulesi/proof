---
name: setup
description: Turn proof on in this project. Finds the type check, lint and test commands the project already defines, writes them to .claude/proof.json (keeping any checks already there), runs each one once and reports which pass and which fail. Use when the user asks to set up or turn on proof, or when the completion gate is OFF in a git repo.
---

# Set proof up

What the project has, found by the detector:

!`node "${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/detect-checks.mjs"`

If the block above shows the command itself rather than a result, run `node "${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/detect-checks.mjs"` once.

## Steps

1. **When there is nothing to set up.** If the output says it is not a git repository, say so in one line and stop. If no test command was found, set up the lightest test runner for the stack from `${CLAUDE_PLUGIN_ROOT}/skills/build/references/test-tools.md` (don't swap out a runner the project already uses), tell the user in one line, and run the detector again. Never invent a type check or lint command the project doesn't have.
2. **Write the file.** Run `node "${CLAUDE_PLUGIN_ROOT}/skills/setup/scripts/detect-checks.mjs" --write`. It only adds checks. A check already in `.claude/proof.json` is kept exactly as it is, and an unreadable file is left alone (the script refuses; report that and stop).
3. **Run every check once** with `node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" --run`. It prints a line per check, ✓ or ✗.
4. **Report.** Repeat each `note:` line from the detector to the user: those are scripts that were skipped on purpose (watch mode would hang the gate, `--fix` edits files during the check). Give one line per check: pass or fail. For each failure, show the last lines of its output and the cause if it is clear. Do not change tests, lint rules or `.claude/proof.json` to make a check pass. Setting proof up is the job here; fixing the project's failures is a separate task, and the user decides whether to do it now.

## Notes

- The file is `.claude/proof.json`, read by the completion gate. The gate runs the checks before Claude stops after a change, and in full before each `git commit`.
- Checks are only proposed from commands the project already defines (package.json scripts, a Makefile target, or the tool's config). A placeholder `test` script that only prints "no test specified" is skipped.
- Only jest and vitest get a per-reply `fast` command, which runs just the tests related to the changed files. Every other check runs in full after each reply that changed files, and before each commit. A slow project may want to add `fast` by hand.
- Scripts in watch mode or with `--fix` are skipped, and the detector says so.
- To add a check by hand, append `{ "name": "...", "run": "..." }` to `checks` in `.claude/proof.json`.
