export * from '@cindy/mcps/host/codexHttpBridge';
import { startCodexHttpBridge as startBridge, selectRemoteInjectableServerNames as selectNames, type StartCodexHttpBridgeOptions } from '@cindy/mcps/host/codexHttpBridge';
import { appServerIds } from '../mcp-apps/runtime.js';

export function startCodexHttpBridge(options: StartCodexHttpBridgeOptions) {
  return startBridge({ ...options, appServerIds });
}

export function selectRemoteInjectableServerNames(available: readonly string[], gates: Parameters<typeof selectNames>[1]): string[] {
  return selectNames(available, gates, appServerIds);
}
