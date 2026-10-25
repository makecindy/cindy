export * from '@cindy/orca-workflow/host/orcaRemoteWorkerHost';
import type { OrcaRemoteWorkerOpenRequest } from '@cindy/device-link';
import type { OrcaRemoteWorkerHostDeps } from '@cindy/orca-workflow/host/orcaRemoteWorkerHost';
import type { OpenedSessionRow, openSession } from '../localDb/sessionOpening.js';

/** 先以同一 INSERT 保存任务和来源，再启动 Agent；启动失败也保留可幂等核对的身份。 */
export function createOrcaRemoteWorkerSessionOpener(deps: {
  openSession: typeof openSession;
  insertSession(row: OpenedSessionRow): Promise<void>;
  bootstrapSession(row: OpenedSessionRow, assertCurrent: () => void): Promise<unknown>;
  broadcastSessionCreated(sessionId: string): void;
  isSelfDeviceId?(deviceId: string): boolean;
  resolveAgentSelection?(request: OrcaRemoteWorkerOpenRequest): Promise<OrcaRemoteWorkerOpenRequest>;
  captureOwner?(): () => void;
}): OrcaRemoteWorkerHostDeps['openSession'] {
  return async (request, lead) => {
    const assertOwner = deps.captureOwner?.() ?? (() => {});
    assertOwner();
    if (request.agentDeviceId && deps.isSelfDeviceId?.(request.agentDeviceId)) {
      request = { ...request, agentDeviceId: null };
    }
    if (request.agentDeviceId) {
      if (!deps.resolveAgentSelection) fail('UNSUPPORTED_CAPABILITY', 'remote Worker Agent selection is unavailable');
      request = await deps.resolveAgentSelection(request);
      assertOwner();
    }
    const { row } = await deps.openSession({
      id: request.sessionId,
      assertCurrent: assertOwner,
      body: {
        title: request.title,
        agentKind: request.agentKind === 'claude-code' ? 'cc' : request.agentKind,
        model: request.model,
        providerId: request.providerId,
        ...(request.agentDeviceId !== undefined ? { agentDeviceId: request.agentDeviceId } : {}),
        effort: request.effort,
        fastMode: request.fastMode,
        permissionMode: request.permissionMode,
        workspaceKind: request.workingDir ? 'project' : 'dialogue',
        workingDir: request.workingDir,
        orcaRemoteLead: lead,
      },
    }, async (opened, assertCurrent) => {
      assertCurrent();
      await deps.insertSession(opened);
      assertCurrent();
      await deps.bootstrapSession(opened, assertCurrent);
    });
    deps.broadcastSessionCreated(row.id);
    const agentKind = row.agentKind === 'cc' ? 'claude-code' : (row.agentKind as 'codex' | 'pi');
    return { workingDir: row.workingDir ?? '', model: row.model, agentKind, effort: row.effort, fastMode: row.fastMode,
      ...(request.agentDeviceId !== undefined ? { agentDeviceId: row.agentDeviceId ?? null, providerId: row.providerId ?? null } : {}) };
  };
}

function fail(code: string, message: string): never { throw new Error(`[${code}] ${message}`); }
