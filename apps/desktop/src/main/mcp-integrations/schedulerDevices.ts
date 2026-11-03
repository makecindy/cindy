import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import type { SchedulerDevice, SchedulerRemoteDeps, SchedulerRemoteOp } from '@cindy/mcps';
import { classifyRemoteHistoryError } from './remoteChatHistory.js';

/**
 * cindy_scheduler 的跨电脑 adapter。复用用户在远程控制里操作定时任务的同一组
 * `maker:schedule:*` channel 与授权（同账号、对方在线且已开启远程控制），不新增 wire。
 * 建链与连接恢复沿用 remoteInvoke 的既有策略（与目标电脑没有链路时会先建链）；本层不另加
 * 重试或缓存，单次请求失败只影响这一次调用。
 */
const CHANNELS: Record<SchedulerRemoteOp, string> = {
  list: 'maker:schedule:list',
  get: 'maker:schedule:get',
  'list-runs': 'maker:schedule:list-runs',
  create: 'maker:schedule:create',
  update: 'maker:schedule:update',
  pause: 'maker:schedule:pause',
  resume: 'maker:schedule:resume',
  delete: 'maker:schedule:delete',
  'run-now': 'maker:schedule:run-now',
};

/** 远程失败说明。只陈述事实；旧版本对方不认识的请求明确说不支持。 */
const MESSAGES: Record<string, string> = {
  REMOTE_DEVICE_OFFLINE: '目标电脑不在线',
  REMOTE_DISABLED: '目标电脑未开启远程控制',
  REMOTE_ACCESS_REVOKED: '目标电脑已撤销对本机的授权',
  REMOTE_LINK_REQUIRED: '与目标电脑的连接已关闭',
  DEVICE_LINK_NOT_READY: '设备互联暂未就绪',
  REMOTE_UNSUPPORTED: '目标电脑的版本不支持远程管理定时任务',
  REMOTE_TIMEOUT: '目标电脑没有在限定时间内回应；写操作可能已生效，重试前请先查询确认',
  HOST_NOT_READY: '目标电脑的定时任务服务尚未就绪',
  REMOTE_RESULT_UNKNOWN: '没有收到目标电脑的可信回执；写操作可能已生效，重试前请先查询确认',
};

const WRITE_OPS: ReadonlySet<SchedulerRemoteOp> = new Set([
  'create',
  'update',
  'pause',
  'resume',
  'delete',
  'run-now',
]);

/**
 * 被控端 dispatch 在 handler **完成之后**还会复核可见性与账号 owner，失败时抛这句
 * （apps/desktop/src/main/device-link/dispatch.ts）。定时任务 handler 自己的「不存在」是
 * `Schedule not found: <id>`，两者文案不同，可以据此区分「没执行」与「执行后回执被拦」。
 */
const POST_HANDLER_REJECTION = '[NOT_FOUND] Session does not exist';

/**
 * 被控端 `maker:schedule:*` 入口在写入之前就会拒绝的错误（apps/desktop/src/main/maker-ipc/schedule.ts）：
 * 参数校验、定时任务不存在、scheduler 尚未就绪。其余 IPC 错误（含 INTERNAL、未编码的错误）
 * 可能发生在写入之后，写操作一律按结果未知处理。
 */
function isRejectedBeforeWrite(message: string): boolean {
  return (
    /\[INVALID_PARAMS]/.test(message) ||
    /\[NOT_FOUND]/.test(message) ||
    /\[INTERNAL] scheduler not ready:/.test(message)
  );
}

/** 请求已发出但拿不到可信结果：写操作不能说没执行，读操作只是这次没读到。 */
function unknownOutcome(op: SchedulerRemoteOp): { ok: false; code: string; message: string } {
  return WRITE_OPS.has(op)
    ? { ok: false, code: 'REMOTE_RESULT_UNKNOWN', message: MESSAGES.REMOTE_RESULT_UNKNOWN }
    : { ok: false, code: 'REMOTE_UNAVAILABLE', message: '暂时无法取得目标电脑的结果' };
}

function failure(code: string, message: string): { ok: false; code: string; message: string } {
  const classified = classifyRemoteHistoryError(code, message);
  // Scheduler 工具沿用 IPC 层的 INVALID_PARAMS 命名。
  const errorCode =
    classified.errorCode === 'INVALID_ARGS' ? 'INVALID_PARAMS' : classified.errorCode;
  return { ok: false, code: errorCode, message: MESSAGES[errorCode] ?? classified.message };
}

