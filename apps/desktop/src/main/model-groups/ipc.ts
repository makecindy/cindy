/** 模型组的 IPC：读写配置、解析选中的路线。只接受可信的主界面。 */
import { ipcMain } from 'electron';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUPS_IPC,
  modelGroupAgentDeviceId,
  modelGroupCandidateKey,
  normalizeModelGroupsConfig,
  sanitizeModelGroupSelection,
  type ModelGroupResolveRequest,
} from '../../shared/modelGroups.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { bindModelGroupSession } from './sessionBindings.js';
import { readModelGroupsConfig, writeModelGroupsConfig } from './store.js';
import { readModelGroupRecoveryOffer, resolver } from './desktopResolver.js';

function sessionIdOf(value: Record<string, unknown>): string {
  const sessionId = value.sessionId;
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 256) {
    throwIpcError('INVALID_PARAMS', 'sessionId is required');
  }
  return sessionId;
}

export function registerModelGroupsIpc(): void {
  ipcMain.handle(MODEL_GROUPS_IPC.GET, (event) => {
    assertTrustedAppRendererEvent(event);
    return readModelGroupsConfig();
  });
  ipcMain.handle(MODEL_GROUPS_IPC.SET, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!raw || typeof raw !== 'object') throwIpcError('INVALID_PARAMS', 'model groups config must be an object');
    return writeModelGroupsConfig(normalizeModelGroupsConfig(raw));
  });
  ipcMain.handle(MODEL_GROUPS_IPC.RESOLVE, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const selection = sanitizeModelGroupSelection(value.selection);
    if (!selection) throwIpcError('INVALID_PARAMS', 'model group selection is required');
    const context = value.context && typeof value.context === 'object' ? value.context as Record<string, unknown> : null;
    const rawLocation = value.location && typeof value.location === 'object' ? value.location as Record<string, unknown> : null;
    const locationId = rawLocation
      ? rawLocation.agentDeviceId === null || rawLocation.agentDeviceId === undefined ? null : modelGroupAgentDeviceId(rawLocation.agentDeviceId)
      : null;
    if (rawLocation && rawLocation.agentDeviceId !== null && rawLocation.agentDeviceId !== undefined && !locationId) {
      throwIpcError('INVALID_PARAMS', 'model group location is invalid');
    }
    const request: ModelGroupResolveRequest = {
      selection,
      dryRun: value.dryRun === true,
      ...(context?.hasImages === true ? { context: { hasImages: true } } : {}),
      ...(rawLocation ? { location: { agentDeviceId: locationId } } : {}),
    };
    return resolver.resolve(request);
  });
  ipcMain.handle(MODEL_GROUPS_IPC.COMMIT, (event, decisionId: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof decisionId !== 'string' || decisionId.length > 64) throwIpcError('INVALID_PARAMS', 'decisionId is required');
    return resolver.commit(decisionId);
  });
  ipcMain.handle(MODEL_GROUPS_IPC.BIND_SESSION, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sessionId = sessionIdOf(value);
    const selection = sanitizeModelGroupSelection(value.selection);
    const route = value.route && typeof value.route === 'object' ? value.route as Record<string, unknown> : {};
    const agentKind = route.agentKind;
    const providerId = route.providerId;
    const model = route.model;
    const agentDeviceId = route.agentDeviceId === undefined || route.agentDeviceId === null
      ? undefined
      : modelGroupAgentDeviceId(route.agentDeviceId);
    if (!selection || (agentKind !== 'cc' && agentKind !== 'codex' && agentKind !== 'pi')
      || typeof providerId !== 'string' || !providerId || providerId.length > MODEL_GROUP_LIMITS.field
      || typeof model !== 'string' || !model || model.length > MODEL_GROUP_LIMITS.field
      || agentDeviceId === null) {
      throwIpcError('INVALID_PARAMS', 'model group selection and route are required');
    }
    bindModelGroupSession(sessionId, selection, modelGroupCandidateKey({ agentKind, providerId, model, agentDeviceId }));
  });
  ipcMain.handle(MODEL_GROUPS_IPC.SWITCH_OFFER, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return readModelGroupRecoveryOffer(sessionIdOf(value));
  });
}
