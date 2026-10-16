#!/usr/bin/env bash
# The real memory reading, with no fake values: the total matches the OS, the percentage is plausible, the precise
# tools worked, and the CLI prints its picture. On macOS this exercises the vm_stat and sysctl parsing.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset PROOF_FAKE_MEM
snap=$(node "$S/mem.mjs" --json)
jget() { node -e 'const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(process.argv[1])); console.log(v)' "$snap" "$1"; }

case "$(uname -s)" in
  Darwin) os_total=$(( $(sysctl -n hw.memsize) / 1048576 ));;
  Linux)  os_total=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo);;
  *)      echo "  skip  no memory reader for $(uname -s)"; finish; exit;;
esac
total=$(jget system.totalMB); pct=$(jget system.pct)

echo "== reading this machine's memory ($(uname -s))"
expect "total matches the OS (${total%.*} MB, OS says $os_total MB)" "node -e 'process.exit(Math.abs(Number(process.argv[1]) - Number(process.argv[2])) <= 2 ? 0 : 1)' '$total' '$os_total'"
expect "used is a plausible share of it (${pct%.*}%)" "node -e 'const p = Number(process.argv[1]); process.exit(p > 1 && p < 100 ? 0 : 1)' '$pct'"
expect "the precise tools worked (not a rough reading)" "[ \"\$(jget system.rough)\" != true ]"
if [ "$(uname -s)" = Darwin ]; then
  expect "macOS: app, wired and compressed memory all parsed from vm_stat" "node -e 'const s = JSON.parse(process.argv[1]).system; process.exit([s.appMB, s.wiredMB, s.compressedMB].every(Number.isFinite) && s.appMB > 0 ? 0 : 1)' \"\$snap\""
fi
expect "apps are listed by memory" "[ \"\$(jget apps.length)\" -gt 0 ]"
expect "the CLI prints what's using memory" "node \"$S/mem.mjs\" | grep -q 'Biggest users'"

finish
