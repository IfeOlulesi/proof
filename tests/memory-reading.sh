#!/usr/bin/env bash
# The real memory reading, with no fake values: the total matches the OS, the percentage is plausible, the precise
# tools worked, and the CLI prints its picture. On macOS this exercises the vm_stat and sysctl parsing.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
unset PROOF_FAKE_MEM
snap=$(node "$S/mem.mjs" --json)
jget() { node -e 'const v = process.argv[2].split(".").reduce((o, k) => (o == null ? o : o[k]), JSON.parse(process.argv[1])); console.log(v)' "$snap" "$1"; }

echo "== machine settings"
expect "the default memory ceiling is 90% and the warning 75% (no machine.json, no env)" "mkdir -p '$T/home' && env -u PROOF_MEMORY_CEILING_PERCENT -u PROOF_MEMORY_WARN_PERCENT HOME='$T/home' node --input-type=module -e \"
import { machineConfig } from '$S/mem.mjs';
const c = machineConfig(); process.exit(c.ceilingPct === 90 && c.warnPct === 75 ? 0 : 1);\""
expect "machine.json still overrides the ceiling" "mkdir -p '$T/home2/.config/proof' && echo '{\"memoryCeilingPercent\": 93}' > '$T/home2/.config/proof/machine.json' && env -u PROOF_MEMORY_CEILING_PERCENT HOME='$T/home2' node --input-type=module -e \"
import { machineConfig } from '$S/mem.mjs';
process.exit(machineConfig().ceilingPct === 93 ? 0 : 1);\""

echo "== parsing the platform tools' output (every OS)"
expect "top's MEM column: K, M and G units, and the +/- trend marks" "node --input-type=module -e \"
import { parseTopMem } from '$S/mem.mjs';
const m = parseTopMem('PID    MEM\n8784   1755M\n546    1.5G+\n12     469K-\n7      0B\n');
process.exit(m.get(8784) === 1755 && m.get(546) === 1536 && Math.abs(m.get(12) - 469 / 1024) < 1e-9 && m.get(7) === 0 && m.size === 4 ? 0 : 1);\""
cat > "$T/win.mjs" <<'EOF'
import { parseWinProcs, appName, isClaudeCli } from 'MEM';
const list = parseWinProcs(JSON.stringify([
  { p: 4120, pp: 900, m: 524288000, c: '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=renderer', t: Date.now() - 60000 },
  { p: 5000, pp: 4120, m: 104857600, c: 'C:\\Program Files\\nodejs\\node.exe node_modules\\jest\\bin\\jest.js --ci', t: 0 },
  { p: 6000, pp: 1, m: 1048576, c: 'C:\\Users\\me\\.local\\bin\\claude.exe', t: 0 },
  { p: 7, pp: 0, m: 2097152, c: '', n: 'Registry', t: 0 },
]));
const one = parseWinProcs(JSON.stringify({ p: 9, pp: 1, m: 1048576, c: 'svchost.exe', t: 0 }));   // a single process isn't an array
const ok = list.length === 4 && list[0].mb === 500 && list[0].pgid === 4120 && list[0].ppid === 900 && Math.abs(list[0].start - (Date.now() - 60000)) < 5000
  && appName(list[0].command) === 'chrome' && appName(list[1].command) === 'Jest' && isClaudeCli(list[2].command) && appName(list[2].command) === 'Claude Code'
  && list[3].label === 'Registry' && one.length === 1 && one[0].mb === 1
  && appName('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser') === 'Brave Browser' && appName('/usr/local/bin/node /x/jest.js') === 'Jest'
  && parseWinProcs(JSON.stringify([{ p: 3, pp: 4, m: 0, c: '', n: 'Memory Compression', t: 0 }]))[0].label === 'Memory Compression'
  // Unix command lines are untouched by the Windows rules
  && !isClaudeCli('grep -rn "claude" src') && !isClaudeCli('git commit -m "claude fix"') && isClaudeCli('claude --resume')
  && appName('python3 run.py --out=report.exe') === 'Python' && appName('/usr/bin/node /srv/tools/setup.exe-helper.js') === 'Node';
if (!ok) { console.error(JSON.stringify(list.map(p => [p, appName(p.command)]))); process.exit(1); }
EOF
sed -i.bak "s#'MEM'#'$S/mem.mjs'#" "$T/win.mjs"
expect "Windows: PowerShell's process list (Task Manager's private working set), with Windows paths named as apps" "node '$T/win.mjs'"
# Windows end to end, short of a real Windows machine: the platform reads as win32 and a stand-in powershell.exe
# answers with what the real one prints.
mkdir -p "$T/winbin"
printf '#!/bin/sh\necho %s\n' "'[{\"p\":4120,\"pp\":900,\"m\":524288000,\"c\":\"\\\"C:\\\\\\\\Program Files\\\\\\\\Google\\\\\\\\Chrome\\\\\\\\Application\\\\\\\\chrome.exe\\\" --type=renderer\",\"t\":0}]'" > "$T/winbin/powershell.exe"
chmod +x "$T/winbin/powershell.exe"
cat > "$T/winsnap.mjs" <<'EOF'
import os from 'node:os';
Object.defineProperty(process, 'platform', { value: 'win32' });
const { snapshot } = await import(process.argv[2]);
const s = snapshot();
const ok = s.system.platform === 'win32' && !s.system.rough && Math.abs(s.system.totalMB - os.totalmem() / 2 ** 20) < 1 && s.system.pct > 0
  && s.apps.length === 1 && s.apps[0].name === 'chrome' && s.apps[0].mb === 500;
