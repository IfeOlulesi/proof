#!/usr/bin/env bash
# Which commands run under the guard, memory turn-taking, quick mode, the gate's live status, the log parser and the
# live monitor.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
mkdir -p src .claude
echo 'export const a = 1' > src/a.ts
echo '{"checks":[{"name":"t","run":"true"}]}' > .claude/proof.json
git add -A && git commit -qm init
hook() { # tool session command
  node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[2],cwd:process.argv[3],tool_name:process.argv[1],tool_input:{command:process.argv[4],description:"d"}}))' "$1" "$2" "$R" "$3"; }
# Each call is a hook alone, with no run after it to release the hold its admission makes (mem.hold): clear holds
# first so one simulated call doesn't shrink the next one's room. "holds" below tests the hold itself.
wrap() { rm -rf "$T/data/holds"; hook Bash "$1" "$2" | node "$S/wrap.mjs" 2>"$T/err"; echo "exit=$?"; }
wrap_keep() { hook Bash "$1" "$2" | node "$S/wrap.mjs" 2>"$T/err"; echo "exit=$?"; }
admit() { hook "$1" s "" | node "$S/admit.mjs" 2>"$T/err"; echo "exit=$?"; }

echo "== which commands run under the guard"
out=$(wrap s1 'npm run e2e -- e2e/today.spec.ts -g S1'); expect "npm run e2e: guarded as e2e, 900s" "grep -q -- '--kind e2e' <<<\"\$out\" && grep -q -- '--timeout 900' <<<\"\$out\""
out=$(wrap s1 'until grep -qE "passed|failed" /tmp/x.log; do sleep 5; done; grep x /tmp/x.log'); expect "until-grep wait loop: guarded as wait, 300s" "grep -q -- '--kind wait' <<<\"\$out\" && grep -q -- '--timeout 300' <<<\"\$out\""
out=$(wrap s1 'npm run build'); expect "npm run build: guarded as build, 1800s" "grep -q -- '--kind build' <<<\"\$out\" && grep -q -- '--timeout 1800' <<<\"\$out\""
out=$(wrap s1 'ls -la src'); expect "ordinary commands pass untouched" "[ \"\$out\" = 'exit=0' ]"
expect "the data folder is passed on to the guard" "grep -q -- \"--data '$T/data'\" <<<\"\$(wrap s1 'npx jest')\""
echo '{"checks":[{"name":"t","run":"true"}],"waitTimeout":42}' > .claude/proof.json
expect "waitTimeout from proof.json" "grep -q -- '--timeout 42' <<<\"\$(wrap s1 'while pgrep -f jest; do sleep 2; done')\""
echo '{"checks":[{"name":"t","run":"true"}]}' > .claude/proof.json

echo "== heavy runs take turns for memory"
fake_mem 23000; out=$(wrap s2 'npx jest --ci')
expect "93% and nothing to wait for: refused (exit 2) with what to do" "grep -q 'exit=2' <<<\"\$out\" && grep -q 'proof memory: not starting this test run' $T/err && grep -q 'ceiling' $T/err"
fake_mem 19200; out=$(wrap s3 'npx jest --ci')
expect "78%: runs, with a memory note for Claude" "grep -q -- '--kind test' <<<\"\$out\" && grep -q 'proof memory: the [A-Za-z]* is at 78%' <<<\"\$out\""
out=$(wrap s3 'npx jest --ci'); expect "the note isn't repeated within 10 minutes" "! grep -q 'proof memory' <<<\"\$out\""
fake_mem 23000
perl -e 'setpgrp(0, 0); exec @ARGV' sleep 6 & SP=$!; sleep 0.3   # a guarded run in its own process group
mkdir -p "$T/data/runs"; printf '{"pgid":%s,"start":%s,"cmd":"sleep 6","kind":"test"}' $SP "$(date +%s)000" > "$T/data/runs/$SP.json"
t0=$(now_ms); out=$(PROOF_ADMIT_WAIT=30 wrap s4 'npx playwright test'); ms=$(( $(now_ms) - t0 ))
expect "over the ceiling with a guarded run in flight: waits for it (${ms}ms), then refuses" "[ $ms -ge 4500 ] && grep -q 'exit=2' <<<\"\$out\" && grep -q 'Waited' $T/err"
fake_mem 9000

