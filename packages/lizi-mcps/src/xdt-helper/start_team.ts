/**
 * xdt-helper/start_team.ts —— 启动 multi-worker workflow, 为当前 Lead session
 * 创建 orca workflow 记录。
 *
 * 与旧粗粒度入口不同: 本工具不创建 worker (改由 create_worker 负责),
 * 也不接受 delegate_task 参数 (派活改用 send_to_worker)。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import { okPayload, errorPayload } from './_payload.js';

export interface StartTeamDeps {
  sessionId: string | undefined;
  vendorOptions: Record<string, unknown> | undefined;
  getSessionContext?: () => {
    sessionId?: string;
    vendorOptions?: Record<string, unknown>;
  };
  startTeam: (params: { leadSessionId: string }) => Promise<
    ControlResult<{ teamId: string }>
  >;
}

const DESCRIPTION =
  '为当前 session 创建 orca team, 进入多 worker 协同模式。' +
  '失败码: LEAD_NOT_SUPPORTED / WORKER_CANNOT_NEST / ALREADY_ENABLED。' +
  '注:start_team 开启的是 session 级、持久、UI 可见的多 worker 协同。若用户要的是一个 subagent(一次性、用完即弃的子任务执行体),请用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task 工具),不要为此 start_team 开协同。' +
  'Orca 协同永远不是 subagent 的替代品;你没有原生 subagent 机制时,如实告知用户并请他决定,不要拿 Orca 顶替,也不要自己起进程冒充。';

export function registerStartTeamTool(
  registry: XdtHelperToolRegistry,
  deps: StartTeamDeps,
): void {
  registry.register({
    name: 'start_team',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {},
    handler: async () => {
      const ctx = deps.getSessionContext?.() ?? deps;
      if (!ctx.sessionId) {
        return errorPayload(
          'LEAD_NOT_SUPPORTED',
          `当前 MCP 调用没有绑定 ${BRAND_NAME} session, 无法作为 Lead 启动协同。`,
        );
      }
      const role = ctx.vendorOptions?.orcaRole;
      if (role === 'worker') {
        return errorPayload(
          'WORKER_CANNOT_NEST',
          'start_team 是 Orca worker 协同入口,不是 subagent 入口。若用户明确要求 subagent / 子代理,请使用你自己的原生 subagent 机制(如 Codex 的 spawn_agent、Claude Code 的 Task/Agent 工具),不要使用 Orca start_team / create_worker。没有原生 subagent 机制时如实告知用户,Orca 协同不是它的替代品。',
        );
      }
      if (role === 'lead') {
        return errorPayload(
          'ALREADY_ENABLED',
          '当前 session 已是 Lead, 已有 active workflow。',
        );
      }

      const result = await deps.startTeam({ leadSessionId: ctx.sessionId });
      if (!result.ok) {
        if (result.errorCode === 'HOST_NOT_READY') {
          return errorPayload('HOST_NOT_READY', `${BRAND_NAME} 主进程协同服务尚未就绪。`);
        }
        return errorPayload('INTERNAL', result.message);
      }

      return okPayload({
        team_id: result.teamId,
        reused: (result as Record<string, unknown>).reused === true,
      });
    },
  });
}
