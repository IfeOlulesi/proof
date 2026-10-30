#!/usr/bin/env bash
# The gate: Stop hook (fast tier), commit hook (full tier) and manual runs, with synthetic checks that log what ran.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export LOG=$T/log
mkdir -p src .claude 'src/(auth)'
echo 'export const a = 1' > src/a.ts
echo 'x' > 'src/(auth)/[id].tsx'
echo '{}' > jest.config.js
echo 'node_modules/' > .gitignore
cat > .claude/proof.json <<'EOF'
{ "checks": [
  {"name":"types","run":"echo types >> \"$LOG\"; sleep 2","when":["src/"]},
  {"name":"lint","run":"echo lint-full >> \"$LOG\"","fast":"printf 'lint-fast %s\\n' {files} >> \"$LOG\"","files":["src/**/*.{ts,tsx}"],"fullWhen":["eslint.config.js"],"when":["src/","eslint.config.js"]},
  {"name":"test","run":"echo test-full >> \"$LOG\"; sleep 2","fast":"printf 'test-fast %s\\n' {files} >> \"$LOG\"; sleep 2","files":["src/**/*.{ts,tsx}"],"fullWhen":["jest.config.js"],"when":["src/","jest.config.js"]},
  {"name":"unit","run":"! grep -rq BUG src","fast":"! grep -q BUG {files}","files":["src/**/*.{ts,tsx}"],"when":["src/"]},
  {"name":"nocache","run":"echo nocache >> \"$LOG\"","cache":false}
], "maxRounds": 4 }
EOF
git add -A && git commit -qm init

ss()   { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],source:"startup"}))' "$1" "$R" | node "$S/session-start.mjs"; }
stop() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],prompt_id:process.argv[3],stop_hook_active:process.argv[4]==="true",last_assistant_message:process.argv[5]}))' "$1" "$R" "$2" "${3:-false}" "${4:-Done.}" | node "$S/gate.mjs"; }
commit() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],tool_name:"Bash",tool_input:{command:process.argv[3]}}))' "$1" "$R" "$2" | node "$S/gate.mjs" --commit 2>"$T/stderr"; echo "exit=$?"; }
newlog() { : > "$LOG"; }

echo "== session start"
out=$(ss s1)
expect "context names the gate and both tiers" "grep -q 'before each git commit, they run in full' <<<\"\$out\""
expect "context gives the manual-run command" "grep -q 'scripts/gate.mjs.\{1,3\} --run' <<<\"\$out\""

echo "== reply that changed two source files (one with (auth) and [id] in its path)"
echo 'export const a = 2' > src/a.ts; echo 'y' > 'src/(auth)/[id].tsx'; newlog
t0=$(now_ms); out=$(stop s1 p1); ms=$(( $(now_ms) - t0 ))
expect "passes, says fast + full-at-commit" "grep -q 'full checks run before each commit' <<<\"\$out\""
expect "lint ran fast with both files, special chars intact" "grep -q \"lint-fast $R/src/(auth)/\\[id\\].tsx\" \$LOG && grep -q \"lint-fast $R/src/a.ts\" \$LOG"
expect "test ran fast, not full" "grep -q test-fast \$LOG && ! grep -q test-full \$LOG"
expect "checks ran in parallel (two 2s checks took < 3.5s, was ${ms}ms)" "[ $ms -lt 3500 ]"

echo "== same code again"
newlog; stop s1 p1 true >/dev/null
expect "everything cached except the uncached check (ran: $(tr '\n' ' ' < "$LOG"))" "[ \"\$(cat \$LOG)\" = nocache ]"

echo "== a chat reply: new prompt, code unchanged since the last check"
newlog; out=$(stop s1 p1b)
expect "nothing runs, not even the uncached check, and nothing is said" "[ ! -s \$LOG ] && [ -z \"\$out\" ]"
echo 'export const a = 3' > src/a.ts; newlog; stop s1 p1c >/dev/null
expect "the next prompt that changes code runs the checks again" "grep -q lint-fast \$LOG"
echo 'export const a = 2' > src/a.ts; stop s1 p1d >/dev/null

echo "== commit: full tier"
newlog; r=$(commit s1 'git add -A && git commit -m "feat"')
expect "commit allowed" "grep -q 'exit=0' <<<\"\$r\" && grep -q 'commit allowed' <<<\"\$r\""
expect "full lint and full test ran" "grep -q lint-full \$LOG && grep -q test-full \$LOG"
expect "types reused its cached full pass" "! grep -q '^types' \$LOG"
newlog; stop s1 p2 >/dev/null
expect "reply after the full pass: fast variants skipped (full passed on same code)" "! grep -qE 'fast|full|types' \$LOG"