echo "== heavy runs fit the room there is (fewer workers instead of waiting or refusing)"
export PROOF_CPUS=14   # Jest's default is cores - 1 = 13 workers: 300 + 13 x 350 = 4850 MB by estimate
fake_mem 18432; out=$(wrap f1 'npx jest --ci')   # 75%: 3686 MB left under the 90% ceiling
expect "75%: jest capped at the workers that fit (9), and Claude is told why" "grep -q -- '--maxWorkers=9' <<<\"\$out\" && grep -q 'capped it at 9 workers' <<<\"\$out\" && grep -q 'slower, not skipped' <<<\"\$out\""
out=$(wrap f2 'npx jest --ci --maxWorkers=2')
expect "a runner named inside a quoted argument is never rewritten" "! grep -q 'maxWorkers' <<<\"\$(wrap f1b \"node -e 'run(\\\"./bin/jest --ci\\\")'\")\""
expect "a capped command gets one cap, in place of its own" "grep -q -- 'jest --maxWorkers=9 --ci' <<<\"\$(wrap f1c 'npx jest --maxWorkers=13 --ci')\" && ! grep -q 'maxWorkers=13' <<<\"\$(wrap f1c 'npx jest --maxWorkers=13 --ci')\""
expect "a run already capped below what fits is left as written" "grep -q -- '--kind test' <<<\"\$out\" && [ \$(grep -o 'maxWorkers' <<<\"\$out\" | wc -l) -eq 1 ]"
echo '{"scripts":{"test":"jest --ci"}}' > package.json
expect "npm test running jest: the cap is passed through to the script" "grep -q -- 'npm test -- --maxWorkers=9' <<<\"\$(wrap f3 'npm test')\""
echo '{"scripts":{"test":"jest && eslint ."}}' > package.json
expect "a script that runs several things isn't rewritten" "! grep -q -- 'maxWorkers' <<<\"\$(wrap f3b 'npm test')\""
echo '{"scripts":{"test":"jest --ci"}}' > package.json
expect "npm test with the user's own --: the cap goes right after it" "grep -q -- 'npm test -- --maxWorkers=9 src' <<<\"\$(wrap f3c 'npm test -- src')\""
expect "pnpm test: the cap goes before the user's --, where pnpm passes it on" "grep -q -- 'pnpm test --maxWorkers=9 -- src' <<<\"\$(wrap f3d 'pnpm test -- src')\""
expect "npm test in the background: the cap stays before the &" "grep -q -- 'npm test -- --maxWorkers=9 &' <<<\"\$(wrap f3e 'npm test &')\""
expect "npm test in a subshell: the cap stays inside the parentheses" "grep -q -- '(npm test -- --maxWorkers=9)' <<<\"\$(wrap f3f '(npm test)')\""
expect "bun test is Bun's own runner, not the test script: not rewritten" "! grep -q -- 'maxWorkers' <<<\"\$(wrap f3g 'bun test')\""
mkdir -p sub && echo '{"scripts":{"test":"mocha"}}' > sub/package.json
expect "cd sub && npm test reads sub/package.json (mocha there): not given a Jest flag" "! grep -q -- 'maxWorkers' <<<\"\$(wrap f3h 'cd sub && npm test')\""
rm -r sub
rm package.json
mkdir -p node_modules/vitest && echo '{"version":"3.2.4"}' > node_modules/vitest/package.json
fake_mem 19500   # 79%: 2618 MB left; vitest's 13 workers need 3500
expect "vitest 3: capped with --minWorkers=1 so the pool can't conflict" "grep -q -- 'vitest run --minWorkers=1 --maxWorkers=' <<<\"\$(wrap f4 'npx vitest run')\""
rm -r node_modules
fake_mem 21500; out=$(wrap f5 'npx jest --ci')   # 87%: 618 MB left; one worker needs 650
expect "not even one worker fits and nothing to wait for: refused, saying so" "grep -q 'exit=2' <<<\"\$out\" && grep -q 'even capped at one worker' $T/err"
fake_mem 18432   # 75%: 3686 MB left
node -e 'require("fs").writeFileSync(process.argv[1]+"/peaks.json",JSON.stringify({[process.argv[2]+"|jest --ci"]:{v:2,runs:[{mb:6500,w:13}],mb:6500,n:1,kind:"test"}}))' "$T/data" "$R"
expect "a measured 6.5 GB run at 13 workers predicts 6 workers in 3.7 GB" "grep -q -- '--maxWorkers=6' <<<\"\$(wrap f6 'npx jest --ci')\""
out=$(wrap f7 'npx jest --ci --config jest.config.js')
expect "--config jest.config.js is still the whole suite, not one file" "grep -q -- '--maxWorkers=' <<<\"\$out\""
out=$(wrap f7b 'npx jest src/a.test.ts')
expect "one test file isn't costed as the whole suite: runs as written" "grep -q -- '--kind test' <<<\"\$out\" && ! grep -q 'maxWorkers' <<<\"\$out\""
node -e 'require("fs").writeFileSync(process.argv[1]+"/peaks.json",JSON.stringify({[process.argv[2]+"|jest (targeted)"]:{v:2,runs:[{mb:4000,w:1}],mb:4000,n:1,kind:"test"}}))' "$T/data" "$R"
out=$(wrap f7c 'npx jest src/a.test.ts')
expect "a one-file run measured at 4 GB in one worker isn't scaled down to fit 3.7 GB" "grep -q 'exit=2' <<<\"\$out\" && ! grep -q 'maxWorkers' <<<\"\$out\""
rm "$T/data/peaks.json"
fake_mem 17000   # 69%: 5118 MB left; jest's 4850 MB would fit if nothing else were starting
perl -e 'setpgrp(0, 0); exec @ARGV' sleep 20 & HP=$!; sleep 0.3
mkdir -p "$T/data/runs"; printf '{"pgid":%s,"start":%s,"cmd":"x","kind":"test","need":3000}' $HP "$(date +%s)000" > "$T/data/runs/$HP.json"
expect "a run started seconds ago holds its expected 3 GB: the next run fits the rest (5 workers)" "grep -q -- '--maxWorkers=5' <<<\"\$(wrap f8 'npx jest --ci')\""
kill $HP 2>/dev/null; rm -f "$T/data/runs/$HP.json"
wrap_keep h1 'npx jest --ci' >/dev/null; out=$(wrap_keep h2 'npx jest --ci')
expect "holds: a run admitted a moment ago (its guard not started yet) holds its room: the next isn't let in at full width" "grep -q 'exit=2' <<<\"\$out\" && grep -q 'even capped at one worker' $T/err"
rm -rf "$T/data/holds"
mkdir -p bin && printf '#!/bin/sh\necho "jest $*" >> "%s/jestlog"\n' "$T" > bin/jest && chmod +x bin/jest
echo '{"checks":[{"name":"unit","run":"./bin/jest --ci","cache":false}]}' > .claude/proof.json
fake_mem 18432; gout=$(node "$S/gate.mjs" --run "$R" 2>&1)
expect "the gate fits a check the same way (ran: $(cat "$T/jestlog" 2>/dev/null))" "grep -q -- '--maxWorkers=9 --ci' $T/jestlog"
echo '{"checks":[{"name":"t","run":"true"}]}' > .claude/proof.json; rm -r bin
unset PROOF_CPUS
fake_mem 9000
printf '{"t":%s,"kind":"memoryStop","pid":1,"command":"node expo start --web","mb":1200,"pct":91}\n' "$(date +%s)000" >> "$T/data/memory-events.jsonl"
out=$(wrap s5 'ls'); expect "a memory stop is passed on to Claude at its next command" "grep -q 'proof memory: the [A-Za-z]* reached 91%' <<<\"\$out\""
out=$(wrap s5 'ls'); expect "and only once" "! grep -q 'reached 91%' <<<\"\$out\""

