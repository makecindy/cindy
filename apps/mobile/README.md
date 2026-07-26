# Cindy Mobile

Mobile controller for Cindy device link. The app logs in with the same Cindy account as desktop, discovers controllable desktop devices, mirrors active sessions, sends messages, and resolves pending remote interactions.

## Planning

- [Design guide](./docs/mobile-design-guide.md)
- [Remote control plan](./docs/remote-control-plan.md)
- [Simulator debugging guide](./docs/simulator-debugging.md)

## Local Setup

```bash
cp apps/mobile/.env.example apps/mobile/.env
pnpm --filter mobile start -- --host localhost --port 8081
```

For current-source iOS Simulator debugging, use the development-client loop in
the [simulator debugging guide](./docs/simulator-debugging.md). Do not use
Expo Go or an installed distribution build as proof that local source changes are running.

Required Expo public env:

- `EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL`: endpoint manifest bootstrap base (per-region hotfix CDN). Runtime business endpoints (auth / device-link / gateway) are resolved from `<base>/endpoint.json` at startup; in dev they default to the repo's `config/endpoint.global.json` and can still be overridden with explicit `EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL` / `EXPO_PUBLIC_CINDY_AUTH_BASE_URL`. Set `EXPO_PUBLIC_ENDPOINTS_CDN=1` to make dev fetch the online manifest used by packaged clients.

The mobile redirect URI is region-specific: `cindycn://auth` for CN and
`cindy://auth` for Global. Cindy Auth and native social login callbacks must
return to the scheme selected by the build region.

## Automated Checks

Headless checks:

```bash
pnpm --filter mobile typecheck
pnpm --filter mobile test
pnpm --filter mobile test:smoke
pnpm --filter mobile test:web-smoke
pnpm --filter mobile test:e2e:doctor
pnpm --filter mobile test:e2e:maestro:check
pnpm --filter mobile test:e2e:reconnect:local
```

Native simulator E2E uses Maestro. Install the CLI once:

```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

Maestro 2.x requires Java 17+. If your default `java` is older but Homebrew `openjdk@17` is installed, run E2E with:

```bash
export PATH="$HOME/.maestro/bin:/opt/homebrew/opt/openjdk@17/bin:$PATH"
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
```

Run the app on an iOS Simulator or Android Emulator, then run:

```bash
pnpm --filter mobile test:e2e:doctor:ios
pnpm --filter mobile test:e2e:maestro
```

Use `test:e2e:doctor:android` before Android runs. The doctor checks Maestro, Expo CLI, booted iOS Simulator or connected Android device, Expo Go URL, and API base consistency before a native flow starts.

The default flow covers mock login and device-list sync. Session control flows can run against either a real desktop dev instance or the built-in protocol-level mock host:

```bash
pnpm --filter mobile test:e2e:maestro -- --flow remote_session_smoke.yaml
pnpm --filter mobile test:e2e:create-session
pnpm --filter mobile test:e2e:maestro -- --flow fork_rewind.yaml
pnpm --filter mobile test:e2e:maestro -- --flow automations.yaml
pnpm --filter mobile test:e2e:maestro -- --flow automations_create_edit.yaml
pnpm --filter mobile test:e2e:maestro -- --flow file_browser.yaml
```

`automations_create_edit.yaml` also touches the schedule template gallery before saving the created automation.

For local device-link smoke, use the preflight runner. It probes the local server, mock auth, device-link REST, controllable desktop presence, then runs the session flow:

```bash
pnpm --filter mobile test:e2e:local
```

For the iOS-first runtime gate, let the runner launch the local server, Expo/Metro, and the protocol mock host before Maestro starts:

```bash
pnpm --filter mobile test:e2e:local:ios
```

To browse real local Cindy session/message data through the same mobile flow, use the real-DB fixture. This keeps the host protocol mocked but reads the desktop SQLite `sessions` and `messages` tables:

```bash
pnpm --filter mobile test:e2e:local:real-db:ios
```

Use the full suite when changing remote controls, file preview, media preview, message selection, automations, or settings:

```bash
pnpm --filter mobile test:e2e:local:full:ios
```

Useful checks while setting up the three processes:

```bash
pnpm --filter mobile test:e2e:local -- --dry-run
pnpm --filter mobile test:e2e:local -- --check-only
pnpm --filter mobile test:e2e:local:fixture -- --check-only
pnpm --filter mobile test:e2e:local:create -- --check-only
pnpm --filter mobile test:e2e:local:controls -- --check-only
pnpm --filter mobile test:e2e:local:full -- --check-only
```

`test:e2e:local:fixture` starts `scripts/mock-device-link-host.mjs`, which logs into the local server with dev auth, appears as a controllable Mac, and answers the mobile app's `device-link` invokes with a stable session fixture. The fixture includes messages, queue controls, schedule basics, remote file stat/list/preview, and image/video/audio media fetch responses. Add `--start-server` if you want the runner to launch `pnpm dev:server` before probing, and add `--start-expo` when you want it to launch Expo/Metro instead of relying on a manually opened Expo terminal.

`test:e2e:local:create` uses the same fixture but starts from the mobile new-session screen, creates a dialogue session on the controlled computer, sends the first message, and verifies the created session opens.

`test:e2e:local:controls` runs the same local fixture with the `controls` scenario and the combined `fixture_controls_smoke.yaml` flow. It covers queue edit, permission, ask-user, plan review, issue confirmation, and a final send in one native Maestro session.

Visual smoke captures screenshots for the devices list, settings, device detail, session, session controls, and the six core session states. Run it against the same mock host or a real desktop fixture:

```bash
pnpm --filter mobile test:e2e:visual
pnpm --filter mobile test:e2e:visual:ios
pnpm --filter mobile test:e2e:visual:android
```

Current product work is iOS-first. Keep the Android commands and profile checks as guardrails so app ids, Expo URLs, safe-area handling, and baseline directories do not drift; collect the Android baseline after the iOS experience is accepted.

This flow uses Maestro `takeScreenshot` for stable artifact capture. Use explicit profiles so iOS and Android do not share app ids, launch URLs, or baseline directories:

```bash
pnpm --filter mobile test:e2e:visual:update-baseline:ios -- --actual-dir .
pnpm --filter mobile test:e2e:visual:baseline:ios -- --actual-dir .
pnpm --filter mobile test:e2e:visual:update-baseline:android -- --actual-dir .
pnpm --filter mobile test:e2e:visual:baseline:android -- --actual-dir .
```

The built-in profiles are `ios-iphone-17-pro-expo-go` and `android-pixel-expo-go`. The baseline checker stores files under `e2e/visual-baselines/<profile>/` with `manifest.json`. iOS profiles crop the top status-bar area before hashing; Android profiles use the full screenshot. The iOS profile currently enforces 12 screenshots, including `visual-settings` and `visual-session-payload`. It intentionally uses strict sha256 comparison for now so layout drift is caught without adding native image dependencies; replace it with tolerant pixel diff only after real device profiles are fixed.

Reconnect smoke is headless and uses the real local device-link relay. It opens a mock host and controller over WebSocket, drops the controller connection, sends a host push while offline, reconnects, and verifies the gap is healed by reloading host-authoritative messages:

```bash
pnpm --filter mobile test:e2e:reconnect:local
```

The package script starts the local server fixture automatically; pass `-- --dry-run` to inspect the host/controller IDs and server command.

Runtime mobile voice input uses the Cindy login access token to create a short-lived voice session. ASR frames and refinement go through `voice-server`; the dedicated inference project key never reaches the app and no LiteLLM key is required in mobile Settings. The old desktop-key relay path (`device-link:voice:credential-sync`) has been removed: desktop now rejects that channel with `VOICE_CREDENTIAL_SYNC_REMOVED`, the mock host mirrors the same rejection, and the legacy credential export/fetch/relay/doctor scripts are gone.

For headless endpoint validation, the ASR/refine preflight remains. It is config-driven: point it at an ASR/refine proxy through `XDT_MOBILE_VOICE_PROXY_BASE_URL` / `XDT_MOBILE_VOICE_PROXY_API_KEY` (or a local credential JSON fixture via `XDT_MOBILE_VOICE_CREDENTIAL_JSON` / `--credential-file`), then add `--run` to actually call the endpoints:

```bash
XDT_MOBILE_VOICE_PROXY_BASE_URL=http://localhost:3345 XDT_MOBILE_VOICE_PROXY_API_KEY=sk-mock-mobile-voice-key \
  pnpm --filter mobile test:voice-cloud:preflight:run
