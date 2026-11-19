/**
 * The entries to the pending credential switch of a task (register.ts): register a switch the busy
 * runtime cannot take now, clear it, wake the task's input after one is applied inline, and read its
 * target. Moved verbatim out of register.ts so the Node Host registers and reads the same switch.
 *
 * Ports: the service and the input coordinator (register.ts holders, read when each call starts, as
 * the bodies read them), the task's engine as its message persistence knows it, and getMaker
 * (messagePersistBroadcaster.desktop.ts and maker-host/index.ts load Electron).
 */
import type { Maker } from '@cindy/maker-core';
import { eq } from 'drizzle-orm';
import { dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { getSessionProvider } from '../maker-host/session-provider-store.js';
import type { AgentInputCoordinator } from './agent-input-coordinator.desktop.js';
import type { PendingCredentialSwitchService } from './pendingCredentialSwitch.js';
import { captureSessionRuntimeControlOwnerEpoch } from './sessionRuntimeControl.js';

export interface PendingCredentialSwitchAccessPorts {
  pendingCredentialSwitchHolder: PendingCredentialSwitchService | null;
  agentInputCoordinatorHolder: Pick<AgentInputCoordinator, 'wakeSession'> | null;
  getSessionDbAgentKind: (sessionId: string) => 'cc' | 'codex' | 'pi' | null;
  getMaker: () => Maker;
}

export async function registerPendingCredentialSwitchWith(
  ports: PendingCredentialSwitchAccessPorts,
  sessionId: string,
  target: { model: string; providerId: string | null; forceSessionRebuild?: boolean; selectionSource?: 'agent' },
): Promise<void> {
  const { pendingCredentialSwitchHolder, getSessionDbAgentKind, getMaker } = ports;
  const service = pendingCredentialSwitchHolder;
  if (!service) {
    throw new Error('Pending credential switch service is not initialized');
  }
  // 捕获会话 agent:deferred 切换在收口时刻要重过停用裁决(期间目标可能被停用,
  // PR #744 review 第七轮);读不到(会话行缺失)则登记不带 agentKind = 收口不裁决。
  const dbAgentKind = getSessionDbAgentKind(sessionId);
  // 捕获切换前的运行路由:model 用 live handle(热切过未落库时比 DB 权威),来源用
  // provider store;effort / fast 无 live getter,从 DB 行读 —— renderer 在收到
  // deferred 结果**之后**才落盘请求值,本函数在 IPC 回包之前执行,此刻行里仍是
  // 切换前值,无竞态。目标在等待期间被全停且目录无启用兜底时,收口按整套
  // previousRoute 回滚(model/provider/effort/fast 一致成对,第十六、十八轮)。
  // deferred 场景会话正在跑 turn,live handle 必在;取不到就不带 = 无从回滚。
  const live = getMaker().getSession(sessionId);
  let prevRow: {
    model: string | null;
    effort: string | null;
    fastMode: boolean | 'ultrafast' | null;
    providerId: string | null;
  } | null = null;
  try {
    const [row] = await getDbClient()
      .drizzle.select({
        model: sessions.model,
        effort: sessions.effort,
        fastMode: sessions.fastMode,
        providerId: sessions.providerId,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    prevRow = row ?? null;
  } catch {
    prevRow = null;
  }
  const prevModel = live?.model ?? prevRow?.model ?? null;
  service.register(sessionId, {
    ...target,
    ownerEpoch: captureSessionRuntimeControlOwnerEpoch(),
    ...(dbAgentKind ? { agentKind: dbToMakerAgentKind(dbAgentKind) } : live?.agentKind ? { agentKind: live.agentKind } : {}),
    ...(prevModel
      ? {
          previousRoute: {
            model: prevModel,
            providerId: getSessionProvider(sessionId) ?? prevRow?.providerId ?? null,
            ...(prevRow?.effort ? { effort: prevRow.effort } : {}),
            ...(prevRow?.fastMode != null ? { fastMode: prevRow.fastMode } : {}),
          },
        }
      : {}),
  });
}

export function clearPendingCredentialSwitchWith(
  ports: PendingCredentialSwitchAccessPorts,
  sessionId: string,
  opts?: { wake?: boolean },
): void {
  const { pendingCredentialSwitchHolder, agentInputCoordinatorHolder } = ports;
  pendingCredentialSwitchHolder?.clear(sessionId);
  // pending 门解除后 coordinator 没有其它唤醒源；wake:false 由调用方在
  // close + route 写入完成后显式唤醒，避免队首趁窗口派发到旧凭证。
  if (opts?.wake !== false) {
    agentInputCoordinatorHolder?.wakeSession(sessionId, 'pending-credential-switch-cancelled');
  }
}

export function wakeSessionInputAfterCredentialSwitchWith(
  ports: PendingCredentialSwitchAccessPorts,
  sessionId: string,
): void {
  const { agentInputCoordinatorHolder } = ports;
  agentInputCoordinatorHolder?.wakeSession(sessionId, 'credential-switch-applied-inline');
}

export function getPendingCredentialSwitchTargetWith(
  ports: PendingCredentialSwitchAccessPorts,
  sessionId: string,
): { model: string; providerId: string | null; forceSessionRebuild?: boolean; selectionSource?: 'agent' } | undefined {
  const { pendingCredentialSwitchHolder } = ports;
  const pending = pendingCredentialSwitchHolder?.get(sessionId);
  return pending ? { model: pending.model, providerId: pending.providerId,
    ...(pending.forceSessionRebuild ? { forceSessionRebuild: true } : {}),
    ...(pending.selectionSource ? { selectionSource: pending.selectionSource } : {}) } : undefined;
}

/** register.ts's settlePendingCredentialSwitch (a task's turn settled), with its holder and logger. */
export function settlePendingCredentialSwitchWith(
  ports: {
    pendingCredentialSwitchHolder: PendingCredentialSwitchService | null;
    log: { warn(message: string, meta?: Record<string, unknown>): void };
  },
  sessionId: string,
  source: string,
): void {
  const { pendingCredentialSwitchHolder, log } = ports;
  const pending = pendingCredentialSwitchHolder?.onTurnSettled(sessionId);
  if (!pending) return;
  void pending.catch((err) => {
    log.warn('pending credential switch settle failed', {
      sessionId,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
