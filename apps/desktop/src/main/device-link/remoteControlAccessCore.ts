/**
 * Process-local permission generation for the local "allow remote control" switch.
 *
 * A transition of the switch ends every routing context retained under the
 * previous permission. This generation is deliberately in-memory: a process
 * restart already drops all prepared contexts, and a persisted generation would
 * outlive the memory it is meant to fence.
 */
import type { readDeviceLinkSettings } from './settings-store.desktop.js';


export type RemoteControlAccessScope = 'all' | { deviceId: string };
type Listener = (scope: RemoteControlAccessScope) => void;
export interface RemoteControlAccessPorts {
readDeviceLinkSettings: typeof readDeviceLinkSettings;
}
export function createRemoteControlAccess(ports: RemoteControlAccessPorts) {
const { readDeviceLinkSettings } = ports;


const listeners = new Set<Listener>();
let generation = 0;
let observed: boolean | null = null;
let notifiedGeneration = 0;
const deviceGenerations = new Map<string, number>();
const DEVICE_GENERATION_LIMIT = 4096;
/** Admission denials observed by this process; each transition ends the peer's routes once. */
const observedRevoked = new Set<string>();
const OBSERVED_REVOKED_LIMIT = 1024;

/**
 * Observe the shared settings file. Reading it here also catches an external
 * instance's write, so every capture closure sees the new generation even
 * before the periodic owner poll runs.
 */
function observe(): boolean {
  const enabled = readDeviceLinkSettings().remoteControlEnabled;
  if (observed === null) {
    observed = enabled;
    return false;
  }
  if (observed === enabled) return false;
  observed = enabled;
  generation += 1;
  return true;
}

/** Read-only access for capture closures; a change observed here fences old captures. */
function remoteControlAccessGeneration(): number {
  observe();
  return generation;
}

/**
 * Explicit production entry called after the shared setting is written or an
 * external change is applied. It notifies consumers once per observed change so
 * they can tombstone entries even when the link-close never reaches them.
 */
function syncRemoteControlAccessGeneration(): number {
  observe();
  if (notifiedGeneration === generation) return generation;
  notifiedGeneration = generation;
  // A restore is a new permission, not a closure. Notifying on it would retire
  // contexts created under the newly restored permission before the owner poll
  // applies the restore. Stale contexts are still fenced by their captured
  // generation on the next executor read.
  if (readDeviceLinkSettings().remoteControlEnabled) return generation;
  for (const listener of listeners) {
    try {
      listener('all');
    } catch {
      // A consumer cannot undo the permission boundary.
    }
  }
  return generation;
}

/** Per-controller access generation; only a revoke of that device advances it. */
function deviceAccessGeneration(deviceId: string): number {
  return deviceGenerations.get(deviceId) ?? 0;
}

/** The controller's per-device revocation is part of the same access scope. */
function isControllerAccessAllowed(deviceId: string): boolean {
  const allowed = !readDeviceLinkSettings().revokedControllers.includes(deviceId);
  // A live allowed observation (e.g. a new prepare after a restore) starts a
  // new denial episode; the next revoke must advance the generation again.
  if (allowed) observedRevoked.delete(deviceId);
  return allowed;
}

/**
 * Explicit revoke (local UI or the owner's external-settings poll). Only the
 * revoked device's retained contexts are fenced; a neighbor keeps its grant.
 */
function bumpDeviceAccessGeneration(deviceId: string): number {
  if (!deviceId) return 0;
  if (deviceGenerations.size >= DEVICE_GENERATION_LIMIT && !deviceGenerations.has(deviceId)) {
    deviceGenerations.delete(deviceGenerations.keys().next().value!);
  }
  const next = (deviceGenerations.get(deviceId) ?? 0) + 1;
  deviceGenerations.set(deviceId, next);
  for (const listener of listeners) {
    try {
      listener({ deviceId });
    } catch {
      // A consumer cannot undo the revocation boundary.
    }
  }
  return next;
}

/**
 * A real dispatch gate observed this controller as revoked. Bump only once per
 * observation episode; repeated denied requests must not churn generations or
 * lengthen any permission. A later allowed request clears the episode.
 */
function noteControllerAccessDenied(deviceId: string): void {
  if (!deviceId || observedRevoked.has(deviceId)) return;
  if (observedRevoked.size >= OBSERVED_REVOKED_LIMIT) {
    observedRevoked.delete(observedRevoked.values().next().value!);
  }
  observedRevoked.add(deviceId);
  bumpDeviceAccessGeneration(deviceId);
}

function noteControllerAccessAllowed(deviceId: string): void {
  observedRevoked.delete(deviceId);
}

function onRemoteControlAccessChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
return { remoteControlAccessGeneration, syncRemoteControlAccessGeneration, deviceAccessGeneration, isControllerAccessAllowed, bumpDeviceAccessGeneration, noteControllerAccessDenied, noteControllerAccessAllowed, onRemoteControlAccessChanged };
}
