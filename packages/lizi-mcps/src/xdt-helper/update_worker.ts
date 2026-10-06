/**
 * xdt-helper/update_worker.ts —— 修改已创建 worker 的展示角色名(role)与 team 内唯一标识(label)。
 * 只改身份元数据,不改 Agent/模型/权限,也不重启会话。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface UpdateWorkerDeps {
  getSessionContext?: () => {
    sessionId?: string;
  };
  updateWorker: (params: {
    callerLeadSessionId: string;
    workerId: string;
    role?: string;
    label?: string;
  }) => Promise<
    ControlResult<
      { workerId: string; role: string; label: string | null },
      'WORKER_NOT_FOUND' | 'INVALID_PARAMS' | 'DUPLICATE_LABEL' | 'WORKER_STATE_CHANGED'
    >
  >;
}

const DESCRIPTION =
  '修改已创建 worker 的角色名(role)/标识(label),不改 Agent/模型/权限,也不重启会话。' +
  'worker_id 接受 worker_id 或 session_id 任一(不接受用 label 定位,先 list_workers 取 id)。' +
  'label 是 team 内唯一 slug(字母/数字/连字符/下划线, 1-32 字符); 改名后 send_to_worker / switch_focus 用新 id 定位。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_NOT_FOUND / INVALID_PARAMS / DUPLICATE_LABEL / WORKER_STATE_CHANGED(被活动插件团队计划引用的 label 不允许改)。';

export function registerUpdateWorkerTool(
  registry: XdtHelperToolRegistry,
  deps: UpdateWorkerDeps,
): void {
  registry.register({
    name: 'update_worker',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      worker_id: z
        .string()
        .min(1)
        .describe('目标 worker 的 worker_id 或 session_id 任一'),
      role: z
        .string()
        .min(1)
        .max(32)
        .optional()
        .describe('新的展示角色名(1-32 字符);省略表示不改'),
      label: z
        .string()
        .min(1)
        .max(32)
        .optional()
        .describe('新的 team 内唯一标识(slug: 字母/数字/连字符/下划线, 1-32 字符);省略表示不改'),
    },
    handler: async ({ worker_id, role, label }) => {
      const ctx = deps.getSessionContext?.();
      if (!ctx?.sessionId) {
        return errorPayload('LEAD_NOT_SUPPORTED', '当前 session 类型不支持作为 Lead, 已拒绝 worker 控制操作。');
      }
      if (role === undefined && label === undefined) {
        return errorPayload('INVALID_PARAMS', 'role or label required');
      }
      const result = await deps.updateWorker({
        callerLeadSessionId: ctx.sessionId,
        workerId: worker_id,
        ...(role !== undefined ? { role } : {}),
        ...(label !== undefined ? { label } : {}),
      });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload(result.errorCode, result.message);
      }
      return okPayload({
        worker_id: result.workerId,
        role: result.role,
        label: result.label,
        instruction: 'Worker identity updated.',
      });
    },
  });
}
