/**
 * 模型组的桌面 IPC 薄装配(业务主体在 handlersCore.ts，供 Desktop 与 Node Host 共用)。
 */
import { and, asc, eq } from 'drizzle-orm';
import { ipcMain } from 'electron';

import { MODEL_GROUPS_IPC } from '../../shared/modelGroups.js';
import { isDeviceLinkInvoke, readDeviceLinkModelSelectionOrigin } from '../device-link/invoke-context.js';
import { getDbClient } from '../localDb/client/current.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { messages } from '../localDb/schema.js';
import { getSessionRowSnapshot, getSessionRowSnapshotStrict } from '../localDb/sessionDispatchSnapshot.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { desktopModelGroupRuntime } from './desktopResolver.js';
import { createModelGroupHandlers, type ModelGroupHandlersSessionTarget } from './handlersCore.js';
import type { ModelGroupRouteNotePorts } from './routeNote.js';

let pendingSessionTargetReader: ((sessionId: string) => ModelGroupHandlersSessionTarget | null) | null = null;

/** 允许 maker-ipc/register.ts 注入待生效跨引擎/换位切换意图读取器，让托管投影兼容 pending intent。 */
export function registerModelGroupPendingTargetReader(
  reader: (sessionId: string) => ModelGroupHandlersSessionTarget | null,
): void {
  pendingSessionTargetReader = reader;
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

export const desktopModelGroupHandlers = createModelGroupHandlers({
  runtime: () => desktopModelGroupRuntime,
  isDeviceLink: () => isDeviceLinkInvoke(),
  deviceLinkOrigin: () => readDeviceLinkModelSelectionOrigin(),
  readSessionTarget: (sessionId) => getSessionRowSnapshot(sessionId),
  readPendingSessionTarget: (sessionId) => pendingSessionTargetReader?.(sessionId) ?? null,
  routeNotePorts,
});

export function registerModelGroupsIpc(): void {
  // 启动后先读一次目录：重启前就在用供应商路由的任务，第一条消息之前就要认得它的路由。
  void desktopModelGroupRuntime.refreshAutoModelGroupRoutes();
  ipcMain.handle(MODEL_GROUPS_IPC.GET, (event, rawOptions?: unknown) =>
    desktopModelGroupHandlers.get(rawOptions, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.SET, (event, raw: unknown) =>
    desktopModelGroupHandlers.set(raw, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.RESOLVE, (event, raw: unknown) =>
    desktopModelGroupHandlers.resolve(raw, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.COMMIT, (event, decisionId: unknown) =>
    desktopModelGroupHandlers.commit(decisionId, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.BIND_SESSION, (event, raw: unknown) =>
    desktopModelGroupHandlers.bindSession(raw, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.UNBIND_SESSION, (event, raw: unknown) =>
    desktopModelGroupHandlers.unbindSession(raw, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.GET_SESSION_BINDING, (event, raw: unknown) =>
    desktopModelGroupHandlers.getSessionBinding(raw, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.SWITCH_OFFER, (event, raw: unknown) =>
    desktopModelGroupHandlers.switchOffer(raw, () => assertTrustedAppRendererEvent(event)));
  ipcMain.handle(MODEL_GROUPS_IPC.ROUTE_NOTE, (event, raw: unknown) =>
    desktopModelGroupHandlers.routeNote(raw, () => assertTrustedAppRendererEvent(event)));
}
