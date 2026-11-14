#!/usr/bin/env bash
# Releases: plugin.json's version is the newest CHANGELOG entry, and every untagged version is released at the commit
# that set it, oldest first. A throwaway repo stands in for proof's.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
REL="$TESTS/../.github/release.mjs"

echo "== this repo"
expect "plugin.json's version is the newest CHANGELOG entry" "(cd '$TESTS/..' && node '$REL' --check >/dev/null)"

mkdir -p plugins/proof/.claude-plugin
bump() { # bump <version> <summary>
  printf '{\n  "name": "proof",\n  "version": "%s"\n}\n' "$1" > plugins/proof/.claude-plugin/plugin.json
  { printf '# Changelog\n\n## %s (2026-11-0%s)\n\n- %s\n\n' "$1" "${1##*.}" "$2"; [ -f CHANGELOG.md ] && sed '1,2d' CHANGELOG.md; true; } > c.tmp && mv c.tmp CHANGELOG.md
  git add -A && git commit -qm "Release $1: $2 ($1)"
}
bump 0.1.0 "first"; git tag -a v0.1.0 -m "proof 0.1.0: first"
bump 0.2.0 "second"; S2=$(git rev-parse --short HEAD)
echo x > other && git add other && git commit -qm "Unrelated"
bump 0.3.0 "third"; S3=$(git rev-parse --short HEAD)

echo "== missed releases"
export PROOF_RELEASES=v0.1.0
out=$(node "$REL" --dry-run 2>&1)
expect "both untagged versions are released, oldest first, at the commits that set them" \
  "[ \"\$(grep '^would release' <<<\"\$out\")\" = \"would release v0.2.0 at $S2: proof 0.2.0: second
would release v0.3.0 at $S3 (latest): proof 0.3.0: third\" ]"
expect "the tagged version is left alone" "! grep -q 'v0.1.0' <<<\"\$out\""
git tag v0.2.0 "$S2"; git tag v0.3.0 "$S3"
out=$(PROOF_RELEASES=v0.1.0,v0.2.0 node "$REL" --dry-run 2>&1)
expect "a version tagged but never released (a run that failed half way) still gets its release" \
  "grep -q 'would release v0.3.0 at $S3 (latest) (already tagged)' <<<\"\$out\" && ! grep -q 'v0.2.0' <<<\"\$out\""
expect "nothing to do once every version is released" "PROOF_RELEASES=v0.1.0,v0.2.0,v0.3.0 node '$REL' --dry-run | grep -q 'up to date: v0.3.0 is released'"

echo "== a version without its CHANGELOG entry"
sed -i.bak 's/0.3.0/0.4.0/' plugins/proof/.claude-plugin/plugin.json
out=$(node "$REL" --check 2>&1); code=$?
expect "is refused, naming both versions" "[ $code -ne 0 ] && grep -q 'plugin.json is 0.4.0 but the newest CHANGELOG entry is 0.3.0' <<<\"\$out\""

finish
