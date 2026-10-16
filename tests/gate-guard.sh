#!/usr/bin/env bash
# The gate running its checks under the guard: leaks, killed gates, and the gate's own time budget.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
mkdir -p src .claude
echo 'export const a = 1' > src/a.ts && git add -A && git commit -qm init
# Live processes running program $1 whose command line contains $2 (so the guard's own command line doesn't count).
running() { ps -A -o stat=,args= | awk -v p="$1" -v a="$2" '$1 !~ /^Z/ && $2==p && index($0, a) {n++} END {print n+0}'; }
cfg() { printf '%s' "$1" > .claude/proof.json; }
ss()   { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],source:"startup"}))' "$1" "$R" | node "$S/session-start.mjs" >/dev/null; }
stop() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],prompt_id:process.argv[3],stop_hook_active:false,last_assistant_message:"Done."}))' "$1" "$R" "$2" | node "$S/gate.mjs"; }

echo "== a leaking check is stopped fast and reported as a leak, not a test failure"
cfg '{"checks":[{"name":"leak","run":"node -e \"const a=[];setInterval(()=>a.push(Buffer.alloc(50*2**20,1)),100) // leakG\"","maxProcessMemoryMB":200},
               {"name":"fine","run":"node -e \"const b=Buffer.alloc(100*2**20,1);console.log(b.length)\""}]}'
t0=$(now_ms); out=$(node "$S/gate.mjs" --run "$R" --no-cache); ms=$(( $(now_ms) - t0 ))
expect "manual run: leak stopped by the guard within ~3s (${ms}ms)" "grep -q 'stopped by the proof guard: memory: one process reached' <<<\"\$out\" && [ $ms -lt 4000 ]"
expect "a check using 100 MB under the default ceilings passes" "grep -q '✓ fine' <<<\"\$out\""
sleep 1; expect "nothing left running" "[ \$(running node leakG) -eq 0 ]"
ss s1; echo 'export const a = 2' > src/a.ts
out=$(stop s1 p1)
expect "Stop: blocked, with the 'loop, leak or hang — don't re-run' note" "grep -q '\"decision\":\"block\"' <<<\"\$out\" && grep -q 'not a failing assertion' <<<\"\$out\" && grep -q 'stopped by the proof guard' <<<\"\$out\""
git checkout -q src/a.ts

echo "== killing the gate mid-check doesn't leave the check running"
cfg '{"checks":[{"name":"hang","run":"sleep 98","timeout":4}]}'
node "$S/gate.mjs" --run "$R" --no-cache >/dev/null 2>&1 & GP=$!
sleep 1.5; expect "check is running under the gate" "[ \$(running sleep 98) -eq 1 ]"
kill -9 $GP 2>/dev/null; wait $GP 2>/dev/null
sleep 6; expect "gate SIGKILLed: the guard still stopped the check at its timeout" "[ \$(running sleep 98) -eq 0 ]"

echo "== the gate finishes inside its time budget instead of being cut off by Claude Code"
cfg '{"checks":[{"name":"slow","run":"sleep 99","timeout":300},{"name":"later","run":"true"}],"concurrency":1}'
ss s2; echo 'export const a = 3' > src/a.ts
t0=$(now_ms); out=$(PROOF_GATE_BUDGET=25 stop s2 q1); ms=$(( $(now_ms) - t0 ))
expect "a 300s check is cut to fit a 25s budget (${ms}ms total)" "[ $ms -lt 22000 ] && grep -q 'stopped by the proof guard: time' <<<\"\$out\""
expect "a check with no time left is reported as not run, not silently skipped" "grep -q 'not run: the gate ran out of time' <<<\"\$out\""
sleep 1; expect "nothing left running" "[ \$(running sleep 99) -eq 0 ]"
git checkout -q src/a.ts

finish
