import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createNodeIOSSimulatorCommandRunner } from "./command-runner.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";
import type { IOSSimulatorCreatedDevice } from "./instance-types.js";
import type { IOSSimulatorPendingCreateEvidence } from "./pending-create-evidence-file.js";
import { parseSimctlListJson } from "./simctl-parser.js";
import type {
  IOSSimulatorCommandResult,
  IOSSimulatorCommandRunner,
  IOSSimulatorDevice,
} from "./types.js";

const XCRUN = "/usr/bin/xcrun";
const UUID_PATTERN = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/;
const CREATE_ABORT_CLEANUP_TIMEOUT_MS = 4_000;
const CREATE_ABORT_RECONCILE_TIMEOUT_MS = 3_000;
const CREATE_MARKER_PREFIX = "__CindyPending__";
const CREATE_MARKER_UUID_PATTERN =
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ANY_CREATE_MARKER_PATTERN = new RegExp(
  `^${CREATE_MARKER_PREFIX}[A-Za-z0-9_-]{8,64}__${CREATE_MARKER_UUID_PATTERN.source.slice(1, -1)}$`,
  "i",
);

/** Internal create markers are recovery evidence, never user-attachable devices. */
export function isIOSSimulatorPendingCreateName(name: string): boolean {
  return ANY_CREATE_MARKER_PATTERN.test(name);
}

export interface IOSSimulatorLifecycleClock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface IOSSimulatorSimctlLifecycleOptions {
  commandRunner?: IOSSimulatorCommandRunner;
  clock?: IOSSimulatorLifecycleClock;
  bootTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Stable, non-secret profile identity used to recover interrupted creates. */
  createMarkerNamespace?: string;
  /**
   * Host-owned breadcrumb armed before every `simctl create`. It is what lets
   * recovery stay off the CoreSimulator path until this profile has actually
   * created a device.
   */
  pendingCreateEvidence?: IOSSimulatorPendingCreateEvidence;
}

export interface IOSSimulatorPendingCreateRecoveryResult {
  /** Marker UUIDs that were renamed or deleted during the sweep. */
  recovered: readonly string[];
  /** False when a marker was observed but could not be safely attributed. */
  complete: boolean;
}

/**
 * Carries the exact device identity when a failed or aborted `simctl create`
 * produced a device but its immediate compensating delete also failed. The
 * ownership actor can persist that identity for recovery instead of losing it.
 */
