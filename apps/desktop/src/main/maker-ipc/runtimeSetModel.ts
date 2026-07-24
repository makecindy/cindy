import type { AgentKind } from '@cindy/maker-core';

import { getSessionProvider, setSessionProvider } from '../maker-host/session-provider-store.js';
// type-only import:编译期擦除,不会把 codex-proxy-host 的运行时依赖拖进本模块/单测。
import type { CodexProxyAuthInjection } from '../maker-host/codex-proxy-host.js';
import {
  CredentialModeSwitchBusyError,
  isCredentialModeSwitchBusyError,
  isLocalSessionBusy,
  prepareLocalSessionCredentialModeSwitch,
  shouldCloseSessionForCredentialSwitch,
} from '../maker-host/codex-credential-switch.js';

interface RuntimeSetModelSession {
  agentKind: AgentKind;
  remoteHostId?: string | null;
  codexProxyActive?: boolean | null;
  model: string;
  setModel: (model: string) => Promise<void>;
}

interface RuntimeSetModelActiveSession {
  id: string;
  agentKind: AgentKind;
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

export interface RuntimeSetModelMaker {
  getSession: (sessionId: string) => RuntimeSetModelSession | undefined;
  listActiveSessions: () => RuntimeSetModelActiveSession[];
  closeSession: (sessionId: string) => Promise<void>;
}

interface RuntimeSetModelLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ApplyRuntimeSetModelChangeInput {
  maker: RuntimeSetModelMaker;
  sessionId: string;
  model: string;
  providerId?: string | null;
  isSessionInTurn?: (sessionId: string) => boolean;
  /**
   * 会话自己正在跑 turn 时的延迟生效登记(PendingCredentialSwitchService.register)。
   * 未注入时退回旧 fail-closed 行为(抛 busy)——只有 register.ts 主链路注入。
   */
  registerPendingCredentialSwitch?: (
    sessionId: string,
    target: { model: string; providerId: string | null },
  ) => void;
  /**
   * 「无需切换」分支清掉旧 pending(后选覆盖先选)。典型场景:deferred 登记后
   * renderer 持久化失败发起回滚 set-model、用户改选回与当前进程同族的来源、或
   * model-only 变更后 pending 的目标形态与当前进程重新同族(如从骨折模型切回
   * 普通模型)—— 不清会让已被放弃的 pending 在 turn 结束时照样生效。
   */
  clearPendingCredentialSwitch?: (sessionId: string, opts?: { wake?: boolean }) => void;
  /**
   * 空闲切换分支收尾唤醒:关会话 + 写新 route 完成后恢复该会话输入队列的派发。
   * 不能依赖 clear 钩子的默认唤醒 —— 那发生在 close **之前**,drain 会趁 await
   * 窗口把队首派发到还活着的旧会话/旧凭证上(review P2 2026-07-04)。
   */
  wakeSessionInputQueue?: (sessionId: string) => void;
  /**
   * 读取该会话当前登记的 pending 目标。model-only 调用(providerId=undefined)时
   * pending.providerId 代表用户已选定、尚未生效的来源意图,必须以它为基准评估新
   * 模型是否仍需切换 —— 仍需则更新 pending 的模型,不需则取消 pending(review
   * P1 2026-07-04:骨折模型 pending 后切回普通模型,旧实现不清 pending)。
   */
  getPendingCredentialSwitch?: (
    sessionId: string,
  ) => { model: string; providerId: string | null } | undefined;
  /**
   * 当前本地 Codex spawn 的鉴权注入形态(getCodexProxyAuthInjectionState())。
   * shouldCloseSessionForCredentialSwitch 用它解析隐式来源的凭证家族,精确判定
   * 是否跨「远端压缩身份」边界;不传时该判定按未知保守处理(倾向关会话重建)。
   */
  codexAuthInjection?: CodexProxyAuthInjection | null;
  logger?: RuntimeSetModelLogger;
}

export type ApplyRuntimeSetModelChangeResult =
  /** 直接生效(热切 route / 或已关会话待下次发送重建)。 */
  | { status: 'applied' }
  /** 凭证形态要换但会话自己在跑:已登记 pending,turn 结束后自动生效。 */
  | { status: 'deferred' };

/**
 * 应用本地运行时 model/provider 切换。
 *
 * provider route 写在 sess.setModel 前,因为运行时切模型可能立即读取路由；若后续
 * setModel 失败,这里负责把 route 恢复到旧值,避免 renderer 看到失败但下一轮已走新来源。
 *
 * 凭证形态切换(shouldCloseSessionForCredentialSwitch=true)语义:
 *   - 会话空闲 → 只关**本会话**(claude / codex 一致;codex 共享 host 的重启延迟到
 *     下一次发送的 getHost 仲裁,其它 codex 会话不再被一刀切 close——它们继续跑旧
 *     形态,直到各自也需要切换)。
 *   - 会话在跑 → 登记 pending(见 PendingCredentialSwitchService),turn 结束自动
 *     生效;不再拒绝丢弃用户选择(2026-07-04 实报:切换被拒未察觉,数小时后发消息
 *     才发现来源仍是旧值)。
 * 即使凭证形态可复用，Codex 跨 provider 的 route 也不能 mid-turn 改写：一个 turn
 * 可能包含多次上游请求，统一延迟到 turn 边界，避免后续工具回合误路由。
 */
export async function applyRuntimeSetModelChange(
  input: ApplyRuntimeSetModelChangeInput,
): Promise<ApplyRuntimeSetModelChangeResult> {
  const { maker, sessionId, model, providerId, isSessionInTurn, logger } = input;
  const sess = maker.getSession(sessionId);
  const currentProviderId = getSessionProvider(sessionId);
  // model-only 调用以 pending 的 providerId 为「当前来源意图」:用户先 deferred 选了
  // 新来源、再换模型时,决策与登记都要沿用那个来源,不能回落到 store 里的旧值
  // (否则会把 pending 的来源覆盖丢)。
  const pendingTarget =
    providerId === undefined ? input.getPendingCredentialSwitch?.(sessionId) : undefined;
  const nextProviderId =
    providerId !== undefined
      ? typeof providerId === 'string' ? providerId : null
      : pendingTarget !== undefined
        ? pendingTarget.providerId
        : currentProviderId;
  const shouldCloseSession = sess
    ? shouldCloseSessionForCredentialSwitch({
        agentKind: sess.agentKind,
        remoteHostId: sess.remoteHostId,
        currentProviderId,
        nextProviderId,
        currentModel: sess.model,
        nextModel: model,
        currentCodexProxyActive: sess.codexProxyActive,
        codexAuthInjection: input.codexAuthInjection,
      })
    : false;
  let selfBusyMemo: boolean | undefined;
  const isSelfBusy = (): boolean => {
    if (selfBusyMemo !== undefined) return selfBusyMemo;
    const active = maker
      .listActiveSessions()
      .find((candidate) => candidate.id === sessionId);
    selfBusyMemo = active
      ? isLocalSessionBusy(active, isSessionInTurn)
      : isSessionInTurn?.(sessionId) === true;
    return selfBusyMemo;
  };

  if (
    sess?.agentKind === 'codex' &&
    !sess.remoteHostId &&
    !shouldCloseSession &&
    currentProviderId !== nextProviderId &&
    isSelfBusy()
  ) {
    // 超集 host 可以跨来源复用，不代表 route 可以在 turn 中途热切。Codex 的一个
    // turn 可能包含多次上游请求；立即改 provider store 会让后续工具回合带着旧
    // wire model 命中新来源，造成同 turn 跨计费，甚至因模型不受支持而 4xx。
    // 把 route/model 的生效边界固定在 turn 结束；pending 收口只关闭本 Session，
    // shared host 保留，不重新 spawn app-server。
    if (input.registerPendingCredentialSwitch) {
      input.registerPendingCredentialSwitch(sessionId, {
        model,
        providerId: nextProviderId,
      });
      logger?.info('set-model: Codex provider route switch deferred until turn end', {
        sessionId,
        currentProviderId,
        nextProviderId,
        fromModel: sess.model,
        toModel: model,
      });
      return { status: 'deferred' };
    }
    throw new CredentialModeSwitchBusyError(
      [sessionId],
      `Cannot switch Codex provider route while the session is busy: ${sessionId}`,
    );
  }

  if (sess && shouldCloseSession) {
    if (isSelfBusy() && input.registerPendingCredentialSwitch) {
      input.registerPendingCredentialSwitch(sessionId, {
        model,
        providerId: nextProviderId,
      });
      logger?.info('set-model: credential switch deferred until turn end', {
        sessionId,
        agentKind: sess.agentKind,
        currentProviderId,
        nextProviderId,
        fromModel: sess.model,
        toModel: model,
      });
      return { status: 'deferred' };
    }
    // 关会话前先清可能存在的 stale pending(后选覆盖先选):close 会触发宿主的
    // onSessionClosed 钩子,pending 若还在会被它以**旧目标**抢先 finalize 并广播,
    // 与本次显式选择打架(review P1 2026-07-04 第三轮);先清让两条 apply 路径读到
    // undefined 提前返回,本分支随后同步写入新 route。wake:false —— 此刻唤醒会让
    // drain 趁下面 await close 的窗口把队首派发到旧会话/旧凭证上,唤醒挪到收尾。
    input.clearPendingCredentialSwitch?.(sessionId, { wake: false });
    try {
      await prepareLocalSessionCredentialModeSwitch({
        maker,
        sessionId,
        isSessionInTurn,
      });
    } catch (err) {
      // 空闲判定与 close 之间的竞态(恰好起了新 turn):有 pending 通道就转延迟,
      // 没有(老调用方)保持抛 busy 的旧语义。
      if (isCredentialModeSwitchBusyError(err) && input.registerPendingCredentialSwitch) {
        input.registerPendingCredentialSwitch(sessionId, {
          model,
          providerId: nextProviderId,
        });
        logger?.info('set-model: credential switch deferred after busy race', {
          sessionId,
          agentKind: sess.agentKind,
        });
        return { status: 'deferred' };
      }
      throw err;
    }
    if (providerId !== undefined) setSessionProvider(sessionId, nextProviderId);
    // close + route 都落定后再唤醒队列:排队消息按新凭证形态 lazy-create 派发。
    input.wakeSessionInputQueue?.(sessionId);
    logger?.info('set-model: closed live session after credential mode switch', {
      sessionId,
      agentKind: sess.agentKind,
      currentProviderId,
      nextProviderId,
      fromModel: sess.model,
      toModel: model,
    });
    return { status: 'applied' };
  }

  if (providerId !== undefined) {
    setSessionProvider(sessionId, nextProviderId);
    // 显式选源且无需切换 → 取消尚未兑现的 pending(后选覆盖先选)。
    input.clearPendingCredentialSwitch?.(sessionId);
  } else if (pendingTarget !== undefined) {
    // model-only 变更 + 已有 pending:能走到无需切换分支,说明按 pending 来源 +
    // 新模型评估后凭证形态已与当前进程同族(典型:骨折模型 pending 后切回普通
    // 模型)→ 切换意图不复存在,取消 pending(review P1)。
    input.clearPendingCredentialSwitch?.(sessionId);
    logger?.info('set-model: cancelled stale pending credential switch after model-only change', {
      sessionId,
      pendingProviderId: pendingTarget.providerId,
      toModel: model,
    });
  }
  if (!sess) {
    logger?.debug('set-model: session not found, no-op', { sessionId });
    return { status: 'applied' };
  }
  try {
    await sess.setModel(model);
  } catch (err) {
    if (providerId !== undefined) {
      setSessionProvider(sessionId, currentProviderId);
    }
    throw err;
  }
  return { status: 'applied' };
}
