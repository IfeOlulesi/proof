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

echo "== other package managers"
clean
printf '{"scripts":{"lint":"true","test":"true"},"devDependencies":{"typescript":"5"}}' > package.json
: > pnpm-lock.yaml; touch tsconfig.json
out=$(node "$DET")
expect "pnpm lockfile: runs through pnpm, and tsc falls back to pnpm exec" "grep -q 'pnpm run lint' <<<\"\$out\" && grep -q 'pnpm exec tsc --noEmit' <<<\"\$out\""
clean
printf '{"scripts":{"lint":"true","test":"true"}}' > package.json; : > yarn.lock
out=$(node "$DET")
expect "yarn lockfile: runs through yarn" "grep -q 'yarn run test' <<<\"\$out\""
clean
printf '{"scripts":{"lint":"true","test":"true"}}' > package.json; : > bun.lockb
out=$(node "$DET")
expect "bun lockfile: runs through bun" "grep -q 'bun run lint' <<<\"\$out\""

echo "== python, rust, go, make"
clean
printf '[tool.ruff]\n[tool.mypy]\n' > pyproject.toml; mkdir tests
out=$(node "$DET")
expect "ruff and mypy from their config; a tests/ folder alone does not add pytest" "grep -q 'ruff check' <<<\"\$out\" && grep -q 'mypy \\.' <<<\"\$out\" && ! grep -q 'pytest' <<<\"\$out\""
expect "python checks are limited to python and config files" "node '$DET' --write >/dev/null && grep -q '\"\\*\\*/\\*\\.py\"' .claude/proof.json"
clean
printf '[tool.pytest.ini_options]\n' > pyproject.toml
out=$(node "$DET")
expect "pytest is proposed once it is configured" "grep -q 'pytest' <<<\"\$out\""
clean
printf '[package]\nname="x"\n' > Cargo.toml
out=$(node "$DET")
expect "cargo: check and test" "grep -q 'cargo check' <<<\"\$out\" && grep -q 'cargo test' <<<\"\$out\""
clean
printf 'module x\n' > go.mod
out=$(node "$DET")
expect "go: vet and test" "grep -q 'go vet' <<<\"\$out\" && grep -q 'go test' <<<\"\$out\""
clean
printf 'lint:\n\techo\ntest:\n\techo\n' > Makefile
out=$(node "$DET")
expect "Makefile: lint and test targets" "grep -q 'make lint' <<<\"\$out\" && grep -q 'make test' <<<\"\$out\""

echo "== jest and vitest get a per-reply fast command"
clean
printf '{"scripts":{"test":"echo jest"}}' > package.json; : > package-lock.json
node "$DET" --write >/dev/null
expect "jest: fast filters to related files, with files and fullWhen" "grep -q 'findRelatedTests {files}' .claude/proof.json && grep -q '\"files\"' .claude/proof.json && grep -q '\"fullWhen\"' .claude/proof.json"
clean
printf '{"scripts":{"test":"echo vitest"}}' > package.json; : > package-lock.json
node "$DET" --write >/dev/null
expect "vitest: fast uses vitest related" "grep -q 'vitest related --run {files}' .claude/proof.json"
clean
printf '{"scripts":{"test":"echo tests"}}' > package.json; : > package-lock.json
node "$DET" --write >/dev/null
expect "other test runners get no fast command" "! grep -q '\"fast\"' .claude/proof.json"

echo "== skipped scripts are noted"
clean
printf '{"scripts":{"test":"jest --watch"}}' > package.json; : > package-lock.json
out=$(node "$DET")
expect "watch-mode test is not proposed, and the note says why" "! grep -q 'npm run test' <<<\"\$out\" && grep -q 'watch mode' <<<\"\$out\""
clean
printf '{"scripts":{"lint":"eslint . --fix"}}' > package.json; : > package-lock.json
out=$(node "$DET")
expect "lint with --fix is not proposed, and the note says why" "! grep -q 'npm run lint' <<<\"\$out\" && grep -qF -- '--fix' <<<\"\$out\""

echo "== the gate runs the generated jest fast command on a change"
clean
printf 'node_modules/\n' > .gitignore
printf '{"scripts":{"test":"echo jest"}}' > package.json; : > package-lock.json
mkdir -p src node_modules/.bin
printf '#!/bin/sh\necho "jest-fast $*" >> "$LOG"\n' > node_modules/.bin/jest; chmod +x node_modules/.bin/jest
echo 'export const a = 1' > src/a.ts
node "$DET" --write >/dev/null
git add -A && git commit -qm "fixture: generated proof.json"
export LOG=$T/jestlog
node -e 'process.stdout.write(JSON.stringify({session_id:"gj1",cwd:process.argv[1],source:"startup"}))' "$PWD" | node "$S/session-start.mjs" >/dev/null
echo 'export const a = 2' > src/a.ts
: > "$LOG"
node -e 'process.stdout.write(JSON.stringify({session_id:"gj1",cwd:process.argv[1],prompt_id:"p1",stop_hook_active:false,last_assistant_message:"Done."}))' "$PWD" | node "$S/gate.mjs" >/dev/null 2>&1
expect "after a reply that changed src/a.ts, the jest fast filter runs on that file" "grep -q 'jest-fast' \"\$LOG\" && grep -q 'src/a.ts' \"\$LOG\""

finish
