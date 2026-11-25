import { PROVIDER_SHARE_GROUP_STATUS_REQUEST, scrubSharedProviderCatalog, type InvokeResultPayload } from '@cindy/device-link';
import { CONTROLLED_MODEL_CATALOG_RETRY_SHARE, MODEL_CATALOG_READ_CHANNELS, type ControlledModelLocation } from '../../shared/controlledModelCatalog.js';
import { extractIpcError } from '../../shared/ipcError.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import { PLUGIN_ENGINES_INVOKE, parseOfferedPluginEngines, pluginEngineKeyFromProviderId } from '../../shared/pluginEngines.js';
import { isProviderShareAgentDeviceId, providerShareIdOfAgentDeviceId } from '../../shared/providerShare.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * Plugin engine list of a source, read through the task computer like its model catalog
 * (plugin-harnesses.md). Kept apart from MODEL_CATALOG_READ_CHANNELS: the provider metadata
 * snapshot path does not cover plugin engines.
 */
const PLUGIN_ENGINE_LIST = PLUGIN_ENGINES_INVOKE.LIST;

/**
 * The source read must settle before the controller's own 30s request does, so the controller
 * receives this computer's answer (a temporary failure) instead of timing out itself.
 */
export const CONTROLLED_SOURCE_READ_TIMEOUT_MS = 20_000;

/**
 * Temporary source failures keep their temporary meaning across the extra hop. Reporting them as
 * PRECONDITION_FAILED made Desktop and Mobile pickers drop a share's catalog (and stop retrying)
 * every time the sharer's computer was briefly slow or offline.
 */
const TEMPORARY_SOURCE_FAILURES: Readonly<Record<string, IpcErrorCode>> = {
  TIMEOUT: 'DEVICE_LINK_TIMEOUT', INVOKE_TIMEOUT: 'DEVICE_LINK_TIMEOUT', DEVICE_LINK_TIMEOUT: 'DEVICE_LINK_TIMEOUT',
  DEVICE_OFFLINE: 'DEVICE_LINK_DEVICE_OFFLINE', DEVICE_LINK_DEVICE_OFFLINE: 'DEVICE_LINK_DEVICE_OFFLINE',
  NOT_CONNECTED: 'DEVICE_LINK_NOT_CONNECTED', DEVICE_LINK_NOT_CONNECTED: 'DEVICE_LINK_NOT_CONNECTED',
  LINK_CLOSED: 'DEVICE_LINK_NOT_CONNECTED', LINK_NOT_OPEN: 'DEVICE_LINK_NOT_CONNECTED',
  PEER_RESET: 'DEVICE_LINK_NOT_CONNECTED', NETWORK_ERROR: 'DEVICE_LINK_NOT_CONNECTED',
  BACKPRESSURE: 'DEVICE_LINK_BUSY', RATE_LIMITED: 'DEVICE_LINK_BUSY', SERVICE_UNAVAILABLE: 'DEVICE_LINK_BUSY',
  DEVICE_LINK_BUSY: 'DEVICE_LINK_BUSY',
  DEVICE_UNRESPONSIVE: 'DEVICE_LINK_DEVICE_UNRESPONSIVE', DEVICE_LINK_DEVICE_UNRESPONSIVE: 'DEVICE_LINK_DEVICE_UNRESPONSIVE',
};

function temporarySourceFailure(code: unknown, message: unknown): IpcErrorCode | undefined {
  const fromMessage = typeof message === 'string' ? /^\[([A-Z_]+)\]/.exec(message)?.[1] : undefined;
  const key = typeof code === 'string' && code !== 'IPC_ERROR' ? code : fromMessage;
  return key ? TEMPORARY_SOURCE_FAILURES[key] : undefined;
}

export interface ControlledModelCatalogDeps {
  assertCaller(): void;
  captureOwner(): () => void;
  retryShareDirectory(agentDeviceId: string): Promise<{ receivedChangeSequence?: number }>;
  locations(): Promise<{ status: 'complete' | 'degraded'; locations: ControlledModelLocation[] }>;
  invoke(deviceId: string, channel: string, args: unknown[], assertOwner: () => void): Promise<InvokeResultPayload>;
}

