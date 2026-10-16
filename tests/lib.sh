# Shared setup for proof's test suites, sourced by each one. Everything runs in a throwaway folder with its own home,
# plugin data folder and git repo, and fake memory readings, so nothing touches your real ~/.claude, ~/.config/proof,
# running dashboard or memory state.
set -u
TESTS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
P="$(cd "$TESTS/../plugins/proof" && pwd -P)"
S="$P/scripts"
FIX="$TESTS/fixtures"
T="$(cd "$(mktemp -d)" && pwd -P)"   # physical path: on macOS /var is a symlink to /private/var

for v in $(compgen -e | grep -E '^(PROOF_|CLAUDE_)'); do unset "$v"; done
mkdir -p "$T/home"
export HOME="$T/home" CLAUDE_CONFIG_DIR="$T/home/.claude" CLAUDE_PLUGIN_ROOT="$P" CLAUDE_PLUGIN_DATA="$T/data" \
  PROOF_DATA_DIR="$T/data" PROOF_MONITOR=0 PROOF_ENFORCE=0 PROOF_FAKE_MEM="$T/mem.json" NODE_NO_WARNINGS=1

# fake_mem <used MB> [total MB]: what proof reads as the machine's memory (default total 24 GB).
fake_mem() { printf '{"totalMB":%s,"usedMB":%s}' "${2:-24576}" "$1" > "$T/mem.json"; }
fake_mem 9000

R="$T/repo"
mkdir -p "$R" && cd "$R" && git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false

pass=0; fail=0
expect() { if eval "$2"; then echo "  ok    $1"; pass=$((pass+1)); else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
now_ms() { node -e 'console.log(Date.now())'; }
# Live (non-zombie) processes whose command line contains $1.
alive() { ps -A -o stat=,args= | awk -v a="$1" '$1 !~ /^Z/ && index($0, a) {n++} END {print n+0}'; }
finish() { echo; echo "$pass passed, $fail failed"; cd /; rm -rf "$T"; [ "$fail" -eq 0 ]; }
