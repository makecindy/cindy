/**
 * hermesBridgeSession — maps one Cindy Hermes session to a bridge identity.
 *
 * Same trust model as Pi (piEnvironment.ts): the bridge resolves tool-call
 * identity from a registered session ctx plus a per-session bearer token, never
 * from tool arguments. Differences for Hermes: the shim is spawned by Hermes
 * from a static config.yaml entry, so the token reaches it through the 0600
 * runtime file (hermesBridgeRuntimeFile.ts) and only the non-secret session id
 * rides the per-turn env.
 */

import { createHmac, randomBytes } from 'node:crypto';

import type { LiziMcpSessionContext } from '@cindy/mcps';

import type { CodexHttpBridge } from './codexHttpBridge.js';
import { removeHermesBridgeSession, upsertHermesBridgeSession } from './hermesBridgeRuntimeFile.js';

/** Env var config.yaml references as `${CINDY_BRIDGE_SESSION}` for the shim. */
export const HERMES_BRIDGE_SESSION_ENV = 'CINDY_BRIDGE_SESSION';

// Process-level key: tokens are stable per session within one app run and change
// on restart. HMAC is one-way, so one leaked token cannot forge another session's.
const HERMES_BRIDGE_SESSION_KEY = randomBytes(32);

type BridgeIdentityApi = Pick<
  CodexHttpBridge,
  | 'port'
  | 'instanceId'
  | 'registerSessionCtx'
  | 'unregisterSessionCtx'
  | 'registerSessionToken'
  | 'unregisterSessionToken'
>;

export interface RegisterHermesBridgeSessionOptions {
  bridge: BridgeIdentityApi;
  runtimeFile: string;
  info: { sessionId: string; sessionInstanceId?: string; workingDir: string };
  /** Frozen per-project tool policy (CODEX_*_BUILTIN_PLUGIN_IDS_KEY); wired by the host. */
  vendorOptions?: Record<string, unknown>;
  memoryScopeKey?: string;
}

export interface HermesBridgeSession {
  env: Record<string, string>;
  dispose: () => void;
  /** Runtime vendorOptions patch (Orca start_team/end_team, ROADMAP 3.7a). */
  setVendorOptions?: (patch: Record<string, unknown>) => void;
}

export function deriveHermesBridgeSessionToken(sessionId: string): string {
  return createHmac('sha256', HERMES_BRIDGE_SESSION_KEY).update(sessionId).digest('hex');
}

export async function registerHermesBridgeSession(
  opts: RegisterHermesBridgeSessionOptions,
): Promise<HermesBridgeSession> {
  const { bridge, runtimeFile, info } = opts;
  const ctx: LiziMcpSessionContext = {
    agentKind: 'hermes',
    sessionId: info.sessionId,
    ...(info.sessionInstanceId ? { sessionInstanceId: info.sessionInstanceId } : {}),
    workingDir: info.workingDir,
    ...(opts.memoryScopeKey ? { memoryScopeKey: opts.memoryScopeKey } : {}),
    vendorOptions: opts.vendorOptions ?? {},
    mcpCallerKind: 'root',
    mcpCallerAttested: true,
  };
  const token = deriveHermesBridgeSessionToken(info.sessionId);

  // Register before the file entry exists: the shim can only authenticate once
  // both sides are in place, and a half-registered session must never linger.
  bridge.registerSessionCtx(info.sessionId, ctx);
  let generation: number | undefined;
  try {
    generation = bridge.registerSessionToken(info.sessionId, token);
    await upsertHermesBridgeSession(
      runtimeFile,
      { port: bridge.port, instanceId: bridge.instanceId },
      info.sessionId,
      token,
    );
  } catch (error) {
    bridge.unregisterSessionToken(info.sessionId, token, generation);
    bridge.unregisterSessionCtx(info.sessionId, ctx);
    throw error;
  }

  let disposed = false;
  return {
    env: { [HERMES_BRIDGE_SESSION_ENV]: info.sessionId },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      // expectedCtx / expectedToken / generation keep a late dispose from
      // removing a newer registration of the same session id.
      bridge.unregisterSessionCtx(info.sessionId, ctx);
      bridge.unregisterSessionToken(info.sessionId, token, generation);
      void removeHermesBridgeSession(runtimeFile, info.sessionId).catch(() => undefined);
    },
  };
}
