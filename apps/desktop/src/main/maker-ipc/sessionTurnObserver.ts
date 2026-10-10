import type { Session } from '@cindy/maker-core';
import { publishChannelTurn } from './channelTurnSignal';
import { MANAGED_LLAMACPP_PROVIDER_ID } from '../../shared/llamaCpp.js';
import { ensureManagedOllamaReadyForSession } from '../local-model-runtime/preflight.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import { isProviderShareAgentDeviceId } from '../../shared/providerShare.js';
import { verdictForModelRoute } from '../maker-host/model-route-guard-live.js';
import { describeModelRouteRejection } from '../maker-host/model-route-guard.js';
import { SilentStopTurnLeaseGate, SessionTurnLeaseTracker } from './sessionTurnLease.js';

export interface InstallSessionTurnObserverDeps {
  readonly beforeLocalProviderStart?: (session: Session) => Promise<void>;
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
      if (session.remoteHostId) {
        await publishChannelTurn(session, 'starting');
        return;
      }
      await deps.beforeLocalProviderStart?.(session);
      // 每条本地 Session.send 都经过这一个 Main-owned 边界，包括 renderer、IM、
      // Goal、Learn、Hook 与 Scheduler。付费权限不能只挂在普通 IPC 发送事务上。
      // Agent 在另一台电脑（含 `share:` 分享来源）上运行时，所选来源在对端目录里；本机目录查不到
      // 它不代表来源失效。来源可用性只放过这一种拒绝，provider 原样保留。
      const providerOnOtherDevice = session.agentDeviceId !== null;
      // 付费门禁按**这次调用的记账主体**执行：`share:` 会话的模型请求只由分享者电脑上的 Agent
      // 用分享者的登录与供应商发出（docs/product-rules/provider-sharing.md §1、§9.2/§9.3），
      // 分享借出的就是分享者的模型额度；受邀者本机目录的 requires_payment 是受邀者自己账号的
      // 标记，裁决不到分享者的额度上，不能拿来拦记在分享者账上的请求。同账号另一台电脑仍由
      // 同一账号付费，门禁照常执行。
      const chargedToShareHost = isProviderShareAgentDeviceId(session.agentDeviceId);
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
        if (
          !chargedToShareHost
          && verdict.kind === 'reroute'
          && verdict.reason === 'payment-required'
        ) {
          throwIpcError(
            'INVALID_PARAMS',
            `model "${model}" must switch to provider "${verdict.providerId}" before sending`,
          );
        }
        if (
          !chargedToShareHost
          && verdict.kind === 'reject'
          && verdict.reason === 'payment-required'
        ) {
          throwIpcError('PERMISSION_DENIED', `model "${model}" requires paid access`);
        }
        if (
          verdict.kind === 'reject'
          && verdict.reason === 'explicit-source-unavailable'
          && !providerOnOtherDevice
        ) {
          throwIpcError('INVALID_PARAMS', describeModelRouteRejection(verdict.reason, model, getSessionProvider(session.id)));
        }
      }
      // Existing tasks must restore the managed service after a manual stop too.
      // Reuse the common send boundary so IM/Goal/Scheduler get the same behavior.
      const providerId = getSessionProvider(session.id);
      if (!providerOnOtherDevice && providerId === MANAGED_LLAMACPP_PROVIDER_ID) {
        await ensureManagedOllamaReadyForSession({ providerId, onlyIfStopped: true });
      }
      deps.silentStopTurnLeaseGate.supersede(session.id);
      // Keep Review's exact-instance liveness listener lazy. PID-only turn
      // leases remain fail-closed until this process actually starts Review.
      await deps.sessionTurnLeaseTracker.markTurnStarted(
        session.id,
        deps.providerTurnLeaseId(session.instanceId, turnGeneration),
      );
      await publishChannelTurn(session, 'starting');
    },
    onUndispatched: async (turnGeneration) => {
      await publishChannelTurn(session, 'undispatched');
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
        if (scheduled) session.claimHostTurnContinuation(turnGeneration);
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
