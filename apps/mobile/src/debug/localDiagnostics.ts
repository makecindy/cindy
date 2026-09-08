import AsyncStorage from "@react-native-async-storage/async-storage";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { AppState } from "react-native";
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
let events: DiagnosticEvent[] = [];
let hydration: Promise<void> | undefined;
let ready = false;
let dirty = false;
let writes = Promise.resolve();
let sharing = false;

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
  const retained = retainedEvents(events);
  if (retained.length !== events.length) {
    events = retained;
    dirty = true;
  }
  if (!ready || !dirty) return writes;
  dirty = false;
  // Snapshot before enqueueing; sequential writes prevent an older flush resurrecting cleared logs.
  const snapshot = JSON.stringify({ enabled: override, events });
  const pending = writes.then(() => AsyncStorage.setItem(KEY, snapshot));
  writes = pending.catch(() => {
    dirty = true;
  });
  return pending;
}

export async function setDiagnosticsEnabled(value: boolean): Promise<void> {
  await hydrateDiagnostics();
  enabled = value;
  override = value;
  dirty = true;
  await flushDiagnostics();
}

export async function clearDiagnostics(): Promise<void> {
  await hydrateDiagnostics();
  events = [];
  dirty = true;
  await flushDiagnostics();
}

/** Delete the user's override; retained logs are intentionally unaffected. */
export async function resetDiagnosticsEnabled(): Promise<void> {
  await hydrateDiagnostics();
  override = undefined;
  enabled = DEFAULT_ENABLED;
  dirty = true;
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
    file = new File(Paths.cache, "cindy-diagnostics.json");
    file.write(
      JSON.stringify(
        { format: 1, events: await diagnosticSnapshot() },
        null,
        2,
      ),
    );
    await Sharing.shareAsync(file.uri, {
      mimeType: "application/json",
      UTI: "public.json",
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
  let stopped = false;
  let state = AppState.currentState;
  let lastTick = performance.now();
  void hydrateDiagnostics().then(() => {
    if (!stopped) recordDiagnostic("app started");
  });
  const listener = AppState.addEventListener("change", (next) => {
    state = next;
    lastTick = performance.now();
    recordDiagnostic(`app ${next}`);
    void flushDiagnostics().catch(() => {});
  });
  const timer = setInterval(() => {
    const now = performance.now();
    if (state === "active" && now - lastTick > 3000)
      recordDiagnostic("js stall", { elapsedMs: now - lastTick - 2000 });
    lastTick = now;
    void flushDiagnostics().catch(() => {});
  }, 2000);
  return () => {
    stopped = true;
    listener.remove();
    clearInterval(timer);
    void flushDiagnostics().catch(() => {});
  };
}
