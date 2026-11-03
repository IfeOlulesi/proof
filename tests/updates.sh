#!/usr/bin/env bash
# The update notice: session start tells Claude when a newer proof is released, from a cache refreshed in the background
# at most once a day. A local server stands in for GitHub.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ss() { node -e 'process.stdout.write(JSON.stringify({session_id:process.argv[1],cwd:process.argv[2],source:"startup"}))' "$1" "$R" | node "$S/session-start.mjs"; }
cache() { mkdir -p "$T/data"; printf '{"checkedAt":%s,"latest":"%s"}' "$1" "$2" > "$T/data/update-check.json"; }
VER=$(node -p 'require(process.argv[1]).version' "$P/.claude-plugin/plugin.json")

node -e 'require("http").createServer((q,r)=>r.end(JSON.stringify({version:"98.1.0"}))).listen(0,"127.0.0.1",function(){require("fs").writeFileSync(process.argv[1],String(this.address().port))})' "$T/port" & SRV=$!
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
export PROOF_UPDATE_URL="http://127.0.0.1:$(cat "$T/port")/plugin.json"

echo "== update notice"
cache "$(now_ms)" 99.0.0
ctx=$(PROOF_UPDATE_CHECK=1 ss u1)
expect "a newer release is in the session context, with the commands to update" "grep -q '99.0.0 is out (this session runs $VER)' <<<\"\$ctx\" && grep -q 'claude plugin update proof@proof' <<<\"\$ctx\""
cache "$(now_ms)" "$VER"
ctx=$(PROOF_UPDATE_CHECK=1 ss u2)
expect "no notice when this is the newest version" "! grep -q 'proof update' <<<\"\$ctx\""
cache "$(now_ms)" 0.0.1
ctx=$(PROOF_UPDATE_CHECK=1 ss u3)
expect "no notice when the release is older (a local build ahead of it)" "! grep -q 'proof update' <<<\"\$ctx\""
cache "$(now_ms)" 99.0.0
ctx=$(ss u4)
expect "no notice, and no check, when it's turned off" "! grep -q 'proof update' <<<\"\$ctx\""
mkdir -p "$HOME/.config/proof"; echo '{"updateCheck":false}' > "$HOME/.config/proof/machine.json"
ctx=$(PROOF_UPDATE_CHECK=1 ss u5)
expect "machine.json updateCheck:false turns it off too" "! grep -q 'proof update' <<<\"\$ctx\""
rm "$HOME/.config/proof/machine.json"

echo "== background refresh"
cache 0 "$VER"
t0=$(now_ms); PROOF_UPDATE_CHECK=1 ss u6 >/dev/null; ms=$(( $(now_ms) - t0 ))
for _ in $(seq 50); do grep -q '98.1.0' "$T/data/update-check.json" && break; sleep 0.1; done
expect "a day-old answer is refreshed in the background with the newest version" "grep -q '98.1.0' '$T/data/update-check.json'"
expect "session start doesn't wait for it (${ms}ms)" "[ $ms -lt 2000 ]"
ctx=$(PROOF_UPDATE_CHECK=1 ss u7)
expect "and the next session shows it" "grep -q '98.1.0 is out' <<<\"\$ctx\""
kill $SRV 2>/dev/null; wait $SRV 2>/dev/null
cache 0 99.0.0
PROOF_UPDATE_CHECK=1 PROOF_UPDATE_URL="http://127.0.0.1:9/plugin.json" node "$S/updates.mjs" --refresh
expect "offline: the last answer is kept and the attempt is recorded" "node -e 'const c=require(process.argv[1]); process.exit(c.latest===\"99.0.0\"&&c.checkedAt>0?0:1)' '$T/data/update-check.json'"

finish
