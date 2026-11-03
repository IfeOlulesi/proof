#!/usr/bin/env bash
# The dashboard's data and page: how session logs become what the page shows, and that the page itself loads.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# log <file> <minutes ago> <json>: append one session-log line, stamped that many minutes ago.
log() { node -e 'const [f, ago, j] = process.argv.slice(1); const r = JSON.parse(j); r.timestamp = new Date(Date.now() - Number(ago) * 60e3).toISOString(); r.uuid = r.uuid || Math.random().toString(36).slice(2); r.sessionId = "s1"; r.cwd = "/tmp/app"; require("fs").appendFileSync(f, JSON.stringify(r) + "\n")' "$@"; }
ask()    { log "$1" "$2" "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"$3\"}}"; }
call()   { log "$1" "$2" "{\"type\":\"assistant\",\"message\":{\"id\":\"m$4\",\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"id\":\"t$4\",\"name\":\"$3\",\"input\":$5}]}}"; }
result() { log "$1" "$2" "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"tool_use_id\":\"t$3\",\"content\":$4}]}}"; }
# view <file>: the session as the page gets it.
view() { node --input-type=module -e "import { loadSessions } from '$S/timeline.mjs'; import { board } from '$S/dashboard.mjs'; const [s] = loadSessions(['$(dirname "$1")']); console.log(JSON.stringify(board([s], { windowMs: 24 * 3600e3 }).sessions[0]))"; }
field() { node -e 'const v = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(JSON.stringify(eval(process.argv[1])))' "$1"; }

echo "== time spent on a plan approval is time waiting on you"
mkdir -p "$T/l1"; L="$T/l1/s1.jsonl"
ask "$L" 30 'plan the checkout flow'
call "$L" 29 ExitPlanMode 1 '{"plan":"1. cart 2. payment"}'
result "$L" 20 1 '"User has approved your plan."'
v=$(view "$L")
expect "about 9 minutes count as waiting on you" "[ \$(field 'Math.round((v.share.waitUser||0)/60e3)' <<<\"\$v\") -ge 8 ]"
expect "and none as planning" "[ \$(field 'Math.round((v.share.plan||0)/60e3)' <<<\"\$v\") -eq 0 ]"
expect "the step reads as asking you to approve the plan" "field 'v.feed.map(f=>f.desc)' <<<\"\$v\" | grep -q 'Ask you to approve the plan'"

echo "== a question left open for hours is still a question, not a stall"
mkdir -p "$T/l2"; L="$T/l2/s1.jsonl"
ask "$L" 500 'rename the project'
call "$L" 490 AskUserQuestion 1 '{"questions":[{"question":"Which name?"}]}'
v=$(view "$L")
expect "8 hours later the session needs you" "[ \$(field 'v.status.state' <<<\"\$v\") = '\"needsInput\"' ]"
expect "and says Claude asked you something" "field 'v.status.label' <<<\"\$v\" | grep -q 'asked you something'"
mkdir -p "$T/l2b"; L="$T/l2b/s1.jsonl"
ask "$L" 300 'plan it'
call "$L" 290 ExitPlanMode 1 '{"plan":"1. a"}'
ask "$L" 200 'never mind, just do it'
call "$L" 199 Read 2 '{"file_path":"/tmp/app/a.ts"}'
result "$L" 199 2 '"ok"'
v=$(view "$L")
expect "a question the session moved on from doesn't pin it as needing you" "[ \$(field 'v.status.state' <<<\"\$v\") != '\"needsInput\"' ]"