export class IOSSimulatorCreateCleanupRequiredError extends IOSSimulatorInstanceError {
  constructor(
    readonly createdDevice: IOSSimulatorCreatedDevice,
    readonly originalReason: unknown,
    options: { cause?: unknown } = {},
  ) {
    super(
      "SIMULATOR_DELETE_FAILED",
      "The simulator was created, but cancellation cleanup could not remove it.",
      true,
    );
    this.name = "IOSSimulatorCreateCleanupRequiredError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export interface IOSSimulatorStatusBarOverrides {
  time?: string;
  dataNetwork?:
    | "hide"
    | "wifi"
    | "3g"
    | "4g"
    | "lte"
    | "lte-a"
    | "lte+"
    | "5g"
    | "5g+"
    | "5g-uwb"
    | "5g-uc";
  wifiMode?: "searching" | "failed" | "active";
  wifiBars?: number;
  cellularMode?: "notSupported" | "searching" | "failed" | "active";
  cellularBars?: number;
  operatorName?: string;
  batteryState?: "charging" | "charged" | "discharging";
  batteryLevel?: number;
}

export interface IOSSimulatorLocationWaypoint {
  latitude: number;
  longitude: number;
}

export interface IOSSimulatorLocationRouteOptions {
  waypoints: IOSSimulatorLocationWaypoint[];
  speedMetersPerSecond?: number;
  intervalSeconds?: number;
  distanceMeters?: number;
}

export type IOSSimulatorContentSize =
  | "extra-small"
  | "small"
  | "medium"
  | "large"
  | "extra-large"
  | "extra-extra-large"
  | "extra-extra-extra-large"
  | "accessibility-medium"
  | "accessibility-large"
  | "accessibility-extra-large"
  | "accessibility-extra-extra-large"
  | "accessibility-extra-extra-extra-large";

export interface IOSSimulatorSimctlLifecycle {
  findExact(
    udid: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorDevice | null>;
  bootExact(udid: string, signal?: AbortSignal): Promise<IOSSimulatorDevice>;
  shutdownExact(udid: string, signal?: AbortSignal): Promise<void>;
  createExact(
    input: {
      name: string;
      deviceTypeIdentifier: string;
      runtimeIdentifier: string;
    },
    signal?: AbortSignal,
  ): Promise<IOSSimulatorCreatedDevice>;
  /** Rename only an exact UUID after ownership has been persisted. */
  renameExact?(udid: string, name: string, signal?: AbortSignal): Promise<void>;
  /** Rename only exact markers already proven owned by this profile. */
  reconcilePendingCreates?(
    ownedDevices: readonly { udid: string; name: string }[],
    signal?: AbortSignal,
  ): Promise<readonly string[]>;
  /**
   * Startup-only recovery while the caller holds this profile's exclusive
   * ownership-registry lease. Unclaimed markers from this exact profile are
   * deleted by exact UUID; other profiles and ordinary devices are untouched.
   */
  recoverPendingCreatesAtStartup?(
    ownedDevices: readonly { udid: string; name: string }[],
    signal?: AbortSignal,
  ): Promise<IOSSimulatorPendingCreateRecoveryResult>;
  deleteExact(udid: string, signal?: AbortSignal): Promise<void>;
  /** Set the simulated system appearance without bringing Simulator.app forward. */
  setAppearance?(
    udid: string,
    appearance: "light" | "dark",
    signal?: AbortSignal,
  ): Promise<void>;
  /** Enable or disable the simulated Increase Contrast accessibility setting. */
  setIncreaseContrast?(
    udid: string,
    enabled: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Set the simulated Dynamic Type content-size category. */
  setContentSize?(
    udid: string,
    contentSize: IOSSimulatorContentSize,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Set or clear the simulated device location. */
  setLocation?(
    udid: string,
    latitude: number,
    longitude: number,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Start a bounded simulated route through explicit latitude/longitude waypoints. */
  startLocationRoute?(
    udid: string,
    options: IOSSimulatorLocationRouteOptions,
    signal?: AbortSignal,
  ): Promise<void>;
  clearLocation?(udid: string, signal?: AbortSignal): Promise<void>;
  /** Grant, revoke, or reset an app privacy permission. */
  setPrivacy?(
    udid: string,
    action: "grant" | "revoke" | "reset",
    service: string,
    bundleId?: string,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Send one bounded APNs simulator payload through simctl. */
  pushNotification?(
    udid: string,
    bundleId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Set or clear deterministic status-bar overrides. */
  setStatusBar?(
    udid: string,
    overrides: IOSSimulatorStatusBarOverrides,
    signal?: AbortSignal,
  ): Promise<void>;
  clearStatusBar?(udid: string, signal?: AbortSignal): Promise<void>;
}

function requireUdid(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simulatorUdid must be an exact simulator UUID",
    );
  }
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\0\r\n]/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `${label} is invalid`,
    );
  }
  return normalized;
}

function requireCreateMarkerNamespace(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "createMarkerNamespace is invalid",
    );
  }
  return normalized;
}

function requireBundleId(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "bundleId is invalid",
    );
  }
  return normalized;
}

function requireLocationWaypoint(
  waypoint: IOSSimulatorLocationWaypoint,
  index: number,
): IOSSimulatorLocationWaypoint {
  if (
    !waypoint ||
    !Number.isFinite(waypoint.latitude) ||
    waypoint.latitude < -90 ||
    waypoint.latitude > 90 ||
    !Number.isFinite(waypoint.longitude) ||
    waypoint.longitude < -180 ||
    waypoint.longitude > 180
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      `location waypoint ${index} is invalid`,
    );
  }
  return waypoint;
}

function requireLocationRoute(
  options: IOSSimulatorLocationRouteOptions,
): IOSSimulatorLocationRouteOptions {
  if (
    !Array.isArray(options.waypoints) ||
    options.waypoints.length < 2 ||
    options.waypoints.length > 64
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "location route must contain between 2 and 64 waypoints",
    );
  }
  const waypoints = options.waypoints.map(requireLocationWaypoint);
  for (const [key, value] of [
    ["speedMetersPerSecond", options.speedMetersPerSecond],
    ["intervalSeconds", options.intervalSeconds],
    ["distanceMeters", options.distanceMeters],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        `${key} must be a positive finite number`,
      );
    }
  }
  if (
    options.intervalSeconds !== undefined &&
    options.distanceMeters !== undefined
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "location route accepts intervalSeconds or distanceMeters, not both",
    );
  }
  return { ...options, waypoints };
}

const CONTENT_SIZES = new Set<IOSSimulatorContentSize>([
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
]);

