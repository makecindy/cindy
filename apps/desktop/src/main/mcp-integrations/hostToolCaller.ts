import { AsyncLocalStorage } from 'node:async_hooks';
import type { HostToolCaller, HostToolRuntime, LiziMcpProvider, LiziMcpSessionContext, ToolCallAuthorizer } from '@cindy/mcps';
import { admitPluginTaskAction, runTaskActionRequest } from '../maker-ipc/taskActionAuthorization.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import type { ScheduleMutationGuard } from '@cindy/maker-scheduler';
import { HostServiceCatalog } from '../cindy-brain/hostServiceCatalog.js';
import { getGhostSetupChangeBus } from '../cindy-brain/ghostSetupChangeBus.js';

/** Attested by the plugin gateway, never reconstructed from tool arguments. */
export interface PluginHostToolCaller {
  caller: Extract<HostToolCaller, { kind: 'plugin' }>;
  server: string;
  tool: string;
  argsJson: string;
  /** Existing scheduler execution precondition, valid only for this invocation. */
  scheduleGuard?: ScheduleMutationGuard;
  /** Revalidates owner, installed revision, group and per-call confirmation. */
  assertCurrent(): void;
  /** Accepted queued delivery checks the same installation without retaining its source runtime. */
  assertDeliveryCurrent?(): void;
}

const callerScope = new AsyncLocalStorage<PluginHostToolCaller>();
let activeCallers = 0;
let providers: readonly LiziMcpProvider[] = [];
let providerOwner: DataOwnerPushStamp | null = null;
export const hostServiceCatalog = new HostServiceCatalog();
// Computer element/snapshot references survive individual calls, scoped to the plugin.
const computerRuntimes = new Map<string, { runtime: HostToolRuntime; revision: string }>();

/** Roster updates must not build an approval projection for an unused service. */
export function hasPluginHostTools(): boolean { return computerRuntimes.size > 0; }

export function disposePluginHostTools(id: string): void {
  const entry = computerRuntimes.get(id);
  computerRuntimes.delete(id);
  void entry?.runtime.close().catch(() => {});
}

export function reconcilePluginHostTools(revisions: ReadonlyMap<string, string>): void {
  for (const [id, entry] of computerRuntimes) {
    if (revisions.get(id) !== entry.revision) disposePluginHostTools(id);
  }
}

export function setHostToolProviders(current: readonly LiziMcpProvider[], owner: DataOwnerPushStamp): void {
  if (providerOwner?.dataOwnerId !== owner.dataOwnerId || providerOwner.ownerGeneration !== owner.ownerGeneration) {
    for (const id of computerRuntimes.keys()) disposePluginHostTools(id);
  }
  providers = current;
  providerOwner = owner;
  if (hostServiceCatalog.replace(current)) getGhostSetupChangeBus().emitAll({ source: 'host_config', ref: 'host-services' });
}

/** The existing stable-owner commit hook may retain a live Maker after recovery. */
export function refreshHostToolProviderOwner(owner: DataOwnerPushStamp): void {
  if (providerOwner && owner.dataOwnerId !== null && providerOwner.dataOwnerId === owner.dataOwnerId &&
    owner.ownerGeneration > providerOwner.ownerGeneration) {
    providerOwner = owner;
  }
}

export function getPluginHostToolCaller(): PluginHostToolCaller | undefined {
  const caller = callerScope.getStore();
  caller?.assertCurrent();
  return caller;
}

export async function runPluginHostToolCall<T>(caller: PluginHostToolCaller, operation: () => Promise<T>): Promise<T> {
  activeCallers++;
  try {
    return await runTaskActionRequest(() => callerScope.run(caller, async () => {
      caller.assertCurrent();
      const result = await operation();
      caller.assertCurrent();
      return result;
    }));
  } finally { if (--activeCallers === 0) callerScope.disable(); }
}

/** The common authorizer accepts only the exact invocation admitted by the gateway. */
export const authorizePluginHostToolCall: ToolCallAuthorizer = async call => {
  const current = getPluginHostToolCaller();
  const caller = call.caller;
  if (!current || caller?.kind !== 'plugin' || call.sessionId !== undefined ||
    caller.pluginId !== current.caller.pluginId || caller.dataOwnerId !== current.caller.dataOwnerId ||
    caller.ownerGeneration !== current.caller.ownerGeneration || call.server !== current.server ||
    call.tool !== current.tool || JSON.stringify(call.args) !== current.argsJson) {
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Plugin invocation has no current Host approval.' };
  }
  const admission = admitPluginTaskAction(call, current.assertCurrent, current.assertDeliveryCurrent);
  return admission.ok ? { ok: true, run: operation =>
    runPluginHostToolCall(current, () => admission.run!(operation)) } : admission;
};

/** Same providers and injected Host services as ordinary Agent tasks. */
export function createHostToolRuntime(server: string, caller: Extract<HostToolCaller, { kind: 'plugin' }>, workingDir = '', revision = '') {
  if (!providerOwner || providerOwner.dataOwnerId !== caller.dataOwnerId || providerOwner.ownerGeneration !== caller.ownerGeneration) return null;
  const context = pluginContext(caller, workingDir);
  const provider = providers.find(item => item.name === server && item.toHostTools);
  if (!provider?.toHostTools || provider.isEnabled?.(context) === false) {
    if (server === 'cindy_computer') disposePluginHostTools(caller.pluginId);
    return null;
  }
  if (server !== 'cindy_computer') return provider.toHostTools(context);
  let entry = computerRuntimes.get(caller.pluginId);
  if (entry && entry.revision !== revision) { disposePluginHostTools(caller.pluginId); entry = undefined; }
  if (!entry) {
    entry = { runtime: provider.toHostTools(context), revision };
    computerRuntimes.set(caller.pluginId, entry);
  }
  const { runtime } = entry;
  // The original runtime owns observations until plugin stop/account switch.
  return { describe: runtime.describe, call: runtime.call, close: async () => {} };
}

function pluginContext(caller: Extract<HostToolCaller, { kind: 'plugin' }>, workingDir: string): LiziMcpSessionContext {
  const context: LiziMcpSessionContext = { agentKind: 'claude-code', workingDir, hostCaller: caller };
  context.getSessionContext = () => context;
  return context;
}

/** Node Host and Desktop bind the same provider to an attested plugin caller. */
export function createProviderHostToolRuntime(current: readonly LiziMcpProvider[], server: string,
  caller: Extract<HostToolCaller, { kind: 'plugin' }>) {
  const provider = current.find(item => item.name === server && item.toHostTools);
  if (!provider?.toHostTools) return null;
  const context = pluginContext(caller, '');
  // An explicit accessor prevents a nested Agent tool call's ambient ALS from being inherited.
  if (provider.isEnabled?.(context) === false) return null;
  return provider.toHostTools(context);
}