echo "== memory notices come from proof, not from reading proof's source"
mkdir -p "$T/l3"; L="$T/l3/s1.jsonl"
ask "$L" 10 'why was the run refused'
call "$L" 9 Grep 1 '{"pattern":"proof memory"}'
result "$L" 9 1 "\"scripts/wrap.mjs:88:  const msg = \`proof memory: not starting this \${kind} run. The \${MACHINE} is at \${pct}%\`;\""
call "$L" 8 Bash 2 '{"command":"npx jest --ci"}'
result "$L" 8 2 '"PreToolUse:Bash hook error: [node \"/x/plugins/proof/scripts/wrap.mjs\"]: proof memory: not starting this test run. The Mac is at 85% (20.5 GB of 24.0 GB) and this run needs about 1.5 GB."'
v=$(view "$L")
expect "one memory event: the real refusal" "[ \$(field 'v.events.filter(e=>e.kind===\"memory\").length' <<<\"\$v\") -eq 1 ]"
expect "starting at proof's own words" "field 'v.events.filter(e=>e.kind===\"memory\").map(e=>e.text)' <<<\"\$v\" | grep -q '\"proof memory: not starting this test run'"
expect "with no template text in it" "! field 'v.events.map(e=>e.text)' <<<\"\$v\" | grep -q '\\\${'"

echo "== the agent drill-down gets each agent's prompt"
mkdir -p "$T/l4/s1/subagents"; L="$T/l4/s1.jsonl"
ask "$L" 20 'build it'
call "$L" 19 Agent 1 '{"description":"Lane B unit 13: payment screen","subagent_type":"general-purpose","prompt":"Build the payment screen to the mockup.","run_in_background":true}'
result "$L" 19 1 '"Async agent launched"'
A="$T/l4/s1/subagents/agent-a1.jsonl"
printf '{"agentType":"general-purpose","description":"Lane B unit 13: payment screen","toolUseId":"t1"}' > "$T/l4/s1/subagents/agent-a1.meta.json"
call "$A" 18 Edit 5 '{"file_path":"/tmp/app/src/pay.tsx"}'
result "$A" 18 5 '"ok"'
v=$(view "$L")
expect "units[].prompt is the prompt it was launched with" "field 'v.units[0] && v.units[0].prompt' <<<\"\$v\" | grep -q 'Build the payment screen to the mockup.'"

