# Codex Appshots for macOS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a macOS-only Codex Appshot workflow that captures the frontmost application window and bounded Accessibility structure, places the result in the current or a new local Codex composer, and supports configurable global preferred/fallback shortcuts without changing ordinary attachments, remote/mobile behavior, or the installed Cindy app.

**Architecture:** A small Swift executable resolves and captures the frontmost macOS window, serializes a privacy-filtered AX tree, and writes one PNG into a Main-owned temporary directory. Desktop Main validates and ingests the result, owns a reload-safe capture inbox and shortcut state, then the Renderer reuses Cindy's existing draft and attachment paths. Appshot metadata remains attached to the existing image reference; both direct and queued Codex sends append the same escaped context block, while Main rejects metadata at non-Codex boundaries.

**Tech Stack:** Electron Main/Preload/Renderer, TypeScript, React, Vitest, Swift 5, AppKit, ApplicationServices, ScreenCaptureKit, CoreGraphics, existing Cindy media store and composer draft store.

**Required worker skills:** Use `test-driven-development` for every task, `systematic-debugging` for any unexpected failure, `verification-before-completion` before completion claims, and `requesting-code-review` after all implementation tasks. Keep Ponytail full mode active: reuse existing media, draft, IPC trust, permission, and native-key-listener paths; add no dependency and no database migration.

---

## File map

- Create `apps/desktop/src/shared/appshots.ts`: wire types, shortcut preferences, validation, dual-modifier matching, XML escaping, and Appshot context formatting.
- Create `apps/desktop/src/shared/__tests__/appshots.test.ts`: shared contract, privacy-safe formatting, and shortcut gesture tests.
- Modify `apps/desktop/src/renderer/lib/fileTypes.ts`: optional Appshot metadata on editable and serialized image attachments.
- Modify `apps/desktop/src/renderer/lib/imageRef.ts`: persist and coerce optional Appshot metadata inside the existing image JSON.
- Modify `apps/desktop/src/renderer/lib/messageAttachmentPayload.ts`: preserve metadata and append Appshot context to direct sends.
- Modify `apps/desktop/src/shared/agentInputQueue.ts`: preserve metadata and append the same context to queued/steered sends.
- Modify existing attachment/message tests under `apps/desktop/src/renderer/__tests__` and `apps/desktop/src/main/__tests__`.
- Create `apps/desktop/native/appshots/macos-appshot-helper.swift`: frontmost-window capture, AX traversal, redaction, bounds, JSON protocol, and deterministic self-test.
- Modify `apps/desktop/forge.config.ts`: compile and package the Appshot helper for macOS 14+.
- Create `apps/desktop/src/main/appshots/MacAppshotNativeHost.ts`: resolve/build/run the helper and parse its one-shot response.
- Create `apps/desktop/src/main/appshots/coordinator.ts`: in-flight guard, private temporary root, validation, media ingest, pending inbox, stable failures, and trusted IPC.
- Create `apps/desktop/src/main/appshots/__tests__/coordinator.test.ts`: malformed output, path escape, PNG, size, permissions, inbox, and concurrency tests.
- Create `apps/desktop/src/main/appshots/shortcutStore.ts`: preferred/fallback persistence and normalization.
- Create `apps/desktop/src/main/appshots/shortcutService.ts`: effective shortcut registration, Codex conflict fallback, notifications, and capture trigger.
- Create `apps/desktop/src/main/appshots/__tests__/shortcutService.test.ts`: persistence, fallback, restoration, and dual-modifier dispatch tests.
- Modify `apps/desktop/src/main/voice-input/global.ts`: expose ref-counted subscribers from the existing native key snapshot listener; do not create a second event tap.
- Modify `apps/desktop/src/main/voice-input/__tests__/globalShortcut.test.ts`: verify voice input and Appshots receive independent snapshots.
- Modify `apps/desktop/src/main/bootstrap-electron.ts`: construct Appshots services, register IPC, focus the main window after capture, and stop services on quit.
- Modify `apps/desktop/src/preload/preload.ts` and `apps/desktop/src/renderer/vite-env.d.ts`: expose typed Appshots capture/inbox/settings methods only.
- Create `apps/desktop/src/renderer/features/appshots/appshotInbox.ts`: exactly-once attachment and Codex/new-draft routing.
- Create `apps/desktop/src/renderer/features/appshots/__tests__/appshotInbox.test.ts`: current-Codex and new-Codex routing tests.
- Modify `apps/desktop/src/renderer/hooks/useAttachments.ts`: add a validated, already-cached Appshot as an ordinary image attachment.
- Modify `apps/desktop/src/renderer/components/new-chat/ExtraDirsButton.tsx`: optional Appshot attachment-menu action.
- Modify `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`: Codex/local/macOS gate and Appshot card presentation.
- Modify `apps/desktop/src/renderer/components/layout/MainLayout.tsx`: subscribe to and drain the Main-owned Appshot inbox.
- Modify `apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`: preserve Appshot metadata when draft images are rehomed.
- Modify `apps/desktop/src/renderer/state/newMakerDraft.ts`: route fallback captures to a local Codex draft without creating a durable session.
- Modify `apps/desktop/src/renderer/components/settings/KeyboardShortcutsSection.tsx`: preferred/fallback Appshot shortcut rows and effective-state display.
- Modify `apps/desktop/src/renderer/i18n/locales/{en,zh-CN,ja,ko}/common.json`: Appshot menu, card, errors, permissions, and shortcut text.
- Modify `apps/desktop/src/main/maker-ipc/register.ts`: fail closed when Appshot metadata reaches a non-Codex direct, enqueue, or steer boundary.

### Task 1: Shared Appshot contract and attachment persistence

