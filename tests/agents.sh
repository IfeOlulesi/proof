#!/usr/bin/env bash
# Agent adapters: each agent's hook input becomes proof's one event, and proof's one result becomes that agent's output.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "== adapters against their fixtures"
out=$(node "$TESTS/agents.mjs"); code=$?
echo "$out" | grep -E '^\s+(ok|FAIL)' | sed 's/^/  /'
expect "every fixture passes" "[ $code -eq 0 ]"

echo "== a fixture without a source fails"
mkdir -p "$T/fx/claude"
echo '{"kind":"turnEnd","input":{}}' > "$T/fx/claude/nosource.json"
out=$(node "$TESTS/agents.mjs" "$T/fx"); code=$?
expect "rejected, and says why" "[ $code -ne 0 ] && grep -q 'no source' <<<\"\$out\""

echo "== the hook scripts go through the adapters"
for f in gate session-start wrap admit; do
  expect "$f.mjs reads its input through hookInput, not readStdin" "grep -q 'hookInput(' \"$S/$f.mjs\" && ! grep -q 'readStdin' \"$S/$f.mjs\""
done
out=$(echo '{"session_id":"x","cwd":"/tmp"}' | PROOF_AGENT=nonesuch node "$S/session-start.mjs" 2>"$T/err"); code=$?
expect "an unknown PROOF_AGENT falls back to Claude and says so (exit $code)" "[ $code -eq 0 ] && grep -q additionalContext <<<\"\$out\" && grep -q 'nonesuch' \"$T/err\""
expect "the event is documented" "grep -q '## The event' \"$P/docs/agents.md\" && grep -q '## The result' \"$P/docs/agents.md\""

# node agents-check.mjs <case>: its lines become this suite's checks.
run_case() {
  out=$(node "$TESTS/agents-check.mjs" "$1" "$T" "$R" 2>&1)
  while IFS= read -r line; do
    case "$line" in
      *"ok  "*) echo "$line"; pass=$((pass+1)) ;;
      *FAIL*) echo "$line"; fail=$((fail+1)) ;;
      *) [ -n "$line" ] && echo "    $line" ;;
    esac
  done <<<"$out"
}

echo "== the capability table"
run_case table
echo "== rules per agent"
run_case rules
echo "== install and uninstall, every agent"
run_case install
echo "== a scripted session through each adapter writes the event log"
git commit -q --allow-empty -m init
run_case session
echo "== quick mode through an agent without a session id in the skill"
run_case quick

echo "== the README labels each agent not tested live"
for row in $(node --input-type=module -e "import { ADAPTERS, } from '$S/agents/index.mjs'; for (const a of Object.values(ADAPTERS)) if (a.name !== 'claude') console.log(a.tested + ':' + a.label.replace(/ /g, '_'))"); do
  label=${row#*:}; label=${label//_/ }
  if [ "${row%%:*}" = docs ]; then expect "README: $label is marked built from docs, not tested live" "grep -q '<summary>$label (built from docs, not tested live)</summary>' \"$TESTS/../README.md\""
  else expect "README: $label is marked tested live" "grep -q '<summary>$label (tested live)</summary>' \"$TESTS/../README.md\""; fi
done

echo "== the update notice reaches other agents"
mkdir -p "$T/data"; printf '{"checkedAt":%s,"latest":"99.0.0"}' "$(now_ms)" > "$T/data/update-check.json"
ctx=$(node -e 'process.stdout.write(JSON.stringify({session_id:"upd",cwd:process.argv[1],hook_event_name:"SessionStart",source:"startup"}))' "$R" | PROOF_UPDATE_CHECK=1 node "$S/session-start.mjs" --agent codex)
expect "Codex's session start says a newer proof is out, and how to update it there" "grep -q '99.0.0 is out' <<<\"\$ctx\" && grep -q 'install.mjs[^ ]* codex' <<<\"\$ctx\" && ! grep -q 'claude plugin update' <<<\"\$ctx\""
ctx=$(node -e 'process.stdout.write(JSON.stringify({sessionId:"updg",session_id:"updg",cwd:process.argv[1],hook_event_name:"SessionStart"}))' "$R" | PROOF_UPDATE_CHECK=1 node "$S/session-start.mjs" --agent grok)
expect "Grok, whose session start can't reach the model, shows it to the user" "grep -q '\"systemMessage\":\"proof update: 99.0.0 is out' <<<\"\$ctx\""
ctx=$(node -e 'process.stdout.write(JSON.stringify({session_id:"updc",cwd:process.argv[1],hook_event_name:"SessionStart",source:"startup"}))' "$R" | PROOF_UPDATE_CHECK=1 node "$S/session-start.mjs")
expect "Claude Code's session start output is the context only, as before" "grep -q '99.0.0 is out' <<<\"\$ctx\" && ! grep -q systemMessage <<<\"\$ctx\""

finish