echo "== agents and new browsers"
fake_mem 23000
expect "93%: a new agent is refused" "grep -q 'exit=2' <<<\"\$(admit Agent)\" && grep -q 'not able to start another agent' $T/err"
expect "93%: a new Playwright browser is refused" "grep -q 'exit=2' <<<\"\$(admit mcp__playwright__browser_navigate)\""
expect "93%: clicking in a browser that's already open is fine" "grep -q 'exit=0' <<<\"\$(admit mcp__playwright__browser_click)\""
expect "93%: Claude in Chrome (your own browser) is never blocked" "grep -q 'exit=0' <<<\"\$(admit mcp__claude-in-chrome__navigate)\""
fake_mem 9000; expect "40%: a new agent starts" "[ \"\$(admit Agent)\" = 'exit=0' ]"

echo "== memory pressure and swap (the percentage alone can look calm)"
printf '{"totalMB":24576,"usedMB":17000,"pressure":"critical","swapMB":9000}' > "$T/mem.json"
out=$(wrap s6 'npx jest --ci')
expect "69% but critical pressure: a heavy run is refused, and the reason is the pressure, not the ceiling" "grep -q 'exit=2' <<<\"\$out\" && grep -q 'critical memory pressure and 8.8 GB is swapped' $T/err && ! grep -q 'past proof' $T/err && [ \$(grep -o 'is swapped to disk' $T/err | wc -l) -eq 1 ]"
expect "critical pressure: a new agent is refused too" "grep -q 'exit=2' <<<\"\$(admit Agent)\" && grep -q 'critical memory pressure' $T/err"
printf '{"totalMB":24576,"usedMB":12000,"pressure":"warn","swapMB":9000}' > "$T/mem.json"
out=$(wrap s7 'npx jest --ci')
expect "49% with raised pressure: runs, with a note that names the pressure and the swap" "grep -q -- '--kind test' <<<\"\$out\" && grep -q 'raised memory pressure and 8.8 GB is swapped' <<<\"\$out\""
printf '{"totalMB":24576,"usedMB":12000,"pressure":"normal","swapMB":9000}' > "$T/mem.json"
expect "normal pressure with old swap: no note (swap stays high after the pressure passes)" "! wrap s8 'npx jest --ci' | grep -q 'pressure\\|swapped' && [ \"\$(admit Agent)\" = 'exit=0' ]"
fake_mem 9000