**Files:**
- Create: `apps/desktop/src/shared/appshots.ts`
- Create: `apps/desktop/src/shared/__tests__/appshots.test.ts`
- Modify: `apps/desktop/src/renderer/lib/fileTypes.ts`
- Modify: `apps/desktop/src/renderer/lib/imageRef.ts`
- Modify: `apps/desktop/src/renderer/lib/messageAttachmentPayload.ts`
- Modify: `apps/desktop/src/shared/agentInputQueue.ts`
- Modify: `apps/desktop/src/renderer/__tests__/imageRefParseUserContent.test.ts`
- Modify: `apps/desktop/src/renderer/__tests__/messageAttachmentPayload.test.ts`
- Modify: `apps/desktop/src/main/__tests__/agentInputQueue.test.ts`

- [ ] **Step 1: Write failing shared contract and persistence tests**

```ts
const metadata: AppshotMetadata = {
  schemaVersion: 1,
  captureId: 'capture-1',
  capturedAt: '2026-08-05T00:00:00.000Z',
  applicationName: 'A&B',
  bundleIdentifier: 'com.example.app',
  windowTitle: '"Draft" <1>',
  accessibilityText: '<AXButton title="Send & close">',
  accessibilityTruncated: false,
};

expect(coerceAppshotMetadata(metadata)).toEqual(metadata);
expect(formatAppshotContext(metadata)).toContain(
  'app="A&amp;B" bundle-identifier="com.example.app" window-title="&quot;Draft&quot; &lt;1&gt;"',
);
expect(formatAppshotContext(metadata)).toContain(
  '&lt;AXButton title=&quot;Send &amp; close&quot;&gt;',
);
expect(coerceAppshotMetadata({ ...metadata, schemaVersion: 2 })).toBeNull();
```

Add one round-trip assertion to `imageRefParseUserContent.test.ts`, one direct-send assertion to `messageAttachmentPayload.test.ts`, and one queued-send assertion to `agentInputQueue.test.ts`: each must retain `appshot`, emit one image block, and emit exactly one escaped `<appshot>` text block after the image.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/shared/__tests__/appshots.test.ts \
  src/renderer/__tests__/imageRefParseUserContent.test.ts \
  src/renderer/__tests__/messageAttachmentPayload.test.ts \
  src/main/__tests__/agentInputQueue.test.ts
```

Expected: FAIL because `AppshotMetadata`, coercion/formatting, and persisted fields do not exist.

- [ ] **Step 3: Add the minimal shared types, validation, and formatter**

Implement these exact public contracts in `shared/appshots.ts`:

```ts
import type { AppShortcutCombo } from './appShortcuts';

export interface AppshotMetadata {
  schemaVersion: 1;
  captureId: string;
  capturedAt: string;
  applicationName: string;
  bundleIdentifier: string | null;
  windowTitle: string | null;
  accessibilityText: string | null;
  accessibilityTruncated: boolean;
  accessibilityUnavailableReason?: 'permission' | 'unsupported' | 'timeout';
}

export interface AppshotCaptureResult {
  captureId: string;
  image: {
    url: string;
    filename: string;
    size: number;
    mimeType: 'image/png';
  };
  metadata: AppshotMetadata;
}

export type AppshotDualModifier = 'command' | 'option' | 'shift';
export type AppshotShortcut =
  | { kind: 'dual-modifier'; modifier: AppshotDualModifier }
  | { kind: 'accelerator'; combo: AppShortcutCombo };

export interface AppshotShortcutPreferences {
  preferred: AppshotShortcut;
  fallback: AppshotShortcut;
}

export const DEFAULT_APPSHOT_SHORTCUT_PREFERENCES: AppshotShortcutPreferences = {
  preferred: { kind: 'dual-modifier', modifier: 'command' },
  fallback: {
    kind: 'accelerator',
    combo: { code: 'KeyA', meta: true, ctrl: false, alt: false, shift: true },
  },
};

export function coerceAppshotMetadata(value: unknown): AppshotMetadata | null;
export function normalizeAppshotShortcut(value: unknown): AppshotShortcut | null;
export function normalizeAppshotShortcutPreferences(value: unknown): AppshotShortcutPreferences;
export function isDualModifierSnapshot(keys: readonly string[], modifier: AppshotDualModifier): boolean;
export function formatAppshotShortcut(shortcut: AppshotShortcut, platform?: string): string;
export function formatAppshotContext(metadata: AppshotMetadata): string;
```

Use exact side pairs `MetaLeft+MetaRight`, `AltLeft+AltRight`, or `ShiftLeft+ShiftRight`; reject snapshots containing any third key. Escape `&`, `<`, `>`, `"`, and `'` in attributes; escape `&`, `<`, and `>` in Accessibility text; remove disallowed XML control characters. Bound coercion to the approved limits: identifiers/names/titles at 4 KiB each and Accessibility text at 512 KiB.

- [ ] **Step 4: Thread `appshot?: AppshotMetadata` through existing image shapes**

Add the same optional property to `AttachedFile`, `SerializedAttachedFile`, `ImageRef`, and `AgentInputSerializedFile`. In `serializeAttachedFiles`, `buildImageAttachment`, and `coerceImageRef`, copy only metadata accepted by `coerceAppshotMetadata`.

Append context in both send builders:

```ts
for (const file of files ?? []) {
  const block = buildAttachmentBlock(file);
  if (block) blocks.push(block);
  if (block?.type === 'image' && file.appshot) {
    blocks.push({ type: 'text', text: formatAppshotContext(file.appshot) });
  }
}
```

Use the same `formatAppshotContext` call in `shared/agentInputQueue.ts`; do not duplicate formatting logic. Preserve `appshot` in persisted image refs so draft reload and lazy session creation retain it.

