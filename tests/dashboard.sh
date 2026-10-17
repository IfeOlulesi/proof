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

echo "== the page"
H="$S/dashboard.html"
expect "keeps its title and the replay placeholder" "grep -q '<title>proof · live</title>' '$H' && grep -q '/\*__PROOF_DATA__\*/' '$H'"
awk '/^<script>$/{n++; next} n==1 && /^<\/script>$/{exit} n==1' "$H" > "$T/app.js"
expect "the app script parses" "node --check '$T/app.js'"
node --input-type=module -e "import { renderPage } from '$S/dashboard.mjs'; process.stdout.write(renderPage({ now: 1, sessions: [{ title: \"run \$' and \$& here\" }] }))" > "$T/page.html"
expect "a replay page keeps \$' and \$& in session data as written" "grep -q 'run \$'\"'\"' and \$& here' '$T/page.html'"

finish
