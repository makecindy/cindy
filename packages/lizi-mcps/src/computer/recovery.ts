import type { ComputerMcpCallContext, ComputerMcpDeps } from "../types.js";
import { computerResultOutcome } from "./result.js";

/** Recovery may observe, but never replay an action or choose a replacement window. */
export type RecoveryTool =
  "list_apps" | "list_windows" | "get_window_state" | "verify_state";
export type RecoveryRead = {
  tool: RecoveryTool;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
};

export function isWindowIdentityFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return [result.code, result.degraded_reason].some(
    (code) => code === "window_id_not_found" || code === "ax_window_unresolved",
  );
}

/** A single best-effort read with its own deadline; failures never replace the primary result. */
export async function readForRecovery(
  deps: ComputerMcpDeps,
  tool: RecoveryTool,
  args: Record<string, unknown>,
  context: ComputerMcpCallContext,
  timeoutMs = 5_000,
): Promise<RecoveryRead> {
  const controller = new AbortController();
  const abort = () => controller.abort(context.signal?.reason);
  const timer = setTimeout(
    () => controller.abort(new Error("Computer Use recovery read timed out")),
    timeoutMs,
  );
  context.signal?.addEventListener("abort", abort, { once: true });
  if (context.signal?.aborted) abort();
  let onAbort: (() => void) | undefined;
  try {
    controller.signal.throwIfAborted();
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const data = await Promise.race([
      deps.callTool(tool, args, { ...context, signal: controller.signal, observationPurpose: 'recovery' }),
      cancelled,
    ]);
    controller.signal.throwIfAborted();
    const object =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : undefined;
    const shapeValid =
      object &&
      (tool === "list_apps"
        ? Array.isArray(object.apps)
        : tool === "list_windows"
          ? Array.isArray(object.windows)
          : tool === "get_window_state"
            ? Array.isArray(object.elements) ||
              typeof object.tree_markdown === "string" ||
              typeof object.screenshot_frame_valid === "boolean"
            : true);
    return {
      tool,
      ok: Boolean(shapeValid) && computerResultOutcome(tool, data).ok,
      data,
    };
  } catch (error) {
    return {
      tool,
      ok: false,
      error: {
        code: controller.signal.aborted
          ? context.signal?.aborted
            ? "REQUEST_CANCELLED"
            : "RECOVERY_TIMEOUT"
          : "RECOVERY_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", abort);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}

/** This error is emitted before launching; generic failures must never be retried. */
export function isAppNameResolutionFailure(
  args: Record<string, unknown>,
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    (/^No installed macOS app found (?:for |with )?name\b/i.test(message) ||
      (error as { code?: unknown } | null)?.code === "APP_NOT_INSTALLED") &&
    (error as { outcomeUnknown?: boolean } | null)?.outcomeUnknown !== true &&
    typeof args.name === "string" &&
    args.name.trim().length > 0 &&
    args.bundle_id === undefined
  );
}

/** Locating a running process cannot satisfy URLs, launch arguments or new-instance intent. */
export function canLocateRunningApp(
  args: Record<string, unknown>,
  error: unknown,
): boolean {
  return (
    isAppNameResolutionFailure(args, error) &&
    args.creates_new_application_instance !== true &&
    args.electron_debugging_port === undefined &&
    args.webkit_inspector_port === undefined &&
    (!Array.isArray(args.urls) || args.urls.length === 0) &&
    (!Array.isArray(args.additional_arguments) ||
      args.additional_arguments.length === 0)
  );
}

export function exactInstalledAppBundle(
  name: string,
  data: unknown,
): string | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { apps?: unknown }).apps)
  )
    return;
  const candidates = (data as { apps: unknown[] }).apps.filter((value) => {
    if (!value || typeof value !== "object") return false;
    const app = value as { name?: unknown };
    return (
      typeof app.name === "string" &&
      app.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
  });
  // Do not collapse duplicate names, even if one happens to have a bundle ID.
  if (candidates.length !== 1) return;
  const bundleId = (candidates[0] as { bundle_id?: unknown }).bundle_id;
  return typeof bundleId === "string" && bundleId.trim() ? bundleId : undefined;
}

export function exactRunningApp(
  name: string,
  data: unknown,
): { pid: number; windows: unknown[] } | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { windows?: unknown }).windows)
  )
    return;
  const windows = (data as { windows: unknown[] }).windows.filter((value) => {
    if (!value || typeof value !== "object") return false;
    const window = value as {
      pid?: unknown;
      app_name?: unknown;
      process?: { name?: unknown };
    };
    const label = window.process?.name ?? window.app_name;
    return (
      Number.isInteger(window.pid) &&
      Number(window.pid) > 0 &&
      typeof label === "string" &&
      label.trim().toLowerCase() === name.trim().toLowerCase()
    );
  });
  const pids = new Set(
    windows.map((window) => (window as { pid: number }).pid),
  );
  if (pids.size === 1) return { pid: [...pids][0]!, windows };
}