- [ ] **Step 5: Re-run focused tests and verify GREEN**

Run the Step 2 command. Expected: all four files PASS, with ordinary-image assertions unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/shared/appshots.ts \
  apps/desktop/src/shared/__tests__/appshots.test.ts \
  apps/desktop/src/shared/agentInputQueue.ts \
  apps/desktop/src/main/__tests__/agentInputQueue.test.ts \
  apps/desktop/src/renderer/lib/fileTypes.ts \
  apps/desktop/src/renderer/lib/imageRef.ts \
  apps/desktop/src/renderer/lib/messageAttachmentPayload.ts \
  apps/desktop/src/renderer/__tests__/imageRefParseUserContent.test.ts \
  apps/desktop/src/renderer/__tests__/messageAttachmentPayload.test.ts
git commit -m "feat: add Appshot attachment contract"
```

### Task 2: Native macOS Appshot helper and package build

**Files:**
- Create: `apps/desktop/native/appshots/macos-appshot-helper.swift`
- Modify: `apps/desktop/forge.config.ts`

- [ ] **Step 1: Add a deterministic self-test before live capture code**

The helper must support:

```swift
if CommandLine.arguments.contains("--self-test") {
  let secure = AXNode(role: "AXSecureTextField", label: "Password", value: "secret")
  let output = serializeAccessibilityTree(root: secure, limits: .test)
  precondition(output.text.contains("Secure text field"))
  precondition(!output.text.contains("secret"))
  precondition(output.truncated)
  emitJSON(["type": "self-test", "ok": true])
  exit(0)
}
```

Use in-memory `AXNode` fixtures so this mode opens no permission prompt and verifies secure-field redaction plus node, depth, byte, and deadline truncation.

- [ ] **Step 2: Compile and run the self-test to verify RED**

Run:

```bash
xcrun swiftc apps/desktop/native/appshots/macos-appshot-helper.swift \
  -O -target arm64-apple-macos14.0 \
  -o /tmp/cindy-macos-appshot-helper
/tmp/cindy-macos-appshot-helper --self-test
```

Expected: compile FAIL until the helper and serializer are implemented.

- [ ] **Step 3: Implement the one-shot helper protocol**

The command line is fixed and Main-owned:

```text
xdt-macos-appshot-helper --output-dir /private/.../cindy-appshot-XXXXXX
```

Emit one sorted-key JSON object to stdout:

```swift
struct CaptureResponse: Codable {
  let type: String                 // "capture"
  let pngPath: String
  let applicationName: String
  let bundleIdentifier: String?
  let windowTitle: String?
  let accessibilityText: String?
  let accessibilityTruncated: Bool
  let accessibilityUnavailableReason: String?
}
```

Implement these concrete functions:

```swift
func frontmostTarget() throws -> (app: NSRunningApplication, window: SCWindow, axWindow: AXUIElement?)
func captureWindow(_ window: SCWindow, to outputURL: URL) async throws -> CGImage
func serializeAccessibilityWindow(_ window: AXUIElement?, startedAt: ContinuousClock.Instant) -> AXSerialization
func isBlankImage(_ image: CGImage) -> Bool
func validatedOutputURL(argument: String) throws -> URL
```

`frontmostTarget()` snapshots `NSWorkspace.shared.frontmostApplication` first, selects its focused AX window when available, then matches a visible layer-zero `SCWindow` by PID, title, and bounds. Reject desktop elements, zero/degenerate bounds, alpha-zero windows, closed targets, and captures with no visible pixel variance. `captureWindow` uses `SCScreenshotManager.captureImage` with `SCContentFilter(desktopIndependentWindow:)` and PNG encoding.

AX traversal must be deterministic pre-order, maximum 2,000 nodes, depth 16, UTF-8 output 512 KiB, and elapsed time 1.5 seconds. Include non-empty role, label, title, value, description, enabled, selected, and focused fields. For `AXSecureTextField`, emit only role and `label="Secure text field"`; omit protected values. Accessibility denial degrades to `accessibilityUnavailableReason: "permission"`; screen-capture denial exits with stable stderr code `APPSHOT_SCREEN_PERMISSION` and creates no PNG.

- [ ] **Step 4: Add Forge compilation and resource packaging**

Add:

```ts
const MACOS_APPSHOT_HELPER_DEPLOYMENT_TARGET = 'macos14.0';

function buildMacAppshotHelper(platform: ForgePlatform, arch: ForgeArch): void {
  if (process.platform !== 'darwin' || !isMacForgePlatform(platform)) return;
  const src = path.join(__dirname, 'native', 'appshots', 'macos-appshot-helper.swift');
  const destDir = path.join(__dirname, 'resources', 'tools', 'appshots');
  const dest = path.join(destDir, 'xdt-macos-appshot-helper');
  if (!fs.existsSync(src)) throw new Error(`[forge] macOS Appshot helper source missing at ${src}`);
  fs.mkdirSync(destDir, { recursive: true });
  buildSwiftHelperForForgeArch(
    src,
    dest,
    arch,
    MACOS_APPSHOT_HELPER_DEPLOYMENT_TARGET,
    ['-O'],
    'Appshot helper',
  );
  fs.chmodSync(dest, 0o755);
}
```

Call `buildMacAppshotHelper(platform, arch)` once in `prePackage`, next to the other Swift helpers. Do not add a package.

- [ ] **Step 5: Verify helper and Forge configuration**

Run the Step 2 command. Expected stdout: `{"ok":true,"type":"self-test"}`.

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/native/appshots/macos-appshot-helper.swift apps/desktop/forge.config.ts
git commit -m "feat: capture macOS Appshots natively"
```

### Task 3: Main-process host, validation, inbox, and trusted IPC

