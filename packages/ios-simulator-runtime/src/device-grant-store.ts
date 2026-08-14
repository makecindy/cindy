import { IOSSimulatorInstanceError } from "./instance-errors.js";

export type IOSSimulatorGrantDecision = "unknown" | "allowed" | "denied";
export type IOSSimulatorGrantPolicySource = "user" | "managed-policy";

export interface IOSSimulatorDeviceGrant {
  simulatorUdid: string;
  agentControl: IOSSimulatorGrantDecision;
  screenshotCapture: IOSSimulatorGrantDecision;
  policySource: IOSSimulatorGrantPolicySource;
  updatedAt: string;
}
export interface IOSSimulatorDeviceGrantStoreOptions {
  now?: () => number;
  /** Previously persisted per-device decisions restored at Host startup. */
  initialGrants?: readonly IOSSimulatorDeviceGrant[];
  /** Synchronous persistence hook; failed elevations roll back and revocations stay fail-closed. */
  onChange?: (grants: IOSSimulatorDeviceGrant[]) => void;
  /** Fail-closed gate supplied by the profile-scoped registry owner. */
  assertMutationAllowed?: () => void;
}

function requireUdid(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "simulatorUdid must be an exact simulator UUID",
    );
  }
  return normalized;
}

function requireDecision(value: unknown): IOSSimulatorGrantDecision {
  if (value !== "unknown" && value !== "allowed" && value !== "denied") {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "Simulator grant decisions must be unknown, allowed, or denied",
    );
  }
  return value;
}

function requirePolicySource(value: unknown): IOSSimulatorGrantPolicySource {
  if (value !== "user" && value !== "managed-policy") {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "Simulator grant policy source is invalid",
    );
  }
  return value;
}

function requireIsoDate(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new IOSSimulatorInstanceError(
      "INVALID_ARGUMENT",
      "Simulator grant updatedAt must be an ISO date",
    );
  }
  return value;
}

function copyGrant(grant: IOSSimulatorDeviceGrant): IOSSimulatorDeviceGrant {
  return { ...grant };
}

function restoreGrant(grant: IOSSimulatorDeviceGrant): IOSSimulatorDeviceGrant {
  return {
    simulatorUdid: requireUdid(grant.simulatorUdid),
    agentControl: requireDecision(grant.agentControl),
    screenshotCapture: requireDecision(grant.screenshotCapture),
    policySource: requirePolicySource(grant.policySource),
    updatedAt: requireIsoDate(grant.updatedAt),
  };
}

/** Per-device consent registry, deliberately independent from Session ownership. */
export class IOSSimulatorDeviceGrantStore {
  readonly #now: () => number;
  readonly #onChange: ((grants: IOSSimulatorDeviceGrant[]) => void) | null;
  readonly #assertMutationAllowed: (() => void) | null;
  readonly #grants = new Map<string, IOSSimulatorDeviceGrant>();

  constructor(options: IOSSimulatorDeviceGrantStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? null;
    this.#assertMutationAllowed = options.assertMutationAllowed ?? null;
    for (const persisted of options.initialGrants ?? []) {
      const grant = restoreGrant(persisted);
      if (this.#grants.has(grant.simulatorUdid)) {
        throw new IOSSimulatorInstanceError(
          "INVALID_ARGUMENT",
          "Persisted simulator grants contain duplicate devices",
        );
      }
      this.#grants.set(grant.simulatorUdid, grant);
    }
  }

  get(simulatorUdid: string): IOSSimulatorDeviceGrant {
    const udid = requireUdid(simulatorUdid);
    return copyGrant(
      this.#grants.get(udid) ?? {
        simulatorUdid: udid,
        agentControl: "unknown",
        screenshotCapture: "unknown",
        policySource: "user",
        updatedAt: new Date(0).toISOString(),
      },
    );
  }

  listAll(): IOSSimulatorDeviceGrant[] {
    return Array.from(this.#grants.values(), copyGrant);
  }

  set(
    simulatorUdid: string,
    patch: Partial<
      Pick<IOSSimulatorDeviceGrant, "agentControl" | "screenshotCapture">
    >,
    policySource: IOSSimulatorGrantPolicySource = "user",
  ): IOSSimulatorDeviceGrant {
    const current = this.get(simulatorUdid);
    if (current.policySource === "managed-policy" && policySource === "user") {
      return current;
    }
    const previous = this.#grants.get(current.simulatorUdid);
    const next: IOSSimulatorDeviceGrant = {
      ...current,
      agentControl:
        patch.agentControl === undefined
          ? current.agentControl
          : requireDecision(patch.agentControl),
      screenshotCapture:
        patch.screenshotCapture === undefined
          ? current.screenshotCapture
          : requireDecision(patch.screenshotCapture),
      policySource: requirePolicySource(policySource),
      updatedAt: new Date(this.#now()).toISOString(),
    };
    try {
      this.#assertMutationAllowed?.();
      this.#grants.set(current.simulatorUdid, next);
      this.#onChange?.(this.listAll());
    } catch (error) {
      // A persistence failure must never grant a capability. Roll elevations
      // back, but retain explicitly non-allowed decisions in memory so a user
      // revocation takes effect for the rest of this Host lifetime even when
      // the profile file is temporarily unwritable.
      const failClosed = copyGrant(current);
      let retainedRestriction = false;
      if (patch.agentControl !== undefined && next.agentControl !== "allowed") {
        failClosed.agentControl = next.agentControl;
        retainedRestriction = true;
      }
      if (
        patch.screenshotCapture !== undefined &&
        next.screenshotCapture !== "allowed"
      ) {
        failClosed.screenshotCapture = next.screenshotCapture;
        retainedRestriction = true;
      }
      if (retainedRestriction) {
        failClosed.policySource = next.policySource;
        failClosed.updatedAt = next.updatedAt;
        this.#grants.set(current.simulatorUdid, failClosed);
      } else if (previous) {
        this.#grants.set(current.simulatorUdid, previous);
      } else {
        this.#grants.delete(current.simulatorUdid);
      }
      throw error;
    }
    return copyGrant(next);
  }

  requireAgentControl(simulatorUdid: string): IOSSimulatorDeviceGrant {
    const grant = this.get(simulatorUdid);
    if (grant.agentControl !== "allowed") {
      throw new IOSSimulatorInstanceError(
        "DEVICE_CONTROL_NOT_GRANTED",
        grant.agentControl === "denied"
          ? "Agent control is denied for this simulator."
          : "Agent control has not been granted for this simulator.",
      );
    }
    return grant;
  }
}
