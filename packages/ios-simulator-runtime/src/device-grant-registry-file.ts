import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { IOSSimulatorDeviceGrant } from "./device-grant-store.js";
import { IOSSimulatorInstanceError } from "./instance-errors.js";

const REGISTRY_VERSION = 1;
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_GRANTS = 512;
const SIMULATOR_UDID_PATTERN =
  /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;

export interface IOSSimulatorDeviceGrantRegistrySnapshot {
  version: 1;
  savedAt: string;
  grants: IOSSimulatorDeviceGrant[];
}

export interface IOSSimulatorDeviceGrantRegistryFileOptions {
  /** Reuses the profile ownership registry's process-wide writer lease. */
  assertMutationAllowed?: () => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalUdid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase();
  return SIMULATOR_UDID_PATTERN.test(normalized) ? normalized : null;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function isDecision(value: unknown): boolean {
  return value === "unknown" || value === "allowed" || value === "denied";
}

function parseGrant(value: unknown): IOSSimulatorDeviceGrant | null {
  if (!isRecord(value)) return null;
  const simulatorUdid = canonicalUdid(value.simulatorUdid);
  if (
    !simulatorUdid ||
    !isDecision(value.agentControl) ||
    !isDecision(value.screenshotCapture) ||
    (value.policySource !== "user" &&
      value.policySource !== "managed-policy") ||
    !isIsoDate(value.updatedAt)
  ) {
    return null;
  }
  return {
    simulatorUdid,
    agentControl: value.agentControl as IOSSimulatorDeviceGrant["agentControl"],
    screenshotCapture:
      value.screenshotCapture as IOSSimulatorDeviceGrant["screenshotCapture"],
    policySource: value.policySource,
    updatedAt: value.updatedAt,
  };
}

function parseSnapshot(value: unknown): IOSSimulatorDeviceGrant[] | null {
  if (
    !isRecord(value) ||
    value.version !== REGISTRY_VERSION ||
    !isIsoDate(value.savedAt) ||
    !Array.isArray(value.grants) ||
    value.grants.length > MAX_GRANTS
  ) {
    return null;
  }
  const grants: IOSSimulatorDeviceGrant[] = [];
  const seenUdids = new Set<string>();
  for (const valueGrant of value.grants) {
    const grant = parseGrant(valueGrant);
    if (!grant || seenUdids.has(grant.simulatorUdid)) return null;
    seenUdids.add(grant.simulatorUdid);
    grants.push(grant);
  }
  return grants;
}

function invalidRegistryError(): IOSSimulatorInstanceError {
  return new IOSSimulatorInstanceError(
    "INVALID_ARGUMENT",
    "The persisted iOS Simulator device grants are invalid.",
  );
}

/** Profile-scoped, schema-bounded device consent snapshot. */
export class IOSSimulatorDeviceGrantRegistryFile {
  readonly #filePath: string;
  readonly #assertMutationAllowed: (() => void) | null;

  constructor(
    filePath: string,
    options: IOSSimulatorDeviceGrantRegistryFileOptions = {},
  ) {
    this.#filePath = filePath;
    this.#assertMutationAllowed = options.assertMutationAllowed ?? null;
  }

  get filePath(): string {
    return this.#filePath;
  }

  loadSync(): IOSSimulatorDeviceGrant[] {
    this.#assertMutationAllowed?.();
    let serialized: Buffer;
    try {
      serialized = readFileSync(this.#filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
      throw invalidRegistryError();
    }
    if (serialized.byteLength > MAX_REGISTRY_BYTES)
      throw invalidRegistryError();
    let value: unknown;
    try {
      value = JSON.parse(serialized.toString("utf8")) as unknown;
    } catch {
      throw invalidRegistryError();
    }
    const grants = parseSnapshot(value);
    if (!grants) throw invalidRegistryError();
    return grants;
  }

  saveSync(grants: readonly IOSSimulatorDeviceGrant[]): void {
    this.#assertMutationAllowed?.();
    const snapshot: IOSSimulatorDeviceGrantRegistrySnapshot = {
      version: REGISTRY_VERSION,
      savedAt: new Date().toISOString(),
      grants: grants.map((grant) => ({ ...grant })),
    };
    const validated = parseSnapshot(snapshot);
    if (!validated) throw invalidRegistryError();
    const serialized = JSON.stringify({ ...snapshot, grants: validated });
    if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRY_BYTES) {
      throw invalidRegistryError();
    }

    mkdirSync(path.dirname(this.#filePath), { recursive: true });
    const tempPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tempPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      this.#assertMutationAllowed?.();
      renameSync(tempPath, this.#filePath);
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // The write error remains authoritative; cleanup is best effort.
      }
    }
  }
}