**Files:**
- Create: `apps/desktop/src/main/appshots/MacAppshotNativeHost.ts`
- Create: `apps/desktop/src/main/appshots/coordinator.ts`
- Create: `apps/desktop/src/main/appshots/__tests__/coordinator.test.ts`
- Modify: `apps/desktop/src/main/bootstrap-electron.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/desktop/src/renderer/vite-env.d.ts`

- [ ] **Step 1: Write failing coordinator boundary tests**

Build one test group around injected dependencies and assert:

```ts
await expect(coordinator.capture()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
expect(nativeHost.capture).toHaveBeenCalledTimes(1); // two overlapping calls
expect(ingestImage).not.toHaveBeenCalled();         // bad PNG/path/oversize
expect(coordinator.listPending()).toEqual([validCapture]);
coordinator.ack(validCapture.captureId);
expect(coordinator.listPending()).toEqual([]);
```

Cover malformed JSON fields, `pngPath` outside the private root, symlink escape after `realpath`, wrong eight-byte PNG signature, file larger than 100 MiB, screen-permission failure, accessibility-only degradation, and no captured content in logs.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/main/appshots/__tests__/coordinator.test.ts
```

Expected: FAIL because the host/coordinator do not exist.

- [ ] **Step 3: Implement the native host and validator**

Use these exact public APIs:

```ts
export interface MacAppshotNativeResult {
  pngPath: string;
  applicationName: string;
  bundleIdentifier: string | null;
  windowTitle: string | null;
  accessibilityText: string | null;
  accessibilityTruncated: boolean;
  accessibilityUnavailableReason?: 'permission' | 'unsupported' | 'timeout';
}

export class MacAppshotNativeHost {
  capture(outputDir: string): Promise<MacAppshotNativeResult>;
}
```

Packaged binary: `path.join(process.resourcesPath, 'tools', 'appshots', 'xdt-macos-appshot-helper')`. Development binary: source-hashed build under `app.getPath('userData')/appshots/xdt-macos-appshot-helper`, following `MacComputerPermissionGuideNativeHost` and compiling with `swiftc -O`. Use `execFile`, a 10-second timeout, 1 MiB JSON stdout cap, and stable error-code mapping; never log stdout/stderr content from the captured app.

- [ ] **Step 4: Implement coordinator capture and reload-safe pending inbox**

Use dependency injection and these contracts:

```ts
export type AppshotFailureCode =
  | 'unsupported-platform'
  | 'capture-in-progress'
  | 'screen-permission'
  | 'no-window'
  | 'window-closed'
  | 'protected-content'
  | 'native-failure';

export interface AppshotCoordinatorDeps {
  captureNative: (outputDir: string) => Promise<MacAppshotNativeResult>;
  ingestPng: (bytes: Uint8Array) => Promise<{ url: string; filename: string }>;
  makeTempDir: () => Promise<string>;
  removeTempDir: (path: string) => Promise<void>;
  now: () => Date;
  randomUUID: () => string;
  publish: (result: AppshotCaptureResult) => void;
}

export class AppshotCoordinator {
  capture(): Promise<AppshotCaptureResult>;
  listPending(): readonly AppshotCaptureResult[];
  ack(captureId: string): boolean;
  clear(): void;
}
```

`capture()` allows one in-flight operation, creates a private `mkdtemp` directory with mode `0700`, resolves `realpath` for root/file, verifies containment, regular-file status, size `1..100 MiB`, and PNG signature `89 50 4E 47 0D 0A 1A 0A`, reads bytes once, ingests through `cindyChatAttachments.ingestChatImageBuffer`, stores a maximum of ten pending results, publishes only metadata plus the managed media URL, and removes the temp root in `finally`.

- [ ] **Step 5: Register trusted IPC and preload surface**

Expose only:

```ts
appshots: {
  capture: (): Promise<{ accepted: true }>;
  listPending: (): Promise<AppshotCaptureResult[]>;
  ack: (captureId: string): Promise<{ acknowledged: boolean }>;
  onCaptured: (callback: (result: AppshotCaptureResult) => void) => () => void;
}
```

IPC channels are `appshots:capture`, `appshots:list-pending`, `appshots:ack`, and `appshots:captured`. Every inbound handler calls `assertTrustedAppRendererEvent`; `ack` validates a non-empty capture ID. Publish only to `mainWindowRef` after `isTrustedAppRendererWindow` passes. `capture` accepts no PID, window ID, file path, or output path.

In `bootstrap-electron.ts`, wire `ingestPng` to `cindyChatAttachments.ingestChatImageBuffer({ buffer, mimeType: 'image/png' })`, call `focusMainWindow()` only after successful capture, and clear pending state on `will-quit`.

- [ ] **Step 6: Re-run coordinator tests and typecheck**

Run the Step 2 command, then Desktop typecheck. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/main/appshots \
  apps/desktop/src/main/bootstrap-electron.ts \
  apps/desktop/src/preload/preload.ts \
  apps/desktop/src/renderer/vite-env.d.ts
git commit -m "feat: coordinate Appshot capture securely"
```

### Task 4: Preferred/fallback global shortcuts using the existing native listener

**Files:**
- Create: `apps/desktop/src/main/appshots/shortcutStore.ts`
- Create: `apps/desktop/src/main/appshots/shortcutService.ts`
- Create: `apps/desktop/src/main/appshots/__tests__/shortcutService.test.ts`
- Modify: `apps/desktop/src/main/voice-input/global.ts`
- Modify: `apps/desktop/src/main/voice-input/__tests__/globalShortcut.test.ts`
- Modify: `apps/desktop/src/main/bootstrap-electron.ts`
- Modify: `apps/desktop/src/preload/preload.ts`
- Modify: `apps/desktop/src/renderer/vite-env.d.ts`

