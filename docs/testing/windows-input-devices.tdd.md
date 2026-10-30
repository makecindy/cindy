# Windows input device detection — validation report

## Scope and baseline

User journeys: discover Codex Micro and gamepads in Keyboard Shortcuts on Windows,
without changing enabled preferences or regressing macOS. No supplied plan.
Branch `codex/fix-windows-input-device-detection` was created from freshly fetched
`origin/main` at `1b379ba5d3dc5caf53e387540d70a9d24f8e6353` on 2026-09-09.
Implementation and local validation were completed before PR submission.
A pre-migration stash was retained as a recovery copy.

## Evidence

- Desktop RED: `pnpm --filter desktop exec vitest run src/main/worklouder-codex/__tests__/sdkResolver.test.ts src/main/xbox-gamepad/__tests__/host.test.ts`
  reproduced missing Store discovery (query never called) and Windows helper rejection
  (`Xbox gamepad helper is not available on win32`). 3 failed, 17 passed.
- Native RED: `cargo test --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml`
  executed the initial mapping regressions: 2 failed (null frame and generic family).
- Desktop GREEN: the same tests passed after implementation. Adding controller tests
  (`src/main/xbox-gamepad/__tests__/controller.test.ts`) and SDK cooldown/path tests yielded 34 passing tests.
- Native GREEN: `cargo test --locked --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml`
  passed 5 tests: all supported digital buttons, analog inputs, neutral release,
  vendor family recognition, and vendor precedence over display name.
- `pnpm test:unit:related`: PASS (Desktop, 198.4 seconds).
- `cargo build --locked --release --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml`: PASS on Windows x64.
- `cargo clippy --locked --manifest-path apps/desktop/native/xbox-gamepad/windows-gamepad-helper/Cargo.toml -- -D warnings`: PASS.
- Targeted ESLint and `git diff --check`: PASS.
- Desktop typecheck initially failed on a missing workspace dependency link for
  `@cindy/model-providers/pi-thinking-levels`. `pnpm install --frozen-lockfile --ignore-scripts`
  restored the link without source/lockfile changes; the repeat check passed.

## Bridge-specific correction after hardware confirmation

- The user confirmed the target is the N4 Bridge virtual device, not original hardware.
  Windows exposes two collections for VID/PID `303A:8360`: primary `FF00/1` and
  companion `FF70/1`, with interface number `-1`. The new helper matches only the
  primary collection, without assuming USB interface 0 or using the companion stream.
- Added an independent Windows native Micro backend using HIDAPI and the public
  Micro-compatible JSON report format. It does not import, copy, or redistribute
  the proprietary SDK or the external bridge's implementation.
- A locally available SDK / ordinary app installation keeps its existing precedence.
  Without one, Windows uses Cindy's bundled native helper, before Store SDK lookup.
- Native bridge RED: all 5 initial framing/filter/input/lighting tests failed before
  implementation. GREEN: 7 native tests pass, including buffer bounds and release lighting.
- Desktop backend RED: native fallback returned null. GREEN: SDK resolver and native
  child adapter tests pass, including queued startup, disposal races, bounded malformed
  output and exactly-once failure/exit delivery.
- Full device suites: `pnpm --filter desktop exec vitest run src/main/worklouder-codex/__tests__ src/main/xbox-gamepad/__tests__`
  passed 298 tests, with 1 pre-existing skipped test. A subsequently added adapter
  buffer-bound regression also passed (4 adapter tests total).
- Real Windows bridge validation passed both directly and through
  `WorkLouderCodexHostClient` + `WindowsMicroHost`: `presence=true`, firmware
  `0.1.0-n4-emulator`, `connected`, then clean disposal. Only a status RPC was sent;
  no synthetic keys were injected into the user's running applications.
- Both native helpers built release binaries; Clippy passed. Their Cargo manifests
  are included in the license generator; regenerated notices and all 9 notice tests pass.
- Final Desktop typecheck passed. An earlier total gate attempt was blocked before
  Desktop tests: `test:runner` scans unrelated `.cindy-worktrees/silent-bohr` tests and
  failed its Windows symlink-skip rule. Reproduced twice before cleanup was authorized.

## P1 review fixes

- Trigger hysteresis: Windows now emits digital LT/RT from per-device `TriggerState`.
  State survives periodic enumeration and forced probes, but resets on replacement.
  The RED reproducer had missing digital trigger fields; GREEN covers pressure
  `0 → 0.6 → 0.5 → 0.6 → 0.41 → 0.4 → 0.5 → 0.55` for both triggers.
  Controller integration tests verify one voice press/release rather than recording churn.
- Micro joystick: `v.oai.rad` and bare `{a,d}` now produce `kind: joystick`; finite
  normalized `[0,1]` bounds, direction samples and centering are tested. The RED
  reproducer returned `None`; GREEN includes native parsing plus adapter validation.
