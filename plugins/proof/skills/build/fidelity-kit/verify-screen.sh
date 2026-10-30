#!/usr/bin/env bash
# Contract first: the reviewed mockup, inventories, references and the kit's own scripts are frozen at the `contract` tag.
# (.claude/proof.json isn't frozen here; the proof gate flags a session that removes or rewrites a check in it.)
cd "$(git rev-parse --show-toplevel)" || exit 1
frozen=(mockup/ fidelity/inventory/ fidelity/refs/ fidelity/extract-inventory.mjs fidelity/verify-screen.mjs fidelity/verify-screen.sh)
git rev-parse -q --verify contract >/dev/null ||
  { echo "FAIL contract: no contract tag; review fidelity/inventory, then git tag -f contract"; exit 1; }
git diff --quiet contract -- "${frozen[@]}" ||
  { echo "FAIL contract: frozen files changed; restore with git checkout contract -- ${frozen[*]}"; exit 1; }
exec node fidelity/verify-screen.mjs "$@"