if (!ok) { console.error(JSON.stringify(s)); process.exit(1); }
EOF
expect "Windows: the machine reading and the app list come through (simulated win32, stand-in PowerShell)" "PATH='$T/winbin':\$PATH node '$T/winsnap.mjs' '$S/mem.mjs'"

case "$(uname -s)" in
  Darwin) os_total=$(( $(sysctl -n hw.memsize) / 1048576 ));;
  Linux)  os_total=$(awk '/^MemTotal:/ {print int($2 / 1024)}' /proc/meminfo);;
  MINGW*|MSYS*|CYGWIN*) os_total=$(powershell.exe -NoProfile -Command '[long]((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1MB)' | tr -d '\r');;
  *)      echo "  skip  no memory reader for $(uname -s)"; finish; exit;;
esac
total=$(jget system.totalMB); pct=$(jget system.pct)

echo "== reading this machine's memory ($(uname -s))"
expect "total matches the OS (${total%.*} MB, OS says $os_total MB)" "node -e 'process.exit(Math.abs(Number(process.argv[1]) - Number(process.argv[2])) <= 2 ? 0 : 1)' '$total' '$os_total'"
expect "used is a plausible share of it (${pct%.*}%)" "node -e 'const p = Number(process.argv[1]); process.exit(p > 1 && p < 100 ? 0 : 1)' '$pct'"
expect "the precise tools worked (not a rough reading)" "[ \"\$(jget system.rough)\" != true ]"
if [ "$(uname -s)" = Linux ] && command -v free >/dev/null; then
  # Read both at the same moment: total minus available, what desktop monitors show as used.
  proof_used=$(node --input-type=module -e "import { readSystem } from '$S/mem.mjs'; console.log(readSystem().usedMB)")
  free_used=$(free -m | awk '/^Mem:/ {print $2 - $7}')
  expect "Linux: used matches free's total minus available ($free_used MB)" "node -e 'process.exit(Math.abs(Number(process.argv[1]) - Number(process.argv[2])) <= Math.max(64, Number(process.argv[2]) * 0.05) ? 0 : 1)' '$proof_used' '$free_used'"
fi
if [ "$(uname -s)" = Darwin ]; then
  expect "macOS: app, wired and compressed memory all parsed from vm_stat" "node -e 'const s = JSON.parse(process.argv[1]).system; process.exit([s.appMB, s.wiredMB, s.compressedMB].every(Number.isFinite) && s.appMB > 0 ? 0 : 1)' \"\$snap\""
fi
if [ "$(uname -s)" = Darwin ]; then
  # Activity Monitor's Memory column is phys_footprint (memory in RAM plus what's compressed or swapped out), not
  # resident size. macOS's own footprint tool reports it; compare a handful of this user's processes against it.
  cat > "$T/footprint.mjs" <<'EOF'
import { execFileSync } from 'node:child_process';
import { readProcesses } from 'MEM';
const mine = new Set(execFileSync('ps', ['-U', String(process.getuid()), '-o', 'pid='], { encoding: 'utf8' }).split('\n').map(Number).filter(Boolean));
const procs = readProcesses().filter(p => mine.has(p.pid) && p.pid !== process.pid).sort((a, b) => b.mb - a.mb);
const bad = []; let n = 0;
for (const p of procs) {
  if (n >= 12) break;
  let fp;
  try { fp = Number(execFileSync('footprint', ['-p', String(p.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/phys_footprint:\s+([\d.]+) (KB|MB|GB|B)/).slice(1).reduce((v, u) => v * { B: 1 / 2 ** 20, KB: 1 / 1024, MB: 1, GB: 1024 }[u])); } catch { continue; }
  n++;
  if (Math.abs(p.mb - fp) > Math.max(16, fp * 0.15)) bad.push(`pid ${p.pid}: proof ${Math.round(p.mb)} MB, footprint ${Math.round(fp)} MB`);
}
if (!n) { console.error('no process could be compared'); process.exit(1); }
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
EOF
  sed -i.bak "s#'MEM'#'$S/mem.mjs'#" "$T/footprint.mjs"
  expect "macOS: per-process memory is Activity Monitor's measure (phys_footprint), not resident size" "node '$T/footprint.mjs'"
fi
expect "apps are listed by memory" "[ \"\$(jget apps.length)\" -gt 0 ]"
expect "the CLI prints what's using memory" "node \"$S/mem.mjs\" | grep -q 'Biggest users'"

finish
