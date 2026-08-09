import { z } from 'zod';

import type { SchedulerToolRegistry } from '../cindy_schedulerToolRegistry.js';
import type { CodexAutomationRecord, SchedulerMcpDeps } from '../types.js';
import { buildJsonResult } from './_shared.js';
import { classifySchedulerError } from './errors.js';

function errorResult(error: unknown) {
  const { code, message } = classifySchedulerError(error);
  return buildJsonResult(
    {
      ok: false,
      code,
      message: code === 'INTERNAL' ? 'Unable to read system Codex automations' : message,
    },
    true,
  );
}

function withoutSourcePath(record: CodexAutomationRecord): Omit<CodexAutomationRecord, 'sourcePath'> {
  const { sourcePath: _sourcePath, ...publicRecord } = record;
  void _sourcePath;
  return publicRecord;
}

export function registerCodexAutomationTools(
  registry: SchedulerToolRegistry,
  deps: SchedulerMcpDeps,
): void {
  const service = deps.codexAutomation;
  if (!service) return;

  registry.register({
    name: 'codex_automation_list',
    category: 'scheduler',
    description:
      '只读列出系统 Codex CLI 的已安排任务。返回完整摘要（名称、prompt、RRULE、模型、推理档位、工作目录和诊断）；不执行、不修改 Codex 文件。',
    inputShape: {},
    handler: async () => {
      try {
        const records = await service.list();
        return buildJsonResult({ ok: true, data: records.map(withoutSourcePath) });
      } catch (error) {
        return errorResult(error);
      }
    },
  });

  registry.register({
    name: 'codex_automation_get',
    category: 'scheduler',
    description:
      '只读获取一条系统 Codex CLI 自动化的完整配置，尤其是完整 prompt。未知 id 返回 NOT_FOUND；不执行、不修改 Codex 文件。',
    inputShape: {
      id: z.string().min(1).describe('自动化 id（来自 codex_automation_list）'),
    },
    handler: async ({ id }) => {
      try {
        const item = await service.get(id);
        if (!item) {
          return buildJsonResult(
            {
              ok: false,
              code: 'NOT_FOUND',
              message: `Codex automation ${id} not found`,
            },
            true,
          );
        }
        return buildJsonResult({ ok: true, data: withoutSourcePath(item) });
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