- Development cache: the build directory now includes a hash of the canonical source
  checkout path. Two older checkouts sharing a dev profile build distinct binaries,
  while repeated resolution in the same checkout still reuses its cache. The RED
  reproducer returned the first checkout's binary for both; GREEN covers both helpers.
  These are in-memory tests and never touch real userData or another worktree.
- P1 verification: 25 Desktop test files passed (304 tests, 1 existing skip);
  6 gamepad Rust tests and 9 Micro Rust tests passed; both release builds and Clippy
  passed. Targeted ESLint, `git diff --check`, and the new Desktop typecheck passed.
- The first P1 `pnpm test:unit:related` rerun was blocked by the unrelated
  `.cindy-worktrees/silent-bohr` symlink-test scan (504 runner tests pass, 1 fails).
  No test bypass, foreign worktree edit, commit or push was performed.

## Authorized blocker cleanup and final gate

- The user explicitly authorized discarding `.cindy-worktrees/silent-bohr`.
  Its 9 untracked architecture documents/screenshots were archived and verified
  before removing the worktree. Branch `cindy/silent-bohr` was retained.
- After removal, `pnpm test:unit:related` passed: runner 505 passed / 0 failed
  (8 existing skips, 21.1 seconds); Desktop related unit tier passed (154.1 seconds).
  No gate was bypassed. The device-fix branch and its source changes were preserved.

## Hardware and platform limits

- The actual Store inventory query found the installed `OpenAI.Codex` package.
  The SDK exists below `app/resources/app.asar/node_modules/@worklouder/device-kit-oai`.
- Loading that SDK from both Cindy's Electron runtime and Node failed with
  `ERR_DLOPEN_FAILED: Access is denied` on its bundled serialport native addon.
  The native fallback now avoids that failure for the confirmed bridge.
  No ACL changes, SDK copying, or native-loader substitutions were attempted.
- The Windows release helper emitted all four initial absence messages, responded
  to `probe`, and exited with code 0 on `stop`. No active controller was enumerated
  during the smoke test; live button/axis input and unplug/replug remain unverified.
- Windows PnP showed a paired Xbox controller and the user-confirmed
  `Mirabox N4 Codex Micro bridge`.
- Uses Windows.Gaming.Input's mapped Gamepad interface. Does not implement arbitrary
  raw HID mappings, Switch 2 USB claiming, or the OS-reserved Xbox guide button.
- macOS hardware, Windows ARM64, and UI end-to-end testing were not run.
  Native Rust tests were run explicitly, not by the Vitest related gate.
- No numerical coverage measurement was taken; an 80% coverage claim is not made.

## Local Windows test installer

- `pnpm --filter desktop release:package -- --platform win32 --arch x64 --region global --no-sign`
  completed on 2026-09-09. The first attempt exhausted Node's default 4 GB heap;
  the successful retry used command-scoped `NODE_OPTIONS=--max-old-space-size=12288`,
  restoring the original environment afterwards. No build gate was skipped.
- Output: `apps/desktop/release/artifacts/global/unversioned/win32-x64/cindy-unversioned-Setup.exe`
  (233650646 bytes). SHA-256:
  `e101b588cf6a37c6fb9c434382b1fb1086bc4e50bf9231de6e67f49413fbb591`.
- Both packaged input helpers are PE x64 and byte-for-byte SHA-256 matches of the
  current Rust target builds. The native Micro entry is present in the packaged
  `bootstrap-electron` JavaScript chunk.
- Packaged migration resource verification passed (105 SQL files). The normal
  packaged smoke test passed against a temporary, isolated userData directory:
  exit 0, schema version 104, empty sessions/messages.
- This unsigned 0.0.0 local test package does not participate in automatic updates.
  It was not installed or published. It includes the uncommitted fixes; the build-info
  commit SHA identifies the base commit, not a newly committed revision.

## PR #4208 review iteration (2026-09-10)

- Greptile 3974944109: restored AG00–AG12 compatibility in native Micro input.
  RED dropped AG06; GREEN covers press/release in bare and wrapped notifications,
  while rejecting AG13, AG99 and malformed key names (10 Micro Rust tests pass).
- Greptile 3974944114: each WGI device metadata probe now returns an independent
  result; the selector skips failed devices and retains stable healthy selections.
  RED propagated one bad device; GREEN covers mixed healthy/failing candidates and
  an all-failed snapshot without terminating the host (8 gamepad Rust tests pass).
- Codex 3974959503: native preparation now exposes readiness separately from HID
  connection time. The connection watchdog starts after helper spawn and ignores
  late readiness from disposed children. RED killed the adapter four times during
  a simulated 30-second build; GREEN preserves one build, then enforces the normal
  five-second connection timeout (36 host/client tests pass).
