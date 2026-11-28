// Shared fixtures of the mobile plugin-management tests (pluginManagement.test.ts and pluginManagementProgress.test.ts):
// one plugin (`plugin`, version 1) updated to `detail` (version 2) on an in-memory Host. Moved here unchanged so the
// model check can run in its own file within the per-file performance budget.
import { vi } from 'vitest';
import { createPluginManagementClient, type PluginManagementInvoke } from '@/plugins/pluginManagementClient';
import { createPluginManagementController } from '@/plugins/pluginManagementController';
import type { ManagedMarketDetail, ManagedPlugin, PluginManagementReceipt, PluginManagementSnapshot } from '@/plugins/pluginManagementTypes';

export const SLOT_WHO = { name: 'Demo', deviceId: 'host-1', deviceName: 'Host' };
/**
 * The leave-cancel as the product reaches it: only for the consent the confirmation sheet put on screen (dispatcher
 * L-2), so a test of the cancel's own mechanics first shows that consent, as the sheet does.
 */
export function shownCancel(c: { getState(): { receipt: { consent?: { requestId: string } } | null }; markConsentShown(id: string): void; cancel(): Promise<void> }) {
  const requestId = c.getState().receipt?.consent?.requestId;
  if (requestId) c.markConsentShown(requestId);
  return c.cancel();
}

export const manifest = { schemaVersion: 3 as const, id: 'demo', name: 'Demo', version: '2', kind: 'chip' };
export const plugin: ManagedPlugin = { instanceKey: '_root__demo', namespace: null, manifest: { ...manifest, version: '1' },
  enabled: true, approval: { state: 'approved', revision: '12345678-1234-4123-8123-123456789abc' } };
export const detail: ManagedMarketDetail = { pluginId: 'market/demo', ghostId: 'demo', namespace: null, name: 'Demo',
  description: null, author: null, scope: 'public', organizationId: null, defaultInstall: false,
  releaseId: 'release-2', version: '2', publishedAt: '', icon: null, installState: 'update-available',
  enabled: true, sourceType: 'server', sourceMarketName: null, manifest };
export const snapshot = (ghosts: ManagedPlugin[] = [plugin]): PluginManagementSnapshot => ({ version: 1, ghosts,
  market: { items: [detail], unavailableReason: null, customSourceNames: [], unavailableCustomSourceNames: [] } });
export const receipt = (phase: PluginManagementReceipt['phase'] = 'running'): PluginManagementReceipt => ({ operationId: 'operation-1', phase });
/**
 * The consent the Host asks for when this file's usual operation (updating `plugin` 1 → 2 to `detail`) stops at one: an
 * update's facts (dispatcher O-4: a consent may be allowed only when it declares what was chosen).
 */
export const confirmation = (): PluginManagementReceipt => ({ ...receipt('confirmation'), consent: { requestId: 'consent-1',
  initiator: 'user', origin: 'market', facts: { kind: 'update', ghostId: 'demo', name: 'Demo', version: '2', previousVersion: '1',
    added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
/**
 * A page approval's consent for `plugin` as the computer asks it (its installed version, purpose ui-capability): the Host
 * names the instance key as `facts.ghostId` (`requestPluginUiApproval`; its test `remotePluginManagement.test.ts`).
 */
export const uiConfirmation = (): PluginManagementReceipt => ({ ...receipt('confirmation'), consent: { requestId: 'consent-1',
  initiator: 'user', origin: 'local-file', purpose: 'ui-capability', facts: { kind: 'update', ghostId: '_root__demo', name: 'Demo',
    version: '1', previousVersion: '1', added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: false } } });
export const capability = { protocolVersion: 1, collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot', label: 'Manage' }] }] };
/** Like vi.waitFor, without its 50 ms polling: retries the assertion while promises settle (file performance budget). */
export async function eventually(assertion: () => void) {
  let last: unknown;
  for (let i = 0; i < 400; i++) {
    try { assertion(); return; } catch (error) { last = error; }
    await (i < 300 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, 0)));
  }
  throw last;
}
export function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
export type Envelope = { actionId: string; input: Record<string, unknown>; resourceRef?: { id: string } };
export function host(handler?: (request: Envelope) => unknown | Promise<unknown>, marketDetail: ManagedMarketDetail = detail) {
  const requests: Envelope[] = [];
  let facts = snapshot();
  const invoke = vi.fn(async (_id: string, channel: string, args?: unknown[], options?: { preSend?: () => void; onRequestWritten?: () => void; onNotSent?: () => void }) => {
    options?.preSend?.();
    // Like the transport: the request is written once its last check passed; a handler that throws lost the reply.
    options?.onRequestWritten?.();
    if (channel.endsWith(':manifest')) return capability;
    const request = args?.[0] as Envelope;
    requests.push(request);
    let result;
    if (request.actionId === 'management:snapshot') result = facts;
    else if (request.actionId === 'management:market-detail') result = marketDetail;
    else result = handler ? await handler(request) : receipt();
    return { effects: [], result };
  }) as unknown as PluginManagementInvoke;
  const client = createPluginManagementClient({ deviceId: 'host-1', invoke });
  return { invoke, requests, client, setFacts: (next: PluginManagementSnapshot) => { facts = next; } };
}
export const controllers: Array<ReturnType<typeof createPluginManagementController>> = [];
export function controller(client: ReturnType<typeof createPluginManagementClient>) {
  const value = createPluginManagementController(client, { createOperationId: () => 'operation-1' });
  controllers.push(value); return value;
}
