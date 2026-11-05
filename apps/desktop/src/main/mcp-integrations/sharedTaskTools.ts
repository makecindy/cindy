import { parseSharedTaskInvitation, SHARED_TASK_INVITATION_PATH, type SharedTaskHostCommand } from '@cindy/device-link';
import type { LiziMcpSessionContext, XdtHelperMcpDeps } from '@cindy/mcps';

/** Host facts only: account, live instance, accepted input and permission generation. */
export interface SharedTaskCaller {
  key: string;
  current: boolean;
  accountScoped: boolean;
  planMode: boolean;
}

interface Deps {
  caller(context: LiziMcpSessionContext): SharedTaskCaller;
  captureGroupAccess(context: LiziMcpSessionContext): Promise<{ assertCurrent(): void; refresh(): Promise<void> } | null>;
  assertActionCurrent(): Promise<void>;
  captureCommand(sessionId: string, assertCurrent: () => void): (command: SharedTaskHostCommand) => Promise<unknown>;
}

const failure = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const rejections: Record<string, string> = {
  PERMISSION_DENIED: '当前输入没有房主的共享管理权限。',
  GROUP_AUTHORIZATION_REQUIRED: '当前群发言没有房主的共享管理权限。',
  GROUP_AUTHORIZATION_UNAVAILABLE: '暂时无法核实群发言权限，请恢复连接后继续。',
  SHARED_TASK_HOST_LIMIT: '已达到共享任务数量上限，请先在共享管理中关闭不再需要的共享。',
  UNSUPPORTED_CAPABILITY: '当前电脑或服务器不支持共享任务，请更新后继续。',
  DEVICE_LINK_NOT_CONNECTED: '共享连接不可用，请恢复连接后查询状态。',
};

/** Only prepares a native invitation. Notifications and recipient selection belong to consumers. */
export function createSharedTaskTools(deps: Deps): NonNullable<XdtHelperMcpDeps['sharedTask']> {
  return async (context, action) => {
    let mutationStarted = false;
    let writeCompleted = false;
    try {
      const sessionId = context.sessionId;
      if (!id(sessionId) || !context.sessionInstanceId) return failure('NO_SESSION_CONTEXT', '无法确认当前任务，请在原任务中调用。');
      const source = deps.caller(context);
      if (!source.current || !source.accountScoped) return failure('PERMISSION_DENIED', '只有房主账号的当前任务可以管理共享。');
      if (action === 'invite' && source.planMode) return failure('PLAN_MODE', '计划模式下不能开启共享或生成邀请。');
      let group: Awaited<ReturnType<Deps['captureGroupAccess']>> = null;
      const assertCurrent = () => {
        const current = deps.caller(context);
        if (!current.current || !current.accountScoped || current.key !== source.key ||
            action === 'invite' && current.planMode) throw new Error('SHARED_TASK_SOURCE_CHANGED');
        group?.assertCurrent();
      };
      const commandForHost = deps.captureCommand(sessionId, assertCurrent);
      group = await deps.captureGroupAccess(context);
      const run = async (command: SharedTaskHostCommand) => {
        await group?.refresh();
        await deps.assertActionCurrent();
        assertCurrent();
        if (command.action !== 'state') mutationStarted = true;
        const result = await commandForHost(command);
        if (command.action !== 'state') writeCompleted = true;
        assertCurrent();
        return result;
      };
      const read = async () => {
        const state = object(await run({ action: 'state', sessionId }));
        if (!state || typeof state.available !== 'boolean') throw new Error('SHARED_TASK_INVALID_RECEIPT');
        if (!state.available || state.detail === null) return { available: state.available, sharedTaskId: null };
        const detail = object(state.detail);
        if (!detail || detail.sessionId !== sessionId || !id(detail.sharedTaskId) ||
            !['active', 'closed'].includes(String(detail.status))) throw new Error('SHARED_TASK_INVALID_RECEIPT');
        return { available: true, sharedTaskId: detail.status === 'active' ? detail.sharedTaskId : null };
      };
      const state = await read();
      const identity = { sessionId, device: 'local' as const };
      if (action === 'state') return { ok: true, ...identity, ...state };
      if (!state.available) return failure('UNSUPPORTED_CAPABILITY', rejections.UNSUPPORTED_CAPABILITY!);
      let sharedTaskId = state.sharedTaskId;
      if (!sharedTaskId) {
        const opened = object(await run({ action: 'open', sessionId }));
        if (!id(opened?.sharedTaskId)) throw new Error('SHARED_TASK_INVALID_RECEIPT');
        sharedTaskId = opened.sharedTaskId;
        if ((await read()).sharedTaskId !== sharedTaskId) throw new Error('SHARED_TASK_REPLACED');
      }
      const invitation = object(await run({ action: 'invite', sharedTaskId }));
      if (invitation?.sharedTaskId !== sharedTaskId || typeof invitation.invitationLink !== 'string' ||
          typeof invitation.invitation !== 'string') throw new Error('SHARED_TASK_INVALID_RECEIPT');
      // The trusted Host builds the endpoint. Reuse the native parser, including loopback dev URLs.
      const link = new URL(invitation.invitationLink);
      const parsed = parseSharedTaskInvitation(invitation.invitationLink,
        link.origin + link.pathname.slice(0, -SHARED_TASK_INVITATION_PATH.length));
      if (!parsed.ok || parsed.invitation !== invitation.invitation) throw new Error('SHARED_TASK_INVALID_RECEIPT');
      if ((await read()).sharedTaskId !== sharedTaskId) throw new Error('SHARED_TASK_REPLACED');
      return { ok: true, ...identity, available: true, sharedTaskId, invitationLink: invitation.invitationLink };
    } catch (error) {
      const code = object(error)?.code;
      // A definite first-write refusal is actionable. Later failures cannot undo
      // an already opened share; network errors and stale receipts remain unknown.
      if (!writeCompleted && code === 'SHARED_TASK_HOST_LIMIT') {
        return failure(code, rejections[code]!);
      }
      // Once a write was admitted, even a later definite rejection cannot prove the whole operation failed.
      if (mutationStarted) return failure('SHARED_TASK_RESULT_UNKNOWN', '未取得有效邀请回执，共享或邀请可能已生成。请先查询共享状态，再决定是否重试；不会自动重发。');
      if (typeof code === 'string' && Object.hasOwn(rejections, code)) return failure(code, rejections[code]!);
      return failure('SHARED_TASK_UNAVAILABLE', '无法确认当前任务的共享状态，未生成邀请。请检查账号与共享连接后再查询。');
    }
  };
}