export function createSchedulerRemoteDeps(deps: {
  listDevices(): Promise<SchedulerDevice[]>;
  captureAccess(): () => void;
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    options?: { preSend?: () => void },
  ): Promise<InvokeResultPayload>;
}): SchedulerRemoteDeps {
  return {
    listDevices: deps.listDevices,
    async invoke(deviceId, op, args) {
      let assertCurrent: () => void;
      try {
        assertCurrent = deps.captureAccess();
      } catch {
        return {
          ok: false,
          code: 'DEVICE_LINK_NOT_READY',
          message: MESSAGES.DEVICE_LINK_NOT_READY,
        };
      }
      let response: InvokeResultPayload;
      try {
        if (op === 'create') {
          const capabilities = await deps.invoke(deviceId, 'maker:get-capabilities', ['claude-code'], { preSend: assertCurrent });
          assertCurrent();
          const supported = capabilities.ok ? capabilities.result as { supportsRemoteScheduleDirectoryCheck?: boolean } | null : null;
          if (supported?.supportsRemoteScheduleDirectoryCheck !== true) {
            return { ok: false, code: 'REMOTE_UNSUPPORTED', message: '目标电脑的版本不支持远程创建定时任务，请先更新目标电脑' };
          }
        }
        const patch = op === 'update' ? args[1] as Record<string, unknown> | undefined : undefined;
        const needsModelSelection = patch?.modelAgentKind != null;
        const needsLocationSelection = patch && (Object.prototype.hasOwnProperty.call(patch, 'modelAgentDeviceId')
          || ['modelAgentKind', 'model', 'providerId', 'effort'].some((key) => patch[key] === null));
        if (needsModelSelection || needsLocationSelection) {
          const capabilities = await deps.invoke(deviceId, 'maker:get-capabilities', ['claude-code'], { preSend: assertCurrent });
          assertCurrent();
          const supported = capabilities.ok ? capabilities.result as {
            supportsScheduleModelSelection?: boolean;
            supportsScheduleAgentDeviceSelection?: boolean;
          } | null : null;
          if (needsModelSelection && supported?.supportsScheduleModelSelection !== true) {
            return { ok: false, code: 'REMOTE_UNSUPPORTED', message: '目标电脑的版本不支持自动化完整模型选择，请先更新目标电脑' };
          }
          if (needsLocationSelection && !supported?.supportsScheduleAgentDeviceSelection) {
            return { ok: false, code: 'REMOTE_UNSUPPORTED', message: '目标电脑的版本不支持自动化选择远程或分享供应商，请先更新目标电脑' };
          }
        }
        response = await deps.invoke(deviceId, CHANNELS[op], args, { preSend: assertCurrent });
      } catch (error) {
        if (error instanceof DeviceLinkError) {
          // inFlight = 请求已发出、回执丢失。
          if (error.inFlight) return unknownOutcome(op);
          return failure(error.code, error.message);
        }
        const message = error instanceof Error ? error.message : '';
        if (/\[DEVICE_LINK_CONTROL_DISABLED]/.test(message))
          return failure('REMOTE_DISABLED', message);
        // 发送前的本机拒绝以 [CODE] 前缀抛出，与对端 IPC 错误共用同一解析。
        const classified = failure('IPC_ERROR', message);
        return classified.code === 'INTERNAL'
          ? { ok: false, code: 'REMOTE_UNAVAILABLE', message: '暂时无法连接目标电脑' }
          : classified;
      }
      try {
        assertCurrent();
      } catch {
        // 请求已发出、本机账号随后切换：回执属于上一个账号，不读取。
        return unknownOutcome(op);
      }
      if (!response.ok) {
        if (
          response.error.code === 'IPC_ERROR' &&
          (response.error.message.includes(POST_HANDLER_REJECTION) ||
            (WRITE_OPS.has(op) && !isRejectedBeforeWrite(response.error.message)))
        ) {
          return unknownOutcome(op);
        }
        return failure(response.error.code, response.error.message);
      }
      if (op === 'list' || op === 'list-runs') {
        if (!Array.isArray(response.result)) {
          return {
            ok: false,
            code: 'REMOTE_INVALID_RESPONSE',
            message: '目标电脑返回了无法识别的结果',
          };
        }
      }
      return { ok: true, data: response.result ?? null };
    },
  };
}
