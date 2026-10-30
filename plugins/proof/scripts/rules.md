# proof — how work gets done in this session

Name the phase before you start, and load its skill:
- discover — ideas, problems, options, scoping, specs → skill proof:discover
- design — UX, flows, mockups, copy, design tokens → skill proof:design
- build — any code change, including implementing a design → skill proof:build
A request that spans phases: finish and check each phase before starting the next.

In every phase:
1. Done means proven. A check you can run (a test, a script, a render compared with its reference, a measurement) decides done, not your own reading of the work. Report what you ran and what you didn't.
2. One unit at a time: one feature, screen, bug or decision. Split anything bigger into a list first, then work it item by item.
3. Take specifics from their source (spec, mockup DOM, API docs, logs). Never retype copy, numbers or requirements from memory.
4. Never weaken a check to pass it: don't edit tests, inventories, specs or .claude/proof.json to make a failure go away. If a check is wrong, say why and ask. Removing or rewriting a check is flagged to the user; setting checks up and adding them isn't.
5. When a check fails, iterate with the narrowest command (one test file or test name). The gate re-runs the full check when you finish.
6. Don't delete folders (no rm -rf). Put scratch work in a fresh `mktemp -d`; tools overwrite their own output folders. If something must go, name the exact path and say why.
7. Keep measured and estimated apart, and label guesses as guesses.
8. When the user corrects you, fix it, then propose the one line for CLAUDE.md, or the check, that would have caught it.
9. If the same problem needs a third correction, stop and recommend /clear with a sharper prompt.
10. Review with the proof:verifier agent once per unit, before committing it (fresh context, correctness and requirement gaps only), not by re-reading your own work.
11. If you must stop for the user's input while checks are failing, end your message with a line starting NEEDS-INPUT: and the question.
12. Memory has a ceiling (90% by default). When there isn't room, test runs get fewer workers (slower, never skipped); other heavy runs and new agents wait their turn, or are refused. When proof reports memory, first stop your own processes you no longer need (dev servers, simulators, browsers). Never close the user's apps; tell them what closing them would free and how much faster the work goes.
13. Wait for a background run with TaskOutput (it returns when the run exits), never by polling its log with until/grep or with pgrep. proof stops wait loops after 5 minutes.
14. Red runs stop at the first failure (--max-failures=1, --bail, -x).
15. Small, clear fixes (copy, styling, a contained bug, up to 3 files): use proof:quick. Work longer than an hour: open the dashboard (proof:watch) and keep your task list current, one item per unit.
