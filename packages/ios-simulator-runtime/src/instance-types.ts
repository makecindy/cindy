import type { IOSSimulatorDevice } from "./types.js";

export type IOSSimulatorCreationProvenance = "cindy" | "external";
export type IOSSimulatorBootProvenance =
  "agent-booted" | "user-booted" | "preexisting";
export type IOSSimulatorLifecycleState =
  "stopped" | "booting" | "ready" | "stopping" | "error";
export type IOSSimulatorViewerState = "detached" | "attaching" | "attached";
export type IOSSimulatorHealthState =
  "healthy" | "degraded" | "recovering" | "error";

export interface IOSSimulatorLease {
  id: string;
  issuedAt: string;
  expiresAt: string;
}
/** Persistable identity and orthogonal state for one Cindy simulator binding. */
export interface IOSSimulatorInstance {
  instanceId: string;
  sessionId: string;
  sessionKind: "local";
  worktreeRoot: string;
  sourceFingerprint: string;
  simulatorUdid: string;
  simulatorName: string;
  runtimeIdentifier: string;
  deviceTypeIdentifier: string;
  creationProvenance: IOSSimulatorCreationProvenance;
  bootProvenance: IOSSimulatorBootProvenance;
  generation: number;
  lifecycleState: IOSSimulatorLifecycleState;
  viewerState: IOSSimulatorViewerState;
  healthState: IOSSimulatorHealthState;
  lease: IOSSimulatorLease;
  createdAt: string;
  lastActiveAt: string;
  stoppedAt: string | null;
  graceExpiresAt: string | null;
  errorCode: string | null;
}

export interface IOSSimulatorAttachInput {
  sessionId: string;
  worktreeRoot: string;
  sourceFingerprint: string;
  device: IOSSimulatorDevice;
  creationProvenance?: IOSSimulatorCreationProvenance;
  bootProvenance?: IOSSimulatorBootProvenance;
}

/** Exact mutation route. Never accept a name or implicit `booted` selector. */
export interface IOSSimulatorMutationRoute {
  sessionId: string;
  instanceId: string;
  generation: number;
  leaseId: string;
}

export interface IOSSimulatorCreatedDevice {
  udid: string;
  name: string;
  runtimeIdentifier: string;
  deviceTypeIdentifier: string;
}
