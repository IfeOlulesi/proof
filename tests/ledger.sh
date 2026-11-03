#!/usr/bin/env bash
# The ledger: every gate run is recorded for good, and catches, flaky checks and blocked commits are counted from it.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
L="$HOME/.config/proof/ledger.jsonl"
unset PROOF_BACKFILL   # lib.sh turns the session-start backfill off for the other suites; this one tests it
mkdir -p src .claude
echo 'export const a = 1' > src/a.ts
# unit fails while src has BUG; flaky fails once per flag file, whatever the code.
cat > .claude/proof.json <<'EOF'
{ "checks": [
  {"name":"unit","run":"if grep -rq BUG src; then echo SECRET-OUTPUT; exit 1; fi","when":["src/"]},
  {"name":"flaky","run":"test -f \"$FLAKY\" || { touch \"$FLAKY\"; exit 1; }","when":["flaky/"],"cache":false}
], "maxRounds": 4 }
EOF
git add -A && git commit -qm init

stop() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],prompt_id:process.argv[3],stop_hook_active:process.argv[4]==="true",last_assistant_message:"Done."}))' "$1" "$R" "$2" "${3:-false}" | node "$S/gate.mjs"; }
commit() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],prompt_id:process.argv[3],tool_name:"Bash",tool_input:{command:"git commit -m x"}}))' "$1" "$R" "$2" | node "$S/gate.mjs" --commit 2>/dev/null; }
line() { tail -n "${1:-1}" "$L" | head -n 1; }
field() { node -e 'const e=JSON.parse(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o?.[k],e); console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
recap() { node "$S/recap.mjs" --json "$@"; }
num() { node -e 'const j=JSON.parse(process.argv[1]); console.log(j[process.argv[2]])' "$1" "$2"; }

echo "== a failing turn end is recorded"
echo 'BUG' >> src/a.ts
stop s1 p1 >/dev/null
expect "ledger file created under ~/.config/proof" "[ -s \"$L\" ]"
e=$(line)
expect "mode stop, outcome block, agent claude" "[ \"\$(field \"\$e\" mode)\" = stop ] && [ \"\$(field \"\$e\" outcome)\" = block ] && [ \"\$(field \"\$e\" agent)\" = claude ]"
expect "session, prompt, project root and HEAD recorded" "[ \"\$(field \"\$e\" session)\" = s1 ] && [ \"\$(field \"\$e\" prompt)\" = p1 ] && [ \"\$(field \"\$e\" root)\" = \"$R\" ] && [ -n \"\$(field \"\$e\" head)\" ] && [ -n \"\$(field \"\$e\" tree)\" ]"
expect "the failing check is listed with ok false" "[ \"\$(field \"\$e\" checks.0.name)\" = unit ] && [ \"\$(field \"\$e\" checks.0.ok)\" = false ]"
expect "check output is never stored" "! grep -q SECRET-OUTPUT \"$L\""

echo "== the fix passes: one catch"
echo 'export const a = 2' > src/a.ts
stop s1 p1 true >/dev/null
expect "pass recorded" "[ \"\$(field \"\$(line)\" outcome)\" = pass ]"
r=$(recap --session s1)
expect "1 catch, 0 flaky (got $r)" "[ \"\$(num \"\$r\" caught)\" = 1 ] && [ \"\$(num \"\$r\" flaky)\" = 0 ]"

echo "== two failing rounds before the pass still count once"
echo 'BUG' >> src/a.ts; stop s2 q1 >/dev/null
echo 'BUG2' >> src/a.ts; stop s2 q1 true >/dev/null
echo 'export const a = 3' > src/a.ts; stop s2 q1 true >/dev/null
r=$(recap --session s2)
expect "1 catch over two failing rounds (got $r)" "[ \"\$(num \"\$r\" caught)\" = 1 ]"

echo "== fail then pass on the same code is flaky, not a catch"
export FLAKY="$T/flaky-flag"
mkdir -p flaky && echo x > flaky/f
stop s3 r1 >/dev/null
stop s3 r1 true >/dev/null
r=$(recap --session s3)
expect "0 caught, 1 flaky (got $r)" "[ \"\$(num \"\$r\" caught)\" = 0 ] && [ \"\$(num \"\$r\" flaky)\" = 1 ]"
rm -rf flaky

echo "== a blocked commit is recorded and counted"
echo 'BUG' >> src/a.ts
commit s4 c1
e=$(line)
expect "mode commit, outcome commitBlocked" "[ \"\$(field \"\$e\" mode)\" = commit ] && [ \"\$(field \"\$e\" outcome)\" = commitBlocked ]"
r=$(recap --session s4)
expect "1 commit blocked (got $r)" "[ \"\$(num \"\$r\" commitsBlocked)\" = 1 ]"
sed -i '' '/BUG/d' src/a.ts

echo "== a manual run is recorded without a session"
node "$S/gate.mjs" --run "$R" >/dev/null
e=$(line)
expect "mode manual" "[ \"\$(field \"\$e\" mode)\" = manual ]"

echo "== PROOF_LEDGER moves it"
PROOF_LEDGER="$T/elsewhere.jsonl" node "$S/gate.mjs" --run "$R" >/dev/null
expect "written to PROOF_LEDGER" "[ -s \"$T/elsewhere.jsonl\" ]"

echo "== receipt: a turn that caught something says so"
echo 'export const a = 4' > src/a.ts; out=$(stop s5 t1)
expect "a clean pass has no receipt (got: $out)" "grep -q 'proof ✓' <<<\"\$out\" && ! grep -q 'caught' <<<\"\$out\""
echo 'BUG' >> src/a.ts; stop s5 t2 >/dev/null
echo 'export const a = 5' > src/a.ts; out=$(stop s5 t2 true)
expect "fail → fix → pass adds what was caught this turn (got: $out)" "grep -q 'caught 1 failure this turn before you saw it (unit)' <<<\"\$out\""
expect "and the session's totals" "grep -q 'this session: 1 caught' <<<\"\$out\""
echo 'export const a = 6' > src/a.ts; out=$(stop s5 t3)
expect "the next clean turn has no receipt again (got: $out)" "! grep -q 'caught' <<<\"\$out\""

echo "== receipt without prompt ids: the turn is the runs since the last turn ended"
echo 'export const a = 7' > src/a.ts; stop s6 '' >/dev/null
echo 'BUG' >> src/a.ts; stop s6 '' >/dev/null
echo 'export const a = 8' > src/a.ts; out=$(stop s6 '' true)
expect "fail → fix → pass is receipted (got: $out)" "grep -q 'caught 1 failure this turn' <<<\"\$out\""
echo 'export const a = 9' > src/a.ts; out=$(stop s6 '')
expect "the next clean turn is quiet (got: $out)" "! grep -q 'caught' <<<\"\$out\""

echo "== recap: totals over a period, as text"
out=$(node "$S/recap.mjs")
expect "names the period and the catches (got: $out)" "grep -q 'the last 7d' <<<\"\$out\" && grep -qE 'caught before you saw them +4' <<<\"\$out\""
expect "names the flaky check" "grep -q 'flaky (passed on a rerun) *1  (flaky)' <<<\"\$out\""
old=$(node -e 'console.log(JSON.stringify({v:1,t:Date.now()-30*864e5,agent:"claude",session:"old",mode:"stop",outcome:"commitBlocked",checks:[]}))')
echo "$old" >> "$L"
r=$(recap); r30=$(recap --since 60d)
expect "--since widens the period (7d: $(num "$r" commitsBlocked), 60d: $(num "$r30" commitsBlocked))" "[ \"\$(num \"\$r30\" commitsBlocked)\" = \$(( \$(num \"\$r\" commitsBlocked) + 1 )) ]"

echo "== a failure the user was already shown is not caught later"
echo 'BUG' >> src/a.ts; stop s7 u1 >/dev/null
node -e 'process.stdout.write(JSON.stringify({session_id:"s7",cwd:process.argv[1],prompt_id:"u1",stop_hook_active:true,last_assistant_message:"Blocked.\nNEEDS-INPUT: is this check right?"}))' "$R" | node "$S/gate.mjs" >/dev/null
expect "asked the user is recorded" "[ \"\$(field \"\$(line)\" outcome)\" = askedUser ]"
echo 'export const a = 10' > src/a.ts; out=$(stop s7 u2)
expect "the next turn's pass has no receipt (got: $out)" "! grep -q 'caught' <<<\"\$out\""
r=$(recap --session s7)
expect "and no catch, but 1 handed back (got $r)" "[ \"\$(num \"\$r\" caught)\" = 0 ] && [ \"\$(num \"\$r\" askedUser)\" = 1 ]"

echo "== a failure reverted to the committed code is not caught later"
git add -A && git commit -qm 'a = 10'
echo 'BUG' >> src/a.ts; stop s8 v1 >/dev/null
git checkout -q -- src/a.ts; stop s8 v1 true >/dev/null
expect "the revert is recorded as clean" "[ \"\$(field \"\$(line)\" outcome)\" = clean ]"
echo 'export const a = 11' > src/a.ts; out=$(stop s8 v2)
r=$(recap --session s8)
expect "the later pass isn't a catch (got $r; $out)" "[ \"\$(num \"\$r\" caught)\" = 0 ] && ! grep -q 'caught' <<<\"\$out\""
expect "the clean line isn't counted as a gate run" "[ \"\$(num \"\$r\" runs)\" = 2 ]"

echo "== odd ledger lines and edge cases in counting"
SYN="$T/syn.jsonl"
node - "$SYN" <<'EOF2'
const fs = require('fs'); const t = Date.now() - 6e4;
const e = (i, x) => JSON.stringify({ v: 1, t: t + i, agent: 'claude', mode: 'stop', root: '/r1', tree: `t${i}`, ...x });
fs.writeFileSync(process.argv[2], [
  'null', '42', '{"broken"',
  e(1, { session: 'm', outcome: 'block', checks: [{ name: 'unit', ok: false, killed: true, machineMemory: true }, null] }),
  e(2, { session: 'm', outcome: 'pass', checks: [{ name: 'unit', ok: true }] }),
  e(3, { session: 'r', outcome: 'block', checks: [{ name: 'unit', ok: false }] }),
  e(4, { session: 'r', root: '/r2', outcome: 'pass', checks: [{ name: 'unit', ok: true }] }),
].join('\n') + '\n');
EOF2
r=$(PROOF_LEDGER="$SYN" node "$S/recap.mjs" --json 2>&1)
expect "lines that aren't objects don't crash the recap (got $r)" "[ -n \"\$(num \"\$r\" runs 2>/dev/null)\" ]"
expect "a check stopped for low machine memory isn't caught, nor is a failure closed by another repo's pass" "[ \"\$(num \"\$r\" caught)\" = 0 ]"
cat "$SYN" >> "$L"; echo 'export const a = 12' > src/a.ts; out=$(stop s9 w1)
expect "and they don't break the gate's passing message (got: $out)" "grep -q 'proof ✓' <<<\"\$out\""

echo "== backfill from Claude transcripts"
export PROOF_LEDGER="$T/backfill-ledger.jsonl"
mkdir -p "$CLAUDE_CONFIG_DIR/projects/p"
node - "$CLAUDE_CONFIG_DIR/projects/p/t1.jsonl" "$PROOF_LEDGER" <<'EOF'
const fs = require('fs');
const [file, ledger] = process.argv.slice(2);
const base = Date.now() - 864e5;
let n = 0;
const at = (i, extra) => ({ uuid: `u${n++}`, timestamp: new Date(base + i * 1000).toISOString(), sessionId: extra.session || 'b1', cwd: '/repo', gitBranch: 'main', promptId: 'pp', ...extra });
const sys = (i, content, extra = {}) => at(i, { type: 'attachment', attachment: { type: 'hook_system_message', content, hookEvent: 'Stop', toolUseID: `h${i}` }, ...extra });
const tool = (i, name, input, extra = {}) => at(i, { type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] }, ...extra });
const lines = [
  sys(1, 'proof: unit failing — sent back to Claude (round 1/5)'),
  { ...sys(1, 'proof: unit failing — sent back to Claude (round 1/5)') },            // logged twice: counts once
  tool(2, 'Edit', { file_path: '/repo/a.ts' }),
  at(3, { type: 'attachment', attachment: { type: 'hook_success', hookEvent: 'Stop', toolUseID: 'h3', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs"', durationMs: 65000 } }),
  sys(3, 'proof ✓ unit (fast), lint (cached) · full checks run before each commit'),
  at(4, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', is_error: true, content: 'PreToolUse:Bash hook error: [node "gate.mjs" --commit]: proof: commit blocked — 1 of 2 full check(s) failing. Every relevant check must pass in full before a commit.\n\n✗ lint — `eslint .` exited 1\nsrc/a.ts' }] } }),
  sys(5, 'proof: lint failing — sent back to Claude (round 1/5)'),
  tool(6, 'Bash', { command: 'ls src' }),                                              // read-only: not a change
  sys(7, 'proof ✓ lint passed'),                                                     // older wording
  // a session the gate has logged live since t=10: only what came before is added
  sys(8, 'proof: unit failing — sent back to Claude (round 1/5)', { sessionId: 'live1' }),
  tool(9, 'Write', { file_path: '/repo/b.ts' }, { sessionId: 'live1' }),
  sys(11, 'proof ✓ unit', { sessionId: 'live1' }),
  // a subagent fixes it: its edits are in its own log, so the Agent call stands in for them
  sys(20, 'proof: unit failing — sent back to Claude (round 1/5)', { sessionId: 'sub1' }),
  tool(21, 'Agent', { description: 'fix unit' }, { sessionId: 'sub1' }),
  sys(22, 'proof ✓ unit', { sessionId: 'sub1' }),
  // a command that only writes to /dev/null or /tmp isn't a change
  sys(30, 'proof: unit failing — sent back to Claude (round 1/5)', { sessionId: 'nul1' }),
  tool(31, 'Bash', { command: 'npm test > /dev/null 2>&1; grep x src > /tmp/out.txt; python3 scripts/report.py' }, { sessionId: 'nul1' }),
  sys(32, 'proof ✓ unit', { sessionId: 'nul1' }),
  // fails in the transcript, passes live, nothing edited in between: unknown, not a catch
  sys(40, 'proof: unit failing — sent back to Claude (round 1/5)', { sessionId: 'live2' }),
];
// a resumed session's file repeats the original's records (same uuids) under its own session id
const resumed = lines.filter(l => (l.sessionId || 'b1') === 'b1').map(l => ({ ...l, sessionId: 'b1-resumed' }));
fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
fs.writeFileSync(file.replace('t1.jsonl', 't2.jsonl'), resumed.map(l => JSON.stringify(l)).join('\n') + '\n');   // written later, as a resumed session's is
fs.writeFileSync(ledger, [
  { v: 1, t: base + 10000, agent: 'claude', session: 'live1', root: '/repo', mode: 'stop', outcome: 'pass', tree: 'x', checks: [{ name: 'unit', ok: true }] },
  { v: 1, t: base + 41000, agent: 'claude', session: 'live2', root: '/repo', mode: 'stop', outcome: 'pass', tree: 'y', checks: [{ name: 'unit', ok: true }] },
].map(e => JSON.stringify(e)).join('\n') + '\n');

EOF
out=$(node "$S/recap.mjs" --backfill)
expect "recap.mjs --backfill reports what it added; a resumed session's copies count once (got: $out)" "grep -q 'proof backfill: 11 gate runs from 5 sessions' <<<\"\$out\""
r=$(recap --session b1)
expect "transcript: 1 catch, 1 flaky, 1 commit blocked (got $r)" "[ \"\$(num \"\$r\" caught)\" = 1 ] && [ \"\$(num \"\$r\" flaky)\" = 1 ] && [ \"\$(num \"\$r\" commitsBlocked)\" = 1 ]"
expect "the gate's logged time counts as time in checks (got $(num "$r" checkMs))" "[ \"\$(num \"\$r\" checkMs)\" = 65000 ]"
expect "lines are marked as from transcripts" "[ \$(grep -c '\"src\":\"transcript\"' \"$PROOF_LEDGER\") = 11 ]"
r=$(recap --session sub1)
expect "a subagent call between failure and pass counts as a change (got $r)" "[ \"\$(num \"\$r\" caught)\" = 1 ]"
r=$(recap --session nul1)
expect "writes to /dev/null and /tmp, and running a script, aren't a change (got $r)" "[ \"\$(num \"\$r\" caught)\" = 0 ] && [ \"\$(num \"\$r\" flaky)\" = 1 ]"
r=$(recap --session live2)
expect "a transcript failure then a live pass can't be compared: neither caught nor flaky (got $r)" "[ \"\$(num \"\$r\" caught)\" = 0 ] && [ \"\$(num \"\$r\" flaky)\" = 0 ]"
r=$(recap --session live1)
expect "live session: only the transcript run before the first live line is added, and its failure can't be compared with the live pass (got $r)" "[ \"\$(num \"\$r\" runs)\" = 2 ] && [ \"\$(num \"\$r\" caught)\" = 0 ] && [ \"\$(num \"\$r\" flaky)\" = 0 ]"
node "$S/backfill.mjs" >/dev/null
expect "a second backfill adds nothing" "[ \$(grep -c '\"src\":\"transcript\"' \"$PROOF_LEDGER\") = 11 ]"

echo "== backfill from a folder with a space in its path"
mkdir -p "$T/with space" && cp -R "$S" "$T/with space/"
PROOF_LEDGER="$T/sp/ledger.jsonl" node "$T/with space/scripts/backfill.mjs" >/dev/null
expect "it still runs" "[ -s \"$T/sp/backfill.json\" ]"
expect "marker written" "[ -s \"$(dirname "$PROOF_LEDGER")/backfill.json\" ]"

echo "== session start backfills once, in the background"
export PROOF_LEDGER="$T/ss/ledger.jsonl"
ss() { node -e 'process.stdout.write(JSON.stringify({session_id:"z",cwd:process.argv[1],source:"startup"}))' "$R" | node "$S/session-start.mjs" >/dev/null; }
ss
for i in $(seq 1 50); do [ -s "$T/ss/backfill.json" ] && break; node -e 'setTimeout(()=>{},100)'; done
expect "the first session start backfilled (no live runs in this ledger, so all 12)" "[ \$(grep -c '\"src\":\"transcript\"' \"$PROOF_LEDGER\") = 12 ]"
ss; node -e 'setTimeout(()=>{},1500)'
expect "the next one doesn't run it again" "[ \$(grep -c '\"src\":\"transcript\"' \"$PROOF_LEDGER\") = 12 ]"

echo "== a backfill that died leaves a stale lock, which the next session start takes over"
export PROOF_LEDGER="$T/stale/ledger.jsonl"
mkdir -p "$T/stale" && touch -t 202001010000 "$T/stale/backfill.json.lock"
ss
for i in $(seq 1 50); do [ -s "$T/stale/backfill.json" ] && break; node -e 'setTimeout(()=>{},100)'; done
expect "it ran" "[ -s \"$T/stale/backfill.json\" ]"

finish
