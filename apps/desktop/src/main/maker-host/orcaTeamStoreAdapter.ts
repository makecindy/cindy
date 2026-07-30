import type { OrcaBridgeMcpDeps, OrcaWorkerLink } from '@cindy/orca-workflow';

import type { OrcaWorkerLinkRecord, OrcaWorkerStatus } from '../localDb/orcaTeamStore.js';

export interface DesktopOrcaTeamStoreAdapterDeps {
  getWorkerLink(input: { workerId?: string; workerSessionId?: string }): Promise<OrcaWorkerLinkRecord | null>;
  updateWorkerStatus(workerId: string, status: OrcaWorkerStatus): Promise<void>;
  markKnownOrcaWorkerSession(workerSessionId: string): void;
  broadcastOrcaWorkerChanged(leadSessionId: string): void;
  logger: { debug(message: string, meta?: Record<string, unknown>): void };
}

export function createDesktopOrcaTeamStoreAdapter(
  deps: DesktopOrcaTeamStoreAdapterDeps,
): NonNullable<OrcaBridgeMcpDeps['orcaTeamStore']> {
  return {
    getWorkerLink: async (input: { workerId?: string; workerSessionId?: string }) => {
      const link = await deps.getWorkerLink(input);
      if (!link) return null;
      // 懒重建 known worker 集合：app 重启后内存集合清零，worker bridge
      // 解析 DB link 时顺手幂等登记，确保手动停止仍能命中 worker 中断跟踪。
      deps.markKnownOrcaWorkerSession(link.workerSessionId);
      const leadSession: OrcaWorkerLink['leadSession'] = {
        sessionId: link.leadSession.sessionId,
        agentKind: link.leadSession.agentKind,
        workingDir: link.leadSession.workingDir,
        model: link.leadSession.model,
        providerId: link.leadSession.providerId ?? null,
        effort: link.leadSession.effort as
          | 'minimal'
          | 'low'
          | 'medium'
          | 'high'
          | 'xhigh'
          | 'max',
        permissionMode: link.leadSession.permissionMode as
          | 'ask'
          | 'auto'
          | 'bypassPermissions'
          | 'acceptEdits'
          | 'plan'
          | 'default',
        fastMode: link.leadSession.fastMode,
        sdkSessionId: link.leadSession.sdkSessionId,
        title: link.leadSession.title,
        // 远端 lead 的 host id 必须随快照带出:worker send_to_lead 时 lead 不
        // 活跃, bridge 经 ensureSessionFromMeta 重建 — 缺失会以远端路径在
        // 本机建 session (codex-connector P1)。
        remoteHostId: link.leadSession.remoteHostId ?? null,
      };
      const bridgeLink = {
        workerId: link.workerId,
        teamId: link.teamId,
        // orca-workflow 包内 OrcaWorkerLink 仍保留 workflowId 字段名（MCP 协议
        // 兼容性）：worker MCP tool 暴露的 workflow_id 不应改为 team_id，避免
        // 破坏现有 worker 通信。这里同时传两份，让 desktop 内部用 teamId，orca-workflow 包用 workflowId。
        workflowId: link.teamId,
        workerSessionId: link.workerSessionId,
        leadSessionId: link.leadSessionId,
        leadSession,
      } satisfies OrcaWorkerLink & { teamId: string };
      return bridgeLink;
    },
    updateWorkerStatus: async (workerId: string, status: OrcaWorkerStatus) => {
      await deps.updateWorkerStatus(workerId, status);
      const link = await deps.getWorkerLink({ workerId });
      if (link) {
        deps.broadcastOrcaWorkerChanged(link.leadSessionId);
      } else {
        deps.logger.debug(
          'orcaTeamStoreAdapter.updateWorkerStatus: worker link 未找到，跳过 ORCA_WORKER_CHANGED 广播',
          { workerId },
        );
      }
    },
  };
}