echo "== another agent's event log becomes the same session model as a Claude transcript"
# One session, written twice: as Claude Code's transcript, and as the event log proof's hooks write for other agents.
mkdir -p "$T/l5" "$T/ev/events/opencode"
node -e '
const [dir, evdir] = process.argv.slice(1), fs = require("fs"), now = Date.now(), at = m => now - m * 60e3, iso = m => new Date(at(m)).toISOString();
const base = { sessionId: "s5", cwd: "/tmp/app" };
let n = 0; const u = () => "u" + n++;
const tr = [
  { ...base, type: "user", uuid: u(), timestamp: iso(30), message: { content: "add the price filter" } },
  { ...base, type: "assistant", uuid: u(), timestamp: iso(29), requestId: "q1", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/tmp/app/src/filter.ts" } }] } },
  { ...base, type: "user", uuid: u(), timestamp: iso(28), message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
  { ...base, type: "assistant", uuid: u(), timestamp: iso(27), requestId: "q2", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npx vitest run src/filter.test.ts" } }] } },
  { ...base, type: "user", uuid: u(), timestamp: iso(25), message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "1 passed" }] } },
  { ...base, type: "assistant", uuid: u(), timestamp: iso(24), requestId: "q3", message: { stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } },
];
fs.writeFileSync(dir + "/s5.jsonl", tr.map(r => JSON.stringify(r)).join("\n") + "\n");
const e = (m, x) => JSON.stringify({ v: 1, t: at(m), agent: "opencode", session: "s5", cwd: "/tmp/app", ...x });
fs.writeFileSync(evdir + "/s5.jsonl", [
  e(31, { kind: "sessionStart", source: "startup" }),
  e(30, { kind: "userPrompt", prompt: "add the price filter" }),
  e(29, { kind: "toolStart", tool: { name: "edit", raw: "edit", summary: "/tmp/app/src/filter.ts", id: "t1" } }),
  e(28, { kind: "toolEnd", tool: { name: "edit", raw: "edit", summary: "/tmp/app/src/filter.ts", id: "t1" } }),
  e(27, { kind: "toolStart", tool: { name: "shell", raw: "bash", summary: "npx vitest run src/filter.test.ts", id: "t2" } }),
  e(25, { kind: "toolEnd", tool: { name: "shell", raw: "bash", summary: "npx vitest run src/filter.test.ts", id: "t2" } }),
  e(24, { kind: "turnEnd" }),
].join("\n") + "\n");
' "$T/l5" "$T/ev/events/opencode"
cmp_models() { node --input-type=module -e "
import { loadSessions } from '$S/timeline.mjs';
const [c] = loadSessions(['$T/l5']), [o] = loadSessions(['$T/ev/events/opencode']);
// What both can know: the prompts, each step (what, its category, when it started and ended), the counts, the state.
// Not compared: model time, tokens, the model's own text (hooks can't see them).
const m = s => ({ prompts: s.prompts.map(p => [p.t, p.text]), tools: s.tools.map(t => [t.cat, t.desc, t.start, t.end]), counts: [s.counts.toolCalls, s.counts.edits, s.counts.testRuns, s.counts.gateRounds], turnEnd: s.turnEnd, cwd: s.cwd, state: s.status().state });
const a = JSON.stringify(m(c)), b = JSON.stringify(m(o));
if (a !== b) { console.log('claude  ' + a); console.log('events  ' + b); process.exit(1); }
console.log(o.harness + ' ' + o.harnessLabel);
"; }
out=$(cmp_models); same=$?
[ $same -eq 0 ] || echo "$out"
expect "prompts, steps, counts and state are the same, field by field" "[ $same -eq 0 ] && grep -q 'opencode opencode' <<<\"\$out\""
# The comparison can fail: the event log one minute off on a tool's end is caught.
sed -i.bak 's/"kind":"toolEnd","tool":{"name":"edit"/"kind":"toolEnd","x":1,"tool":{"name":"edit"/' "$T/ev/events/opencode/s5.jsonl"
node -e 'const f=process.argv[1],fs=require("fs");const L=fs.readFileSync(f,"utf8").trim().split("\n").map(JSON.parse);L.find(l=>l.x).t-=60e3;fs.writeFileSync(f,L.map(l=>JSON.stringify(l)).join("\n")+"\n")' "$T/ev/events/opencode/s5.jsonl"
cmp_models >/dev/null; differs=$?
expect "and a step that ended a minute earlier in one of them is a difference" "[ $differs -ne 0 ]"
mv "$T/ev/events/opencode/s5.jsonl.bak" "$T/ev/events/opencode/s5.jsonl"
v=$(node --input-type=module -e "import { loadSessions } from '$S/timeline.mjs'; import { board } from '$S/dashboard.mjs'; const [s] = loadSessions(['$T/ev/events/opencode']); console.log(JSON.stringify(board([s], { windowMs: 24 * 3600e3 }).sessions[0]))")
expect "the page gets the agent's name with the session" "[ \$(field 'v.agent + \"/\" + v.agentLabel' <<<\"\$v\") = '\"opencode/opencode\"' ]"

echo "== an event log that stops mid-step: stopped after 10 quiet minutes, not working"
mkdir -p "$T/ev2/events/opencode"
node -e 'const at = m => Date.now() - m * 60e3; require("fs").writeFileSync(process.argv[1], [
  { v: 1, t: at(40), agent: "opencode", session: "s6", cwd: "/tmp/app", kind: "userPrompt", prompt: "run the e2e suite" },
  { v: 1, t: at(39), agent: "opencode", session: "s6", cwd: "/tmp/app", kind: "toolStart", tool: { name: "shell", raw: "bash", summary: "npx playwright test", id: "c1" } },
].map(r => JSON.stringify(r)).join("\n") + "\n{\"v\":1,\"t\":")' "$T/ev2/events/opencode/s6.jsonl"
st=$(node --input-type=module -e "import { loadSessions } from '$S/timeline.mjs'; const [s] = loadSessions(['$T/ev2/events/opencode']); console.log(s.status().state)")
expect "a truncated log quiet for 39 minutes isn't working (state: $st)" "! grep -qE 'working|thinking|agents' <<<\"$st\""
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ v: 1, t: Date.now() - 60e3, agent: "opencode", session: "s7", cwd: "/tmp/app", kind: "toolStart", tool: { name: "shell", raw: "bash", summary: "npx playwright test", id: "c1" } }) + "\n")' "$T/ev2/events/opencode/s7.jsonl"
st=$(node --input-type=module -e "import { loadSessions } from '$S/timeline.mjs'; const s = loadSessions(['$T/ev2/events/opencode']).find(x => x.id === 's7'); console.log(s.status().state)")
expect "a step started a minute ago is still working (state: $st)" "[ '$st' = working ]"

