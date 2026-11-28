/**
 * [INPUT]: depends on MAKER_INVOKE, the live Session stopWorkflowAgent method and shared IPC errors
 * [OUTPUT]: exports registerStopWorkflowAgentHandler for exact Workflow child cancellation
 * [POS]: the maker-ipc adapter for stopping one Workflow Agent without touching its siblings
 * [PROTOCOL]: Update this header on change, then check CLAUDE.md
 */

import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export interface StopWorkflowAgentHandlerDeps {
  assertCaller(event: unknown): void;
  getLiveSession(
    sessionId: string,
  ): { stopWorkflowAgent(workflowTaskId: string, agentId: string): Promise<void> } | undefined;
}

function requiredId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > 256) {
    throwIpcError('INVALID_PARAMS', `${name} required`);
  }
}

/**
 * 单 Agent 停止刻意使用独立 channel:旧被控端只识别顶层 STOP_AGENT_TASK,
 * 若复用并追加参数,旧 handler 会忽略参数而停止整个 Workflow。新 channel 在旧端
 * 返回 CHANNEL_NOT_ALLOWED,由 Renderer 提示升级;会话已卸载则进程已死,幂等成功。
 */
export function registerStopWorkflowAgentHandler(
  registry: IpcHandlerRegistry,
  deps: StopWorkflowAgentHandlerDeps,
): void {
  registry.handle(
    MAKER_INVOKE.STOP_WORKFLOW_AGENT,
    async (event, sessionId: unknown, workflowTaskId: unknown, agentId: unknown) => {
      deps.assertCaller(event);
      requiredId(sessionId, 'sessionId');
      requiredId(workflowTaskId, 'workflowTaskId');
      requiredId(agentId, 'agentId');

      const session = deps.getLiveSession(sessionId);
      if (!session) return { ok: true as const };
      try {
        await session.stopWorkflowAgent(workflowTaskId, agentId);
        return { ok: true as const };
      } catch (error) {
        if (isIpcError(error)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (
          (error instanceof Error && error.name === 'NotSupportedError') ||
          /not supported/i.test(message)
        ) {
          throwIpcError(
            'UNSUPPORTED_CAPABILITY',
            'stopWorkflowAgent is not supported for this session',
          );
        }
        throwIpcError('INTERNAL', 'failed to stop Workflow Agent');
      }
    },
  );
}
