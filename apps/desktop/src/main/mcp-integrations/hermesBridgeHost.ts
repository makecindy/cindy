/**
 * hermesBridgeHost — main-process wiring for Cindy tools inside Hermes (1.5b-3).
 *
 * Per Hermes turn: lease the shared local bridge (piEnvironment), freeze the
 * per-project tool policy into the session ctx's vendorOptions (same keys and
 * semantics as Pi), and register the session identity + token
 * (hermesBridgeSession). The stdio shim (cindy-tools `hermes-bridge-shim`) is
 * registered in Hermes' config.yaml per exposed server with a STATIC command;
 * only the non-secret session id rides the per-session env.
 *
 * Exposure is fail-closed: only SAFE servers are registered by default; GATED
 * servers (can act on the machine or on remote hosts) need an explicit opt-in.
 */

import os from 'node:os';
import path from 'node:path';

import type { Logger, McpProvider } from '@cindy/maker-core';

import {
  CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY,
  CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY,
} from './codexBuiltinToolPolicy.js';
import { clearHermesBridgeRuntimeFile } from './hermesBridgeRuntimeFile.js';
import {
  HERMES_BRIDGE_SESSION_ENV,
  registerHermesBridgeSession,
  type HermesBridgeSession,
} from './hermesBridgeSession.js';
import { acquireCindyToolBridge } from './piEnvironment.js';
import { pluginIdForKnownProviderName } from '../maker-host/plugins/builtin-plugins.js';
import { RUNTIME_MCP_NAMES_KEY } from '../maker-host/agentCapabilityCatalog.js';
import { createPluginRegistry } from '../maker-host/plugins/index.js';

/** Read-mostly document tools. Exposed by default. */
export const HERMES_BRIDGE_SAFE_SERVERS: readonly string[] = ['cindy_docs'];
/**
 * Drive a browser, the desktop, or SSH hosts. Hermes' own approval hook is not
 * wired yet (protocol "reserved M3"), so these stay off unless opted in.
 */
export const HERMES_BRIDGE_GATED_SERVERS: readonly string[] = [
  'cindy_browser',
  'cindy_computer',
  'cindy_ssh',
];

/**
 * Orca team tools (start_team, create_worker, send_to_worker, ...). Exposed only while
 * collaboration is enabled (or the session is already a team member), same gate as Pi
 * (piEnvironment.ts). ADR 0006, ROADMAP 3.7a. Creation and permission escalation stay
 * checked by the Orca host handlers.
 */
export const HERMES_BRIDGE_COLLAB_SERVERS: readonly string[] = ['cindy_orca'];

/** Marker used to recognise (and only ever touch) shim entries we wrote. */
const SHIM_BUNDLE_BASENAME = 'hermes-bridge-shim.mjs';

export function defaultHermesBridgeRuntimeFile(): string {
  return path.join(os.homedir(), '.cindy-harness', 'hermes-bridge.json');
}

/** Servers Hermes may see: allow-listed, actually running, and (if gated) opted in. */
export function selectHermesBridgeServers(
  available: readonly string[],
  optedInGated: ReadonlySet<string> = new Set(),
  collabEnabled = false,
): string[] {
  const running = new Set(available);
  return [
    ...HERMES_BRIDGE_SAFE_SERVERS,
    ...HERMES_BRIDGE_GATED_SERVERS.filter((name) => optedInGated.has(name)),
    ...(collabEnabled ? HERMES_BRIDGE_COLLAB_SERVERS : []),
  ].filter((name) => running.has(name));
}

/**
 * Same rule as Pi: collaboration on globally, or the session is already a team member
 * (the global switch only affects new teams), and never when the project disabled it.
 */
export function isHermesCollabEnabled(
  vendorOptions: Record<string, unknown> | undefined,
  disabledPluginIds: readonly string[],
  globalCollabEnabled: boolean,
): boolean {
  const role = vendorOptions?.orcaRole;
  const activeTeamMember = role === 'lead' || role === 'worker';
  return (globalCollabEnabled || activeTeamMember) && !disabledPluginIds.includes('collab');
}

export interface HermesShimServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Static: no per-session or secret value; the session id is a `${VAR}` reference. */
export function buildHermesShimServerConfig(
  shimPath: string,
  server: string,
): HermesShimServerConfig {
  return {
    command: 'node',
    args: [shimPath, '--server', server],
    env: { [HERMES_BRIDGE_SESSION_ENV]: `\${${HERMES_BRIDGE_SESSION_ENV}}` },
  };
}

function isOurShimEntry(entry: { args?: string[] } | undefined): boolean {
  return !!entry?.args?.some((arg) => path.basename(arg) === SHIM_BUNDLE_BASENAME);
}

export interface HermesShimRegistrationDeps {
  listServers: () => Promise<
    Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
  >;
  setServer: (name: string, server: HermesShimServerConfig) => Promise<unknown>;
  removeServer: (name: string) => Promise<unknown>;
}

/**
 * Make config.yaml's shim entries match `exposed`: write missing/different ones,
 * remove our own entries for servers that are no longer exposed. Entries the
 * user wrote (not pointing at our bundle) are never modified or removed.
 */
