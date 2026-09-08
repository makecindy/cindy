import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { AppState } from "react-native";
import { mobileDebugLog, setMobileDebugSink } from "./mobileDebugLog";
import { serializeMobileDebugRecord } from "./mobileDebugRecord";
import {
  appendMobileDebugFile,
  clearMobileDebugFiles,
  copyMobileDebugFiles,
  pruneMobileDebugFiles,
} from "./mobileDebugFiles";
import { getMobileMarkdownRenderMetrics } from "../session/mobileMarkdownRenderMetrics";
import { getMobileMessageWebViewMetrics } from "../session/mobileMessageWebViewMetrics";
import {
  MAX_DIAGNOSTIC_EVENTS,
  projectDiagnostic,
  restoreDiagnosticEvents,
  type DiagnosticEvent,
} from "./diagnosticEvents";

const KEY = "cindy.mobile.localDiagnostics.v1";
const DEFAULT_ENABLED = process.env.EXPO_PUBLIC_CINDY_DIAGNOSTICS === "1";
let enabled = false;
let override: boolean | undefined;
let persistedOverride: boolean | undefined;
const recordingListeners = new Set<() => void>();
let events: DiagnosticEvent[] = [];
let hydration: Promise<void> | undefined;
let ready = false;
let dirty = false;
let writes = Promise.resolve();
let flushing = false;
let sharing = false;
let debugBatch = "";
let debugBytes = 0;
let dropped = 0;
const MAX_PENDING_BYTES = 512 * 1024;

function updateDebugSink(): void {
  setMobileDebugSink(
    enabled
      ? (level, scope, args) => {
          if (scope === "device-link" || scope === "lifecycle")
            recordDiagnostic(...args);
          const line = serializeMobileDebugRecord(level, scope, args);
          const bytes = new TextEncoder().encode(line).byteLength;
          if (debugBytes + bytes > MAX_PENDING_BYTES) {
            dropped++;
            return;
          }
          debugBatch += line;
          debugBytes += bytes;
        }
      : undefined,
  );
  for (const listener of recordingListeners) listener();
}

function retainedEvents(value: unknown): DiagnosticEvent[] {
  const now = Date.now();
  return restoreDiagnosticEvents(value).filter(
    (event) => event.at >= now - 7 * 24 * 60 * 60 * 1000 && event.at <= now,
  );
}

/** Explicitly hydrated, bounded local journal. No upload and no global console interception. */
export function hydrateDiagnostics(): Promise<void> {
  return (hydration ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      if (raw !== null) {
        if (raw.length > 256_000) throw new Error("oversized diagnostics");
        const saved = JSON.parse(raw);
        if (
          !saved ||
          typeof saved !== "object" ||
          Array.isArray(saved) ||
          (saved.enabled !== undefined && typeof saved.enabled !== "boolean")
        )
          throw new Error("invalid diagnostics");
        override =
          typeof saved.enabled === "boolean" ? saved.enabled : undefined;
        events = retainedEvents(saved.events);
        dirty =
          Array.isArray(saved.events) && saved.events.length !== events.length;
      }
      enabled = override ?? DEFAULT_ENABLED;
    } catch {
      // Read failures cannot silently turn an existing opt-out back on.
      enabled = false;
      override = false;
    }
    ready = true;
    persistedOverride = override;
    updateDebugSink();
  })());
}

export function diagnosticsEnabled(): boolean {
  return enabled;
}

/** Revalidate before either export or upload; never return mutable journal state. */
export async function diagnosticSnapshot(): Promise<DiagnosticEvent[]> {
  await hydrateDiagnostics();
  return retainedEvents(events);
}

export function recordDiagnostic(...args: unknown[]): void {
  if (!ready || !enabled) return;
  const event = projectDiagnostic(args);
  if (!event) return;
  events.push(event);
  if (events.length > MAX_DIAGNOSTIC_EVENTS)
    events.splice(0, events.length - MAX_DIAGNOSTIC_EVENTS);
  dirty = true;
}

