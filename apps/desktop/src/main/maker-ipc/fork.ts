/**
 * registerMakerForkIpc — maker:fork
 *
 * Stage 2 C2: 把老 local-db:sessions:fork 搬到 maker.* 命名空间。
 * 业务函数 (apps/desktop/src/main/maker-orchestration/fork.ts) 不变, 只是 IPC 入口换源。
 *
 * 错误码映射 (与老 local-db:sessions:fork 一致):
 *   SOURCE_NOT_FOUND / MESSAGE_NOT_FOUND  → NOT_FOUND
 *   NOT_USER_MESSAGE                       → INVALID_PARAMS
 *   SOURCE_NEVER_RAN / NO_PRIOR_ASSISTANT / CODEX_FORK_STATE_UNAVAILABLE → 同名透传
 *
 * fork 点支持 user / assistant 消息 (语义区别见 forkSessionAtMessage doc)。
 */

import { isScopedPeer, remoteAgentErrorCode } from '@cindy/device-link';
import { ipcMain } from 'electron';
import { z } from 'zod';
import type { ForkRequest, ForkReceipt } from '@cindy/maker-shared/fork-request';
import type { Session } from '../../renderer/lib/ccAgent.types';
import { forkRequestCapabilities, runForkRequest } from '../maker-orchestration/fork-request';

import { createLogger } from '../logger.js';
import { createSideChat, listSideChats, forkSessionAtMessage, forkSessionStripEncrypted } from '../maker-orchestration/fork.js';
import { requireString, throwIpcError } from '../utils/ipcValidate.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { getDeviceLinkInvokeContext } from '../device-link/invoke-context.js';
import { assertTaskActionCurrent } from './taskActionAuthorization.js';
import { isIpcError } from '../../shared/ipc-errors.js';

import { MAKER_INVOKE } from './channels.js';

const log = createLogger('maker-ipc/fork');

/**
 * 广播「新会话已建」给所有窗口 + device-link tap(转发给订阅 `sessions` topic 的控制端)。
 * 统一走 emitSessionCreated，避免 fork 会话在被控端 / 其它控制端侧边栏凭空消失。
 */
function broadcastSessionCreated(sessionId: string): void {
  emitSessionCreated(sessionId);
}

/** UI and Host tools share the completed fork, including task-list notification. */
export function forkTaskAtMessage(sessionId: string, messageClientId: string): Promise<Session>;
export function forkTaskAtMessage(sessionId: string, messageClientId: string, request: ForkRequest): Promise<ForkReceipt<Session>>;
export async function forkTaskAtMessage(sessionId: string, messageClientId: string, request?: ForkRequest): Promise<Session | ForkReceipt<Session>> {
  if (request) {
    const receipt = await runForkRequest(parseForkRequest(request));
    await assertTaskActionCurrent();
    if (receipt.session && request.action === 'create') broadcastSessionCreated(receipt.session.id);
    return receipt;
  }
  const session = await forkSessionAtMessage(sessionId, messageClientId);
  await assertTaskActionCurrent();
  broadcastSessionCreated(session.id);
  return session;
}

const forkRequestSchema = z.object({
  version: z.literal(1), action: z.enum(['create', 'status']), requestId: z.string().uuid(),
  sourceSessionId: z.string().min(1).max(512), messageClientId: z.string().min(1).max(512),
  target: z.object({
    agentKind: z.enum(['claude-code', 'codex', 'pi', 'acp']), model: z.string().min(1).max(512),
    providerId: z.string().min(1).max(512).nullable(),
    agentDeviceId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).nullable(),
    effort: z.string().max(64).optional(), fastMode: z.union([z.boolean(), z.literal('ultrafast')]).optional(),
  }).strict().optional(),
}).strict();

export function parseForkRequest(input: unknown): ForkRequest {
  const parsed = forkRequestSchema.safeParse(input);
  if (!parsed.success) throwIpcError('INVALID_PARAMS', 'Invalid fork request');
  return parsed.data;
}

function assertOwnedTaskCaller(event: Electron.IpcMainInvokeEvent, channel: string): void {
  const context = getDeviceLinkInvokeContext();
  if (context) {
    // Main creates this context only after device-link authorization. A remote
    // invoke has no Electron frame; never accept a caller-supplied substitute.
    if (context.channel !== channel || !context.controllerDeviceId || context.sharedTask || isScopedPeer(context.controllerDeviceId)) {
      throwIpcError('PERMISSION_DENIED', 'This action requires the task owner');
    }
  } else {
    assertTrustedAppRendererEvent(event);
  }
}