function requireStatusBarOverrides(
  overrides: IOSSimulatorStatusBarOverrides,
): [string, string][] {
  const entries: [string, string][] = [];
  const add = (key: string, value: string | number | undefined) => {
    if (value !== undefined) entries.push([`--${key}`, String(value)]);
  };
  if (overrides.time !== undefined) {
    if (
      typeof overrides.time !== "string" ||
      !overrides.time.trim() ||
      /[\0\r\n]/.test(overrides.time) ||
      overrides.time.length > 128
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "status-bar time is invalid",
      );
    }
    add("time", overrides.time);
  }
  const dataNetworks = new Set([
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
  ]);
  if (
    overrides.dataNetwork !== undefined &&
    !dataNetworks.has(overrides.dataNetwork)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "status-bar dataNetwork is invalid",
    );
  }
  add("dataNetwork", overrides.dataNetwork);
  const wifiModes = new Set(["searching", "failed", "active"]);
  if (overrides.wifiMode !== undefined && !wifiModes.has(overrides.wifiMode)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "status-bar wifiMode is invalid",
    );
  }
  add("wifiMode", overrides.wifiMode);
  const cellularModes = new Set([
    "notSupported",
    "searching",
    "failed",
    "active",
  ]);
  if (
    overrides.cellularMode !== undefined &&
    !cellularModes.has(overrides.cellularMode)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "status-bar cellularMode is invalid",
    );
  }
  add("cellularMode", overrides.cellularMode);
  if (
    overrides.wifiBars !== undefined &&
    (!Number.isInteger(overrides.wifiBars) ||
      overrides.wifiBars < 0 ||
      overrides.wifiBars > 3)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "wifiBars must be between 0 and 3",
    );
  }
  add("wifiBars", overrides.wifiBars);
  if (
    overrides.cellularBars !== undefined &&
    (!Number.isInteger(overrides.cellularBars) ||
      overrides.cellularBars < 0 ||
      overrides.cellularBars > 4)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "cellularBars must be between 0 and 4",
    );
  }
  add("cellularBars", overrides.cellularBars);
  if (overrides.operatorName !== undefined) {
    if (
      typeof overrides.operatorName !== "string" ||
      overrides.operatorName.length > 128 ||
      /[\0\r\n]/.test(overrides.operatorName)
    ) {
      throw new IOSSimulatorInstanceError(
        "INVALID_ARGUMENT",
        "operatorName is invalid",
      );
    }
    add("operatorName", overrides.operatorName);
  }
  const batteryStates = new Set(["charging", "charged", "discharging"]);
  if (
    overrides.batteryState !== undefined &&
    !batteryStates.has(overrides.batteryState)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "batteryState is invalid",
    );
  }
  add("batteryState", overrides.batteryState);
  if (
    overrides.batteryLevel !== undefined &&
    (!Number.isInteger(overrides.batteryLevel) ||
      overrides.batteryLevel < 0 ||
      overrides.batteryLevel > 100)
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "batteryLevel must be between 0 and 100",
    );
  }
  add("batteryLevel", overrides.batteryLevel);
  if (entries.length === 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "at least one status-bar override is required",
    );
  }
  return entries;
}

function defaultClock(): IOSSimulatorLifecycleClock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      }),
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new IOSSimulatorInstanceError(
        "MUTATION_CANCELLED",
        "Simulator startup was cancelled because its lifecycle changed.",
        true,
      );
}

