#!/usr/bin/env bash
# The init-proof skill: the detector finds the checks a project already defines, --write adds them to .claude/proof.json
# without touching the checks already there, a broken file is left alone, the written file passes the gate, and the
# session-start notice points at the skill.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
DET="$P/skills/init-proof/scripts/detect-checks.mjs"
clean() { find . -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +; }
count() { node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).checks;console.log(c.length)' "$1"; }

echo "== outside a repo"
mkdir -p "$T/plain" && out=$(cd "$T/plain" && node "$DET" 2>&1); code=$?
expect "refuses, and says why, outside a git repo" "[ $code -ne 0 ] && grep -q 'Not a git repository' <<<\"\$out\""

echo "== detection"
clean
printf '{"scripts":{"typecheck":"tsc --noEmit","lint":"eslint .","test":"jest --ci"},"devDependencies":{"typescript":"5.0.0"}}' > package.json
: > package-lock.json
out=$(node "$DET")
expect "finds type check, lint and test from package.json scripts, run through npm" "grep -q 'npm run typecheck' <<<\"\$out\" && grep -q 'npm run lint' <<<\"\$out\" && grep -q 'npm run test' <<<\"\$out\""
expect "prints a proposed proof.json and writes nothing without --write" "grep -q '\"checks\"' <<<\"\$out\" && [ ! -e .claude/proof.json ]"
node "$DET" --write >/dev/null
expect "--write creates .claude/proof.json with the three checks" "[ \"\$(count .claude/proof.json)\" = 3 ]"

clean
printf '{"scripts":{"test":"echo \\"Error: no test specified\\" && exit 1"}}' > package.json
: > package-lock.json
out=$(node "$DET")
expect "a placeholder test script is not proposed" "! grep -q 'npm run test' <<<\"\$out\""
clean
out=$(node "$DET" 2>&1)
expect "a project with no commands gets a clear message" "grep -q 'No type check, lint or test command found' <<<\"\$out\""

echo "== existing proof.json"
clean
printf '{"scripts":{"lint":"true","test":"true"}}' > package.json
: > package-lock.json
mkdir -p .claude
printf '{"checks":[{"name":"custom","run":"make custom"}]}' > .claude/proof.json
node "$DET" --write >/dev/null
expect "keeps the existing check and appends the new ones" "[ \"\$(count .claude/proof.json)\" = 3 ] && grep -q 'make custom' .claude/proof.json"
before=$(cat .claude/proof.json)
out=$(node "$DET" --write)
expect "a second --write adds nothing and leaves the file as it is" "grep -q 'Nothing to add' <<<\"\$out\" && [ \"\$(cat .claude/proof.json)\" = \"\$before\" ]"

clean
printf '{"scripts":{"lint":"true"}}' > package.json
: > package-lock.json
mkdir -p .claude
printf '{ this is not json' > .claude/proof.json
node "$DET" --write >/dev/null 2>&1; code=$?
expect "a proof.json that is not valid JSON is refused and left alone" "[ $code -eq 2 ] && [ \"\$(cat .claude/proof.json)\" = '{ this is not json' ]"

echo "== the written file passes the gate"
clean
printf '{"scripts":{"lint":"true","test":"true"}}' > package.json
: > package-lock.json
node "$DET" --write >/dev/null
out=$(node "$S/gate.mjs" --run 2>&1); code=$?
expect "gate --run passes every written check" "[ $code -eq 0 ] && grep -q 'All 2 checks passed' <<<\"\$out\""

echo "== session-start notice"
mkdir -p "$T/bare" && cd "$T/bare" && git init -q
out=$(node -e 'process.stdout.write(JSON.stringify({session_id:"ip1",cwd:process.argv[1],source:"startup"}))' "$T/bare" | node "$S/session-start.mjs")
expect "a git repo without proof.json is told to run the init-proof skill" "grep -q 'proof:init-proof' <<<\"\$out\""
cd "$R"

finish