- [ ] **Step 1: Write failing shortcut behavior tests**

Assert these transitions with fake `globalShortcut`, running-app snapshots, key snapshots, and JSON storage:

```ts
expect(service.state().configured).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred);
expect(service.state().active).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.preferred);

runningBundleIds.add('com.openai.codex');
service.refreshConflicts();
expect(service.state().active).toEqual(DEFAULT_APPSHOT_SHORTCUT_PREFERENCES.fallback);

keys.emit(['MetaLeft', 'MetaRight']);
keys.emit(['MetaLeft', 'MetaRight']);
expect(capture).toHaveBeenCalledTimes(1); // rising edge only
keys.emit([]);
keys.emit(['MetaLeft', 'MetaRight']);
expect(capture).toHaveBeenCalledTimes(2);
```

Also assert preferred restoration after Codex exits, fallback after Electron rejects a conventional registration, disabled global trigger when both fail, preference persistence across reload, and manual capture remaining available.

- [ ] **Step 2: Run shortcut tests and verify RED**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/main/appshots/__tests__/shortcutService.test.ts \
  src/main/voice-input/__tests__/globalShortcut.test.ts
```

Expected: Appshots shortcut tests FAIL; existing voice tests remain green.

- [ ] **Step 3: Implement the dedicated preference store**

Persist only user values in `appshots-shortcuts.v1.json` under `app.getPath('userData')`:

```ts
export interface AppshotShortcutStoreDeps {
  getFilePath: () => string;
  readFile: (path: string) => string;
  writeFileAtomic: (path: string, value: string) => void;
}

export class AppshotShortcutStore {
  get(): AppshotShortcutPreferences;
  set(next: unknown): AppshotShortcutPreferences;
  reset(): AppshotShortcutPreferences;
}
```

Normalize with `normalizeAppshotShortcutPreferences`; reject preferred/fallback equality and system-reserved conventional combinations. Defaults remain code-owned and are not written until the user customizes them.

- [ ] **Step 4: Share the existing key snapshot process**

In `voice-input/global.ts`, add a ref-counted subscriber set around the existing `macModifierShortcutListener`:

```ts
type MacModifierSnapshotSubscriber = (keys: readonly string[]) => void;
const macModifierSnapshotSubscribers = new Map<string, MacModifierSnapshotSubscriber>();

export async function retainMacModifierKeySnapshots(
  owner: string,
  subscriber: MacModifierSnapshotSubscriber,
): Promise<() => void> {
  macModifierSnapshotSubscribers.set(owner, subscriber);
  const started = await macModifierShortcutListener.startKeyCapture();
  if (!started.ok) {
    macModifierSnapshotSubscribers.delete(owner);
    throw new Error(started.error);
  }
  return () => {
    macModifierSnapshotSubscribers.delete(owner);
    if (macModifierSnapshotSubscribers.size === 0 && modifierShortcutRecordingWebContentsIds.size === 0) {
      macModifierShortcutListener.stopKeyCapture();
    }
  };
}
```

Dispatch every `onKeys` snapshot to both the existing recording windows and a copied subscriber list. Update `stopNativeShortcutListenerPreservingCapture()` to preserve the helper while either recordings or subscribers exist. Do not instantiate another `MacModifierShortcutListener` and do not modify the Swift listener.

- [ ] **Step 5: Implement effective shortcut service**

```ts
export interface AppshotShortcutState {
  preferences: AppshotShortcutPreferences;
  configured: AppshotShortcut;
  active: AppshotShortcut | null;
  fallbackReason?: 'codex-running' | 'registration-conflict' | 'input-monitoring';
}

export class AppshotShortcutService {
  start(): Promise<void>;
  stop(): void;
  state(): AppshotShortcutState;
  setPreferences(value: unknown): Promise<AppshotShortcutState>;
  reset(): Promise<AppshotShortcutState>;
  refreshConflicts(): Promise<void>;
}
```

For a dual-modifier shortcut, retain the shared snapshots and trigger capture only on false-to-true exact-pair transitions. For a conventional shortcut, convert its existing `AppShortcutCombo` with `comboToElectronAccelerator` and register via Electron. Treat a running `NSRunningApplication`/`app.getApplicationNameForProtocol` equivalent with bundle ID `com.openai.codex` as a conflict only for dual-modifier preferred shortcuts; activate fallback while it runs and retry preferred when workspace application activation/termination events indicate a change. On capture failure, publish only stable codes.

- [ ] **Step 6: Add trusted settings IPC and lifecycle wiring**

Extend preload API:

```ts
getShortcutState: (): Promise<AppshotShortcutState>;
setShortcutPreferences: (value: AppshotShortcutPreferences) => Promise<AppshotShortcutState>;
resetShortcutPreferences: () => Promise<AppshotShortcutState>;
onShortcutStateChanged: (callback: (state: AppshotShortcutState) => void) => () => void;
```

All handlers require a trusted Renderer. Start after app readiness and the shared voice listener is registered; stop and unregister accelerators on `will-quit`. Cindy fully quit therefore leaves no shortcut process or registration.

- [ ] **Step 7: Re-run tests and commit**

Run Step 2 and Desktop typecheck. Expected: PASS.

```bash
git add apps/desktop/src/main/appshots \
  apps/desktop/src/main/voice-input/global.ts \
  apps/desktop/src/main/voice-input/__tests__/globalShortcut.test.ts \
  apps/desktop/src/main/bootstrap-electron.ts \
  apps/desktop/src/preload/preload.ts \
  apps/desktop/src/renderer/vite-env.d.ts
