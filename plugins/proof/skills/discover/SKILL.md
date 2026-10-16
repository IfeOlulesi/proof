---
name: discover
description: Brainstorm, scope and spec a product idea or feature before design or code. Use for ideation, problem framing, comparing approaches, prioritising, PRDs and specs, and "what should we build". Ends in a decision plus SPEC.md and features.json in which every requirement says how it will be verified.
---

# Discover: turn an idea into a decision and a checkable spec

Leave this phase with (1) a decision and the reason for it, and (2) a spec where every requirement says how it will be proven. Requirements without a verification method are where "Claude missed it" starts.

## Workflow

1. **Frame.** In a few lines each: who it's for, the job it does for them, what they do today, why now, and the constraints (money, time, platform, market). Ask only for what you can't infer; mark the rest as assumptions.
2. **Diverge before converging.** Give at least three genuinely different approaches, not variants of one. For each: what it bets on, the cheapest way to test that bet, and the main risk.
3. **Converge on stated criteria.** Name the criteria first, compare the options against them, recommend one. Record the decision, why, and what evidence would change it.
4. **Write SPEC.md** from `${CLAUDE_SKILL_DIR}/templates/SPEC.md`. Every acceptance criterion is a checkbox line ending in `verify:` plus how it will be proven: a test, a script, a render compared with a reference, a measurement, or numbered manual steps.
5. **Write features.json**: one entry per buildable unit, each about an hour of focused work, all with `"passes": false`:
   `{"features": [{"id": "F1", "title": "...", "criteria": ["..."], "verify": "how it is proven", "passes": false, "evidence": ""}]}`
   Only a passing check may flip `passes`, and `evidence` must say which one.
6. **Run the check** below and fix everything it reports.
7. **Get a fresh read.** Ask the proof:verifier agent to review SPEC.md against the user's stated goal: missing flows, untestable criteria, contradictions. Fix the real gaps.

## Rules

- Facts need sources. Label assumptions. Don't invent market numbers.
- Keep non-goals explicit; they stop scope creep during build.
- Prefer the smallest version that tests the riskiest assumption.
- When the user only wants ideas, skip steps 4–7, but still end with a recommendation and the single next step.

## Check

`node "${CLAUDE_SKILL_DIR}/scripts/check-spec.mjs" SPEC.md features.json`

It fails on missing sections, acceptance criteria without `verify:`, leftover template or placeholder text, and malformed features (no id, title or verify; duplicate ids; `passes: true` without evidence). To make the completion gate enforce it, add to `.claude/proof.json`:
`{"name": "spec", "run": "node \"$CLAUDE_PLUGIN_ROOT/skills/discover/scripts/check-spec.mjs\"", "when": ["SPEC.md", "features.json"]}`

## Done when

The check passes, the verifier reports no material gaps, and the user has the decision, the spec and the first feature to build.