echo "== the guard: wait loops, the machine ceiling, learned needs"
node "$S/guard.mjs" --timeout 2 --kind wait -- 'sleep 30 # waitprobe' 2>"$T/g1"; r=$?
expect "a wait loop stops at its limit with advice to check the run itself" "[ $r -eq 124 ] && grep -q 'its condition never came true' $T/g1 && ! grep -q 'Find the cause' $T/g1"
node "$S/guard.mjs" --timeout 60 --kind test -- 'sleep 40 # runA' 2>"$T/gA" & GA=$!; sleep 1.2
node "$S/guard.mjs" --timeout 60 --kind test -- 'sleep 40 # runB' 2>"$T/gB" & GB=$!; sleep 1.5
fake_mem 23000
wait $GB; tB=$(now_ms)
expect "machine over the ceiling: the newest run (B) is stopped first, as a memory stop" "grep -q 'machine memory: the [A-Za-z]* reached' $T/gB && grep -q 'stopped first' $T/gB"
expect "the older run (A) is still going when B stops" "[ \$(alive 'sleep 40 # runA') -ge 1 ]"
wait $GA; tA=$(now_ms)
expect "then A is stopped too, after B ($(( tA - tB ))ms later)" "grep -q 'machine memory' $T/gA && [ $tA -gt $tB ]"
expect "memory stops are logged for the monitor and Claude" "[ \$(grep -c '\"guarded\":true' $T/data/memory-events.jsonl) -ge 2 ]"
fake_mem 9000
node "$S/guard.mjs" --timeout 30 --kind test -- "node -e \"const b=Buffer.alloc(300*2**20,1);setTimeout(()=>console.log(b.length),2500)\"" >/dev/null 2>&1
sleep 0.5
expect "the guard learns how much memory a command needed" "node -e 'const p=require(\"$T/data/peaks.json\"); process.exit(Object.values(p).some(e=>e.kind===\"test\"&&e.mb>250)?0:1)'"
mkdir -p bin && cat > bin/jest <<'EOF2'
#!/bin/sh
node -e "const {spawn}=require('child_process');for(let i=0;i<3;i++)spawn(process.execPath,['-e','const b=Buffer.alloc(100*2**20,1);setTimeout(()=>{},2500)'],{stdio:'inherit'});const b=Buffer.alloc(60*2**20,1);setTimeout(()=>{},2700)"
EOF2
chmod +x bin/jest
PROOF_CPUS=14 node "$S/guard.mjs" --timeout 30 --kind test -- './bin/jest --maxWorkers=3 --ci' >/dev/null 2>&1; sleep 1.5; rm -r bin
expect "and how many workers it had, so the need scales with them" "node -e 'const e=require(\"$T/data/peaks.json\")[process.argv[1]+\"|jest --ci\"]; process.exit(e&&e.v===2&&e.runs.at(-1).w===3&&e.runs.at(-1).mb>150?0:1)' \"$R\""

