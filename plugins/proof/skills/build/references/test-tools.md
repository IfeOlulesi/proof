# Test tools: what to suggest, what to set up

Checked 2026-10-30. Memory figures marked *measured* were taken on an M-series Mac, 24 GB; the rest are vendor claims or estimates and say so.

## The rule

- **The project already has a test runner:** use it. Don't migrate it. If it's one of the heavy ones (Jest, a JVM runner, a booted simulator) and proof has stopped runs for memory, mention the lighter option below once, in one line, and let the user decide.
- **Nothing is set up:** set up the lightest default for the stack (table below) without asking, write the first test for the unit you're on, add it to `.claude/proof.json`, and tell the user in one line what now checks their work.
- **Judge every check by its exit code only.** Vitest 4.1+, Jest 30.3+ and Bun print only failures when they detect an agent (`CLAUDECODE`, `AI_AGENT` and similar, which Claude Code sets). Passing runs print almost nothing. Never grep for PASS lines; where a script must read the output, pin a reporter (`--reporter=default`, `--reporters=default`) or use JUnit/JSON.
- **Red runs stop at the first failure.** Use the bail flag in the table. `node --test` and `swift test` have none: run the single failing file instead.

## Lightest default per stack

| Stack | Default | Run (red run / bail) | Step up to, when needed |
|---|---|---|---|
| Node JS/TS | `node:test`, built in (TS types strip natively on Node 22.18+) | `node --test` · run one file to stop early | Vitest, when the project uses Vite, path aliases, DOM tests or heavy mocking |
| Bun | `bun test` | `bun test --bail` | – |
| Deno | `deno test` | `deno test --fail-fast` · `--related <files>` for the fast tier | – |
| Vite / React web | Vitest + happy-dom (≥ 20.0.2) | `npx vitest run --bail=1` · `vitest related --run {files}` for the fast tier | jsdom, only where happy-dom lacks an API |
| Python | `unittest` with no dependencies; pytest if it's already there | `python -m unittest -f` · `pytest -q -x -p no:cacheprovider` | pytest-xdist only for large suites (each worker costs its own RAM) |
| Go | `go test` | `go test -failfast -count=1 ./...` | – |
| Rust | `cargo test` | `cargo test -q` | cargo-nextest (fails fast by default) |
| Swift | `swift test` (Swift Testing) | `swift test --filter <name>` | – |
| Kotlin / JVM | Gradle + JUnit | `./gradlew test --fail-fast --tests <name>` | Kotest |
| Dart / Flutter | `dart test` / `flutter test` | `--fail-fast --reporter=compact` | – |
| Ruby | minitest | `ruby -Itest test/x_test.rb` | – |
| PHP | Pest | `vendor/bin/pest --bail --compact` | – |
| Elixir | ExUnit | `mix test --max-failures 1` | – |
| Shell scripts | bats-core | `bats --abort test/` | – |
| HTTP API | hurl (one small binary; exit 4 on a failed assert) | `hurl --test tests/*.hurl` | supertest inside the project's runner |

Measured start-up for one trivial test: bun 11 ms / 27 MB, unittest 30 ms / 22 MB, pytest 92 ms / 43 MB, `node --test` 167 ms / 74 MB, vitest 333 ms / 102 MB. Jest installs 255 packages; zora and poku install one.

## Browser and screen checks

