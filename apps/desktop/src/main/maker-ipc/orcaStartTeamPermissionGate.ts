import type { OrcaWorkerPermissionMode } from '../../shared/orca-worker-permission-mode.js';
import type { OrcaWorkerPermissionConfirmDecision } from './orcaWorkerPermissionConfirmBridge.js';

export interface OrcaStartTeamPermissionGateParams {
  leadSessionId: string;
  workerPermissionMode?: OrcaWorkerPermissionMode;
}

interface OrcaStartTeamPermissionGateDeps<TResult> {
  getCurrentWorkerPermissionMode: () => OrcaWorkerPermissionMode;
  requestFullAccessConfirmation: (
    leadSessionId: string,
  ) => Promise<OrcaWorkerPermissionConfirmDecision>;
  startTeam: (params: OrcaStartTeamPermissionGateParams) => Promise<TResult>;
}

export type OrcaStartTeamPermissionGateResult<TResult> =
  TResult | { ok: false; errorCode: 'USER_CANCELLED' | 'CONFIRM_TIMEOUT'; message: string };

/**
 * Agent tool 把 Worker 默认权限提升为 Full access 前的 Main 侧门禁。
 *
 * lifecycle.startTeam 同时负责更新偏好和创建 Team，因此必须在用户确认成功后才能调用。
 */
export async function startOrcaTeamWithPermissionGate<TResult>(
  params: OrcaStartTeamPermissionGateParams,
  deps: OrcaStartTeamPermissionGateDeps<TResult>,
): Promise<OrcaStartTeamPermissionGateResult<TResult>> {
  const requiresConfirmation =
    deps.getCurrentWorkerPermissionMode() !== 'bypassPermissions' &&
    params.workerPermissionMode === 'bypassPermissions';
  if (requiresConfirmation) {
    const decision = await deps.requestFullAccessConfirmation(params.leadSessionId);
    if (!decision.confirmed) {
      return {
        ok: false,
        errorCode: decision.reason === 'timeout' ? 'CONFIRM_TIMEOUT' : 'USER_CANCELLED',
        message:
          decision.reason === 'timeout'
            ? 'Worker Full access 确认超时，本次未更新默认权限，也未开启协同。'
            : '用户未确认 Worker Full access，本次未更新默认权限，也未开启协同。',
      };
    }
  }
  return deps.startTeam(params);
}
