/**
 * xdt-helper/list_workers.ts —— 列出当前 workflow 所有 worker。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, ControlWorkerEngine } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface WorkerSummary {
  workerId: string;
  sessionId: string;
  role: string;
  /** 'acp' = 插件引擎 Worker。 */
  agent: ControlWorkerEngine;
  model: string;
  effort: string | null;
  label: string | null;
  status: 'idle' | 'running' | 'done' | 'error';
  focused: boolean;
  idleSince: string | null;
}

export interface ListWorkersDeps {
  sessionId: string | undefined;
  getSessionContext?: () => {
    sessionId?: string;
  };
  listWorkers: (params: { leadSessionId: string }) => Promise<
    ControlResult<{ workers: WorkerSummary[] }>
  >;
}

const DESCRIPTION =
  '列出当前 team 所有 worker(role/agent/label/status/focused)。focused=true 是当前 UI 展示的。';

export function registerListWorkersTool(
  registry: XdtHelperToolRegistry,
  deps: ListWorkersDeps,
): void {
  registry.register({
    name: 'list_workers',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {},
    handler: async () => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead。');
      }
      const result = await deps.listWorkers({ leadSessionId: ctx.sessionId });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload('INTERNAL', result.message);
      }
      return okPayload({
        workers: result.workers,
        count: result.workers.length,
      });
    },
  });
}
