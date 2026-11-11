/**
 * xdt-helper/archive_worker.ts —— 归档单个 worker (abort + close SDK + archive DB)。
 * 不影响同 workflow 其他 worker。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface ArchiveWorkerDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  archiveWorker: (params: {
    callerLeadSessionId: string;
    workerId: string;
  }) => Promise<ControlResult<{ workerId: string; withdrawnFailureNotices?: number }, 'WORKER_NOT_FOUND'>>;
}

const DESCRIPTION =
  '归档单个 worker(不影响同 team 其他 worker)。归档后该 worker 的上下文不再可用，名字可由新 worker 重新使用；' +
  'worker 只是出错(用量上限、模型不可用等)时不必归档：它原样保留，可直接 send_to_worker 继续，需要时先换模型。' +
  '该 worker 排在你队列里、你还没读到的异常终止回报会一并撤下(withdrawn_failure_notices)，不会再单独唤醒你。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND。';

export function registerArchiveWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: ArchiveWorkerDeps,
): void {
  registry.register({
    name: 'archive_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('要归档的 worker id'),
    },
    handler: async ({ worker_id }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      const result = await deps.archiveWorker({
        callerLeadSessionId: ctx.sessionId,
        workerId: worker_id,
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        instruction: 'Worker archived.',
        ...(result.withdrawnFailureNotices
          ? { withdrawn_failure_notices: result.withdrawnFailureNotices }
          : {}),
      });
    },
  });
}