echo "== non-commit commands pass straight through"
t0=$(now_ms); r=$(commit s1 'git status'); ms=$(( $(now_ms) - t0 ))
expect "git status: exit 0, no output, ${ms}ms" "[ \"\$r\" = 'exit=0' ] && [ ! -s $T/stderr ]"
r=$(commit s1 'git commit-tree abc'); expect "git commit-tree is not a commit" "[ \"\$r\" = 'exit=0' ]"

echo "== commands that write files and commit in one go are refused"
r=$(commit s1 "printf 'x' > src/new.ts && git add -A && git commit -m n")
expect "write + commit in one command: refused (exit 2)" "grep -q 'exit=2' <<<\"\$r\" && grep -q 'commit refused' $T/stderr"
r=$(commit s1 "mkdir -p src && git add -A && git commit -m n")
expect "mkdir before commit: refused" "grep -q 'exit=2' <<<\"\$r\""
r=$(commit s1 "$(cat "$FIX/heredoc-commit.txt")")
expect "cd + git add + heredoc message with quotes and apostrophes: allowed through to the checks" "! grep -q 'commit refused' $T/stderr"
r=$(commit s1 'GIT_AUTHOR_DATE=2026-01-01 git commit -m x')
expect "env-prefixed commit: allowed through" "! grep -q 'commit refused' $T/stderr"
r=$(commit s1 'git commit -m x && npm test')
expect "commands after the commit don't matter" "! grep -q 'commit refused' $T/stderr"

echo "== fullWhen and deletions force the full command per reply"
echo '{"x":1}' > jest.config.js; newlog; stop s1 p3 >/dev/null
expect "jest.config.js change: test ran full" "grep -q test-full \$LOG && ! grep -q test-fast \$LOG"
git checkout -q jest.config.js; rm 'src/(auth)/[id].tsx'; newlog; stop s1 p4 >/dev/null
expect "deleted source file: lint and test ran full" "grep -q lint-full \$LOG && grep -q test-full \$LOG"
git checkout -q -- 'src/(auth)/[id].tsx'

echo "== failing check: reply blocked, commit blocked"
echo 'BUG' >> src/a.ts; out=$(stop s1 p5)
expect "reply blocked with decision=block" "grep -q '\"decision\":\"block\"' <<<\"\$out\""
expect "reason tells Claude to iterate narrowly, not re-run everything" "grep -q 'run only the failing test or file' <<<\"\$out\" && ! grep -q 're-run the failing check yourself' <<<\"\$out\""
r=$(commit s1 'git commit -am wip')
expect "commit blocked (exit 2) with reason on stderr" "grep -q 'exit=2' <<<\"\$r\" && grep -q 'commit blocked' $T/stderr"
out=$(stop s1 p5 true); out2=$(stop s1 p5 true)
expect "stall: after 2 rounds without progress, Claude may stop and you're told" "grep -q 'this is not done' <<<\"\$out2\""
out=$(stop s1 p5b)
expect "a chat reply while checks fail isn't blocked, but says what still fails" "! grep -q 'decision' <<<\"\$out\" && grep -q 'no file changes since the last check (unit still failing)' <<<\"\$out\""
grep -v BUG src/a.ts > "$T/a.ts"; cat "$T/a.ts" > src/a.ts; out=$(stop s1 p6)
expect "fixed: passes" "grep -q 'proof ✓' <<<\"\$out\""