echo "== quick mode"
stop() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],prompt_id:process.argv[3],stop_hook_active:false,last_assistant_message:"Done."}))' "$1" "$R" "$2" | node "$S/gate.mjs"; }
commit() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],tool_name:"Bash",tool_input:{command:process.argv[3]}}))' "$1" "$R" "$2" | node "$S/gate.mjs" --commit 2>"$T/cerr"; echo "exit=$?"; }
ss() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],source:"startup"}))' "$1" "$R" | node "$S/session-start.mjs"; }
ctx=$(ss q1)
expect "session context: memory line, dashboard address, 15 rules" "grep -q 'Memory now:' <<<\"\$ctx\" && grep -q 'http://127.0.0.1:47331/' <<<\"\$ctx\" && grep -q '15. Small, clear fixes' <<<\"\$ctx\""
out=$(node "$S/gate.mjs" --quick q1); expect "--quick turns it on and says the limits" "grep -q 'Quick mode is on' <<<\"\$out\""
echo 'export const a = 2' > src/a.ts
out=$(stop q1 p1); expect "a one-file change passes in quick mode" "grep -q 'proof ✓' <<<\"\$out\" && ! grep -q 'decision' <<<\"\$out\""
for i in 1 2 3 4; do echo "export const b$i = 1" > src/b$i.ts; done
out=$(stop q1 p2); expect "five files: blocked once, back to the full process" "grep -q 'no longer a quick fix: 5 files' <<<\"\$out\" && grep -q '\"decision\":\"block\"' <<<\"\$out\""
out=$(stop q1 p3); expect "after the switch, the gate runs as usual" "grep -q 'proof ✓' <<<\"\$out\""
git add -A && git commit -qm wip
ss q2 >/dev/null; node "$S/gate.mjs" --quick q2 >/dev/null; mkdir -p supabase/migrations; echo 'select 1;' > supabase/migrations/001.sql
out=$(stop q2 p1); expect "a migration ends quick mode even as a single file" "grep -q 'touches supabase/migrations/001.sql' <<<\"\$out\""
git add -A && git commit -qm wip2
ss q3 >/dev/null; node "$S/gate.mjs" --quick q3 >/dev/null; echo 'export const a = 3' > src/a.ts
r=$(commit q3 'git add -A && git commit -m fix')
expect "a commit that passes ends quick mode" "grep -q 'exit=0' <<<\"\$r\" && ! grep -q '\"quick\"' $T/data/sessions/q3-*.json"
out=$(node "$S/gate.mjs" --quick '${CLAUDE_SESSION_ID}'); expect "an unsubstituted session id is reported, not recorded" "grep -q 'could not be recorded' <<<\"\$out\""
git checkout -q -- . 2>/dev/null; git clean -fdq 2>/dev/null

echo "== the gate takes turns for memory and reports what it's doing"
echo '{"checks":[{"name":"one","run":"sleep 2","cache":false},{"name":"two","run":"sleep 2","cache":false}]}' > .claude/proof.json
fake_mem 9000; t0=$(now_ms); node "$S/gate.mjs" --run "$R" >/dev/null; ms1=$(( $(now_ms) - t0 ))
fake_mem 23000; t0=$(now_ms); node "$S/gate.mjs" --run "$R" >/dev/null; ms2=$(( $(now_ms) - t0 ))
expect "room to spare: checks run side by side (${ms1}ms); over the ceiling: one at a time (${ms2}ms)" "[ $ms1 -lt 3500 ] && [ $ms2 -ge 3900 ]"
fake_mem 9000
git add -A && git commit -qm cfg
ss g1 >/dev/null; echo 'export const a = 9' > src/a.ts
stop g1 p1 >/dev/null & SG=$!; sleep 1.2
expect "while the gate runs, its live file says which checks are running" "grep -q '\"state\":\"running\"' $T/data/live/gate-g1.json"
wait $SG; expect "and it's removed when the gate finishes" "[ ! -f $T/data/live/gate-g1.json ]"

