import type {
  IOSSimulatorMcpCallContext,
  IOSSimulatorMcpDeps,
  IOSSimulatorMcpErrorCode,
  IOSSimulatorMcpToolName,
} from "../types.js";
import {
  IOSSimulatorToolRegistry,
  iosSimulatorBusinessError,
  iosSimulatorTextResult,
} from "./tool-registry.js";
import { z } from "zod";

function isBusinessError(result: unknown): result is {
  ok: false;
  errorCode: IOSSimulatorMcpErrorCode;
  message?: string;
  data?: Record<string, unknown>;
} {
  return (
    Boolean(result) &&
    typeof result === "object" &&
    (result as { ok?: unknown }).ok === false &&
    typeof (result as { errorCode?: unknown }).errorCode === "string"
  );
}

async function callHost(
  deps: IOSSimulatorMcpDeps,
  name: IOSSimulatorMcpToolName,
  args: Record<string, unknown>,
  context: IOSSimulatorMcpCallContext | undefined,
): Promise<ReturnType<typeof iosSimulatorTextResult>> {
  try {
    const result = await deps.callTool(name, args, context);
    if (isBusinessError(result)) {
      return iosSimulatorBusinessError(
        result.errorCode,
        result.message ?? "iOS Simulator host call failed",
        result.data,
      );
    }
    if (
      !result ||
      typeof result !== "object" ||
      (result as { ok?: unknown }).ok !== true
    ) {
      return iosSimulatorBusinessError(
        "IOS_SIMULATOR_HOST_ERROR",
        "Invalid iOS Simulator host result.",
      );
    }
    return iosSimulatorTextResult(result);
  } catch (error) {
    return iosSimulatorBusinessError(
      "IOS_SIMULATOR_HOST_ERROR",
      error instanceof Error ? error.message : String(error),
    );
  }
}

const observeAfterShape = {
  observeAfter: z.enum(["none", "immediate", "stable"]).default("none"),
  observeTimeoutMs: z.number().int().min(100).max(15_000).default(3_000),
  stableForMs: z.number().int().min(100).max(2_000).default(300),
};

const uiElementConditionShape = {
  elementId: z.string().min(1).max(128).optional(),
  role: z.string().min(1).max(128).optional(),
  labelContains: z.string().min(1).max(500).optional(),
  valueContains: z.string().min(1).max(500).optional(),
};

const uiElementCondition = z
  .object(uiElementConditionShape)
  .strict()
  .refine((value) => Object.values(value).some((entry) => entry !== undefined), {
    message: "At least one element selector is required.",
  });

const waitCondition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("element_exists"), selector: uiElementCondition }).strict(),
  z.object({ kind: z.literal("element_missing"), selector: uiElementCondition }).strict(),
  z.object({ kind: z.literal("screen_changed"), snapshotId: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("screen_stable") }).strict(),
]);

const keyName = z.enum([
  "return",
  "tab",
  "escape",
  "delete",
  "arrow_up",
  "arrow_down",
  "arrow_left",
  "arrow_right",
]);

const batchAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tap"), elementId: z.string().min(1).max(128) }).strict(),
  z
    .object({
      type: z.literal("swipe"),
      startX: z.number().finite().nonnegative().max(1_000_000),
      startY: z.number().finite().nonnegative().max(1_000_000),
      endX: z.number().finite().nonnegative().max(1_000_000),
      endY: z.number().finite().nonnegative().max(1_000_000),
      durationMs: z.number().int().min(50).max(10_000).default(300),
    })
    .strict(),
  z
    .object({
      type: z.literal("drag"),
      fromElementId: z.string().min(1).max(128),
      toElementId: z.string().min(1).max(128),
      durationMs: z.number().int().min(100).max(10_000).default(500),
    })
    .strict(),
  z
    .object({
      type: z.literal("long_press"),
      elementId: z.string().min(1).max(128),
      durationMs: z.number().int().min(300).max(10_000).default(750),
    })
    .strict(),
  z.object({ type: z.literal("type_text"), text: z.string().max(10_000) }).strict(),
  z.object({ type: z.literal("key_press"), key: keyName }).strict(),
]);