/** B supplies both the locations and their catalogs; A's received shares are irrelevant. */
export function createControlledModelCatalogReader(deps: ControlledModelCatalogDeps) {
  return async (raw: unknown): Promise<unknown> => {
    deps.assertCaller();
    const assertOwner = deps.captureOwner();
    assertOwner();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throwIpcError('INVALID_PARAMS', 'Model catalog request required');
    }
    const request = raw as Record<string, unknown>;
    if (request.op === 'locations') {
      const snapshot = await deps.locations();
      assertOwner();
      return snapshot;
    }
    if (request.op === CONTROLLED_MODEL_CATALOG_RETRY_SHARE) {
      const deviceId = request.agentDeviceId;
      if (typeof deviceId !== 'string' || !providerShareIdOfAgentDeviceId(deviceId)
        || Object.keys(request).some(key => key !== 'op' && key !== 'agentDeviceId')) {
        throwIpcError('INVALID_PARAMS', 'Invalid shared model directory retry');
      }
      const result = await deps.retryShareDirectory(deviceId);
      assertOwner();
      return { ok: true, ...result };
    }
    const pluginEngineRead = request.channel === PLUGIN_ENGINE_LIST;
    if (request.op !== 'read'
      || typeof request.agentDeviceId !== 'string'
      || (!pluginEngineRead && !MODEL_CATALOG_READ_CHANNELS.some(channel => channel === request.channel))
      || !Array.isArray(request.args) || request.args.length > 1) {
      throwIpcError('INVALID_PARAMS', 'Invalid model catalog read');
    }
    const agentRead = request.channel === 'maker:get-capabilities' || request.channel === 'maker:agent:status';
    const providerOptions = request.args[0];
    const shareStatusRead = isProviderShareAgentDeviceId(request.agentDeviceId) && !!providerOptions
      && typeof providerOptions === 'object' && !Array.isArray(providerOptions)
      && Object.keys(providerOptions).length === 1
      && PROVIDER_SHARE_GROUP_STATUS_REQUEST in providerOptions
      && providerOptions[PROVIDER_SHARE_GROUP_STATUS_REQUEST] === true;
    const validProviderOptions = request.args.length === 0 || (!!providerOptions
      && typeof providerOptions === 'object' && !Array.isArray(providerOptions)
      && Object.keys(providerOptions).every(key => key === 'capabilities')
      && Array.isArray(providerOptions.capabilities)
      && providerOptions.capabilities.every((value: unknown) => typeof value === 'string'));
    if (agentRead ? request.args.length !== 1 || !['claude-code', 'codex', 'pi'].includes(request.args[0] as string)
      : request.channel === 'maker:provider:list' ? !validProviderOptions && !shareStatusRead : request.args.length !== 0) {
      throwIpcError('INVALID_PARAMS', 'Invalid model catalog arguments');
    }
    const snapshot = await deps.locations();
    assertOwner();
    const deviceId = request.agentDeviceId;
    const source = snapshot.locations.find(location => location.agentDeviceId === deviceId);
    if (!source) {
      if (snapshot.status === 'degraded') throwIpcError('MODEL_VISIBILITY_NOT_READY', 'Model source directory is temporarily unavailable');
      throwIpcError('PRECONDITION_FAILED', 'Model source is unavailable on the task computer');
    }
    // A share is one provider: a built-in provider share offers no plugin engine, so it is not asked.
    const sharedProviderId = isProviderShareAgentDeviceId(deviceId) ? source.favoriteSource?.providerId : undefined;
    if (pluginEngineRead && sharedProviderId !== undefined && !pluginEngineKeyFromProviderId(sharedProviderId)) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: InvokeResultPayload;
    try {
      result = await Promise.race([
        deps.invoke(deviceId, request.channel as string, request.args, assertOwner),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('Model source read timed out'), { code: 'TIMEOUT' })),
            CONTROLLED_SOURCE_READ_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      const row = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : {};
      const temporary = temporarySourceFailure(row.code, row.message);
      if (!temporary) throw error;
      assertOwner();
      throwIpcError(temporary, 'Model source is temporarily unavailable');
    } finally {
      if (timer) clearTimeout(timer);
    }
    assertOwner();
    // A revoked/paused share or a disabled device must not publish a late catalog.
    const current = await deps.locations();
    assertOwner();
    if (!current.locations.some(location => location.agentDeviceId === deviceId)) {
      if (current.status === 'degraded') throwIpcError('MODEL_VISIBILITY_NOT_READY', 'Model source directory is temporarily unavailable');
      throwIpcError('PRECONDITION_FAILED', 'Model source is no longer available');
    }
    if (!result.ok) {
      // Keep source readiness/compatibility semantics across the extra hop.
      // Authorization above still wins over an obsolete source response.
      if (result.error.code === 'IPC_ERROR') {
        const error = extractIpcError(new Error(result.error.message));
        if (error) throwIpcError(error.code, error.message);
      }
      if (result.error.code === 'CHANNEL_NOT_ALLOWED') {
        throwIpcError('DEVICE_LINK_CHANNEL_NOT_ALLOWED', result.error.message);
      }
      const temporary = temporarySourceFailure(result.error.code, result.error.message);
      if (temporary) throwIpcError(temporary, 'Model source is temporarily unavailable');
      throwIpcError('PRECONDITION_FAILED', 'Model source is currently unavailable');
    }
    if (pluginEngineRead) {
      // Only well-formed engine views travel on. Account usage is read from the computer that has
      // the engine, never through the task computer, so the usage flag is dropped here; a share
      // keeps only the engine it was granted for.
      return parseOfferedPluginEngines(result.result)
        .filter(engine => sharedProviderId === undefined || engine.providerId === sharedProviderId)
        .map(({ reportsUsage: _reportsUsage, ...engine }) => engine);
    }
    // 分享来的供应商与控制端直读(ipc.ts)用同一份受邀者投影，远控时的模型列表同样按组判断能否选用
    // (provider-sharing.md §5.1)。
    return request.channel === 'maker:provider:list' && isProviderShareAgentDeviceId(deviceId)
      ? scrubSharedProviderCatalog(result.result)
      : result.result;
  };
}
