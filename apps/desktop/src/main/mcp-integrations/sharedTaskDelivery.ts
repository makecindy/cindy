import { randomUUID } from 'node:crypto';
import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import type { XdtHelperMcpDeps } from '@cindy/mcps';
import { CINDY_MAKE_ENABLED, isCindyMakeSource } from '@cindy/maker-shared/cindy-make-feature';
import { normalizeAgentInputClearBoundaryMs, type AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import type { SharedTaskCallerAccess } from './sharedTaskTools.js';
import { parseSharedTaskTarget } from './sharedTaskTarget.js';
import { classifyRemoteHistoryError, parseEncodedIpcError } from './remoteChatHistory.js';

type Delivery = NonNullable<XdtHelperMcpDeps['sendToSharedTask']>;
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Guest composer path: the target Host stamps author, runtime, directory and permissions. */
export function createSharedTaskDelivery(deps: SharedTaskCallerAccess & {
  assertActionCurrent(): Promise<void>;
  invoke(peer: string, channel: string, args: unknown[], options: { preSend: () => void }): Promise<InvokeResultPayload>;
}): Delivery {
  return async ({ target: value, message, deliveryId: previousId, context }) => {
    const target = parseSharedTaskTarget(value);
    const fail = (errorCode: string, message: string, deliveryId?: string) => ({
      ok: false as const, errorCode, message,
      ...(target ? { task_link: target.taskLink } : {}),
      ...(deliveryId ? { delivery_id: deliveryId } : {}),
    });
    if (!target) return fail('INVALID_ARGS', '请传入已加入共享任务的完整复制任务链接或共享引用，不要使用邀请链接或房主设备 ID。');
    if (!context.sessionId || !context.sessionInstanceId) return fail('PERMISSION_DENIED', '缺少当前本机任务身份。');
    const { peer, sessionId, taskLink } = target;
    const deliveryId = previousId ?? randomUUID();
    let writeStarted = false;
    let writeAcknowledged = false;
    let targetRejection: string | undefined;
    let observedState: unknown;
    let reconcile: (() => Promise<Awaited<ReturnType<Delivery>> | null>) | undefined;
    try {
      const initial = deps.caller(context);
      if (!initial.current || !initial.accountScoped) return fail('PERMISSION_DENIED', '当前输入无权使用此账号收到的共享任务。');
      if (initial.planMode) return fail('PLAN_MODE', '计划模式下不能发送共享任务消息。');
      const group = await deps.captureGroupAccess(context);
      const assertCurrent = () => {
        const current = deps.caller(context);
        if (!current.current || !current.accountScoped || current.key !== initial.key || current.planMode) {
          throw Object.assign(new Error('当前任务、账号或权限已变更。'), { code: 'ACCESS_REVOKED' });
        }
        group?.assertCurrent();
      };
      const invoke = async (channel: string, args: unknown[], write = false) => {
        assertCurrent();
        const reply = await deps.invoke(peer, channel, args, { preSend: () => {
          assertCurrent();
          if (write) writeStarted = true;
        } });
        if (write) writeStarted = true;
        assertCurrent();
        if (!reply.ok) {
          const code = reply.error.code === 'IPC_ERROR' ? parseEncodedIpcError(reply.error.message)?.code ?? reply.error.code : reply.error.code;
          if (write) targetRejection = code;
          throw Object.assign(new Error(reply.error.message), { code });
        }
        return reply.result;
      };
      await group?.refresh();
      const session = object(await invoke('local-db:sessions:get', [sessionId]));
      if (session?.id !== sessionId || session.status === 'deleted' ||
          !CINDY_MAKE_ENABLED && typeof session.source === 'string' && isCindyMakeSource(session.source)) {
        return fail('NOT_FOUND', '该共享任务当前不可访问。');
      }
      if (session.status === 'archived') return fail('ARCHIVED', '该共享任务已归档，消息未发送。');
      if (!['cc', 'claude-code', 'codex', 'pi'].includes(String(session.agentKind))) {
        return fail('UNSUPPORTED_CAPABILITY', '该共享任务的执行引擎不支持此发送入口。');
      }
      const projection = () => invoke('maker:input:get-projection', [sessionId, { deliveryClientIds: [deliveryId] }]);
      const receipt = (value: unknown) => {
        const data = object(value);
        if (data?.inputDeliveryVersion !== 1 || !Array.isArray(data.deliveryReceipts)) return null;
        const rows = data.deliveryReceipts.filter(row => object(row)?.clientId === deliveryId);
        return rows.length === 1 ? object(rows[0])?.state : null;
      };
      const result = (state: unknown): Awaited<ReturnType<Delivery>> | null => {
        if (state === 'removed') return fail('DELIVERY_REMOVED', '该消息已被取消或清除，不会再次发送。', deliveryId);
        if (state !== 'pending' && state !== 'accepted') return null;
        return { ok: true, target_session_id: taskLink, task_link: taskLink, delivery_id: deliveryId,
          delivery_state: state, wake_kind: state === 'pending' ? 'queued' : 'accepted' };
      };
      reconcile = async () => { observedState = receipt(await projection()); return result(observedState); };
      const before = receipt(await projection());
      const known = result(before);
      if (known) return known;
      if (previousId) return fail('DELIVERY_UNKNOWN', '尚无法确认原消息的投递状态。保留此 ID 继续对账，不要换新 ID 或重发。', deliveryId);
      if (before !== 'unknown') return fail('UNSUPPORTED_CAPABILITY', '对方版本未提供可靠消息回执，消息未发送。');
      // Placeholder fields only satisfy the existing composer shape; the Host
      // replaces them from its own task before any queue mutation.
      const item: AgentInputQueuedMessage = {
        clientId: deliveryId, durableDelivery: true, text: message, persistedContent: message,
        model: '', effort: '', permissionMode: 'ask', workingDir: '',
        createOpts: { agentKind: dbToMakerAgentKind(String(session.agentKind)), workingDir: '', model: '' },
        chatMessage: { clientId: deliveryId, role: 'user', content: message },
      };
      await group?.refresh();
      await deps.assertActionCurrent();
      assertCurrent();
      await invoke('maker:input:enqueue', [sessionId, item, {
        expectedClearBoundaryMs: normalizeAgentInputClearBoundaryMs(session.clearedAt) ?? null,
      }], true);
      writeAcknowledged = true;
      const confirmed = await reconcile();
      if (confirmed) return confirmed;
    } catch (error) {
      if (!writeStarted || !writeAcknowledged && error instanceof DeviceLinkError && error.inFlight !== true) {
        const code = object(error)?.code;
        if (code === 'PERMISSION_DENIED') return fail('PERMISSION_DENIED', '当前账号没有向该共享任务发消息的权限。', previousId);
        const classified = classifyRemoteHistoryError(typeof code === 'string' ? code : 'INTERNAL',
          error instanceof Error ? error.message : '共享任务连接不可用。');
        return fail(classified.errorCode, classified.message, previousId);
      }
      // One read can recover a lost ack. Never replay the write, including when
      // revocation at the result gate makes an already accepted request uncertain.
      try {
        const confirmed = await reconcile?.();
        if (confirmed) return confirmed;
        // A completed target refusal plus a current durable receipt showing no
        // retained input is a definite rejection. A lost/denied read stays unknown.
        if (observedState === 'unknown' && targetRejection === 'PERMISSION_DENIED') {
          return fail('PERMISSION_DENIED', '当前账号没有向该共享任务发消息的权限，目标未保留此输入。');
        }
      } catch { /* keep unknown */ }
    }
    return fail('DELIVERY_UNKNOWN', '未取得可信投递回执，消息可能已送达。请用相同目标与 delivery_id 对账；不要重发。', deliveryId);
  };
}
