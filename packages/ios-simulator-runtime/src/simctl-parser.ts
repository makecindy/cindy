import { IOSSimulatorRuntimeError } from "./errors.js";
import type { IOSSimulatorDevice, IOSSimulatorRuntimeInfo } from "./types.js";

interface ParsedSimctlList {
  runtimes: IOSSimulatorRuntimeInfo[];
  devices: IOSSimulatorDevice[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isIOSRuntime(record: Record<string, unknown>): boolean {
  const identifier = readString(record, "identifier") ?? "";
  const name = readString(record, "name") ?? "";
  const platform = readString(record, "platform") ?? "";
  return (
    identifier.includes(".SimRuntime.iOS-") ||
    name.startsWith("iOS ") ||
    platform === "iOS"
  );
}

function runtimeFromUnknown(value: unknown): IOSSimulatorRuntimeInfo | null {
  if (!isRecord(value) || !isIOSRuntime(value)) return null;
  const identifier = readString(value, "identifier");
  const name = readString(value, "name");
  if (!identifier || !name) return null;
  const availabilityError = readString(value, "availabilityError");
  return {
    identifier,
    name,
    version: readString(value, "version"),
    buildVersion:
      readString(value, "buildversion") ?? readString(value, "buildVersion"),
    isAvailable:
      typeof value.isAvailable === "boolean"
        ? value.isAvailable
        : availabilityError === null,
    availabilityError,
  };
}

function deviceFromUnknown(
  value: unknown,
  runtime: IOSSimulatorRuntimeInfo,
): IOSSimulatorDevice | null {
  if (!isRecord(value)) return null;
  const udid = readString(value, "udid");
  const name = readString(value, "name");
  if (!udid || !name) return null;
  const availabilityError = readString(value, "availabilityError");
  return {
    udid,
    name,
    state: readString(value, "state") ?? "Unknown",
    isAvailable:
      runtime.isAvailable &&
      (typeof value.isAvailable === "boolean"
        ? value.isAvailable
        : availabilityError === null),
    availabilityError,
    runtimeIdentifier: runtime.identifier,
    runtimeName: runtime.name,
    runtimeVersion: runtime.version,
    deviceTypeIdentifier: readString(value, "deviceTypeIdentifier"),
    lastBootedAt: readString(value, "lastBootedAt"),
  };
}

/** Parse `xcrun simctl list -j` without relying on human-readable output. */
export function parseSimctlListJson(text: string): ParsedSimctlList {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new IOSSimulatorRuntimeError(
      "INVALID_SIMCTL_OUTPUT",
      `simctl returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(raw)) {
    throw new IOSSimulatorRuntimeError(
      "INVALID_SIMCTL_OUTPUT",
      "simctl result must be an object",
    );
  }

  const parsedRuntimes = Array.isArray(raw.runtimes)
    ? raw.runtimes
        .map(runtimeFromUnknown)
        .filter((item): item is IOSSimulatorRuntimeInfo => item !== null)
    : [];
  const runtimeById = new Map<string, IOSSimulatorRuntimeInfo>();
  for (const runtime of parsedRuntimes) {
    const existing = runtimeById.get(runtime.identifier);
    if (!existing || (!existing.isAvailable && runtime.isAvailable)) {
      runtimeById.set(runtime.identifier, runtime);
    }
  }
  const runtimes = Array.from(runtimeById.values());
  const devices: IOSSimulatorDevice[] = [];

  if (isRecord(raw.devices)) {
    for (const [runtimeIdentifier, candidates] of Object.entries(raw.devices)) {
      let runtime = runtimeById.get(runtimeIdentifier);
      if (!runtime && runtimeIdentifier.includes(".SimRuntime.iOS-")) {
        runtime = {
          identifier: runtimeIdentifier,
          name:
            runtimeIdentifier.split(".").at(-1)?.replace("iOS-", "iOS ") ??
            runtimeIdentifier,
          version: null,
          buildVersion: null,
          isAvailable: true,
          availabilityError: null,
        };
        runtimeById.set(runtimeIdentifier, runtime);
        runtimes.push(runtime);
      }
      if (!runtime || !Array.isArray(candidates)) continue;
      for (const candidate of candidates) {
        const device = deviceFromUnknown(candidate, runtime);
        if (device) devices.push(device);
      }
    }
  }

  runtimes.sort(
    (a, b) =>
      b.name.localeCompare(a.name) || a.identifier.localeCompare(b.identifier),
  );
  devices.sort((a, b) => {
    const bootRank =
      Number(b.state === "Booted") - Number(a.state === "Booted");
    return (
      bootRank ||
      b.runtimeName.localeCompare(a.runtimeName) ||
      a.name.localeCompare(b.name) ||
      a.udid.localeCompare(b.udid)
    );
  });
  return { runtimes, devices };
}