export function flushDiagnostics(): Promise<void> {
  // Keep only the bounded live buffer while a disk write is pending, not a queue of large snapshots.
  if (flushing) return writes.then(flushDiagnostics);
  const retained = retainedEvents(events);
  if (retained.length !== events.length) {
    events = retained;
    dirty = true;
  }
  if (!ready || (!dirty && !debugBatch && !dropped)) return writes;
  dirty = false;
  flushing = true;
  const batch =
    debugBatch +
    (dropped
      ? serializeMobileDebugRecord("warn", "performance", [
          "debug records lost (buffer or storage)",
          { dropped },
        ])
      : "");
  debugBatch = "";
  debugBytes = 0;
  dropped = 0;
  // Snapshot before enqueueing; sequential writes prevent an older flush resurrecting cleared logs.
  const snapshotOverride = override;
  const snapshot = JSON.stringify({ enabled: snapshotOverride, events });
  const pending = writes.then(async () => {
    // File failure must not discard the pending settings/summary write.
    try {
      appendMobileDebugFile(batch);
    } catch (error) {
      // Count records in the failed batch; a settings-only failure did not lose the file contents.
      if (batch) dropped += batch.split("\n").length - 1;
      throw error;
    } finally {
      await AsyncStorage.setItem(KEY, snapshot);
      persistedOverride = snapshotOverride;
    }
  });
  writes = pending
    .catch(() => {
      dirty = true;
      // Do not grow an unbounded retry queue when storage is unavailable.
      // A later successful flush explicitly records the gap.
    })
    .finally(() => {
      flushing = false;
    });
  return pending;
}

export async function setDiagnosticsEnabled(value: boolean): Promise<void> {
  await hydrateDiagnostics();
  override = value;
  dirty = true;
  try {
    await flushDiagnostics();
  } finally {
    // The switch and probe reflect the last durable preference, including failed opt-outs.
    override = persistedOverride;
    enabled = override ?? DEFAULT_ENABLED;
    updateDebugSink();
  }
  if (value)
    mobileDebugLog("info", "lifecycle", "debug recording enabled", {
      appState: AppState.currentState,
    });
}

export async function clearDiagnostics(): Promise<void> {
  await hydrateDiagnostics();
  events = [];
  debugBatch = "";
  debugBytes = 0;
  dropped = 0;
  dirty = true;
  const cleared = writes.then(clearMobileDebugFiles);
  writes = cleared.catch(() => {});
  await cleared;
  await flushDiagnostics();
}

export async function exportDiagnostics(): Promise<void> {
  if (sharing) return;
  sharing = true;
  let file: File | undefined;
  try {
    await hydrateDiagnostics();
    await flushDiagnostics();
    if (!(await Sharing.isAvailableAsync()))
      throw new Error("sharing unavailable");
    file = new File(Paths.cache, `cindy-mobile-debug-${Date.now()}.ndjson`);
    copyMobileDebugFiles(file);
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/plain",
      UTI: "public.plain-text",
    });
  } finally {
    try {
      if (file?.exists) file.delete();
    } finally {
      sharing = false;
    }
  }
}

/** Lifecycle flush plus a low-frequency foreground-only stall probe; no Metro dependency. */
export function startLocalDiagnostics(): () => void {
  // Retention is independent of recording. Reuse the write queue and lifecycle, not a timer.
  const prune = () => {
    writes = writes.then(pruneMobileDebugFiles).catch(() => {});
  };
  prune();
  let stopped = false;
  let state = AppState.currentState;
  let lastTick = performance.now();
  void hydrateDiagnostics().then(() => {
    if (!stopped)
      mobileDebugLog("info", "lifecycle", "app started", { appState: state });
  });
  const listener = AppState.addEventListener("change", (next) => {
    if (next === "active") prune();
    state = next;
    lastTick = performance.now();
    mobileDebugLog("info", "lifecycle", `app ${next}`);
    void flushDiagnostics().catch(() => {});
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    const now = performance.now();
    if (state === "active" && now - lastTick > 3000)
      mobileDebugLog("warn", "lifecycle", "js stall", {
        elapsedMs: now - lastTick - 2000,
      });
    lastTick = now;
    if (enabled)
      mobileDebugLog("debug", "performance", "render metrics", {
        markdown: getMobileMarkdownRenderMetrics(),
        webViews: getMobileMessageWebViewMetrics(),
      });
    void flushDiagnostics().catch(() => {});
  };
  const syncProbe = () => {
    if (!enabled || stopped) {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    } else if (timer === undefined) {
      lastTick = performance.now();
      timer = setInterval(tick, 2000);
    }
  };
  recordingListeners.add(syncProbe);
  syncProbe();
  return () => {
    stopped = true;
    listener.remove();
    recordingListeners.delete(syncProbe);
    syncProbe();
    void flushDiagnostics().catch(() => {});
  };
}