git commit -m "feat: add Appshot global shortcuts"
```

### Task 5: Renderer inbox, Codex-only composer action, and Appshot card

**Files:**
- Create: `apps/desktop/src/renderer/features/appshots/appshotInbox.ts`
- Create: `apps/desktop/src/renderer/features/appshots/__tests__/appshotInbox.test.ts`
- Modify: `apps/desktop/src/renderer/hooks/useAttachments.ts`
- Modify: `apps/desktop/src/renderer/components/new-chat/ExtraDirsButton.tsx`
- Modify: `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`
- Modify: `apps/desktop/src/renderer/components/layout/MainLayout.tsx`
- Modify: `apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx`
- Modify: `apps/desktop/src/renderer/state/newMakerDraft.ts`

- [ ] **Step 1: Write failing exactly-once routing tests**

Test a pure injected router:

```ts
const current = routeAppshotCapture(result, {
  route: '/cc-agent/codex-session',
  resolveSession: () => ({ id: 'codex-session', agentKind: 'codex', writable: true, local: true }),
  appendDraftAttachment,
  openNewCodexDraft,
});
expect(current).toEqual({ destination: 'session', key: 'codex-session' });

routeAppshotCapture(result, nonCodexContext);
expect(openNewCodexDraft).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'codex' }));
expect(appendDraftAttachment).toHaveBeenCalledWith(NEW_MAKER_DRAFT_KEY, expect.anything());

expect(consumeCaptureTwice(result)).toEqual(['attached', 'duplicate']);
```

Cover writable local Codex, read-only/running remote/non-Codex/no-session fallback, and capture-ID deduplication.

- [ ] **Step 2: Run inbox tests and verify RED**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/renderer/features/appshots/__tests__/appshotInbox.test.ts
```

Expected: FAIL because the inbox router does not exist.

- [ ] **Step 3: Add an already-cached Appshot to attachment state**

Extend `UseAttachmentsReturn` and `ChatInput`'s explicit attachment-state type:

```ts
addAppshot: (result: AppshotCaptureResult) => Promise<void>;
```

Implementation creates one normal image attachment without recaching bytes:

```ts
const addAppshot = useCallback(async (result: AppshotCaptureResult) => {
  const attachment: AttachedFile = {
    id: result.captureId,
    name: result.image.filename,
    path: `appshot://${result.captureId}`,
    ext: '.png',
    size: result.image.size,
    category: 'image',
    mimeType: 'image/png',
    url: result.image.url,
    originalName: result.image.filename,
    appshot: result.metadata,
  };
  setAttachments((current) => current.some((file) => file.appshot?.captureId === result.captureId)
    ? current
    : [...current, attachment]);
}, []);
```

Keep `appshot` untouched in `rehomeDraftAttachments`; object-spread URL replacement already preserves it, so add a regression assertion rather than a new branch.

- [ ] **Step 4: Implement inbox routing and MainLayout subscription**

`appshotInbox.ts` exports:

```ts
export function toAppshotAttachment(result: AppshotCaptureResult): AttachedFile;
export function routeAppshotCapture(result: AppshotCaptureResult, context: AppshotRouteContext): AppshotRouteResult;
export function installAppshotInbox(context: AppshotRouteContext): () => void;
```

`installAppshotInbox` drains `listPending()` at mount, subscribes to `onCaptured`, tracks capture IDs while a consume is in flight, writes the attachment first, then calls `ack`; failed writes remain pending for reload recovery.

Current-session routing accepts only a writable local `agentKind === 'codex'` route. Otherwise call `patchDraft` with `{ vendor: 'codex', workingDir: null, remoteHostId: null, deviceLinkDeviceId: null, deviceLinkDeviceName: null, extraDirs: [] }`, append to `NEW_MAKER_DRAFT_KEY` while preserving existing text/attachments, and navigate to `/cc-agent/new`. This uses existing lazy-create and never sends a message.

- [ ] **Step 5: Add Codex-only attachment menu action and card**

Extend `ExtraDirsButtonProps`:

```ts
onCaptureAppshot?: () => void | Promise<void>;
```

Show the menu item only when provided. In `ChatInput`, provide it only when all are true: `process.platform` reported through existing platform state is `darwin`, the composer is local, `agentKind === 'codex'`, and mutations are unlocked. Handler calls `window.electronAPI.appshots.capture()`; it does not attach from the response and does not send.

In `ThumbnailItem`, when `file.appshot` exists, render application name, window title fallback, existing image preview, and existing remove action. Keep lightbox and ordinary-image behavior unchanged.

- [ ] **Step 6: Re-run Renderer tests and typecheck**

Run Step 2, then:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/renderer/__tests__/useAttachmentsRejections.test.ts \
  src/renderer/__tests__/messageAttachmentPayload.test.ts
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/renderer/features/appshots \
  apps/desktop/src/renderer/hooks/useAttachments.ts \
  apps/desktop/src/renderer/components/new-chat/ExtraDirsButton.tsx \
  apps/desktop/src/renderer/components/new-chat/ChatInput.tsx \
  apps/desktop/src/renderer/components/layout/MainLayout.tsx \
  apps/desktop/src/renderer/features/cc-agent/NewMakerDraftRoute.tsx \
  apps/desktop/src/renderer/state/newMakerDraft.ts
git commit -m "feat: route Appshots into Codex drafts"
```

### Task 6: Codex-only send boundary and non-Codex fail-closed enforcement

**Files:**
- Modify: `apps/desktop/src/main/maker-ipc/register.ts`
- Create: `apps/desktop/src/main/maker-ipc/__tests__/appshotBoundary.test.ts`
- Modify: `apps/desktop/src/renderer/__tests__/messageAttachmentPayload.test.ts`
- Modify: `apps/desktop/src/main/__tests__/agentInputQueue.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Test exported pure validation before IPC wiring:

```ts
expect(validateAndStripAppshotMetadata(codexMessage, 'codex')).toEqual(messageWithoutInternalMetadata);
expect(() => validateAndStripAppshotMetadata(codexMessage, 'claude-code'))
  .toThrowError(/Appshots are only supported in Codex sessions/);
