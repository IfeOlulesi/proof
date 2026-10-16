---
name: quick
description: Small, clear changes done fast but still proven — a copy or styling fix, a contained bug, a config value; three files or fewer. Use when the user asks for a quick fix or the change is obviously small. If it grows past that, the gate switches back to the full build process.
---

# Quick: small, clear fixes

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" --quick ${CLAUDE_SESSION_ID}`

If the line above shows the command itself rather than a result, run it once.

Quick mode is for a change whose right outcome is obvious: copy, styling, a contained bug, a config value.
- It covers up to 3 files and 100 changed lines.
- Nothing in auth, payments, data models or migrations, security rules, CI, or the check definitions.
- If the change outgrows that, the gate stops you once; switch to proof:build and carry on there.

## Steps

1. **Find the code.** Read only what the change needs.
2. **Make the change.**
   - For a bug in an area that has tests: add the one test that catches it, run it and watch it fail (stop at the first failure: `--bail`, `-x`, `--max-failures=1`), then fix it.
   - For copy and styling: take the values from the source (mockup, spec), not from memory.
3. **Prove it with the narrowest command:** the related test file, the one screen check, or running the thing and looking at it.
4. **Commit once.** The commit gate still runs every relevant check in full.
5. **Report in two lines:** what changed, and what proved it.

## Skipped in quick mode

Reading SPEC.md, features.json and PROGRESS.md, the baseline run, the verifier agent, and the PROGRESS.md entry.

## Never, even in quick mode

- Edit tests, checks or `.claude/proof.json` to get a pass.
- Delete folders with `rm -rf`.
- Bundle a second change into the same fix.