export function registerIOSSimulatorTools(
  registry: IOSSimulatorToolRegistry,
  deps: IOSSimulatorMcpDeps,
  getContext?: () => IOSSimulatorMcpCallContext | undefined,
): void {
  registry.register({
    name: "check_environment",
    description:
      "Check whether the current local macOS session can use Cindy's embedded iOS Simulator runtime, Xcode, and the viewer bridge. This does not open macOS Simulator.app.",
    readOnly: true,
    inputShape: {},
    handler: async () =>
      callHost(deps, "check_environment", {}, getContext?.()),
  });
  registry.register({
    name: "doctor",
    description:
      "Run one bounded Host diagnosis for the current Cindy session, including environment, ownership, drivers, admitted capabilities, tool availability, and recommended next actions.",
    readOnly: true,
    inputShape: {},
    handler: async () => callHost(deps, "doctor", {}, getContext?.()),
  });
  registry.register({
    name: "list_devices",
    description:
      "List available simulated iPhone and iPad devices with exact UDIDs and boot states.",
    readOnly: true,
    inputShape: {},
    handler: async () => callHost(deps, "list_devices", {}, getContext?.()),
  });
  registry.register({
    name: "list_instances",
    description:
      "List only the iOS Simulator instances owned by the current Cindy session.",
    readOnly: true,
    inputShape: {},
    handler: async () => callHost(deps, "list_instances", {}, getContext?.()),
  });
  registry.register({
    name: "create_instance",
    description:
      "Create a Cindy-owned embedded simulator from an installed template device, then attach it to this session for display in Cindy's viewer.",
    inputShape: {
      templateUdid: z.string().uuid(),
      name: z.string().trim().min(1).max(128),
    },
    handler: async (args) =>
      callHost(deps, "create_instance", args, getContext?.()),
  });
  registry.register({
    name: "attach_device",
    description:
      "Attach one exact simulator UDID to the current Cindy embedded-simulator session. Resource admission is enforced by the host; do not open Simulator.app.",
    inputShape: { udid: z.string().uuid() },
    handler: async (args) =>
      callHost(deps, "attach_device", args, getContext?.()),
  });
  const routeShape = {
    instanceId: z.string().min(1).max(128),
    generation: z.number().int().positive(),
    leaseId: z.string().min(1).max(128),
  };
  const statusBarShape = {
    time: z.string().max(128).optional(),
    dataNetwork: z
      .enum([
        "hide",
        "wifi",
        "3g",
        "4g",
        "lte",
        "lte-a",
        "lte+",
        "5g",
        "5g+",
        "5g-uwb",
        "5g-uc",
      ])
      .optional(),
    wifiMode: z.enum(["searching", "failed", "active"]).optional(),
    wifiBars: z.number().int().min(0).max(3).optional(),
    cellularMode: z
      .enum(["notSupported", "searching", "failed", "active"])
      .optional(),
    cellularBars: z.number().int().min(0).max(4).optional(),
    operatorName: z.string().max(128).optional(),
    batteryState: z.enum(["charging", "charged", "discharging"]).optional(),
    batteryLevel: z.number().int().min(0).max(100).optional(),
  };
  registry.register({
    name: "start_instance",
    description:
      "Boot the exact simulator attached to this Cindy embedded-simulator session and invalidate stale generations. Keep the device in Cindy's viewer rather than opening Simulator.app.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "start_instance", args, getContext?.()),
  });
  registry.register({
    name: "stop_instance",
    description: "Shut down the exact attached simulator without deleting it.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "stop_instance", args, getContext?.()),
  });
  registry.register({
    name: "detach_device",
    description:
      "Detach the viewer. Cindy-booted devices get a ten-minute grace period; preexisting devices remain running.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "detach_device", args, getContext?.()),
  });
  const snapshotRouteShape = {
    ...routeShape,
    snapshotId: z.string().uuid(),
  };
  registry.register({
    name: "get_screen_map",
    description:
      "Read a bounded accessibility-first screen map. Use its snapshotId and elementIds for the next action.",
    readOnly: true,
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "get_screen_map", args, getContext?.()),
  });
  registry.register({
    name: "audit_accessibility",
    description:
      "Run a bounded accessibility audit over the current simulator screen map without changing device state.",
    readOnly: true,
    inputShape: {
      ...routeShape,
      maxViolations: z.number().int().min(1).max(500).default(200),
    },
    handler: async (args) =>
      callHost(deps, "audit_accessibility", args, getContext?.()),
  });
  const screenElementShape = z.object({
    elementId: z.string().min(1).max(128),
    role: z.string().max(128),
    label: z.string().max(500).nullable(),
    value: z.string().max(500).nullable(),
    enabled: z.boolean().nullable(),
    visible: z.boolean().nullable(),
    frame: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().finite(),
        height: z.number().finite(),
      })
      .nullable(),
  });
  registry.register({
    name: "compare_screen_maps",
    description:
      "Compare a previously observed accessibility screen map with the current screen without changing device state.",
    readOnly: true,
    inputShape: {
      ...routeShape,
      baseline: z.object({
        snapshotId: z.string().uuid(),
        instanceId: z.string().min(1).max(128),
        generation: z.number().int().positive(),
        interactionEpoch: z.number().int().nonnegative(),
        capturedAt: z.string().max(128),
        truncated: z.boolean(),
        elements: z.array(screenElementShape).max(1_500),
      }),
      maxChanges: z.number().int().min(1).max(500).default(200),
    },
    handler: async (args) =>
      callHost(deps, "compare_screen_maps", args, getContext?.()),
  });
  registry.register({
    name: "wait_for_ui",
    description:
      "Wait for one bounded accessibility condition without fixed sleeps, then return a fresh screen map.",
    readOnly: true,
    inputShape: {
      ...routeShape,
      condition: waitCondition,
      timeoutMs: z.number().int().min(100).max(30_000).default(10_000),
      pollIntervalMs: z.number().int().min(100).max(2_000).default(250),
      stableForMs: z.number().int().min(100).max(2_000).default(300),
    },
    handler: async (args) => callHost(deps, "wait_for_ui", args, getContext?.()),
  });
  registry.register({
    name: "tap",
    description:
      "Tap an element from the current screen map, or explicit device coordinates as a fallback.",
    inputShape: {
      ...snapshotRouteShape,
      elementId: z.string().min(1).max(128).optional(),
      x: z.number().finite().nonnegative().max(1_000_000).optional(),
      y: z.number().finite().nonnegative().max(1_000_000).optional(),
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "tap", args, getContext?.()),
  });
  registry.register({
    name: "swipe",
    description:
      "Swipe between explicit device points after observing the current screen map.",
    inputShape: {
      ...snapshotRouteShape,
      startX: z.number().finite().nonnegative().max(1_000_000),
      startY: z.number().finite().nonnegative().max(1_000_000),
      endX: z.number().finite().nonnegative().max(1_000_000),
      endY: z.number().finite().nonnegative().max(1_000_000),
      durationMs: z.number().int().min(50).max(60_000).default(300),
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "swipe", args, getContext?.()),
  });
  registry.register({
    name: "drag",
    description:
      "Drag from one element in the current screen map to another using native HID when admitted and WDA otherwise.",
    inputShape: {
      ...snapshotRouteShape,
      fromElementId: z.string().min(1).max(128),
      toElementId: z.string().min(1).max(128),
      durationMs: z.number().int().min(100).max(10_000).default(500),
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "drag", args, getContext?.()),
  });
  registry.register({
    name: "long_press",
    description:
      "Long-press an element from the current screen map for a bounded duration.",
    inputShape: {
      ...snapshotRouteShape,
      elementId: z.string().min(1).max(128),
      durationMs: z.number().int().min(300).max(10_000).default(750),
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "long_press", args, getContext?.()),
  });
  registry.register({
    name: "key_press",
    description:
      "Send one bounded WebDriver keyboard key to the currently focused control.",
    inputShape: {
      ...snapshotRouteShape,
      key: keyName,
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "key_press", args, getContext?.()),
  });
  registry.register({
    name: "batch",
    description:
      "Run up to 16 low-risk UI actions against one instance route, stopping on the first failure and returning a final observation.",
    inputShape: {
      ...snapshotRouteShape,
      actions: z.array(batchAction).min(1).max(16),
      observeAfter: z.enum(["immediate", "stable"]).default("stable"),
      observeTimeoutMs: z.number().int().min(100).max(15_000).default(3_000),
      stableForMs: z.number().int().min(100).max(2_000).default(300),
    },
    handler: async (args) => callHost(deps, "batch", args, getContext?.()),
  });
  const touchSampleShape = z.object({
    phase: z.enum(["down", "move", "up", "cancel"]),
    x: z.number().finite().nonnegative().max(1_000_000),
    y: z.number().finite().nonnegative().max(1_000_000),
    dtMs: z.number().int().min(0).max(60_000).optional(),
  });
  registry.register({
    name: "touch_path",
    description:
      "Perform one bounded continuous native touch path in device coordinates after observing the current screen map. Use edge only for an intentional system-edge gesture.",
    inputShape: {
      ...snapshotRouteShape,
      points: z.array(touchSampleShape).min(2).max(4_096),
      edge: z.enum(["none", "left", "top", "bottom", "right"]).default("none"),
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "touch_path", args, getContext?.()),
  });
  registry.register({
    name: "touch2_path",
    description:
      "Perform two synchronized bounded native touch paths in device coordinates after observing the current screen map. Both paths must use matching phases and timing.",
    inputShape: {
      ...snapshotRouteShape,
      first: z.array(touchSampleShape).min(2).max(4_096),
      second: z.array(touchSampleShape).min(2).max(4_096),
      ...observeAfterShape,
    },
    handler: async (args) =>
      callHost(deps, "touch2_path", args, getContext?.()),
  });
  registry.register({
    name: "type_text",
    description: "Type bounded text into the currently focused control.",
    inputShape: {
      ...snapshotRouteShape,
      text: z.string().max(10_000),
      ...observeAfterShape,
    },
    handler: async (args) => callHost(deps, "type_text", args, getContext?.()),
  });
  registry.register({
    name: "press_home",
    description:
      "Press the simulated Home button after observing the current screen map.",
    inputShape: { ...snapshotRouteShape, ...observeAfterShape },
    handler: async (args) => callHost(deps, "press_home", args, getContext?.()),
  });
  registry.register({
    name: "set_orientation",
    description: "Rotate the simulator after observing the current screen map.",
    inputShape: {
      ...snapshotRouteShape,
      orientation: z.enum(["PORTRAIT", "LANDSCAPE"]),
    },
    handler: async (args) =>
      callHost(deps, "set_orientation", args, getContext?.()),
  });
  registry.register({
    name: "set_appearance",
    description: "Set the simulated system appearance to light or dark.",
    inputShape: {
      ...routeShape,
      appearance: z.enum(["light", "dark"]),
    },
    handler: async (args) =>
      callHost(deps, "set_appearance", args, getContext?.()),
  });
  registry.register({
    name: "set_increase_contrast",
    description:
      "Enable or disable the simulated Increase Contrast accessibility setting.",
    inputShape: {
      ...routeShape,
      enabled: z.boolean(),
    },
    handler: async (args) =>
      callHost(deps, "set_increase_contrast", args, getContext?.()),
  });
  registry.register({
    name: "set_content_size",
    description: "Set the simulated Dynamic Type content-size category.",
    inputShape: {
      ...routeShape,
      contentSize: z.enum([
        "extra-small",
        "small",
        "medium",
        "large",
        "extra-large",
        "extra-extra-large",
        "extra-extra-extra-large",
        "accessibility-medium",
        "accessibility-large",
        "accessibility-extra-large",
        "accessibility-extra-extra-large",
        "accessibility-extra-extra-extra-large",
      ]),
    },
    handler: async (args) =>
      callHost(deps, "set_content_size", args, getContext?.()),
  });
  registry.register({
    name: "set_location",
    description: "Set a simulated latitude and longitude on the exact device.",
    inputShape: {
      ...routeShape,
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
    },
    handler: async (args) =>
      callHost(deps, "set_location", args, getContext?.()),
  });
  registry.register({
    name: "start_location_route",
    description:
      "Start a bounded simulated route through explicit latitude and longitude waypoints.",
    inputShape: {
      ...routeShape,
      waypoints: z
        .array(
          z.object({
            latitude: z.number().finite().min(-90).max(90),
            longitude: z.number().finite().min(-180).max(180),
          }),
        )
        .min(2)
        .max(64),
      speedMetersPerSecond: z
        .number()
        .finite()
        .positive()
        .max(10_000)
        .optional(),
      intervalSeconds: z.number().finite().positive().max(86_400).optional(),
      distanceMeters: z.number().finite().positive().max(10_000_000).optional(),
    },
    handler: async (args) =>
      callHost(deps, "start_location_route", args, getContext?.()),
  });
  registry.register({
    name: "clear_location",
    description: "Clear any simulated location from the exact device.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "clear_location", args, getContext?.()),
  });
  registry.register({
    name: "set_privacy",
    description:
      "Grant, revoke, or reset one simulated privacy permission for an app.",
    inputShape: {
      ...routeShape,
      action: z.enum(["grant", "revoke", "reset"]),
      service: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
      bundleId: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/)
        .optional(),
    },
    handler: async (args) =>
      callHost(deps, "set_privacy", args, getContext?.()),
  });
  registry.register({
    name: "push_notification",
    description:
      "Send one bounded APNs payload to an installed app on the exact simulator.",
    inputShape: {
      ...routeShape,
      bundleId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/),
      payload: z.record(z.string(), z.unknown()),
    },
    handler: async (args) =>
      callHost(deps, "push_notification", args, getContext?.()),
  });
  registry.register({
    name: "set_status_bar",
    description:
      "Apply deterministic status-bar overrides to the exact simulator.",
    inputShape: { ...routeShape, ...statusBarShape },
    handler: async (args) =>
      callHost(deps, "set_status_bar", args, getContext?.()),
  });
  registry.register({
    name: "clear_status_bar",
    description:
      "Clear all simulated status-bar overrides on the exact simulator.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "clear_status_bar", args, getContext?.()),
  });
  registry.register({
    name: "lock_screen",
    description:
      "Lock the exact simulator after observing the current screen map.",
    inputShape: snapshotRouteShape,
    handler: async (args) =>
      callHost(deps, "lock_screen", args, getContext?.()),
  });
  registry.register({
    name: "unlock_screen",
    description:
      "Unlock the exact simulator after observing the current screen map.",
    inputShape: snapshotRouteShape,
    handler: async (args) =>
      callHost(deps, "unlock_screen", args, getContext?.()),
  });
  registry.register({
    name: "build_app",
    description:
      "Build one iOS app for the embedded simulator instance. For repositories with multiple or nested Xcode containers, pass containerPath as a worktree-relative path (or an absolute path that still resolves inside the worktree), then select a shared scheme when needed. Continue with install_app and launch_app on this same Cindy session. This may require command approval.",
    inputShape: {
      ...routeShape,
      containerPath: z.string().trim().min(1).max(4096).optional(),
      scheme: z.string().min(1).max(256).optional(),
    },
    handler: async (args) => callHost(deps, "build_app", args, getContext?.()),
  });
  registry.register({
    name: "read_build_diagnostics",
    description:
      "Read a bounded chunk of build output or xcresult diagnostics returned by a successful or failed build_app call.",
    readOnly: true,
    inputShape: {
      diagnosticsId: z.string().uuid(),
      source: z.enum(["build-log", "xcresult"]),
      offset: z.number().int().nonnegative().default(0),
      limit: z
        .number()
        .int()
        .min(1)
        .max(64 * 1024)
        .default(16 * 1024),
    },
    handler: async (args) =>
      callHost(deps, "read_build_diagnostics", args, getContext?.()),
  });
  registry.register({
    name: "install_app",
    description:
      "Install a build artifact produced for this Cindy session onto the exact simulator.",
    inputShape: { ...routeShape, artifactId: z.string().uuid() },
    handler: async (args) =>
      callHost(deps, "install_app", args, getContext?.()),
  });
  registry.register({
    name: "launch_app",
    description:
      "Launch an installed build artifact on the exact Cindy embedded simulator with bounded arguments; this does not open macOS Simulator.app.",
    inputShape: {
      ...routeShape,
      artifactId: z.string().uuid(),
      args: z.array(z.string().max(4_096)).max(64).default([]),
    },
    handler: async (args) => callHost(deps, "launch_app", args, getContext?.()),
  });
  registry.register({
    name: "terminate_app",
    description:
      "Terminate the app represented by a current build artifact on the exact simulator.",
    inputShape: { ...routeShape, artifactId: z.string().uuid() },
    handler: async (args) =>
      callHost(deps, "terminate_app", args, getContext?.()),
  });
  registry.register({
    name: "open_url",
    description:
      "Open a validated non-file URL on the exact simulator. This may require URL approval.",
    inputShape: { ...routeShape, url: z.string().min(1).max(8_192) },
    handler: async (args) => callHost(deps, "open_url", args, getContext?.()),
  });
  registry.register({
    name: "take_screenshot",
    description:
      "Capture the exact simulator and persist the explicit result in Cindy media. The image may be sent to the model.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "take_screenshot", args, getContext?.()),
  });
  registry.register({
    name: "capture_visual_baseline",
    description:
      "Capture a bounded in-memory screenshot baseline for a later pixel diff. The baseline is not persisted as media.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "capture_visual_baseline", args, getContext?.()),
  });
  registry.register({
    name: "visual_diff",
    description:
      "Compare the current simulator screenshot with an in-memory baseline and return bounded pixel metrics.",
    readOnly: true,
    inputShape: {
      ...routeShape,
      baselineId: z.string().uuid(),
      threshold: z.number().int().min(0).max(255).default(16),
    },
    handler: async (args) =>
      callHost(deps, "visual_diff", args, getContext?.()),
  });
  registry.register({
    name: "capture_state",
    description:
      "Capture one bounded diagnostic state with driver health, orientation, screen map, and stream metadata.",
    readOnly: true,
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "capture_state", args, getContext?.()),
  });
  registry.register({
    name: "get_diagnostics",
    description: "Read one session-scoped bounded diagnostics entry by ID.",
    readOnly: true,
    inputShape: { diagnosticsId: z.string().uuid() },
    handler: async (args) =>
      callHost(deps, "get_diagnostics", args, getContext?.()),
  });
  registry.register({
    name: "start_recording",
    description:
      "Start one explicit H.264 simulator recording in a unique temporary file.",
    inputShape: routeShape,
    handler: async (args) =>
      callHost(deps, "start_recording", args, getContext?.()),
  });
  registry.register({
    name: "stop_recording",
    description:
      "Stop a current recording and ingest the finalized MOV into Cindy media.",
    inputShape: { ...routeShape, recordingId: z.string().uuid() },
    handler: async (args) =>
      callHost(deps, "stop_recording", args, getContext?.()),
  });
}
