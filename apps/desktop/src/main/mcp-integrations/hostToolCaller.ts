import { AsyncLocalStorage } from 'node:async_hooks';
import type { HostToolCaller, LiziMcpProvider, LiziMcpSessionContext, ToolCallAuthorizer } from '@cindy/mcps';
import { admitPluginTaskAction, runTaskActionRequest } from '../maker-ipc/taskActionAuthorization.js';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';

/** Attested by the plugin gateway, never reconstructed from tool arguments. */
export interface PluginHostToolCaller {
  caller: Extract<HostToolCaller, { kind: 'plugin' }>;
  server: string;
  tool: string;
  argsJson: string;
  /** Revalidates owner, installed revision, group and per-call confirmation. */
  assertCurrent(): void;
}

const callerScope = new AsyncLocalStorage<PluginHostToolCaller>();
let providers: readonly LiziMcpProvider[] = [];
let providerOwner: DataOwnerPushStamp | null = null;

export function setHostToolProviders(current: readonly LiziMcpProvider[], owner: DataOwnerPushStamp): void {
  providers = current;
  providerOwner = owner;
}

export function getPluginHostToolCaller(): PluginHostToolCaller | undefined {
  const caller = callerScope.getStore();
  caller?.assertCurrent();
  return caller;
}

export function runPluginHostToolCall<T>(caller: PluginHostToolCaller, operation: () => Promise<T>): Promise<T> {
  return runTaskActionRequest(() => callerScope.run(caller, async () => {
    caller.assertCurrent();
    const result = await operation();
    caller.assertCurrent();
    return result;
  }));
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
  const admission = admitPluginTaskAction(call, current.assertCurrent);
  return admission.ok ? { ok: true, run: operation =>
    runPluginHostToolCall(current, () => admission.run!(operation)) } : admission;
};

/** Same providers and injected Host services as ordinary Agent tasks. */
export function createHostToolRuntime(server: string, caller: Extract<HostToolCaller, { kind: 'plugin' }>) {
  if (!providerOwner || providerOwner.dataOwnerId !== caller.dataOwnerId || providerOwner.ownerGeneration !== caller.ownerGeneration) return null;
  const provider = providers.find(item => item.name === server && item.toHostTools);
  if (!provider?.toHostTools) return null;
  const context: LiziMcpSessionContext = {
    agentKind: 'claude-code', workingDir: '', hostCaller: caller,
  };
  // An explicit accessor prevents a nested Agent tool call's ambient ALS from being inherited.
  context.getSessionContext = () => context;
  return provider.toHostTools(context);
}