- **Use Playwright's headless shell, never full Chromium.** Install with `npx playwright install --only-shell chromium` (Playwright 1.49+; older versions use `npx playwright install chromium`). Don't set `channel: 'chromium'`. *Measured*: one context and a screenshot took about 420 MB on the shell against 1.05–1.1 GB on full Chromium.
- **Keep the browser small:** `workers: 1`, one browser reused across checks, a fresh context per check that's closed after it (each open context added about 100 MB), trace and video off. `--single-process` crashes; GPU flags made no difference.
- **A static HTML screenshot** doesn't need Playwright: run the `chrome-headless-shell` binary from Playwright's download folder (`~/Library/Caches/ms-playwright/chromium_headless_shell-*/` on macOS, `~/.cache/ms-playwright/` on Linux; it isn't on PATH) with `--screenshot=out.png --window-size=1280,800 file://…` (*measured* 0.19 s, under 100 MB), then compare.
- **Compare images with odiff** (`npx odiff-bin a.png b.png diff.png`; exit 0 match, 21 different size, 22 different pixels). *Measured* 0.1 s / 103 MB against pixelmatch's 0.27 s / 287 MB on a full-page image.
- **DOM-only checks** (text, counts, flows without pixels) can run on Lightpanda over CDP (`lightpanda serve --port 9222`, then `chromium.connectOverCDP`; *measured* about 55 MB). It does no CSS layout: never use it for screenshots or sizes. Set `LIGHTPANDA_DISABLE_TELEMETRY=true`.
- **Component tests in a browser:** Vitest browser mode (`@vitest/browser-playwright`) with `toMatchScreenshot`.

## Mobile

| Job | Lightest option | Cost |
|---|---|---|
| React Native logic and screens | React Native Testing Library + jest-expo (`npx expo install @testing-library/react-native --dev`) | No device. Estimate 200–500 MB |
| Mobile user flow | Maestro: `maestro test flow.yaml` (non-zero exit on failure) | JVM about 360 MB (claimed) plus the simulator or emulator |
| Flutter screen | Golden tests in `flutter test` | No emulator. Estimate 300–600 MB |
| Android / Compose screen | Paparazzi or Roborazzi on the JVM (`./gradlew verifyPaparazziDebug`) | No emulator, but Gradle can take 1–4 GB: set `unitTests.maxHeapSize` |
| iOS screen | swift-snapshot-testing in `xcodebuild test` | A booted simulator takes about 1–4 GB (claimed); a plugged-in device costs the Mac almost nothing |

## Tools built for agents

These are for **exploring and using the running app**, and for writing tests. The gate still runs the project's own tests by exit code.

| Use | Suggest | Setup |
|---|---|---|
| Drive the web app and read the page | playwright-cli (shares Playwright's browser, uses fewer tokens than the MCP) | `npx playwright cli` (Playwright 1.62+), or `npm i -g @playwright/cli && playwright-cli install --skills` |
| Same, with screenshot diffs or a light engine | agent-browser | `npm i -g agent-browser && agent-browser install` (`--engine lightpanda` for DOM-only work) |
| Write Playwright tests where there are none | Playwright test agents (planner, generator, healer) | `npx playwright init-agents --loop=claude` |
| Performance, console and network debugging | Chrome DevTools MCP | `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp` |
| Mobile flows and screen inspection | Maestro MCP (built into the CLI) | `claude mcp add maestro -- maestro mcp` |
| Simulators, emulators and devices | mobile-mcp | `claude mcp add mobile-mcp -- npx -y @mobilenext/mobile-mcp@latest` |
| Expo apps (SDK 54+) | Expo MCP | `claude mcp add --transport http expo https://mcp.expo.dev/mcp`, `npx expo install expo-mcp --dev` |
| Native iOS build and test | MobileBuildMCP (formerly XcodeBuildMCP) | `npx -y mobilebuildmcp@latest mcp` |
| iOS simulator taps and screenshots | ios-simulator-mcp (needs idb) | `claude mcp add ios-simulator npx ios-simulator-mcp` |

pytest has no built-in agent mode. If its output floods the context, use `-q --tb=short -rfE`.

**Don't suggest:**
- **Playwright MCP:** heavier than playwright-cli, which its own README points coding agents to.
- **Shortest, Magnitude:** stale or pivoted.
- **Octomind, Bugster:** shut down in 2026.
- **AI QA SaaS** (QA Wolf, Momentic, testRigor, Checksum, Meticulous): paid, and the tests live outside the repo.
- **Vision-model tools** (Midscene, Stagehand, browser-use) as a gate: they need an API key and the same run can pass one time and fail the next.
- **Test-runner MCP servers:** they add nothing over an exit code.
