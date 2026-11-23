/**
 * 模型组的 IPC：读写配置、解析选中的路线。改配置只接受可信的主界面；读、选路、提交、记绑定与写说明
 * 另外接受同账号本人控制的手机与电脑(model-groups.md §6.3)，分享来的任务等受限控制端不行。
 */
import { and, asc, eq } from 'drizzle-orm';
import { ipcMain } from 'electron';

import {
  MODEL_GROUP_LIMITS,
  MODEL_GROUPS_IPC,
  modelGroupAgentDeviceId,
  modelGroupCandidateKey,
  modelGroupSelectionForOwner,
  normalizeModelGroupsConfig,
  sanitizeModelGroupRouteNote,
  sanitizeModelGroupSelection,
  type ModelGroupResolveRequest,
} from '../../shared/modelGroups.js';
import { isDeviceLinkInvoke } from '../device-link/invoke-context.js';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { messages } from '../localDb/schema.js';
import { getSessionRowSnapshotStrict } from '../localDb/sessionDispatchSnapshot.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { assertModelGroupsCaller } from './remoteAccess.js';
import { acceptModelGroupRouteNote, type ModelGroupRouteNotePorts } from './routeNote.js';
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

function remoteSafeSelection(raw: unknown) {
  const selection = sanitizeModelGroupSelection(raw);
  return selection && isDeviceLinkInvoke() ? modelGroupSelectionForOwner(selection) : selection;
}

const routeNotePorts: ModelGroupRouteNotePorts = {
  async sessionExists(sessionId) {
    return !!(await getSessionRowSnapshotStrict(sessionId));
  },
  async firstUserMessageAt(sessionId) {
    const [row] = await getDbClient().drizzle.select({ createdAt: messages.createdAt }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, 'user')))
      .orderBy(asc(messages.createdAt)).limit(1);
    const value = row?.createdAt as unknown;
    const at = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : Number.NaN;
    return Number.isFinite(at) ? at : null;
  },
  async createNote(sessionId, row) {
    await createMessage(sessionId, {
      clientId: row.clientId,
      role: 'assistant',
      content: '',
      agentMeta: { pluginModelRoute: row.note } as never,
      ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    });
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

export function registerModelGroupsIpc(): void {
  ipcMain.handle(MODEL_GROUPS_IPC.GET, (event) => {
    assertModelGroupsCaller(event);
    return readModelGroupsConfig();
  });
  ipcMain.handle(MODEL_GROUPS_IPC.SET, (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!raw || typeof raw !== 'object') throwIpcError('INVALID_PARAMS', 'model groups config must be an object');
    return writeModelGroupsConfig(normalizeModelGroupsConfig(raw));
  });
  ipcMain.handle(MODEL_GROUPS_IPC.RESOLVE, async (event, raw: unknown) => {
    assertModelGroupsCaller(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const selection = remoteSafeSelection(value.selection);
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
      ...(value.remoteInvocableOnly === true ? { remoteInvocableOnly: true } : {}),
    };
    return resolver.resolve(request);
  });
  ipcMain.handle(MODEL_GROUPS_IPC.COMMIT, (event, decisionId: unknown) => {
    assertModelGroupsCaller(event);
    if (typeof decisionId !== 'string' || decisionId.length > 64) throwIpcError('INVALID_PARAMS', 'decisionId is required');
    return resolver.commit(decisionId);
  });
  ipcMain.handle(MODEL_GROUPS_IPC.BIND_SESSION, (event, raw: unknown) => {
    assertModelGroupsCaller(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sessionId = sessionIdOf(value);
    const selection = remoteSafeSelection(value.selection);
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
  ipcMain.handle(MODEL_GROUPS_IPC.ROUTE_NOTE, async (event, raw: unknown) => {
    assertModelGroupsCaller(event);
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const sessionId = sessionIdOf(value);
    const note = sanitizeModelGroupRouteNote(value.note);
    if (!note) throwIpcError('INVALID_PARAMS', 'model group route note is invalid');
    if (!(await acceptModelGroupRouteNote(routeNotePorts, sessionId, note))) throwIpcError('NOT_FOUND', 'session not found');
  });
}
