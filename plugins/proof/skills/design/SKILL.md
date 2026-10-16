---
name: design
description: Product and UI design — flows, wireframes, HTML mockups, design systems and tokens, UX copy, micro-interactions. Use when creating or changing a design or mockup, before app code. Produces a mockup engineering can be verified against, with tokens, every screen and state, final copy, test IDs and an interaction spec.
---

# Design: make a mockup that is also a test

The mockup is the spec that engineering will be checked against. Any element it doesn't name, state it doesn't show, or number it leaves implicit becomes a defect later.

## Workflow

1. **Inputs.** Read SPEC.md if there is one; every flow and acceptance criterion needs a screen or state. List the screens and, for each, its states: default, empty, loading, error, disabled, pressed/focus, long content, keyboard open (forms).
2. **Explore, then commit.** Show 2–3 distinct directions. Generative design skills (UI UX Pro Max, Taste, frontend-design) belong here. Once the user picks one, lock it; stop generating new styles.
3. **Tokens first.** Define colour, type scale, spacing, radius, shadow and motion (durations, easings) as CSS custom properties on `:root`. Screens use tokens, not raw values.
4. **Build the mockup** in `mockup/` at the repo root (e.g. `mockup/app.html`):
   - `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">` in the head
   - one `data-screen="<id>"` container per screen at the device's logical size (default 393×852). When frames sit side by side, give them a fixed width and `flex-shrink: 0` so they never squeeze
   - each state as its own frame, e.g. `data-screen="checkout--error"`
   - final copy and realistic data, never lorem ipsum
5. **Tag everything.** Put a unique, meaningful `data-testid` on every element that carries text, an icon, an image or an interaction. Within a screen, suffix repeated items: `order-row-1`, `order-row-2`. Engineering mirrors these IDs as testID, accessibilityIdentifier, Key or testTag.
6. **Specify interactions** in `mockup/interactions.json`, one entry per interactive element:
   `{"element": "cta-continue", "trigger": "tap", "states": ["default", "pressed", "loading"], "effect": "navigate:/signup", "duration_ms": 120, "easing": "cubic-bezier(0.2, 0, 0, 1)", "delay_ms": 0, "reduced_motion": "no scale"}`
   Take the numbers from your CSS. Touch screens have no hover, so map hover to pressed.
7. **Look at it.** Run the check, open the screenshots it writes and fix what you see. Never judge a design from its code alone.
8. **Get a fresh read.** Ask the proof:verifier agent to check the mockup against SPEC.md: every flow and criterion has a screen or state.

## Check

`node "${CLAUDE_SKILL_DIR}/scripts/check-design.mjs" mockup/app.html [--viewport 393x852] [--min-target 44]`

It fails on any of these:
- a missing charset or viewport meta tag
- screen frames that don't render at the device width
- untagged visible text, controls or media
- duplicate test IDs within a screen
- missing `data-screen` frames
- placeholder copy
- text contrast below WCAG AA
- touch targets under 44×44
- interactive elements with no entry in interactions.json

It also writes a screenshot of every screen to `.proof/design/`. It needs Playwright; if it's missing, it prints the install command and exits 3. To have the completion gate enforce it, add to `.claude/proof.json`:
`{"name": "design", "run": "node \"$CLAUDE_PLUGIN_ROOT/skills/design/scripts/check-design.mjs\" mockup/app.html", "when": ["mockup/**"]}`

## Done when

The check passes, you have reviewed every screenshot, and the user has approved the direction. Then commit and tag the mockup (`git tag design-v1`) so build works against a frozen version.