/** Exact-UDID, argv-only CoreSimulator lifecycle adapter. */
export function createIOSSimulatorSimctlLifecycle(
  options: IOSSimulatorSimctlLifecycleOptions = {},
): IOSSimulatorSimctlLifecycle {
  const runner = options.commandRunner ?? createNodeIOSSimulatorCommandRunner();
  const clock = options.clock ?? defaultClock();
  const bootTimeoutMs = options.bootTimeoutMs ?? 120_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const createMarkerNamespace = requireCreateMarkerNamespace(
    options.createMarkerNamespace ?? randomUUID().replaceAll("-", ""),
  );
  const createMarkerPrefix = `${CREATE_MARKER_PREFIX}${createMarkerNamespace}__`;
  const pendingCreateEvidence = options.pendingCreateEvidence ?? null;
  if (bootTimeoutMs <= 0 || pollIntervalMs <= 0) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simctl timeouts must be positive",
    );
  }

  async function runSimctl(args: readonly string[], signal?: AbortSignal) {
    throwIfAborted(signal);
    const result = signal
      ? await runner.run(XCRUN, args, { signal })
      : await runner.run(XCRUN, args);
    throwIfAborted(signal);
    return result;
  }

  function isPendingCreateName(name: string): boolean {
    return (
      isIOSSimulatorPendingCreateName(name) &&
      name.startsWith(createMarkerPrefix) &&
      CREATE_MARKER_UUID_PATTERN.test(name.slice(createMarkerPrefix.length))
    );
  }

  /**
   * Markers minted by this process that may still exist in CoreSimulator. A
   * marker stays pending from the moment `simctl create` can commit a device
   * until that device is proven renamed away or deleted — a span that covers the
   * caller's ownership write, which is the window the breadcrumb exists for.
   *
   * The breadcrumb may only be retired while this map is empty: another create
   * still inside that window needs the same evidence to survive a crash.
   */
  const pendingCreateMarkers = new Map<string, string | null>();
  let lastArmedEvidenceGeneration = 0;
  // Evidence may predate this lifecycle. If startup recovery could not prove
  // that older marker is gone, a later create must not retire the shared file
  // merely because its own marker settled successfully.
  let startupRecoveryIncomplete = false;

  function armPendingCreateMarker(markerName: string): void {
    if (!pendingCreateEvidence) return;
    lastArmedEvidenceGeneration = pendingCreateEvidence.arm();
    pendingCreateMarkers.set(markerName, null);
  }

  function bindPendingCreateMarker(markerName: string, udid: string): void {
    if (!pendingCreateMarkers.has(markerName)) return;
    pendingCreateMarkers.set(markerName, udid.toUpperCase());
  }

  /** Only call from a path that proves this exact marker no longer exists. */
  function settlePendingCreateMarker(markerName: string): void {
    if (!pendingCreateEvidence) return;
    if (!pendingCreateMarkers.delete(markerName)) return;
    if (pendingCreateMarkers.size > 0 || startupRecoveryIncomplete) return;
    // The newest arm is the generation the file now carries, so retiring against
    // it is a no-op if anything armed the breadcrumb outside this lifecycle.
    pendingCreateEvidence.clearIfUnchanged(lastArmedEvidenceGeneration);
  }

  function settlePendingCreateMarkerForDevice(udid: string): void {
    if (pendingCreateMarkers.size === 0) return;
    const normalized = udid.toUpperCase();
    for (const [markerName, markerUdid] of pendingCreateMarkers) {
      if (markerUdid === normalized) {
        settlePendingCreateMarker(markerName);
        return;
      }
    }
  }

  async function cleanupFailedCreate(
    udid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await runner.run(
      XCRUN,
      ["simctl", "delete", udid],
      signal
        ? { timeoutMs: CREATE_ABORT_CLEANUP_TIMEOUT_MS, signal }
        : { timeoutMs: CREATE_ABORT_CLEANUP_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "SIMULATOR_DELETE_FAILED",
        "The simulator created during cancellation could not be removed.",
        true,
      );
    }
  }

  /**
   * `verified` separates "this profile provably created nothing" from "the check
   * itself could not run". Only the former may retire create evidence.
   */
  async function recoverCreatedMarker(
    markerName: string,
    deviceTypeIdentifier: string,
    runtimeIdentifier: string,
    signal: AbortSignal,
  ): Promise<{ device: IOSSimulatorDevice | null; verified: boolean }> {
    const result = await runner.run(XCRUN, ["simctl", "list", "-j"], {
      timeoutMs: CREATE_ABORT_CLEANUP_TIMEOUT_MS,
      signal,
    });
    if (result.exitCode !== 0 || signal.aborted) {
      return { device: null, verified: false };
    }
    // The marker name is random and profile-scoped, so its presence alone proves
    // CoreSimulator committed something for this operation. Verification must key
    // on that name only: `deviceTypeIdentifier` is nullable in a listing, so a
    // metadata mismatch would otherwise be read as "nothing was created" and
    // retire the recovery evidence for a device that really exists.
    const named = parseSimctlListJson(result.stdout).devices.filter(
      (device) => device.name === markerName,
    );
    const candidates = named.filter(
      (device) =>
        device.runtimeIdentifier === runtimeIdentifier &&
        device.deviceTypeIdentifier === deviceTypeIdentifier &&
        UUID_PATTERN.test(device.udid.toUpperCase()),
    );
    // Deletion keeps the stricter identity rule; only a listing without this
    // exact name proves nothing needs recovering.
    if (candidates.length === 1) return { device: candidates[0]!, verified: true };
    return { device: null, verified: named.length === 0 };
  }

  async function list(signal?: AbortSignal): Promise<IOSSimulatorDevice[]> {
    throwIfAborted(signal);
    const result = signal
      ? await runner.run(XCRUN, ["simctl", "list", "-j"], { signal })
      : await runner.run(XCRUN, ["simctl", "list", "-j"]);
    throwIfAborted(signal);
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "SIMULATOR_NOT_FOUND",
        "Unable to read the installed iOS Simulator devices.",
        true,
      );
    }
    return parseSimctlListJson(result.stdout).devices;
  }

  async function findExact(
    udid: string,
    signal?: AbortSignal,
  ): Promise<IOSSimulatorDevice | null> {
    const normalized = requireUdid(udid);
    return (
      (await list(signal)).find(
        (device) => device.udid.toUpperCase() === normalized,
      ) ?? null
    );
  }

  async function renameExact(
    udid: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const normalized = requireUdid(udid);
    const targetName = requireIdentifier(name, "name");
    const result = await runSimctl(
      ["simctl", "rename", normalized, targetName],
      signal,
    );
    if (result.exitCode !== 0) {
      throw new IOSSimulatorInstanceError(
        "SIMULATOR_CREATE_FAILED",
        "The newly created iOS Simulator could not be named.",
        true,
      );
    }
    // The caller persists ownership before finalizing the name, so a marker that
    // is renamed away is both recorded and no longer sweepable.
    if (!isPendingCreateName(targetName)) {
      settlePendingCreateMarkerForDevice(normalized);
    }
  }

  return {
    findExact,

    async bootExact(udid, signal): Promise<IOSSimulatorDevice> {
      const normalized = requireUdid(udid);
      throwIfAborted(signal);
      const before = await findExact(normalized, signal);
      if (!before) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_NOT_FOUND",
          "The selected iOS Simulator device does not exist.",
        );
      }
      if (before.state.toLowerCase() !== "booted") {
        let bootedOrStarting = false;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          throwIfAborted(signal);
          const boot = signal
            ? await runner.run(XCRUN, ["simctl", "boot", normalized], {
                signal,
              })
            : await runner.run(XCRUN, ["simctl", "boot", normalized]);
          throwIfAborted(signal);
          if (boot.exitCode === 0) {
            bootedOrStarting = true;
            break;
          }

          // CoreSimulator may return a non-zero boot result while its device
          // transition is already in flight. Confirm the state before treating
          // the failure as terminal, then allow one short retry for a genuine
          // transient service race.
          const afterFailure = await findExact(normalized, signal);
          const state = afterFailure?.state.toLowerCase();
          if (state === "booted" || state === "booting") {
            bootedOrStarting = true;
            break;
          }
          if (attempt === 0) {
            await clock.sleep(500, signal);
            throwIfAborted(signal);
          }
        }
        if (!bootedOrStarting) {
          throw new IOSSimulatorInstanceError(
            "SIMULATOR_BOOT_FAILED",
            "The selected iOS Simulator could not be started.",
            true,
          );
        }
      }

      const deadline = clock.now() + bootTimeoutMs;
      while (clock.now() < deadline) {
        throwIfAborted(signal);
        const device = await findExact(normalized, signal);
        if (!device) {
          throw new IOSSimulatorInstanceError(
            "SIMULATOR_NOT_FOUND",
            "The selected iOS Simulator disappeared while starting.",
          );
        }
        if (device.state.toLowerCase() === "booted") {
          const remaining = Math.max(1_000, deadline - clock.now());
          // `simctl bootstatus -b` owns the readiness wait.  On a fresh iOS
          // runtime, data migration can take longer than the old 15-second
          // per-call cap; repeatedly restarting bootstatus prevented it from
          // ever reaching its terminal state before the outer deadline.
          const ready = await runner.run(
            XCRUN,
            ["simctl", "bootstatus", normalized, "-b"],
            signal
              ? { timeoutMs: remaining, signal }
              : { timeoutMs: remaining },
          );
          throwIfAborted(signal);
          if (ready.exitCode === 0) return device;
        }
        await clock.sleep(
          Math.min(pollIntervalMs, deadline - clock.now()),
          signal,
        );
        throwIfAborted(signal);
      }
      throw new IOSSimulatorInstanceError(
        "SIMULATOR_BOOT_TIMEOUT",
        "The iOS Simulator did not finish booting in time.",
        true,
      );
    },

    async shutdownExact(udid, signal): Promise<void> {
      const normalized = requireUdid(udid);
      throwIfAborted(signal);
      const device = await findExact(normalized, signal);
      throwIfAborted(signal);
      if (!device) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_NOT_FOUND",
          "The selected iOS Simulator device does not exist.",
        );
      }
      if (device.state.toLowerCase() === "shutdown") return;
      const result = signal
        ? await runner.run(XCRUN, ["simctl", "shutdown", normalized], {
            signal,
          })
        : await runner.run(XCRUN, ["simctl", "shutdown", normalized]);
      throwIfAborted(signal);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_SHUTDOWN_FAILED",
          "The selected iOS Simulator could not be stopped.",
          true,
        );
      }
    },

    async createExact(input, signal): Promise<IOSSimulatorCreatedDevice> {
      requireIdentifier(input.name, "name");
      const deviceTypeIdentifier = requireIdentifier(
        input.deviceTypeIdentifier,
        "deviceTypeIdentifier",
      );
      const runtimeIdentifier = requireIdentifier(
        input.runtimeIdentifier,
        "runtimeIdentifier",
      );
      const markerName = `${createMarkerPrefix}${randomUUID()}`;
      throwIfAborted(signal);
      // Arm before CoreSimulator can commit the device: everything after this
      // point may leave a hidden marker behind if the process dies, and the
      // breadcrumb is the only thing that survives to prove it.
      armPendingCreateMarker(markerName);
      let result: IOSSimulatorCommandResult | null = null;
      let commandError: unknown = null;
      try {
        result = await runner.run(
          XCRUN,
          [
            "simctl",
            "create",
            markerName,
            deviceTypeIdentifier,
            runtimeIdentifier,
          ],
          signal ? { timeoutMs: 60_000, signal } : { timeoutMs: 60_000 },
        );
      } catch (error) {
        commandError = error;
      }

      const stdoutUdid = result?.stdout.trim().toUpperCase() ?? "";
      let createdDevice: IOSSimulatorCreatedDevice | null = UUID_PATTERN.test(
        stdoutUdid,
      )
        ? {
            udid: stdoutUdid,
            name: markerName,
            runtimeIdentifier,
            deviceTypeIdentifier,
          }
        : null;
      if (createdDevice) bindPendingCreateMarker(markerName, createdDevice.udid);
      const createFailure =
        commandError ??
        (result?.exitCode !== 0
          ? new IOSSimulatorInstanceError(
              "SIMULATOR_CREATE_FAILED",
              "The iOS Simulator device could not be created.",
            )
          : null);

      // CoreSimulator may commit the device before a cancelled xcrun flushes
      // its UUID. The random profile marker remains in CoreSimulator itself,
      // so one bounded post-create list can recover only this operation.
      let cleanupController: AbortController | null = null;
      let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
      if (!createdDevice) {
        cleanupController = new AbortController();
        cleanupTimer = setTimeout(
          () => cleanupController?.abort(),
          CREATE_ABORT_RECONCILE_TIMEOUT_MS,
        );
        cleanupTimer.unref?.();
        try {
          const recovered = await recoverCreatedMarker(
            markerName,
            deviceTypeIdentifier,
            runtimeIdentifier,
            cleanupController.signal,
          );
          if (recovered.device) {
            createdDevice = {
              udid: recovered.device.udid.toUpperCase(),
              name: markerName,
              runtimeIdentifier,
              deviceTypeIdentifier,
            };
            bindPendingCreateMarker(markerName, createdDevice.udid);
          } else if (recovered.verified) {
            // This create provably left nothing behind, so it must not keep the
            // profile paying a startup sweep it cannot clean anything with.
            settlePendingCreateMarker(markerName);
          }
        } catch {
          // The marker is profile-scoped and remains recoverable on startup.
        }
      }

      if (createdDevice && (signal?.aborted || createFailure)) {
        const originalReason = signal?.aborted ? signal.reason : createFailure;
        try {
          await cleanupFailedCreate(
            createdDevice.udid,
            cleanupController?.signal,
          );
          // The compensating delete succeeded, so this marker is gone.
          settlePendingCreateMarker(markerName);
        } catch (error) {
          throw new IOSSimulatorCreateCleanupRequiredError(
            createdDevice,
            originalReason,
            { cause: error },
          );
        } finally {
          if (cleanupTimer) clearTimeout(cleanupTimer);
        }
      } else if (cleanupTimer) {
        clearTimeout(cleanupTimer);
      }
      if (signal?.aborted) {
        throwIfAborted(signal);
      }
      if (commandError) throw commandError;
      if (createFailure) throw createFailure;
      if (!createdDevice) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CREATE_FAILED",
          "The iOS Simulator device could not be created.",
        );
      }
      return createdDevice;
    },

    renameExact,

    async reconcilePendingCreates(
      ownedDevices,
      signal,
    ): Promise<readonly string[]> {
      const owned = new Map(
        ownedDevices.map((device) => [
          requireUdid(device.udid),
          requireIdentifier(device.name, "name"),
        ]),
      );
      const pending = (await list(signal)).filter(
        (device) =>
          isPendingCreateName(device.name) &&
          owned.has(device.udid.toUpperCase()),
      );
      const reconciled: string[] = [];
      for (const device of pending) {
        const udid = device.udid.toUpperCase();
        await renameExact(udid, owned.get(udid)!, signal);
        reconciled.push(udid);
      }
      return reconciled;
    },

    async recoverPendingCreatesAtStartup(
      ownedDevices,
      signal,
    ): Promise<IOSSimulatorPendingCreateRecoveryResult> {
      const owned = new Map(
        ownedDevices.map((device) => [
          requireUdid(device.udid),
          requireIdentifier(device.name, "name"),
        ]),
      );
      let pending: IOSSimulatorDevice[];
      try {
        pending = (await list(signal)).filter((device) =>
          isPendingCreateName(device.name),
        );
      } catch (error) {
        startupRecoveryIncomplete = true;
        throw error;
      }
      const recovered: string[] = [];
      let complete = true;
      let firstFailure: unknown = null;
      for (const device of pending) {
        const udid = device.udid.toUpperCase();
        try {
          const ownedName = owned.get(udid);
          if (ownedName) {
            await renameExact(udid, ownedName, signal);
            recovered.push(udid);
            continue;
          }

          // CoreSimulator is global to the macOS user. Re-read the exact UUID
          // before deleting so an external rename or replacement cannot turn
          // a profile-scoped cleanup into deletion of an ordinary device.
          const current = await findExact(udid, signal);
          if (
            !current ||
            current.name !== device.name ||
            !isPendingCreateName(current.name) ||
            current.runtimeIdentifier !== device.runtimeIdentifier ||
            current.deviceTypeIdentifier === null ||
            current.deviceTypeIdentifier !== device.deviceTypeIdentifier
          ) {
            // We deliberately avoid deleting a marker whose identity changed or
            // whose metadata is incomplete. That is not a completed sweep: the
            // breadcrumb must survive so a later startup can retry the cleanup.
            complete = false;
            continue;
          }
          await cleanupFailedCreate(udid, signal);
          recovered.push(udid);
        } catch (error) {
          if (signal?.aborted) {
            startupRecoveryIncomplete = true;
            throwIfAborted(signal);
          }
          firstFailure ??= error;
        }
      }
      if (firstFailure !== null) {
        startupRecoveryIncomplete = true;
        throw firstFailure;
      }
      startupRecoveryIncomplete = !complete;
      return { recovered, complete };
    },

    async deleteExact(udid, signal): Promise<void> {
      const normalized = requireUdid(udid);
      throwIfAborted(signal);
      const result = signal
        ? await runner.run(XCRUN, ["simctl", "delete", normalized], {
            signal,
          })
        : await runner.run(XCRUN, ["simctl", "delete", normalized]);
      throwIfAborted(signal);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_DELETE_FAILED",
          "The iOS Simulator device could not be deleted.",
        );
      }
      // A rolled-back create leaves nothing for a sweep to find either.
      settlePendingCreateMarkerForDevice(normalized);
    },

    async setAppearance(udid, appearance, signal): Promise<void> {
      const normalized = requireUdid(udid);
      if (appearance !== "light" && appearance !== "dark") {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "appearance must be light or dark",
        );
      }
      const result = await runSimctl(
        ["simctl", "ui", normalized, "appearance", appearance],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator appearance could not be changed.",
          true,
        );
      }
    },

    async setIncreaseContrast(udid, enabled, signal): Promise<void> {
      const normalized = requireUdid(udid);
      if (typeof enabled !== "boolean") {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "increase contrast enabled must be a boolean",
        );
      }
      const result = await runSimctl(
        [
          "simctl",
          "ui",
          normalized,
          "increase_contrast",
          enabled ? "enabled" : "disabled",
        ],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator increase contrast setting could not be changed.",
          true,
        );
      }
    },

    async setContentSize(udid, contentSize, signal): Promise<void> {
      const normalized = requireUdid(udid);
      if (!CONTENT_SIZES.has(contentSize)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "content size is invalid",
        );
      }
      const result = await runSimctl(
        ["simctl", "ui", normalized, "content_size", contentSize],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator content size could not be changed.",
          true,
        );
      }
    },

    async setLocation(udid, latitude, longitude, signal): Promise<void> {
      const normalized = requireUdid(udid);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "latitude must be between -90 and 90",
        );
      }
      if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "longitude must be between -180 and 180",
        );
      }
      const coordinate = `${latitude},${longitude}`;
      const result = await runSimctl(
        ["simctl", "location", normalized, "set", coordinate],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator location could not be changed.",
          true,
        );
      }
    },

    async startLocationRoute(udid, options, signal): Promise<void> {
      const normalized = requireUdid(udid);
      const route = requireLocationRoute(options);
      const args = ["simctl", "location", normalized, "start"];
      if (route.speedMetersPerSecond !== undefined) {
        args.push(`--speed=${route.speedMetersPerSecond}`);
      }
      if (route.distanceMeters !== undefined) {
        args.push(`--distance=${route.distanceMeters}`);
      } else if (route.intervalSeconds !== undefined) {
        args.push(`--interval=${route.intervalSeconds}`);
      }
      args.push(
        ...route.waypoints.map(
          (waypoint) => `${waypoint.latitude},${waypoint.longitude}`,
        ),
      );
      const result = await runSimctl(args, signal);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator location route could not be started.",
          true,
        );
      }
    },

    async clearLocation(udid, signal): Promise<void> {
      const normalized = requireUdid(udid);
      const result = await runSimctl(
        ["simctl", "location", normalized, "clear"],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator location could not be cleared.",
          true,
        );
      }
    },

    async setPrivacy(udid, action, service, bundleId, signal): Promise<void> {
      const normalized = requireUdid(udid);
      if (!["grant", "revoke", "reset"].includes(action)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "privacy action is invalid",
        );
      }
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(service)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "privacy service is invalid",
        );
      }
      if (bundleId && !/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/.test(bundleId)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "bundleId is invalid",
        );
      }
      if (action !== "reset" && !bundleId) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "bundleId is required for privacy grant/revoke",
        );
      }
      const args = ["simctl", "privacy", normalized, action, service];
      if (bundleId) args.push(bundleId);
      const result = await runSimctl(args, signal);
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator privacy setting could not be changed.",
          true,
        );
      }
    },

    async pushNotification(udid, bundleId, payload, signal): Promise<void> {
      const normalized = requireUdid(udid);
      const normalizedBundleId = requireBundleId(bundleId);
      if (
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload) ||
        !payload.aps
      ) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "push payload must be an object containing aps",
        );
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "push payload is not serializable",
        );
      }
      if (Buffer.byteLength(serialized, "utf8") > 4096) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "push payload must be at most 4096 bytes",
        );
      }
      throwIfAborted(signal);
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cindy-ios-push-"));
      const payloadPath = path.join(tempRoot, "payload.json");
      try {
        await writeFile(
          payloadPath,
          serialized,
          signal
            ? { encoding: "utf8", mode: 0o600, signal }
            : { encoding: "utf8", mode: 0o600 },
        );
        throwIfAborted(signal);
        const result = await runSimctl(
          ["simctl", "push", normalized, normalizedBundleId, payloadPath],
          signal,
        );
        if (result.exitCode !== 0) {
          throw new IOSSimulatorInstanceError(
            "SIMULATOR_CONTROL_FAILED",
            "The simulator push notification could not be delivered.",
            true,
          );
        }
      } finally {
        await rm(tempRoot, { recursive: true, force: true });
      }
    },

    async setStatusBar(udid, overrides, signal): Promise<void> {
      const normalized = requireUdid(udid);
      const entries = requireStatusBarOverrides(overrides);
      const result = await runSimctl(
        ["simctl", "status_bar", normalized, "override", ...entries.flat()],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator status bar could not be overridden.",
          true,
        );
      }
    },

    async clearStatusBar(udid, signal): Promise<void> {
      const normalized = requireUdid(udid);
      const result = await runSimctl(
        ["simctl", "status_bar", normalized, "clear"],
        signal,
      );
      if (result.exitCode !== 0) {
        throw new IOSSimulatorInstanceError(
          "SIMULATOR_CONTROL_FAILED",
          "The simulator status bar override could not be cleared.",
          true,
        );
      }
    },
  };
}