expect(() => requireCodexQueuedAppshots({ ...queued, createOpts: { agentKind: 'pi' } }))
  .toThrowError(/Appshots are only supported in Codex sessions/);
```

Include direct send, enqueue, steer, malformed metadata, and an ordinary image sent to Claude Code unchanged.

- [ ] **Step 2: Run the focused boundary test and verify RED**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/main/maker-ipc/__tests__/appshotBoundary.test.ts \
  src/renderer/__tests__/messageAttachmentPayload.test.ts \
  src/main/__tests__/agentInputQueue.test.ts
```

Expected: new boundary test FAIL.

- [ ] **Step 3: Preserve an internal marker through Renderer and queue builders**

Add `appshot?: AppshotMetadata` to image attachment blocks only. Each builder emits the image block with this internal property and the separate formatted text block. Existing provider-normalization must never receive this property.

- [ ] **Step 4: Validate against authoritative session kind and strip marker**

Implement in `maker-ipc/register.ts`:

```ts
export function validateAndStripAppshotMetadata(
  message: IpcUserMessage,
  agentKind: AgentKind,
): IpcUserMessage {
  if (typeof message === 'string' || typeof message.content === 'string') return message;
  let found = false;
  const content = message.content.map((block) => {
    if (block.type !== 'image' || block.appshot === undefined) return block;
    found = true;
    if (!coerceAppshotMetadata(block.appshot)) {
      throwIpcError('INVALID_PARAMS', 'invalid Appshot metadata');
    }
    const { appshot: _appshot, ...safeBlock } = block;
    return safeBlock;
  });
  if (found && agentKind !== 'codex') {
    throwIpcError('INVALID_PARAMS', 'Appshots are only supported in Codex sessions');
  }
  return { ...message, content };
}
```

Call it before `normalizeUserMessage` in `prepareUserMessageForAgent`, using `maker.getSessionMeta(sessionId)` or the live session's authoritative `agentKind`; fail closed if metadata is present and kind cannot be resolved. In `requireQueuedMessage`, inspect `files[].appshot`; reject unless `createOpts.agentKind === 'codex'`, and reject malformed metadata. This covers enqueue and steer before they detach from the IPC context.

- [ ] **Step 5: Re-run focused tests and commit**

Run Step 2. Expected: PASS.

```bash
git add apps/desktop/src/main/maker-ipc/register.ts \
  apps/desktop/src/main/maker-ipc/__tests__/appshotBoundary.test.ts \
  apps/desktop/src/renderer/__tests__/messageAttachmentPayload.test.ts \
  apps/desktop/src/main/__tests__/agentInputQueue.test.ts
git commit -m "fix: enforce Codex-only Appshot sends"
```

### Task 7: Shortcut settings, permission guidance, i18n, and release verification

**Files:**
- Modify: `apps/desktop/src/renderer/components/settings/KeyboardShortcutsSection.tsx`
- Modify: `apps/desktop/src/renderer/components/settings/__tests__/KeyboardShortcutsSection.mutationRace.test.tsx`
- Modify: `apps/desktop/src/renderer/i18n/locales/en/common.json`
- Modify: `apps/desktop/src/renderer/i18n/locales/zh-CN/common.json`
- Modify: `apps/desktop/src/renderer/i18n/locales/ja/common.json`
- Modify: `apps/desktop/src/renderer/i18n/locales/ko/common.json`
- Modify: `apps/desktop/src/main/appshots/coordinator.ts`
- Modify: `apps/desktop/src/main/appshots/shortcutService.ts`
- Modify: `apps/desktop/src/main/bootstrap-electron.ts`

- [ ] **Step 1: Write failing settings and permission presentation tests**

Add assertions for two editable rows, effective shortcut, fallback reason, mutation-race protection, and permission actions:

```tsx
expect(screen.getByText('Capture Appshot')).toBeVisible();
expect(screen.getByText('Double Command')).toBeVisible();
expect(screen.getByText('⌘⇧A')).toBeVisible();
expect(screen.getByText(/Active: ⌘⇧A/)).toBeVisible();
```

Coordinator/shortcut tests must assert: missing Screen Recording produces no inbox item and a Screen Recording action; missing Accessibility produces an attachment plus `UI structure unavailable`; missing Input Monitoring disables only the dual-modifier trigger and leaves the manual composer action.

- [ ] **Step 2: Run settings, coordinator, shortcut, and i18n tests to verify RED**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/renderer/components/settings/__tests__/KeyboardShortcutsSection.mutationRace.test.tsx \
  src/main/appshots/__tests__/coordinator.test.ts \
  src/main/appshots/__tests__/shortcutService.test.ts \
  src/renderer/__tests__/i18nCompleteness.test.ts
