import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { InstanceConfig } from "./config.js";
import type { PluginOauthPublicIdentity } from '@cindy/device-link';
import { AUTH_RECOVERY_CAPABILITIES } from "./auth-recovery.js";

export type InstanceReadiness = Record<
  "auth" | "database" | "binaries" | "maker" | "deviceLink",
  boolean
>;

export function buildInstanceStatus(
  config: Pick<InstanceConfig, "deviceId">,
  readiness: InstanceReadiness,
  now: number,
  stopping = false,
  oauthIdentity?: PluginOauthPublicIdentity,
  authRecovery?: { version: 1; state: 'login-required' | 'ready' | 'pending' },
) {
  const ready = Object.values(readiness).every(Boolean);
  return {
    version: 1,
    instanceId: config.deviceId,
    phase: stopping ? "stopping" : ready ? "ready" : "starting",
    heartbeatAtMs: now,
    // Top level on purpose: older CIS strips unknown top-level fields but parses authRecovery strictly.
    ...(authRecovery ? { authRecovery, authRecoveryCapabilities: [...AUTH_RECOVERY_CAPABILITIES] } : {}),
    ...(ready && !stopping && oauthIdentity ? {oauthIdentity} : {}),
    readiness: Object.fromEntries(
      Object.entries(readiness).map(([component, passed]) => [
        component,
        passed ? "ready" : "not-ready",
      ]),
    ),
    idle: {
      maySuspend: false,
      blockers: ["activity-unknown"],
      lastBusyAtMs: now,
      nextWakeAtMs: null,
    },
  };
}

export function startInstanceStatus(
  config: InstanceConfig,
  read: () => InstanceReadiness,
  onFailure: () => void,
  readOauthIdentity: () => PluginOauthPublicIdentity | undefined | Promise<PluginOauthPublicIdentity | undefined> = () => undefined,
  readAuthRecovery: () => { version: 1; state: 'login-required' | 'ready' | 'pending' } | undefined = () => undefined,
): () => void {
  let epoch = 0;
  let inflight = false;
  const write = async (stopping = false): Promise<void> => {
    if (inflight && !stopping) return;
    inflight = true;
    const generation = ++epoch;
    const temporary = `${config.statusFile}.${randomUUID()}`;
    try {
      const oauthIdentity = stopping ? undefined : await readOauthIdentity();
      if (generation !== epoch) return;
      fs.mkdirSync(path.dirname(config.statusFile), {
        recursive: true,
        mode: 0o700,
      });
      fs.writeFileSync(
        temporary,
        JSON.stringify(
          buildInstanceStatus(config, read(), Date.now(), stopping, oauthIdentity, readAuthRecovery()),
        ),
        { flag: "wx", mode: 0o600 },
      );
      fs.renameSync(temporary, config.statusFile);
    } catch {
      onFailure();
    } finally {
      fs.rmSync(temporary, { force: true });
      if (generation === epoch) inflight = false;
    }
  };
  void write();
  const timer = setInterval(() => { void write(); }, 5_000);
  timer.unref();
  return () => {
    clearInterval(timer);
    void write(true);
  };
}