echo "== timeline: sleep detection and resumed sessions"
node --input-type=module -e "
import { Session, silentWindows } from '$S/timeline.mjs';
const t0 = Date.parse('2026-10-12T00:00:00Z'), m = 60e3;
const mk = (rows) => { const s = new Session('/x/a.jsonl'); for (const r of rows) s.feed(r); return s; };
const tu = (t, id) => ({ type: 'assistant', timestamp: new Date(t).toISOString(), requestId: 'r' + t, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npx jest' } }] } });
const tr = (t, id) => ({ type: 'user', timestamp: new Date(t).toISOString(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
// two calls in flight, 90 silent minutes, both finish within 3 minutes of activity resuming: asleep
const s = mk([tu(t0, 'a'), tu(t0 + m, 'b'), tr(t0 + 92 * m, 'a'), tr(t0 + 93 * m, 'b')]);
const w = silentWindows(s);
// one call, 30 silent minutes: could just be slow, not called sleep
const s2 = mk([tu(t0, 'c'), tr(t0 + 31 * m, 'c')]);
process.exit(w.length === 1 && w[0][1] - w[0][0] > 80 * m && silentWindows(s2).length === 0 ? 0 : 1);
" ; expect "a silence with several calls finishing right after it is sleep; one slow call isn't" "[ $? -eq 0 ]"
mkdir -p "$T/fork" && node --input-type=module -e "
import { writeFileSync } from 'fs';
const t0 = Date.now() - 3600e3; const row = (i, t) => JSON.stringify({ type: 'user', uuid: 'u' + i, timestamp: new Date(t).toISOString(), message: { content: 'prompt ' + i } });
writeFileSync('$T/fork/a.jsonl', [0, 1, 2].map(i => row(i, t0 + i * 60e3)).join('\n') + '\n');
writeFileSync('$T/fork/b.jsonl', [1, 2, 3].map(i => row(i, t0 + i * 60e3)).join('\n') + '\n');
"
expect "a resumed session's copied lines are counted once" "node --input-type=module -e \"import { loadSessions } from '$S/timeline.mjs'; const ss = loadSessions(['$T/fork']); process.exit(ss.reduce((n, s) => n + s.prompts.length, 0) === 4 ? 0 : 1)\""

echo "== the monitor"
export PROOF_DASHBOARD_PORT=47399 CLAUDE_CONFIG_DIR=$T/cc
SID=11111111-2222-3333-4444-555555555555; PD=$T/cc/projects/-x-repo; mkdir -p "$PD/$SID/subagents"
node --input-type=module -e "
import { writeFileSync } from 'fs';
const now = Date.now(), iso = t => new Date(t).toISOString(); let n = 0;
const base = { sessionId: '$SID', cwd: '$R', gitBranch: 'main' };
const rows = [
  { type: 'ai-title', aiTitle: 'Build the settings screen' },
  { ...base, type: 'user', uuid: 'a' + n++, timestamp: iso(now - 20 * 60e3), message: { content: 'build the settings screen' } },
  { ...base, type: 'assistant', uuid: 'a' + n++, timestamp: iso(now - 19 * 60e3), requestId: 'q1', message: { model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Agent', input: { description: 'Lane A: settings', subagent_type: 'general-purpose', run_in_background: true } }] } },
  { ...base, type: 'user', uuid: 'a' + n++, timestamp: iso(now - 19 * 60e3 + 500), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Async agent launched successfully. agentId: ag1' }] } },
  { ...base, type: 'assistant', uuid: 'a' + n++, timestamp: iso(now - 18 * 60e3), requestId: 'q2', message: { model: 'claude-x', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Started the lane.' }] } },
];
writeFileSync('$PD/$SID.jsonl', rows.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync('$PD/$SID/subagents/agent-ag1.meta.json', JSON.stringify({ agentType: 'general-purpose', description: 'Lane A: settings', toolUseId: 't1' }));
writeFileSync('$PD/$SID/subagents/agent-ag1.jsonl', [
  { ...base, isSidechain: true, agentId: 'ag1', type: 'user', uuid: 'b1', timestamp: iso(now - 19 * 60e3), message: { content: 'do the settings screen' } },
  { ...base, isSidechain: true, agentId: 'ag1', type: 'assistant', uuid: 'b2', timestamp: iso(now - 3 * 60e3), requestId: 'q3', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run e2e -- e2e/settings.spec.ts', description: 'Run the settings e2e spec' } }] } },
].map(r => JSON.stringify(r)).join('\n') + '\n');
"
url=$(node "$S/monitor.mjs" --ensure)
MP=$(node -e 'console.log(require(process.argv[1]).pid)' "$T/data/monitor.json" 2>/dev/null)
trap '[ -n "${MP:-}" ] && kill "$MP" 2>/dev/null' EXIT   # never leave the monitor running, even if a check fails
expect "--ensure starts it and prints the address" "[ \"\$url\" = 'http://127.0.0.1:47399/' ]"
expect "it answers /health" "curl -s http://127.0.0.1:47399/health | grep -q '\"proof\":true'"
expect "it refuses other host names (DNS rebinding)" "[ \$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example' http://127.0.0.1:47399/data.json) = 403 ]"
sleep 2; curl -s 'http://127.0.0.1:47399/data.json?hours=1' > "$T/d.json"
expect "the session is there, with its title and the agent mid-work" "node -e 'const d=require(\"$T/d.json\");const v=d.sessions[0];process.exit(v&&v.title===\"Build the settings screen\"&&v.status.state===\"agents\"&&v.now.some(n=>/Lane A/.test(n.who)&&n.cat===\"test\")?0:1)'"
expect "memory is sampled" "node -e 'const d=require(\"$T/d.json\");process.exit(typeof d.machine.system.pct===\"number\"&&d.machine.samples.length>0?0:1)'"
expect "the page is served" "curl -s http://127.0.0.1:47399/ | grep -q 'proof · live'"
printf '{"pid":%s,"mode":"stop","start":%s,"checks":[{"name":"types","state":"running"},{"name":"test","state":"passed"}]}' $$ "$(date +%s)000" > "$T/data/live/gate-$SID.json"
sleep 2; curl -s 'http://127.0.0.1:47399/data.json?hours=1' > "$T/d2.json"
expect "a running gate shows as the main thread's status" "node -e 'const v=require(\"$T/d2.json\").sessions[0];process.exit(v.status.cat===\"gate\"&&/proof gate: types \\(1 of 2 done\\)/.test(v.status.label)?0:1)'"
rm -f "$T/data/live/gate-$SID.json"
kill -STOP "$MP"; sleep 23; kill -CONT "$MP"; sleep 3
curl -s 'http://127.0.0.1:47399/data.json?hours=1' > "$T/d3.json"
expect "a frozen stretch (like the Mac sleeping) is recorded" "node -e 'const a=require(\"$T/d3.json\").machine.asleep;process.exit(a.length===1&&a[0][1]-a[0][0]>=20000?0:1)'"
node "$S/monitor.mjs" --stop; sleep 0.5
expect "--stop stops it" "! curl -s --max-time 1 http://127.0.0.1:47399/health >/dev/null"

echo "== a monitor whose plugin folder moved (an update, or the old install sent to the Trash)"
monitor_pid() { node -e 'console.log(require(process.argv[1]).pid)' "$T/data/monitor.json" 2>/dev/null; }
page_code() { curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:47399/; }
cp -R "$S" "$T/install"; node "$T/install/monitor.mjs" --ensure >/dev/null; MP=$(monitor_pid)
mv "$T/install" "$T/trashed"
expect "it still serves the page after its folder moves" "curl -s http://127.0.0.1:47399/ | grep -q 'proof · live'"
node "$S/monitor.mjs" --stop; sleep 0.5
cp -R "$S" "$T/broken"; rm "$T/broken/dashboard.html"; node "$T/broken/monitor.mjs" --ensure >/dev/null; MP=$(monitor_pid)
expect "(setup) a monitor that can't read its page answers 500" "[ \$(page_code) = 500 ]"
node "$S/monitor.mjs" --ensure >/dev/null; MP=$(monitor_pid)
expect "--ensure replaces a monitor whose page fails" "curl -s http://127.0.0.1:47399/ | grep -q 'proof · live'"
node "$S/monitor.mjs" --stop; sleep 0.5

finish
