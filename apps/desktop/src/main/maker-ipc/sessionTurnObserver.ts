import type { Session } from '@cindy/maker-core';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { verdictForModelRoute } from '../maker-host/model-route-guard-live.js';
import { SilentStopTurnLeaseGate, SessionTurnLeaseTracker } from './sessionTurnLease.js';

export interface InstallSessionTurnObserverDeps {
  readonly silentStopTurnLeaseGate: Pick<
    SilentStopTurnLeaseGate,
    'supersede' | 'schedule' | 'supersedeOwnedBy'
  >;
  readonly sessionTurnLeaseTracker: Pick<
    SessionTurnLeaseTracker,
    'markTurnStarted' | 'markTurnEnded'
  >;
  readonly providerTurnLeaseId: (sessionInstanceId: string, turnGeneration: number) => string;
  readonly log: Pick<ReturnType<typeof createLogger>, 'debug'>;
}

export function installSessionTurnObserver(deps: InstallSessionTurnObserverDeps, session: Session) {
  session.setTurnLifecycleObserver({
    beforeProviderStart: async (turnGeneration) => {
      if (session.remoteHostId) return;
      // 每条本地 Session.send 都经过这一个 Main-owned 边界，包括 renderer、IM、
      // Goal、Learn、Hook 与 Scheduler。付费权限不能只挂在普通 IPC 发送事务上。
      const model = session.model;
      if (model) {
        const verdict = await verdictForModelRoute(
          session.agentKind,
          model,
          getSessionProvider(session.id),
        );
        // beforeProviderStart 已经进入 Session 内部，无法再安全重建跨凭证形态的
        // runtime。付费 reroute 不能当作 pass，否则 null-provider 仍会落到已锁定
        // 的 XD 默认来源。普通停用/能力/独占 reroute 属于既有 best-effort 轴，
        // 运行中会话按 model-route-guard 契约不在这里打断。
        if (verdict.kind === 'reroute' && verdict.reason === 'payment-required') {
          throwIpcError(
            'INVALID_PARAMS',
            `model "${model}" must switch to provider "${verdict.providerId}" before sending`,
          );
        }
        if (verdict.kind === 'reject' && verdict.reason === 'payment-required') {
          throwIpcError('PERMISSION_DENIED', `model "${model}" requires paid access`);
        }
      }
      deps.silentStopTurnLeaseGate.supersede(session.id);
      // Keep Review's exact-instance liveness listener lazy. PID-only turn
      // leases remain fail-closed until this process actually starts Review.
      await deps.sessionTurnLeaseTracker.markTurnStarted(
        session.id,
        deps.providerTurnLeaseId(session.instanceId, turnGeneration),
      );
    },
    onUndispatched: async (turnGeneration) => {
      if (session.remoteHostId) return;
      await deps.sessionTurnLeaseTracker.markTurnEnded(
        session.id,
        deps.providerTurnLeaseId(session.instanceId, turnGeneration),
      );
    },
    onTerminal: ({ turnGeneration, event, isCurrentGeneration }) => {
      if (session.remoteHostId) return;
      const turnLeaseId = deps.providerTurnLeaseId(session.instanceId, turnGeneration);
      const isSilentStop =
        event.type === 'done' &&
        (event.data as { silentStop?: unknown } | null | undefined)?.silentStop === true;
      if (isSilentStop && isCurrentGeneration) {
        // The provider turn ended, but the product turn remains occupied while
        // the bounded auto-resume decision runs. Its exact lease is either
        // replaced by the next provider generation or released by settle.
        const scheduled = deps.silentStopTurnLeaseGate.schedule(session.id, event, turnLeaseId);
        if (!scheduled) {
          deps.log.debug('ignored duplicate silent-stop terminal for the current turn', {
            sessionId: session.id,
            turnLeaseId,
          });
        }
        return;
      }
      if (isCurrentGeneration) deps.silentStopTurnLeaseGate.supersede(session.id);
      void deps.sessionTurnLeaseTracker.markTurnEnded(session.id, turnLeaseId);
    },
  });
  return () => {
    session.setTurnLifecycleObserver(null);
    deps.silentStopTurnLeaseGate.supersedeOwnedBy(session.id, `${session.instanceId}:`);
    void deps.sessionTurnLeaseTracker.markTurnEnded(session.id);
  };
}