```

For the usual local iOS smoke, the runner starts the local mock voice proxy and can run the same preflight against it first:

```bash
pnpm --filter mobile test:e2e:local:voice:ios -- --voice-cloud-preflight --no-mock-audio
```

Add `--voice-cloud-all-candidates` to that smoke when you want the local mock voice proxy to exercise every ASR/refine fallback candidate before Maestro starts.

The Maestro voice flow remains a stable UI/controller regression and may use mock output, because real ASR text depends on microphone input and should not be asserted as a fixed string.

Mobile voice input keeps the same provider-neutral fallback order as desktop: Volcengine SAUC first, then Qwen realtime, then OpenAI-compatible realtime. Every candidate/recovery obtains a fresh one-shot ticket from `voice-server`; refinement keeps its two-model fallback and falls back to raw ASR text if both fail.

The default app id is `com.xd.cindy`. Override when testing Expo Go or a custom dev build:

```bash
XDT_MOBILE_E2E_APP_ID=host.exp.Exponent pnpm --filter mobile test:e2e:maestro
pnpm --filter mobile test:e2e:maestro -- --app-id com.example.XDMaker --flow login_mock.yaml
pnpm --filter mobile test:e2e:maestro -- --platform android --app-id com.example.XDMaker --flow login_mock.yaml
```

When using Expo Go, the runner opens `exp://localhost:8081/--/devices` by default so flows start from the devices route. Override it when Expo runs on another host or port:

```bash
XDT_MOBILE_E2E_APP_ID=host.exp.Exponent XDT_MOBILE_E2E_EXPO_URL=exp://localhost:19000/--/devices pnpm --filter mobile test:e2e:local:media
```

For Android Expo Go, pass Android's package id explicitly:

```bash
XDT_MOBILE_E2E_PLATFORM=android XDT_MOBILE_E2E_APP_ID=host.exp.exponent XDT_MOBILE_E2E_EXPO_URL=exp://10.0.2.2:8081/--/devices pnpm --filter mobile test:e2e:maestro
```
