#!/usr/bin/env bash
# Gate rounds for agents whose turn end says neither which prompt it belongs to nor whether it's a fix round
# (opencode's session.idle): proof counts the rounds itself, stops at maxRounds, and a new user prompt starts over.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
export CNT="$T/count"
mkdir -p src .claude
echo 'export const a = 1' > src/a.ts
# Fails every time, with one FAIL line fewer each round, so the gate sees progress and doesn't stop for a stall.
cat > .claude/proof.json <<'EOF'
{ "checks": [
  {"name":"unit","run":"n=$(cat \"$CNT\"); echo $((n-1)) > \"$CNT\"; i=0; while [ $i -lt $n ]; do echo FAIL x; i=$((i+1)); done; exit 1","when":["src/"],"cache":false}
], "maxRounds": 3 }
EOF
git add -A && git commit -qm init
echo 20 > "$CNT"
echo 'export const a = 2' > src/a.ts

# A turn end with only a session and a folder: no prompt id, no continuation flag.
bare() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2]}))' "$1" "$R" | node "$S/gate.mjs"; }
prompt() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2]}))' "$1" "$R" | node "$S/gate.mjs" --prompt; }

echo "== rounds without prompt ids"
for r in 1 2 3; do
  out=$(bare s1)
  expect "turn end $r is sent back as round $r/3" "grep -q '\"decision\":\"block\"' <<<\"\$out\" && grep -q 'round $r/3' <<<\"\$out\""
done
out=$(bare s1)
expect "turn end 4 is let through: still failing after 3 rounds (got: ${out:0:160})" "! grep -q '\"decision\":\"block\"' <<<\"\$out\" && grep -q 'still failing after 3 fix round' <<<\"\$out\""

echo "== a new user prompt starts the count again"
prompt s1 >/dev/null
echo 'export const a = 3' > src/a.ts      # the new prompt's work
out=$(bare s1)
expect "sent back as round 1/3 again" "grep -q 'round 1/3' <<<\"\$out\""

echo "== the prompt hook is quiet"
out=$(prompt s1); code=$?
expect "no output, exit 0" "[ -z \"\$out\" ] && [ $code -eq 0 ]"

echo "== the same, through every agent's adapter"
out=$(node "$TESTS/agents-check.mjs" rounds "$T" "$R" 2>&1)
while IFS= read -r line; do
  case "$line" in
    *"ok  "*) echo "$line"; pass=$((pass+1)) ;;
    *FAIL*) echo "$line"; fail=$((fail+1)) ;;
    *) [ -n "$line" ] && echo "    $line" ;;
  esac
done <<<"$out"

finish
