/**
 * The host functions the usage write and broadcast cores take from the process they run in
 * (sessionSpendBroadcasterCore.ts, usageBroadcasterCore.ts, turnCostBroadcasterCore.ts,
 * modelMismatchBroadcasterCore.ts). Electron-free, so the Node Host loads the same cores.
 *
 * Each port has the name and the signature of the import it replaces, so the cores' code is the
 * desktop's unchanged. On the desktop each wrapper (sessionSpendBroadcaster.ts, usageBroadcaster.ts,
 * turnCostBroadcaster.ts, modelMismatchBroadcaster.ts) binds the ports its own core uses, from the
 * imports the module had before, so its import graph is the one it had. Unbound (the Node Host):
 * there are no windows to broadcast to, and the desktop-only defaults (the message patches, the
 * durable write queue, the gateway prices) reject, so a caller has to pass its own dependencies.
 */
import type { MessageAgentMetaPatchResult } from './localDb/messageMutations.js';
import type { ModelPricingMap } from './usage/modelPricingCore.js';
import type { RegionalMoney } from '../shared/regionalMoney.js';

export type { MessageAgentMetaPatchResult };

/** What the cores use of a renderer window. */
export interface UsageBroadcastWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void };
}

export interface UsageBroadcastPorts {
  getAllWindows(): readonly UsageBroadcastWindow[];
  isTrustedAppRendererWindow(win: UsageBroadcastWindow): boolean;
  patchMessageAgentMeta(sessionId: string, clientId: string, patch: Record<string, unknown>): Promise<boolean>;
  patchMessageAgentMetaWithResult(
    sessionId: string,
    clientId: string,
    patch: Record<string, unknown>,
  ): Promise<MessageAgentMetaPatchResult | null>;
  readPriorUserRoundCost(sessionId: string, assistantClientId: string): Promise<{
    additionalCosts?: RegionalMoney[];
    money: RegionalMoney | null;
    costUsd: number;
    hasEstimatedValue: boolean;
    isFirstUserRound?: boolean;
  }>;
  enqueueDurableWrite<T>(label: string, fn: (ownerScope: unknown) => Promise<T> | T): Promise<T>;
  getGatewayModelPricing(): Promise<ModelPricingMap | null>;
}

const unbound = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} is not bound in this process; pass the dependency explicitly`));

let ports: UsageBroadcastPorts = {
  getAllWindows: () => [],
  isTrustedAppRendererWindow: () => false,
  patchMessageAgentMeta: unbound('patchMessageAgentMeta'),
  patchMessageAgentMetaWithResult: unbound('patchMessageAgentMetaWithResult'),
  readPriorUserRoundCost: unbound('readPriorUserRoundCost'),
  enqueueDurableWrite: unbound('enqueueDurableWrite'),
  getGatewayModelPricing: unbound('getGatewayModelPricing'),
};

/** Bind some of the ports (each desktop wrapper binds the ones its core uses). */
export function bindUsageBroadcastPorts(next: Partial<UsageBroadcastPorts>): void {
  ports = { ...ports, ...next };
}

/** In place of Electron's BrowserWindow: the windows to broadcast to. */
export const BrowserWindow = {
  getAllWindows: (): readonly UsageBroadcastWindow[] => ports.getAllWindows(),
};

export function isTrustedAppRendererWindow(win: UsageBroadcastWindow): boolean {
  return ports.isTrustedAppRendererWindow(win);
}

export function patchMessageAgentMeta(sessionId: string, clientId: string, patch: Record<string, unknown>): Promise<boolean> {
  return ports.patchMessageAgentMeta(sessionId, clientId, patch);
}

export function patchMessageAgentMetaWithResult(
  sessionId: string,
  clientId: string,
  patch: Record<string, unknown>,
): Promise<MessageAgentMetaPatchResult | null> {
  return ports.patchMessageAgentMetaWithResult(sessionId, clientId, patch);
}

export function readPriorUserRoundCost(
  sessionId: string,
  assistantClientId: string,
): ReturnType<UsageBroadcastPorts['readPriorUserRoundCost']> {
  return ports.readPriorUserRoundCost(sessionId, assistantClientId);
}

export function enqueueDurableWrite<T>(label: string, fn: (ownerScope: unknown) => Promise<T> | T): Promise<T> {
  return ports.enqueueDurableWrite(label, fn);
}

export function getGatewayModelPricing(): Promise<ModelPricingMap | null> {
  return ports.getGatewayModelPricing();
}