echo "== check definitions changed by the session"
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.checks=j.checks.filter(c=>c.name!=="unit");require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
out=$(stop s1 p7)
expect "removing a check is caught and sent back" "grep -q 'check definitions' <<<\"\$out\" && grep -q 'changed: .claude/proof.json' <<<\"\$out\""
r=$(commit s1 'git commit -am weaken')
expect "and can't be committed before the user is asked" "grep -q 'exit=2' <<<\"\$r\" && grep -q 'check definitions' $T/stderr"
out=$(stop s1 p7 true $'I removed the unit check because...\nNEEDS-INPUT: OK to drop it?')
expect "NEEDS-INPUT lets Claude stop and ask" "grep -q 'stopped to ask you' <<<\"\$out\""
out=$(stop s1 p8)
expect "once asked, the same change isn't flagged again" "! grep -q 'check definitions' <<<\"\$out\""
git checkout -q .claude/proof.json; rm .claude/proof.json; out=$(stop s1 p9)
expect "deleting proof.json is caught (gate can't be switched off silently)" "grep -q 'deleted: .claude/proof.json' <<<\"\$out\""
git checkout -q .claude/proof.json
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.checks.push({name:"extra",run:"true",when:["src/"]});j.checks[0].when.push("lib/");j.checks.reverse();require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
out=$(stop s1 p9b)
expect "adding a check, widening a when, reordering: not asked about" "! grep -q 'check definitions' <<<\"\$out\""
git checkout -q .claude/proof.json
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.checks.find(c=>c.name==="unit").run="true";require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
out=$(stop s1 p9c)
expect "changing a check's command is caught, by name" "grep -q 'check .\\{1,2\\}unit.\\{1,2\\} removed or its command changed' <<<\"\$out\""
git checkout -q .claude/proof.json
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.checks.find(c=>c.name==="test").when=["src/"];require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
out=$(stop s1 p9d)
expect "narrowing a check's when is caught" "grep -q 'check .\\{1,2\\}test.\\{1,2\\} no longer runs on jest.config.js' <<<\"\$out\""
git checkout -q .claude/proof.json
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.checks.find(c=>c.name==="unit").fast="true";require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
out=$(stop s1 p9e)
expect "changing a check's per-reply command is caught" "grep -q 'per-reply command changed' <<<\"\$out\""
git checkout -q .claude/proof.json
echo '{"disableAllHooks":true}' > .claude/settings.json; out=$(stop s1 p9f)
expect "creating .claude/settings.json is caught" "grep -q 'changed: .claude/settings.json' <<<\"\$out\""
rm .claude/settings.json

echo "== a session that sets the gate up isn't asked to have it reviewed"
mv .claude/proof.json "$T/proof.json"; ss s3 >/dev/null; cp "$T/proof.json" .claude/proof.json
out=$(stop s3 r1)
expect "proof.json created in-session: no flag" "! grep -q 'check definitions' <<<\"\$out\""

echo "== your own edits made before a session aren't flagged"
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.maxRounds=5;require("fs").writeFileSync(f,JSON.stringify(j,null,2))'
ss s2 >/dev/null; echo 'export const a = 3' > src/a.ts; out=$(stop s2 q1)
expect "pre-session proof.json edit: no flag" "! grep -q 'check definitions' <<<\"\$out\""
git checkout -q .claude/proof.json src/a.ts

echo "== timeouts kill the whole process group"
git commit -qam "state" 2>/dev/null; ss s3 >/dev/null
node -e 'const f=".claude/proof.json",j=require(process.cwd()+"/"+f);j.checks=[{name:"hang",run:"sleep 97 & sleep 98; wait",timeout:1}];require("fs").writeFileSync(f,JSON.stringify(j))'
echo 'export const a = 9' > src/a.ts
t0=$(now_ms); node "$S/gate.mjs" --run "$R" --no-cache >/dev/null; ms=$(( $(now_ms) - t0 ))
sleep 0.5
expect "gave up at the timeout (${ms}ms) and left no stray processes" "[ $ms -lt 6000 ] && ! pgrep -f 'sleep 9[78]' >/dev/null"
git checkout -q .claude/proof.json src/a.ts

echo "== the fingerprint never touches the real index"
echo 'export const a = 4' > src/a.ts; git add src/a.ts; echo 'new' > src/untracked.ts
sleep 1.2; git status --porcelain >/dev/null; sleep 1.2; git status --porcelain >/dev/null   # let git settle its own index refresh
staged_before=$(git diff --cached --name-only); idx_before=$(cksum < .git/index)
node "$S/gate.mjs" --run "$R" --no-cache >/dev/null; node "$S/gate.mjs" --run "$R" >/dev/null
staged_after=$(git diff --cached --name-only); idx_after=$(cksum < .git/index)
expect "staged set and index bytes unchanged" "[ \"\$staged_before\" = \"\$staged_after\" ] && [ \"\$idx_before\" = \"\$idx_after\" ]"

echo "== manual run reports cached passes"
out=$(node "$S/gate.mjs" --run "$R")
expect "second manual run shows cached results" "grep -q 'cached — passed on this exact code' <<<\"\$out\""

finish