echo "== the monitor lists Claude and other agents' sessions together, from one data folder"
export PROOF_DASHBOARD_PORT=47398
mkdir -p "$T/cc/projects/app"
cp "$T/l5/s5.jsonl" "$T/cc/projects/app/s5.jsonl"
# The opencode session is written by proof's own hooks, in a process that shares no environment with the monitor:
# only the --data folder the installer would have written into opencode's plugin.
env -i PATH="$PATH" HOME="$HOME" PROOF_MONITOR=0 PROOF_BACKFILL=0 PROOF_UPDATE_CHECK=0 node "$S/session-start.mjs" --agent opencode --data "$T/data" <<<"{\"hook\":\"sessionStart\",\"sessionID\":\"ses_oc\",\"cwd\":\"$R\"}" >/dev/null
env -i PATH="$PATH" HOME="$HOME" PROOF_BACKFILL=0 node "$S/gate.mjs" --prompt --agent opencode --data "$T/data" <<<"{\"hook\":\"userPrompt\",\"sessionID\":\"ses_oc\",\"cwd\":\"$R\",\"prompt\":\"make the header sticky\"}"
CLAUDE_CONFIG_DIR="$T/cc" node "$S/monitor.mjs" --ensure >/dev/null
MP=$(node -e 'console.log(require(process.argv[1]).pid)' "$T/data/monitor.json" 2>/dev/null)
trap '[ -n "${MP:-}" ] && kill "$MP" 2>/dev/null' EXIT
sleep 2; curl -s 'http://127.0.0.1:47398/data.json?hours=2' > "$T/mix.json"
expect "data.json has the Claude session and the opencode one, each with its agent" "node -e 'const d=require(\"$T/mix.json\");const a=d.sessions.map(s=>s.agent+\":\"+s.id).sort().join(\",\");process.exit(a===\"claude:s5,opencode:ses_oc\"?0:(console.log(a),1))'"
# A turn-end gate the agent killed (its hook timed out) leaves its live file behind with no process.
node -e 'process.exit(0)' & DEAD=$!; wait $DEAD
mkdir -p "$T/data/live"; printf '{"pid":%s,"mode":"stop","start":%s,"checks":[{"name":"e2e","state":"running"}]}' "$DEAD" "$(now_ms)" > "$T/data/live/gate-ses_oc.json"
sleep 2; curl -s 'http://127.0.0.1:47398/data.json?hours=2' > "$T/mix2.json"
expect "a gate killed by the agent's timeout shows as timed out" "node -e 'const v=require(\"$T/mix2.json\").sessions.find(s=>s.id===\"ses_oc\");process.exit(v.events.some(e=>/proof gate timed out: opencode stopped it/.test(e.text))?0:1)'"
node "$S/monitor.mjs" --stop >/dev/null; sleep 0.5

echo "== the page"
H="$S/dashboard.html"
expect "keeps its title and the replay placeholder" "grep -q '<title>proof · live</title>' '$H' && grep -q '/\*__PROOF_DATA__\*/' '$H'"
awk '/^<script>$/{n++; next} n==1 && /^<\/script>$/{exit} n==1' "$H" > "$T/app.js"
expect "the app script parses" "node --check '$T/app.js'"
node --input-type=module -e "import { renderPage } from '$S/dashboard.mjs'; process.stdout.write(renderPage({ now: 1, sessions: [{ title: \"run \$' and \$& here\" }] }))" > "$T/page.html"
expect "a replay page keeps \$' and \$& in session data as written" "grep -q 'run \$'\"'\"' and \$& here' '$T/page.html'"

finish