- Both native Clippy checks pass. Final combined-change submission gates passed:
  related Desktop tests (165.0 seconds) and Desktop typecheck (incremental cache in
  a unique temporary directory, with unchanged strict checking). The previously packaged 0.0.0 installer predates this
  review iteration and is not evidence for these additional fixes.

## Delivery self-check

### Issue #4212 acceptance follow-up

- Action plan posted to #4212 before implementation (issuecomment-5613783170).
- Extracted the existing native presence/snapshot message projection without
  changing state semantics. Rust producer tests and TypeScript consumer tests use
  the same windowsLifecycle.json contract fixture. The producer exercises live
  metadata reuse, stable selection, real removal, read failure and frame mapping;
  the consumer streams fragmented JSON/UTF-8 through the actual Host and controller.
- Assertions cover repeated recoverable metadata failures while voice/scroll are
  held, no same-family switch, exactly-once releases for real disconnect/read error,
  and replacement ordering. Additional Host/controller tests cover disable, loss of
  foreground and layout preview. These are simulated fault/contract tests, not
  physical-device or full-UI evidence.
- The consumer baseline passed before refactoring. The producer contract initially
  lacked a pure message projection seam; after extraction, all 11 gamepad Rust
  tests and all 6 cross-layer consumer tests passed. No new product bug was claimed
  from the test-seam or JSON numeric-representation setup failures.
- An actual active Xbox One Game Controller was enumerated on this Windows host.
  Complete UI/hardware operation acceptance and final-head installer evidence are
  still pending. Final acceptance will be reported in #4212 only after all checks,
  physical operation evidence and maintainer approval are satisfied.
- Pre-commit validation passed: related Desktop unit gate (432.3 seconds), Desktop
  typecheck, 11 gamepad / 14 Micro Rust tests, both Clippy checks, 9 license/SBOM
  tests, targeted ESLint and diff checks.

### Follow-up: transient metadata is not unplug (Greptile 3975106066)

- Fresh WGI list membership is checked by COM object identity. A selected handle
  that remains present reuses its known metadata; only new handles need fallible
  metadata queries. Real removal and GetCurrentReading failures still release input.
- RED selected a second controller when the current controller's metadata probe
  failed. GREEN retains the current controller and separately proves disappeared
  handles are not retained. All 10 gamepad Rust tests and Clippy pass.
- Explicit probe frames remain forced even when the selected Device is cloned;
  cached metadata does not suppress layout-preview snapshots.
- The maintainer architecture approval gate is tracked in upstream issue #4212;
  this fix does not bypass that gate or replace maintainer approval.
- Final submission validation passed: related Desktop unit gate (169.7 seconds),
  Desktop typecheck with the existing temporary incremental cache, and diff checks.

### Follow-up: legacy Micro compatibility (Codex 3975189213 / 3975189217)

- Native input now follows the existing host contract for omitted/null act, exact
  numeric strings, numeric values, key aliases and encoder identifiers. Invalid
  coercions remain rejected. RED dropped valid legacy notifications; GREEN covers
  bare and wrapped notifications plus invalid actions.
- RPC rejections retain typed details internally. Only explicit unsupported-method
  responses to device.status degrade to empty optional telemetry. Timeouts, HID
  failures, permission errors and other remote failures remain fatal; other RPCs
  do not use this fallback. RED rejected method-not-found status; GREEN keeps the
  device usable while preserving real failure behavior.
- All 14 Micro Rust tests, Clippy and release build pass. The existing local test
  installer predates these review fixes and has not been rebuilt during monitoring.
- Final submission gates passed: related Desktop unit tests (283.8 seconds),
  Desktop typecheck with the existing temporary cache, and diff checks.

### Follow-up: bounded cold-start state (Codex 3976152597)

- RED reproduced queue overflow while native binary preparation remained pending:
  repeated discovery/probe/lighting polling exhausted the old 64-item FIFO.
- Preparation now retains only the latest idempotent request per kind, with the
  existing bound preserved for unknown requests. A pending stop supersedes all
  obsolete state and prevents later polling from restarting work.
- GREEN: 38 adapter/HostClient tests passed, including 200 polling iterations
  during deferred preparation and stop supersession; targeted ESLint passed.
- Required pre-commit related unit gate and Desktop typecheck both passed.
- The successful installer built from 0b926345e predates this fix and is intermediate
  evidence only; final-head packaging and physical/UI acceptance remain pending.

### Follow-up: coalesced native output (Codex 3976294716)

- RED: one fragmented message followed by 2,000 complete messages in one chunk
  delivered zero events because the aggregate buffer exceeded the per-line cap.
- Complete lines are now consumed individually, retaining the 65,536-character
  limit for each complete line and the unfinished tail. Oversized terminated and
  unterminated lines still fail closed; valid batching does not consume retries.
