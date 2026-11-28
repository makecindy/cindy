import { executeCloudManagement, startCloudManagementMaintenance } from './managementRuntime.js';
import { probeAvailableShells } from '../terminal/shellResolver.js';
import { net } from 'electron';
import { getInstanceConfig } from '../instance-runtime/config.js';
import { getCloudSettingsSnapshotContext } from './snapshotRuntime.js';
import { getHostSettings, getHostSettingsOperation, updateHostSettings } from './index.js';
import { HostSettingsError } from './operations.js';
import { createSettingsWebTransport } from './webTransport.js';
import { readSettingsBatch } from './webBatch.js';
import { SETTINGS_WEB_CHANNELS, type SettingsWebEnvelope, type SettingsWebResult } from '../../shared/settingsWeb.js';
import { executeWebHostCall, isWebHostCall, type WebHostCallDeps } from './webHostCalls.js';
import { isMaintenanceRetry, MAINTENANCE_RETRY, runRemoteChange } from '../instance-runtime/maintenance.js';

// Desktop startup provides these: DeviceLink dispatch and the remote desktop import Host settings,
// so this module does not import them.
let webHostCallDeps: WebHostCallDeps | null = null;

/** Private Host adapter for origin-checked browser requests delivered by the configured CIS. */
export async function executeWebSettingsRequest(request: SettingsWebEnvelope, assertCurrent: () => void): Promise<SettingsWebResult> {
  assertCurrent();
  const caller = { id: `web:${request.sessionKey}`, assertCurrent };
  try {
    if (isWebHostCall(request.command)) {
      if (!webHostCallDeps) return { ok: false, code: 'SETTINGS_REQUEST_FAILED' };
      return await executeWebHostCall({ ...request, command: request.command }, webHostCallDeps);
    }
    if (request.command.kind === 'manage') return { ok: true, management: await executeCloudManagement(request, assertCurrent) };
    if (request.command.kind === 'readBatch') {
      return await readSettingsBatch(request.command.domains,
        domain => executeWebSettingsRequest({ ...request, command: { kind: 'read', domain } }, assertCurrent), assertCurrent);
    }
    if (request.command.kind === 'update') {
      // The authenticated web form's Save is the human action, as with native settings
      // IPC. This path is not exposed through helper tools or device-link invoke.
      // Maintenance waits for an accepted save to persist, and refuses new ones once it has begun.
      const change = request.command.change;
      return { ok: true, receipt: await runRemoteChange(() => updateHostSettings(caller, change)) } as SettingsWebResult;
    }
    if (request.command.kind === 'receipt') return { ok: true, receipt: getHostSettingsOperation(caller, request.command.operationId) } as SettingsWebResult;
    const domain = request.command.domain;
    const choices = domain === 'terminal' ? { defaultShellPref: [
        { value: 'auto', label: 'Auto' }, ...probeAvailableShells().map(shell => ({ value: shell.id, label: shell.displayName })),
      ] } : undefined;
    let settings = await getHostSettings(caller, domain, request.command.workspaceId);
    assertCurrent();
    if (domain === 'appearance' && settings.status === 'ready') {
      const keys = ['uiFamily', 'codeFamily', 'uiSize', 'codeSize', 'windowZoom'];
      const project = (value: unknown) => Object.fromEntries(keys.map(key => [key, (value as Record<string, unknown>)[key]]));
      const customizedKeys = settings.customizedKeys.filter(key => keys.includes(key));
      settings = { ...settings, value: project(settings.value), defaults: project(settings.defaults), customizedKeys, isCustomized: customizedKeys.length > 0 } as typeof settings;
    }
    // New-task defaults stay in the app window's draft and are never ready here.
    return { ok: true, settings: { ...settings, domain,
      ...(settings.status === 'ready' && choices ? { choices } : {}) } } as SettingsWebResult;
  } catch (error) {
    return { ok: false, code: error instanceof HostSettingsError ? error.code : isMaintenanceRetry(error) ? MAINTENANCE_RETRY : 'SETTINGS_REQUEST_FAILED' };
  }
}

export function startCloudSettingsWebTransport(hostCalls: WebHostCallDeps): () => void {
  if (getInstanceConfig()?.authProtocol !== 'resource-v1') return () => {};
  webHostCallDeps = hostCalls;
  const transport = createSettingsWebTransport({ getContext: getCloudSettingsSnapshotContext,
    fetch: (input, init) => net.fetch(input as string, init), execute: executeWebSettingsRequest, managementV1: true,
    hostCalls: { channels: [...SETTINGS_WEB_CHANNELS], desktopV1: true } });
  const stopManagement = startCloudManagementMaintenance();
  transport.start();
  return () => { transport.stop(); stopManagement(); webHostCallDeps = null; };
}
