/** Device-link-only adapter for the module-neutral remote resource registry. */
import { ipcMain } from 'electron';
import {
  REMOTE_RESOURCE_GET_CHANNEL,
  REMOTE_RESOURCE_INVOKE_CHANNEL,
  REMOTE_RESOURCE_LIST_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  parseRemoteActionInvokeRequest,
  parseRemoteCollectionListRequest,
  parseRemoteResourceGetRequest,
  parseRemoteResourceManifestRequest,
} from '@cindy/device-link';

import { getDeviceLinkInvokeContext } from './invoke-context.js';
import {
  RemoteResourceRegistryError,
  remoteResourceRegistry,
  type RemoteResourceHostContext,
} from './remoteResourceRegistry.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';

const log = createLogger('device-link:remote-resources-ipc');

function requireRemoteContext(expectedChannel: string): RemoteResourceHostContext {
  const context = getDeviceLinkInvokeContext();
  if (!context || context.channel !== expectedChannel) {
    throwIpcError('PERMISSION_DENIED', 'remote resource API is only available through device-link');
  }
  return { controllerDeviceId: context.controllerDeviceId };
}

function rethrowRegistryError(error: unknown): never {
  if (error instanceof RemoteResourceRegistryError && error.code !== 'INTERNAL') {
    throwIpcError(error.code, error.message);
  }
  log.warn('remote resource provider failed', {
    error: error instanceof Error ? error.message : String(error),
  });
  throwIpcError('INTERNAL', 'remote resource provider failed');
}

export function registerRemoteResourcesIpc(): void {
  ipcMain.handle(REMOTE_RESOURCE_MANIFEST_CHANNEL, async (_event, raw: unknown) => {
    const context = requireRemoteContext(REMOTE_RESOURCE_MANIFEST_CHANNEL);
    const request = parseRemoteResourceManifestRequest(raw);
    if (!request) throwIpcError('INVALID_PARAMS', 'invalid remote resource manifest request');
    return remoteResourceRegistry.manifest(context, request);
  });

  ipcMain.handle(REMOTE_RESOURCE_LIST_CHANNEL, async (_event, raw: unknown) => {
    const context = requireRemoteContext(REMOTE_RESOURCE_LIST_CHANNEL);
    const request = parseRemoteCollectionListRequest(raw);
    if (!request) throwIpcError('INVALID_PARAMS', 'invalid remote resource list request');
    try {
      return await remoteResourceRegistry.list(context, request);
    } catch (error) {
      rethrowRegistryError(error);
    }
  });

  ipcMain.handle(REMOTE_RESOURCE_GET_CHANNEL, async (_event, raw: unknown) => {
    const context = requireRemoteContext(REMOTE_RESOURCE_GET_CHANNEL);
    const request = parseRemoteResourceGetRequest(raw);
    if (!request) throwIpcError('INVALID_PARAMS', 'invalid remote resource get request');
    try {
      return await remoteResourceRegistry.get(context, request);
    } catch (error) {
      rethrowRegistryError(error);
    }
  });

  ipcMain.handle(REMOTE_RESOURCE_INVOKE_CHANNEL, async (_event, raw: unknown) => {
    const context = requireRemoteContext(REMOTE_RESOURCE_INVOKE_CHANNEL);
    const request = parseRemoteActionInvokeRequest(raw);
    if (!request) throwIpcError('INVALID_PARAMS', 'invalid remote resource action request');
    try {
      return await remoteResourceRegistry.invoke(context, request);
    } catch (error) {
      rethrowRegistryError(error);
    }
  });
}

export const __testing = { rethrowRegistryError };