- GREEN: 41 adapter/HostClient tests and targeted ESLint passed. The required root
  related-unit gate and Desktop typecheck also passed before submission.
- User hardware acceptance: Bluetooth buttons, sticks and triggers were reported
  working. USB is NOT accepted: the native WGI helper emitted only one neutral
  frame over 30 seconds while an independent XInput sample read active buttons,
  trigger pressure and stick axes. This is evidence of a native reading-path gap,
  not proof of a cable fault or proof that a replacement backend is already fixed.

### Follow-up: USB Xbox input (Codex 3976765716)

- Xbox/XInput-compatible controllers now use XInput 1.4, not WGI readings, for
  both USB and Bluetooth. WGI no longer publishes the Xbox family, avoiding a
  second presence owner or stale neutral frames overwriting XInput input.
- The selected XInput slot remains stable while readable; failure emits absence
  before a replacement's presence/frame, resets trigger state, and releases via
  the existing Host/controller protocol. Empty slots are scanned on a one-second
  cadence or explicit probe, not every frame. No idle-frame fallback heuristic.
- XInput has slot identity rather than WGI device names: the accessory reports
  Xbox Controller (XInput N), category XInput, and unknown transport rather than
  pretending to infer a physical device name or USB/Bluetooth mapping. Native
  non-XInput PlayStation/Nintendo/generic controllers retain their WGI path;
  controllers exposed by external XInput emulators appear in the Xbox slot.
- RED: three new tests failed at the missing XInput implementation. GREEN: all
  16 Rust tests and six shared Host/controller contract tests passed, including
  every supported button, axis endpoints, trigger normalization/hysteresis,
  stable multi-slot selection, actual read failure, and exactly ordered release.
- Clippy --all-targets and release build passed. Existing discovery tests moved
  unchanged to a sibling test module to satisfy the all-targets Clippy check.
- Live USB enumeration still succeeds. The new helper read a non-neutral D-pad
  state, but this unattended 30-second capture did not show a press/release
  sequence. Do NOT count it as complete physical input or UI acceptance; user
  retest and Bluetooth regression on the new backend remain required.
- cargo-llvm-cov is not installed, so no numerical coverage claim is made.
- Required submission gates passed: root related unit gate (Desktop 152.7 seconds),
  Desktop typecheck, Rust formatting and diff checks.

### Follow-up: XInput/WGI duplicate enumeration (Codex 3978022650)

- Windows Raw Input HID interfaces now identify XInput-owned hardware products
  using the documented IG_ component and VID/PID, independently of vendor brands
  and display names. Filter candidates before per-family selection, including
  cached WGI metadata, so an excluded duplicate does not hide a healthy candidate.
- Complete inventory refresh replaces the exclusion set; partial enumeration
  retains known exclusions and adds newly confirmed products. Raw paths stay
  internal, buffers/counts are bounded, and no drivers or input registration change.
- This uses Microsoft's product-level XInput exclusion convention, not an exact
  XInput-slot-to-WGI-object identity mapping. Devices sharing a VID/PID in mixed
  XInput/non-XInput modes remain a limitation requiring broader hardware coverage.
  Reference: https://learn.microsoft.com/en-us/windows/win32/xinput/xinput-and-directinput
- RED: three ownership tests executed and failed at the missing implementation
  (an earlier test syntax typo was corrected first and is not RED evidence).
  GREEN: 19 gamepad Rust tests, 14 Micro Rust tests, both Clippy checks and nine
  notices/SBOM tests passed; the gamepad release build is also validated.
- User confirmed the b310ae048 isolated instance (ready, PID 31860) handles USB
  and Bluetooth buttons, both sticks, LT/RT and release/return-to-neutral correctly.
  This is user-performed hardware evidence, not simulated input. Explicit unplug
  while held, foreground/background dispatch and final-head package smoke still
  need separate evidence. Third-party duplicate hardware is not available locally.
- Required submission gates passed: root related unit gate (Desktop 138.9 seconds),
  Desktop typecheck and diff checks.

Accuracy 4/5: passing tests and actual native-load failure recorded; live input unverified.
Completeness 4/5: bridge connection verified; physical input and full UI still need validation.
Clarity 4/5: separates path discovery from functional support; findings span two different devices.
Actionability 4/5: reviewable branch and required local checks pass; physical/UI validation remains.
Conciseness 4/5: scoped main/native changes; the helper necessarily adds a native build path.
Overall 4.0/5. Would the user agree? Backend connection success is evidenced, UI success is not claimed.
Priority improvements: verify actual connected-controller input and full UI behavior.
Verdict: implementation ready for PR review and hardware/UI validation after the required local gates pass. The user authorized PR submission on 2026-09-10.
