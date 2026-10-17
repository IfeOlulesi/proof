#!/usr/bin/env bash
# Runs proof's checks: syntax, the manifests (when the claude CLI is installed), then the scenario suites.
#   bash tests/run.sh                 everything (about three minutes)
#   bash tests/run.sh gate gate-guard only the named suites (file names in tests/, without .sh)
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0

echo "== syntax"
while IFS= read -r f; do node --check "$f" || { echo "  syntax error: $f"; fail=1; }; done < <(find plugins -name '*.mjs')
while IFS= read -r f; do bash -n "$f" || { echo "  syntax error: $f"; fail=1; }; done < <(find plugins tests -name '*.sh')
while IFS= read -r f; do node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>/dev/null || { echo "  bad JSON: $f"; fail=1; }; done < <(find . -name '*.json' -not -path './.git/*')
[ $fail -eq 0 ] && echo "  ok"

if command -v claude >/dev/null 2>&1; then
  echo "== manifests"
  if claude plugin validate --strict . >/dev/null && claude plugin validate --strict plugins/proof >/dev/null; then echo "  ok"
  else echo "  claude plugin validate --strict failed"; fail=1; fi
fi

suites=("$@")
[ ${#suites[@]} -gt 0 ] || suites=(memory-reading gate gate-guard memory-quick-dashboard dashboard)
for s in "${suites[@]}"; do
  echo; echo "#### $s"
  bash "tests/$s.sh" || fail=1
done

echo
if [ $fail -eq 0 ]; then echo "all passed"; else echo "FAILED"; fi
exit $fail