export function registerMakerForkIpc(): void {
  ipcMain.handle(MAKER_INVOKE.SIDE_CHAT_LIST, (event, sourceSessionId: unknown) => {
    assertOwnedTaskCaller(event, MAKER_INVOKE.SIDE_CHAT_LIST);
    return listSideChats(requireString(sourceSessionId, 'sourceSessionId'));
  });
  ipcMain.handle(MAKER_INVOKE.SIDE_CHAT, async (event, input: unknown) => {
    assertOwnedTaskCaller(event, MAKER_INVOKE.SIDE_CHAT);
    // Older hosts require a string. An object fails closed if a cached capability
    // outlives a host downgrade, instead of creating a branch with a different ID.
    const request = typeof input === 'object' && input !== null ? input as Record<string, unknown> : null;
    const sid = requireString(request ? request.parentSessionId : input, 'sourceSessionId');
    const childId = request ? requireString(request.childId, 'childId') : undefined;
    if (childId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(childId)) {
      throwIpcError('INVALID_PARAMS', 'Invalid side chat ID');
    }
    try {
      const session = await createSideChat(sid, childId);
      broadcastSessionCreated(session.id);
      return session;
    } catch (error) {
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      log.warn('side chat creation failed', { sourceSessionId: sid, code, error: message });
      if (code === 'SOURCE_NOT_FOUND') throwIpcError('NOT_FOUND', 'Source task is unavailable');
      if (code === 'REMOTE_NOT_SUPPORTED') throwIpcError('UNSUPPORTED_CAPABILITY', 'Native history is on another execution host');
      if (code === 'NO_PRIOR_ASSISTANT' || code === 'SOURCE_NEVER_RAN') {
        throwIpcError('NO_PRIOR_ASSISTANT', 'Wait for the first completed reply');
      }
      // 远程 Agent 的错误码带给界面，让它说清是哪台电脑、什么原因(与分叉同一套提示)。
      const remoteCode = remoteAgentErrorCode(message);
      throwIpcError('PRECONDITION_FAILED', remoteCode
        ? `[${remoteCode}] Could not create a side chat from this history`
        : 'Could not create a side chat from this history');
    }
  });
  ipcMain.handle(
    MAKER_INVOKE.FORK,
    async (
      _event: Electron.IpcMainInvokeEvent,
      sourceSessionId: unknown,
      messageClientId: unknown,
    ) => {
      if (typeof sourceSessionId === 'object' && sourceSessionId !== null) {
        assertOwnedTaskCaller(_event, MAKER_INVOKE.FORK);
        if ((sourceSessionId as { action?: unknown }).action === 'capabilities') return forkRequestCapabilities();
        const request = parseForkRequest(sourceSessionId);
        try {
          return await forkTaskAtMessage(request.sourceSessionId, request.messageClientId, request);
        } catch (error) {
          if (isIpcError(error)) throw error;
          const code = (error as { code?: string }).code;
          const remote = remoteAgentErrorCode(error instanceof Error ? error.message : '');
          if (remote) throwIpcError('PRECONDITION_FAILED', `[${remote}] The native history is unavailable`);
          if (code === 'SOURCE_NOT_FOUND' || code === 'MESSAGE_NOT_FOUND') throwIpcError('NOT_FOUND', 'The fork source is unavailable');
          if (code === 'NOT_USER_MESSAGE') throwIpcError('INVALID_PARAMS', 'Choose a user message or reply');
          if (code === 'UNSUPPORTED_HISTORY') throwIpcError('FORK_UNSUPPORTED_HISTORY', 'This history cannot be forked');
          if (code === 'NO_PRIOR_ASSISTANT' || code === 'SOURCE_NEVER_RAN' || code === 'CODEX_FORK_STATE_UNAVAILABLE') {
            throwIpcError(code, 'The native history is unavailable');
          }
          log.warn('fork request failed before a confirmed result', { code });
          throwIpcError('PRECONDITION_FAILED', 'Could not prepare this fork request');
        }
      }
      const sid = requireString(sourceSessionId, 'sourceSessionId');
      const mid = requireString(messageClientId, 'messageClientId');
      try {
        return await forkTaskAtMessage(sid, mid);
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('fork failed', { sourceSessionId: sid, messageClientId: mid, code, error: msg });
        switch (code) {
          case 'SOURCE_NOT_FOUND':
          case 'MESSAGE_NOT_FOUND':
            throwIpcError('NOT_FOUND', msg);
            break;
          case 'NOT_USER_MESSAGE':
            throwIpcError('INVALID_PARAMS', msg);
            break;
          case 'SOURCE_NEVER_RAN':
            throwIpcError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
            break;
          case 'NO_PRIOR_ASSISTANT':
            throwIpcError('NO_PRIOR_ASSISTANT', '请在 AI 回复之后的提问上 fork');
            break;
          case 'CODEX_FORK_STATE_UNAVAILABLE':
            throwIpcError('CODEX_FORK_STATE_UNAVAILABLE', msg);
            break;
          case 'UNSUPPORTED_HISTORY':
            throwIpcError('FORK_UNSUPPORTED_HISTORY', msg);
            break;
          default:
            throw err;
        }
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.FORK_STRIP_ENCRYPTED,
    async (_event: Electron.IpcMainInvokeEvent, sourceSessionId: unknown) => {
      const sid = requireString(sourceSessionId, 'sourceSessionId');
      try {
        const session = await forkSessionStripEncrypted(sid);
        broadcastSessionCreated(session.id);
        return session;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('fork strip encrypted failed', { sourceSessionId: sid, code, error: msg });
        switch (code) {
          case 'SOURCE_NOT_FOUND':
            throwIpcError('NOT_FOUND', msg);
            break;
          case 'NOT_CODEX_SESSION':
          case 'REMOTE_NOT_SUPPORTED':
            throwIpcError('INVALID_PARAMS', msg);
            break;
          case 'SOURCE_NEVER_RAN':
            throwIpcError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
            break;
          case 'CODEX_FORK_STATE_UNAVAILABLE':
            throwIpcError('CODEX_FORK_STATE_UNAVAILABLE', msg);
            break;
          case 'UNSUPPORTED_HISTORY':
            throwIpcError('FORK_UNSUPPORTED_HISTORY', msg);
            break;
          default:
            throw err;
        }
      }
    },
  );
}
