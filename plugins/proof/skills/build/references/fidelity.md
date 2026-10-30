# Implementing a mockup: the fidelity loop

Use this whenever the job is "make the app match this mockup". Never implement every screen in one session. One prompt carrying hundreds of implicit requirements is how elements, copy and interactions go missing.

## 0. The contract (once per approved mockup version)

1. **Put the approved mockup in `mockup/`.** Keep its `data-screen` and `data-testid` attributes (see the proof:design skill). Mockup and app both need `<meta charset="utf-8">` and `<meta name="viewport" content="width=device-width, initial-scale=1">`.
2. **Install the kit** from the repo root with the command in the build skill. It runs `fidelity-kit/install.mjs` from the build skill's folder, and you pass the app's dev URL (Expo web 8081, Vite 5173, Next 3000), e.g. `--app-url http://localhost:8081`.
   - It copies the scripts to `fidelity/`, adds a `fidelity` check to `.claude/proof.json` and updates `.gitignore`.
   - The check is marked `cache: false`, because its result depends on the running app, not just the code.
   - It needs Playwright: `npm i -D playwright && npx playwright install --only-shell chromium`.
   - A repo set up with an earlier version upgrades with `install.mjs --upgrade` (see the build skill).
3. **Extract each screen and state frame:**
   `node fidelity/extract-inventory.mjs mockup/app.html <screen-id> '[data-screen="<screen-id>"]'`
   - If the mockup frames aren't 393×852, prefix the command with `FIDELITY_VIEWPORT=<w>x<h>` (e.g. `390x844`). Each inventory stores the size, so verification renders the app at the same size.
   - Tag everything reported as `WARN untagged` in the mockup, then re-run.
4. **Point each inventory at the app.** In `fidelity/inventory/<screen>.json`:
   - set `route` to the app path for that screen
   - set `appScope`, a CSS selector, if the app renders the screen inside a container
   Show the user the inventories to review.
5. **Freeze:** `git add -A && git commit -m "fidelity contract" && git tag -f contract`.
   From now on the check fails if the mockup, inventories, references or kit scripts change. Re-tag only when the user approves a change. (`.claude/proof.json` isn't frozen; the gate flags a session that removes or rewrites a check in it.)

## 1. Foundation (one session)

- Move the tokens from the mockup's CSS custom properties into the app theme.
- Build the shared components: buttons, inputs, cards, list rows, navigation bars, sheets. Check each one against a crop of the mockup.
- Mirror the test IDs in the app:
  - React Native: `testID`
  - iOS: `accessibilityIdentifier`
  - Compose: `testTag`
  - Flutter: `Key` or `Semantics`
- Commit.

## 2. One screen per fresh session

There are two ways to run it:
- **Unattended.** List screen IDs in dependency order in `fidelity/screens.txt`, start the app, then run `APP_URL=<url> fidelity/run-screens.sh`. Try two or three screens first.
- **Interactive.** At the start of the session, run `echo <screen> > fidelity/.current-screen`. The gate then runs `fidelity/verify-screen.sh <screen>` every time you finish. Delete the file only when the user signs the screen off.

- **Parallel (Orca or other worktrees).** Use one worktree per screen, and only after the foundation is merged.
  - Each worktree runs its own dev server on its own port.
  - Write that worktree's URL to `fidelity/.app-url`, e.g. `echo http://localhost:8082 > fidelity/.app-url`, so the check never reads another worktree's server.
  - The check reads its URL from `fidelity/.app-url`, then `$APP_URL`, then the URL given at install.

For each screen:
- Read only that screen's mockup frame, its inventory and its reference images.
- Build it from theme tokens and shared components.
- Copy text from the inventory; never retype it.

## 3. Compare, cheapest check first

`fidelity/verify-screen.sh <screen>` checks every inventory item for presence, exact copy, position and size (±2 px), font, colour, background, radius and shadow.

Fix in this order: missing items, then copy, then geometry, then style. While items are failing, it saves only the full-screen capture (`fidelity/shots/<screen>.png`). When it prints `ALL PASS`, it also saves per-element crops. Then ask the proof:screen-judge agent to compare `fidelity/refs/<screen>*.png` with `fidelity/shots/<screen>*.png`, and fix its FAILs.

## 4. Interactions, after static fidelity passes

For each entry in `mockup/interactions.json`, implement the trigger, the states and the motion using the spec's numbers. Then verify:
- with timing tests:
  - Reanimated's Jest helpers
  - Flutter `pump(duration)`
  - Compose `mainClock`
  - on the web, `document.getAnimations()`
- with a screenshot of each state
- with a scripted flow in Maestro or Playwright

Screenshot checks freeze animations, so they never prove motion.

## Platforms

- **Web, PWA or Expo web:** the kit works as is. react-native-web renders `testID` as `data-testid`. Treat Expo web as the fast inner loop and do final sign-off on a simulator.
- **Native sign-off** (React Native on a device, Flutter, SwiftUI, Compose):
  - Keep the inventory, the references and the gate.
  - Read the screen through the platform's element tree, using the same IDs: Expo MCP `automation_find_view`, Maestro `inspect_screen`, mobile-mcp, or Roborazzi's JSON.
  - Compare positions in points or dp at the same screen size.
  - Styling is judged from reference screenshots and by the screen judge.
- **Captures:**
  - iOS: `xcrun simctl io booted screenshot <file>`
  - Android: `adb exec-out screencap -p > <file>`
- **Layout defaults differ from CSS:**
  - React Native flexbox defaults to `flexDirection: column` and `flexShrink: 0`.
  - Flutter needs `Stack` and `Positioned` for absolute layout.