```

Expected: new Appshot settings/i18n assertions FAIL.

- [ ] **Step 3: Add preferred and fallback shortcut controls**

Reuse existing keyboard recording styles and `AppShortcutCombo` event conversion for conventional combinations. Add a compact selector for `Double Command`, `Double Option`, `Double Shift`, or `Key combination` for each row. Load state from `appshots.getShortcutState`, save both fields atomically with `setShortcutPreferences`, and retain the existing request-ID mutation race guard. Display `Configured`, `Fallback`, and `Active` values; show the fallback reason when active differs.

- [ ] **Step 4: Add stable user-facing errors and permission actions**

Map only stable codes in Renderer. Actions open existing Cindy permission guidance:

```ts
type AppshotPermissionTarget = 'screen-recording' | 'accessibility' | 'input-monitoring';
window.electronAPI.appshots.openPermissionSettings(target);
```

Main handles this trusted IPC by reusing `showComputerPermissionGuideWindow` for Screen Recording/Accessibility and the existing modifier-shortcut Input Monitoring path. Do not request permissions at startup; invoke only after capture or shortcut selection. Do not include app/window/AX content in notifications or logs.

- [ ] **Step 5: Add complete locale keys**

Add equivalent keys in all four locale files under:

```json
{
  "appshots": {
    "capture": "Appshot",
    "captureInProgress": "An Appshot capture is already in progress.",
    "uiUnavailable": "UI structure unavailable",
    "screenPermission": "Allow Screen Recording to capture this window.",
    "accessibilityPermission": "Allow Accessibility to include UI structure.",
    "inputMonitoringPermission": "Allow Input Monitoring to use double-modifier shortcuts."
  },
  "settings": {
    "shortcuts": {
      "appshots": {
        "title": "Capture Appshot",
        "preferred": "Preferred shortcut",
        "fallback": "Fallback shortcut",
        "active": "Active: {{shortcut}}",
        "doubleCommand": "Double Command",
        "doubleOption": "Double Option",
        "doubleShift": "Double Shift"
      }
    }
  }
}
```

Translate values naturally; keys and placeholders must remain identical.

- [ ] **Step 6: Run targeted and full verification**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run \
  src/shared/__tests__/appshots.test.ts \
  src/main/appshots/__tests__/coordinator.test.ts \
  src/main/appshots/__tests__/shortcutService.test.ts \
  src/main/maker-ipc/__tests__/appshotBoundary.test.ts \
  src/main/voice-input/__tests__/globalShortcut.test.ts \
  src/renderer/features/appshots/__tests__/appshotInbox.test.ts \
  src/renderer/__tests__/messageAttachmentPayload.test.ts \
  src/main/__tests__/agentInputQueue.test.ts \
  src/renderer/components/settings/__tests__/KeyboardShortcutsSection.mutationRace.test.tsx \
  src/main/maker-host/__tests__/providerRoute.test.ts
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop typecheck
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop lint
```

Expected: all PASS. Confirm touched TypeScript modules meet at least 80% line coverage with:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop exec vitest run --coverage \
  src/shared/__tests__/appshots.test.ts \
  src/main/appshots/__tests__/coordinator.test.ts \
  src/main/appshots/__tests__/shortcutService.test.ts \
  src/main/maker-ipc/__tests__/appshotBoundary.test.ts \
  src/renderer/features/appshots/__tests__/appshotInbox.test.ts
```

- [ ] **Step 7: Build a separate macOS app without replacing the installed Cindy**

Run:

```bash
PATH=/Users/hanbala/.nvm/versions/node/v22.22.3/bin:$PATH pnpm --filter desktop package -- --platform=darwin --arch=arm64
```

Expected artifact under `apps/desktop/out/`, not `/Applications/Cindy.app`. Run the packaged helper self-test from the artifact's `Contents/Resources/tools/appshots/xdt-macos-appshot-helper --self-test` and expect `{"ok":true,"type":"self-test"}`.

Manual acceptance on that separate build:

1. Capture Safari, Finder, a text editor, and Cindy; verify image, app name, bundle ID, title, and AX structure.
2. Verify Retina/non-Retina, multiple displays, and partially off-screen windows.
3. Verify full permissions, screenshot-only, and no permissions; secure values never appear.
4. Verify current local Codex receives one unsent card; Claude Code/Pi/remote/no-session opens a new local Codex draft and does not send.
5. Verify double Command, custom preferred/fallback, Codex-running fallback, restoration after Codex exits, restart persistence, and no response after Cindy fully quits.
6. Verify phone pairing, remote connection, normal images, and the saved Qianlong Claude provider route still behave as before.

- [ ] **Step 8: Request code and security review, fix findings, then commit**

Review scope must include native output-path containment, symlink handling, PNG/size validation, trusted Renderer IPC, secure AX redaction, non-Codex rejection, shortcut listener lifetime, and absence of hardcoded credentials. Re-run Step 6 after fixes.

```bash
git add apps/desktop/src/renderer/components/settings/KeyboardShortcutsSection.tsx \
  apps/desktop/src/renderer/components/settings/__tests__/KeyboardShortcutsSection.mutationRace.test.tsx \
  apps/desktop/src/renderer/i18n/locales/en/common.json \
  apps/desktop/src/renderer/i18n/locales/zh-CN/common.json \
  apps/desktop/src/renderer/i18n/locales/ja/common.json \
  apps/desktop/src/renderer/i18n/locales/ko/common.json \
  apps/desktop/src/main/appshots \
  apps/desktop/src/main/bootstrap-electron.ts
git commit -m "feat: finish macOS Codex Appshots"
```

## Completion gate

- [ ] No placeholder implementation, deferred implementation marker, new dependency, database migration, credential change, remote/mobile capture control, auto-send, or second native keyboard event tap.
- [ ] Every approved requirement in `docs/superpowers/specs/2026-08-05-codex-appshots-design.md` maps to Tasks 1-7.
- [ ] Shared names remain consistent: `AppshotMetadata`, `AppshotCaptureResult`, `AppshotShortcut`, `AppshotShortcutPreferences`, `AppshotShortcutState`, `formatAppshotContext`, and `validateAndStripAppshotMetadata`.
- [ ] All tests, typecheck, lint, Swift self-test, separate package build, manual macOS checks, code review, and security review pass.
- [ ] `/Applications/Cindy.app`, phone pairing, remote connection state, provider credentials, `.codebase-memory/`, and unrelated user files remain untouched.