export async function syncHermesShimRegistrations(
  deps: HermesShimRegistrationDeps,
  shimPath: string,
  exposed: readonly string[],
): Promise<{ written: string[]; removed: string[] }> {
  const current = await deps.listServers();
  const written: string[] = [];
  const removed: string[] = [];
  for (const name of exposed) {
    const want = buildHermesShimServerConfig(shimPath, name);
    const have = current[name];
    if (have && !isOurShimEntry(have)) continue; // user-owned name: leave alone
    if (
      have &&
      JSON.stringify([have.command, have.args, have.env]) ===
        JSON.stringify([want.command, want.args, want.env])
    ) {
      continue;
    }
    await deps.setServer(name, want);
    written.push(name);
  }
  for (const name of [...HERMES_BRIDGE_SAFE_SERVERS, ...HERMES_BRIDGE_GATED_SERVERS, ...HERMES_BRIDGE_COLLAB_SERVERS]) {
    if (exposed.includes(name)) continue;
    if (isOurShimEntry(current[name])) {
      await deps.removeServer(name);
      removed.push(name);
    }
  }
  return { written, removed };
}

export interface HermesBridgeHostDeps {
  providers: () => McpProvider[];
  logger: Logger;
  runtimeFile?: string;
  /** Gated servers the owner has opted into; empty (default) exposes only SAFE ones. */
  optedInGatedServers?: () => ReadonlySet<string>;
  /** Global collaboration switch (Settings); production: plugin registry `collab`. */
  globalCollabEnabled?: () => boolean;
  /** Null when the bundle is not built/shipped → Hermes runs without Cindy tools. */
  resolveShimPath: () => string | null;
  registration: HermesShimRegistrationDeps;
}

type PrepareInfo = {
  sessionId: string;
  sessionInstanceId?: string;
  workingDir: string;
  permissionMode?: string;
  /** Session vendorOptions at start (Orca role when resuming a lead/worker). */
  vendorOptions?: Record<string, unknown>;
};

/**
 * Hermes' `--safe-mode` (every mode but full access) disables MCP, so only a
 * `bypassPermissions` (`--yolo`) run can reach the shim. Owner decision, 1.5b-5d.
 */
export const HERMES_BRIDGE_PERMISSION_MODE = 'bypassPermissions';

/** Builds the `AgentDeps.prepareHermesBridgeSession` hook. */
export function createHermesBridgePreparer(deps: HermesBridgeHostDeps) {
  const runtimeFile = deps.runtimeFile ?? defaultHermesBridgeRuntimeFile();
  const log = deps.logger.child('hermes-bridge-host');
  // The file survives a crashed run with a dead port and old tokens: wipe it
  // once per process, before this run's first entry.
  let startupClear: Promise<void> | null = null;

  return async (info: PrepareInfo): Promise<HermesBridgeSession | null> => {
    if (info.permissionMode !== HERMES_BRIDGE_PERMISSION_MODE) return null;
    const shimPath = deps.resolveShimPath();
    if (!shimPath) {
      log.warn('hermes bridge shim bundle not found; Hermes runs without Cindy tools');
      return null;
    }
    const lease = await acquireCindyToolBridge(deps.providers(), log);
    if (!lease) return null;
    try {
      const registry = createPluginRegistry();
      const disabledPluginIds = registry.getDisabledRuntimePluginIds(info.workingDir);
      const exposed = selectHermesBridgeServers(
        lease.serverNames,
        deps.optedInGatedServers?.() ?? new Set(),
        isHermesCollabEnabled(
          info.vendorOptions,
          disabledPluginIds,
          deps.globalCollabEnabled?.() ?? registry.isEnabled('collab'),
        ),
      );
      await syncHermesShimRegistrations(deps.registration, shimPath, exposed);

      // Freeze the per-project policy now (Pi does the same): later Settings
      // changes do not affect this running session; the bridge re-checks it on
      // every tools/call against this frozen snapshot. The session's own Orca
      // identity (orcaRole, team ids) rides along and is updated in place by
      // setVendorOptions below (ROADMAP 3.7a), as Pi does.
      const vendorOptions: Record<string, unknown> = {
        ...(info.vendorOptions ?? {}),
        [CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY]: disabledPluginIds,
      };
      // Servers the bridge mounts for this session: the same descriptor Pi
      // records, so a route for a non-exposed server answers "not mounted".
      vendorOptions[RUNTIME_MCP_NAMES_KEY] = [...exposed];
      // The bridge's per-call gate checks plugin ids (not server names): allow
      // only the exposed servers' plugins, so a gated plugin stays blocked even
      // if something else reaches its route with this session's token.
      vendorOptions[CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY] = exposed.flatMap((name) => {
        const pluginId = pluginIdForKnownProviderName(name);
        return pluginId ? [pluginId] : [];
      });

      startupClear ??= clearHermesBridgeRuntimeFile(runtimeFile);
      await startupClear;
      const session = await registerHermesBridgeSession({
        bridge: lease.bridge,
        runtimeFile,
        info,
        vendorOptions,
      });
      const frozenPolicyKeys = new Set([
        CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY,
        CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY,
        RUNTIME_MCP_NAMES_KEY,
      ]);
      return {
        env: session.env,
        dispose: () => {
          session.dispose();
          lease.release();
        },
        // Same object the bridge holds for this session's tool calls: an Orca
        // start_team takes effect on the next call. The frozen tool policy cannot be
        // patched from here.
        setVendorOptions: (patch: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(patch)) {
            if (frozenPolicyKeys.has(key)) continue;
            if (value === null || value === undefined) delete vendorOptions[key];
            else vendorOptions[key] = value;
          }
        },
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  };
}

/** App quit / bridge shutdown: the file's port and tokens are dead. */
export function clearHermesBridgeRuntimeFileOnShutdown(
  runtimeFile: string = defaultHermesBridgeRuntimeFile(),
): Promise<void> {
  return clearHermesBridgeRuntimeFile(runtimeFile);
}
