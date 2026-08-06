/**
 * registerIpc.ts —— learn 功能的 Electron IPC 边界。
 *
 * handler body 全部薄委托 LearnController;错误按规则 13 走 throwIpcError
 * (LearnError.code 直接映射)。查询型 learn:list-runs 走 fallback data 例外
 * (失败返 { runs: [] },renderer 解构空数组继续渲染)。
 */

import { BrowserWindow, ipcMain } from 'electron';

import { createLogger } from '../logger';
import { tapWindowBroadcast } from '../device-link/broadcast-tap';
import { throwIpcError } from '../utils/ipcValidate';
import type { IpcErrorCode } from '../../shared/ipc-errors';
import type {
  LearnEventPayload,
  LearnProposalDiff,
  LearnRunPublic,
  LearnStartRequest,
} from '../../shared/learnTypes';
import { getLearnController } from './index';
import { LearnError } from './controller';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

const log = createLogger('learn-host:ipc');

/** learn:* channel 常量 —— preload 与 renderer 按同名字符串消费。 */
export const LEARN_CHANNELS = {
  START: IPC_CHANNELS.LEARN.START,
  LIST_RUNS: IPC_CHANNELS.LEARN.LIST_RUNS,
  GET_PROPOSAL_DIFF: IPC_CHANNELS.LEARN.GET_PROPOSAL_DIFF,
  APPLY: IPC_CHANNELS.LEARN.APPLY,
  DISCARD: IPC_CHANNELS.LEARN.DISCARD,
  CANCEL: IPC_CHANNELS.LEARN.CANCEL,
  EVENT: IPC_CHANNELS.LEARN.EVENT,
} as const;

/** LearnError.code → IpcErrorCode(同名直传;controller 的 code 集合就是按此设计的)。 */
function rethrow(err: unknown): never {
  if (err instanceof LearnError) {
    // 不强转:LearnError.code 的字面量联合必须是 IpcErrorCode 的子集,新增
    // code 没进枚举会在这里编译报错(规则 13 禁 as 强转绕过)。
    const code: IpcErrorCode = err.code;
    throwIpcError(code, err.message);
  }
  throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
}

function mustController(): NonNullable<ReturnType<typeof getLearnController>> {
  const controller = getLearnController();
  if (!controller) throwIpcError('INTERNAL', 'learn host is not ready');
  return controller;
}

export function broadcastLearnEvent(payload: LearnEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(LEARN_CHANNELS.EVENT, payload);
    } catch {
      // 单窗口挂了不影响其它窗口
    }
  }
  // device-link:旁路给控制端(账号级 → sessions topic,控制端按设备订阅即达;
  // 远程 /learn 的状态卡 / 审查面板据此驱动)。无控制链路时 O(1) no-op。
  tapWindowBroadcast(LEARN_CHANNELS.EVENT, payload);
}

/** 幂等保护:registerLearnIpc 位于 splash 后的可重试注册块内(makerIpcsRegistered
 *  flag 在块尾才置位),后续步骤抛错重试会二次执行到这里 —— ipcMain.handle 同名
 *  二次注册直接 throw,反而让重试永远无法恢复(Greptile review,含复现)。 */
let _learnIpcRegistered = false;

export function registerLearnIpc(): void {
  if (_learnIpcRegistered) return;
  _learnIpcRegistered = true;
  ipcMain.handle(LEARN_CHANNELS.START, async (_event, req: LearnStartRequest) => {
    try {
      return await mustController().startLearn(req);
    } catch (err) {
      rethrow(err);
    }
  });

  // 查询型:learn host 未就绪 / 意外异常时返回空列表 + ready=false,renderer
  // 据此区分"真没有 run"与"启动期还没就绪"(后者需重试恢复状态卡,review 修正)。
  ipcMain.handle(LEARN_CHANNELS.LIST_RUNS, async (): Promise<{ runs: LearnRunPublic[]; ready: boolean }> => {
    try {
      const controller = getLearnController();
      if (!controller) return { runs: [], ready: false };
      return { runs: await controller.listRuns(), ready: true };
    } catch (err) {
      log.warn('list-runs failed (returning empty):', err);
      return { runs: [], ready: false };
    }
  });

  ipcMain.handle(
    LEARN_CHANNELS.GET_PROPOSAL_DIFF,
    async (_event, params: { runId: string }): Promise<LearnProposalDiff> => {
      try {
        return await mustController().getProposalDiff(params.runId);
      } catch (err) {
        rethrow(err);
      }
    },
  );

  ipcMain.handle(LEARN_CHANNELS.APPLY, async (_event, params: { runId: string }) => {
    try {
      return await mustController().apply(params.runId);
    } catch (err) {
      rethrow(err);
    }
  });

  ipcMain.handle(LEARN_CHANNELS.DISCARD, async (_event, params: { runId: string }) => {
    try {
      await mustController().discard(params.runId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  });

  ipcMain.handle(LEARN_CHANNELS.CANCEL, async (_event, params: { runId: string }) => {
    try {
      await mustController().cancel(params.runId);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  });
}
