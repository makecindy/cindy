import { REMOTE_RESOURCE_INVOKE_CHANNEL, REMOTE_RESOURCE_MANIFEST_CHANNEL } from '@cindy/device-link';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { isRemoteResourcesUnsupported } from '@/device-link/remoteResources';
import {
  isBoundedPluginResponse, marketItemMatchesPlugin, parsePluginManagementDetail,
  parsePluginManagementReceipt, parsePluginManagementSnapshot, pluginApprovalToken,
  type ManagedMarketDetail, type ManagedPlugin,
} from './pluginManagementTypes';

/** Use DeviceLinkContext.invoke directly; preserve its final, synchronous queue fence. */
export type PluginManagementInvoke = <T = unknown>(deviceId: string, channel: string, args?: unknown[],
  options?: { preSend?: () => void; background?: boolean }) => Promise<T>;
export interface PluginManagementClientOptions {
  invoke: PluginManagementInvoke;
  deviceId: string;
  /** Target/view/connection fence, in addition to the built-in account-owner fence. */
  isCurrent?: () => boolean;
}
export type PluginManagementBegin = { operationId: string } & (
  | { kind: 'install'; detail: ManagedMarketDetail; installed?: ManagedPlugin }
  | { kind: 'uninstall' | 'enable' | 'disable'; installed: ManagedPlugin }
);
export class PluginManagementRequestError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) { super(message); }
}
export function pluginManagementErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error ? error.message : 'REQUEST_FAILED';
}
const descriptor = { protocolVersion: 1, primitives: ['status', 'markdown', 'action', 'form', 'list'] };
const validId = (id: string, max = 128) => typeof id === 'string' && id.length > 0 && id.length <= max && !id.includes('\0');
const localError = (code: string): never => { throw new PluginManagementRequestError(code); };
/** Input budget is UTF-8 bytes, matching the existing Host resource invoke contract. */
function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const char of value) { const code = char.codePointAt(0)!; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return bytes;
}
export function createPluginManagementClient(options: PluginManagementClientOptions) {
  const owner = getMobileAuthOwner();
  const isOwnerCurrent = () => !owner.switching && isMobileAuthOwnerCurrent(owner);
  const isCurrent = () => isOwnerCurrent() && (options.isCurrent?.() ?? true);
  async function call<T>(channel: string, payload: unknown, parse: (value: unknown) => T, mutation = false, guard?: () => boolean, cleanup = false): Promise<T> {
    const requestCurrent = () => (cleanup ? isOwnerCurrent() : isCurrent()) && (!guard || guard());
    const assertRequestCurrent = () => { if (!requestCurrent()) localError('PLUGIN_MANAGEMENT_STALE'); };
    assertRequestCurrent();
    try {
      const response = await options.invoke(options.deviceId, channel, [payload], { preSend: assertRequestCurrent });
      if (!requestCurrent()) throw new PluginManagementRequestError('PLUGIN_MANAGEMENT_STALE', mutation);
      if (!isBoundedPluginResponse(response)) throw new Error('INVALID_RESPONSE');
      return parse(response);
    } catch (error) {
      if (error instanceof PluginManagementRequestError) throw error;
      throw new PluginManagementRequestError(pluginManagementErrorCode(error), mutation);
    }
  }
  async function action<T>(name: string, input: Record<string, unknown>, parse: (value: unknown) => T, instance?: string, mutation = false, guard?: () => boolean, cleanup = false) {
    if (!isBoundedPluginResponse(input)) return localError('INVALID_INPUT');
    if (utf8Bytes(JSON.stringify(input)) > 64 * 1024) return localError('INPUT_TOO_LARGE');
    return call(REMOTE_RESOURCE_INVOKE_CHANNEL, {
      client: descriptor, collectionId: 'plugins', actionId: `management:${name}`, input,
      ...(instance ? { resourceRef: { collectionId: 'plugins', kind: 'plugin', id: instance } } : {}),
    }, (response) => {
      if (!response || typeof response !== 'object' || !('result' in response)) throw new Error('INVALID_RESPONSE');
      return parse(response.result);
    }, mutation, guard, cleanup);
  }
  const receiptAction = (name: string, operationId: string, input: Record<string, unknown> = {}, mutation = false, guard?: () => boolean, cleanup = false) => {
    if (!validId(operationId)) return localError('INVALID_INPUT');
    return action(name, { operationId, ...input }, (v) => parsePluginManagementReceipt(v, operationId), undefined, mutation, guard, cleanup);
  };
  return {
    deviceId: options.deviceId,
    isCurrent,
    async capability(): Promise<'supported' | 'unsupported'> {
      try {
        return await call(REMOTE_RESOURCE_MANIFEST_CHANNEL, { client: descriptor }, (value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_RESPONSE');
          const data = value as { collections?: Array<{ id?: string; actions?: Array<{ id?: string; disabled?: boolean }> }> };
          if (!Array.isArray(data.collections) || !data.collections.every((c) => c && typeof c.id === 'string'
            && (c.actions === undefined || (Array.isArray(c.actions) && c.actions.every((a) => a && typeof a.id === 'string'))))) throw new Error('INVALID_RESPONSE');
          return data.collections.some((c) => c.id === 'plugins' && c.actions?.some((a) => a.id === 'management:snapshot' && !a.disabled)) ? 'supported' : 'unsupported';
        });
      } catch (error) {
        if (isRemoteResourcesUnsupported(error)) return 'unsupported';
        throw error;
      }
    },
    snapshot: () => action('snapshot', {}, parsePluginManagementSnapshot),
    async detail(pluginId: string) {
      if (!validId(pluginId, 1024)) return localError('INVALID_INPUT');
      return action('market-detail', { pluginId }, (v) => {
        const detail = parsePluginManagementDetail(v);
        if (detail.pluginId !== pluginId) throw new Error('INVALID_RESPONSE');
        return detail;
      });
    },
    begin(request: PluginManagementBegin, guard?: () => boolean) {
      if (!validId(request.operationId)) return localError('INVALID_INPUT');
      const installed = request.installed;
      if (installed && !validId(installed.instanceKey, 1024)) return localError('INVALID_INPUT');
      const input: Record<string, unknown> = { operationId: request.operationId, kind: request.kind,
        ...(installed ? { expectedInstalledApproval: pluginApprovalToken(installed) } : {}) };
      if (request.kind === 'install') {
        const detail = parsePluginManagementDetail(request.detail);
        if (detail.installState === 'conflict' || (installed && !marketItemMatchesPlugin(detail, installed))
          || (!installed && detail.installState !== 'not-installed')) return localError('PLUGIN_INSTALL_CHANGED');
        input.pluginId = detail.pluginId;
        input.expectedReleaseId = detail.releaseId;
        if (detail.sourceType !== 'server') input.expectedManifest = detail.manifest;
      }
      return action('begin', input, (v) => parsePluginManagementReceipt(v, request.operationId), installed?.instanceKey, true, guard);
    },
    operation: (id: string) => receiptAction('operation', id),
    answer(id: string, requestId: string, confirmed: boolean, guard?: () => boolean) {
      if (!validId(requestId) || typeof confirmed !== 'boolean') return localError('INVALID_INPUT');
      return receiptAction('answer', id, { requestId, confirmed }, true, guard);
    },
    cancel: (id: string, guard?: () => boolean) => receiptAction('cancel', id, {}, true, guard),
    /** Controller teardown only: cancel the original Host operation after its view is gone. Owner fencing remains mandatory. */
    async cancelForCleanup(id: string) { return receiptAction('cancel', id, {}, true, undefined, true); },
  };
}
export type PluginManagementClient = ReturnType<typeof createPluginManagementClient>;
