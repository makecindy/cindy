import type { AgentKind } from '@cindy/maker-core';

import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type { IpcErrorCode } from '../../shared/ipc-errors.js';
import {
  type MakerSessionCreateOpts,
  readCreateSessionOpts,
  withCreateSessionStderr,
} from './sessionRequest.js';
import { isCredentialModeSwitchBusyError } from '../maker-host/codex-credential-switch.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/**
 * remote-claude-route 抛出的 [REMOTE_*] 前缀错误 → 共享 IPC 错误码。
 * 纯字符串匹配,不引入 maker-core 类型(避免 main 侧耦合)。
 */
function remoteRouteErrorCode(err: unknown): IpcErrorCode | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('[REMOTE_PROVIDER_UPDATING]')) return 'REMOTE_PROVIDER_UPDATING';
  if (msg.includes('[REMOTE_PROVIDER_UNSUPPORTED]')) return 'REMOTE_PROVIDER_UNSUPPORTED';
  if (msg.includes('[REMOTE_NATIVE_OAUTH_UNAVAILABLE]')) return 'REMOTE_NATIVE_OAUTH_UNAVAILABLE';
  // 轮 40-w4-t3 HIGH:远端 Pi 会话启动时 Cindy AI gateway endpoint 未就绪 ——
  // maker-core 抛 [REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE](含 raw 实现细节
  // runtimeConfig.remoteEndpoint is empty)。不映射会让用户看到不可操作的英文
  // raw message;映射后 renderer 走已存在 5 语言的
  // logic.errors.remoteError.REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE 文案(引导去
  // Settings → Model Providers 检查 Cindy AI 状态)。
  if (msg.includes('[REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE]')) return 'REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE';
  // 轮 42 P2:远端 Pi 选了 loopback-only BYOM provider —— 创建即拒绝, renderer
  // 走 logic.errors.remoteError.REMOTE_LOCAL_ONLY_PROVIDER 文案(引导换网关或
  // 远端可达的 BYOM 端点)。
  if (msg.includes('[REMOTE_LOCAL_ONLY_PROVIDER]')) return 'REMOTE_LOCAL_ONLY_PROVIDER';
  return null;
}

export interface MakerSessionCreateResultSession {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  capabilities: unknown;
}

/**
 * CREATE_SESSION adapter 只拥有 IPC 边界逻辑；创建事务仍由 register.ts 注入，
 * 避免把 Orca / project-context / DB 兜底路径压成一个错误抽象。
 */
export interface MakerSessionCreateHandlerDeps<
  TSession extends MakerSessionCreateResultSession = MakerSessionCreateResultSession,
> {
  bootstrapSession(opts: MakerSessionCreateOpts): Promise<{
    session: TSession;
    didInjectOrcaInstructions: boolean;
    didInjectProjectContext: boolean;
  }>;
  markOrcaRoleIfNeeded(
    sessionId: string,
    orcaRole: MakerSessionCreateOpts['orcaRole'],
  ): Promise<void>;
  markKnownNonOrcaIfApplicable(sessionId: string, opts: MakerSessionCreateOpts): void;
  allocateDialogueWorkspace?: (sessionId: string, nowMs: number) => string;
  createSessionId?: () => string;
  now?: () => number;
  /**
   * 显式 sessionId 的创建事务锁。device-link 的预创建 worktree 补偿回收使用同一把锁，
   * 防止控制端超时后晚到的 create 与 cleanup 并发，出现「刚落库就被删目录」。
   */
  withSessionLock?: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>;
  sendWorkerReadyMessage(session: TSession): void;
  broadcastSessionCreated(sessionId: string): void;
  logCreateSession(fields: Record<string, unknown>): void;
  warnStderr(agentKind: AgentKind, line: string): void;
}

export function registerMakerSessionCreateHandler<TSession extends MakerSessionCreateResultSession>(
  registry: IpcHandlerRegistry,
  deps: MakerSessionCreateHandlerDeps<TSession>,
): void {
  registry.handle(MAKER_INVOKE.CREATE_SESSION, async (_e, opts: unknown) => {
    const o = withCreateSessionStderr(
      readCreateSessionOpts(opts, {
        allocateDialogueWorkspace: deps.allocateDialogueWorkspace,
        createSessionId: deps.createSessionId,
        now: deps.now,
      }),
      deps.warnStderr,
    );

    const run = async () => {
      let bootstrapped: Awaited<ReturnType<typeof deps.bootstrapSession>>;
      try {
        bootstrapped = await deps.bootstrapSession(o);
      } catch (err) {
        if (isCredentialModeSwitchBusyError(err)) {
          // 独立 code:新建会话撞上凭证切换忙(别的会话在跑),不是"本会话在跑"。
          // renderer 据此走 ipcError.CREDENTIAL_SWITCH_BUSY 专属文案。
          throwIpcError('CREDENTIAL_SWITCH_BUSY', err.message);
        }
        // 远端 Claude 路由 materialization 错误([REMOTE_*] 前缀)映射到独立 code,
        // renderer 按 code 给可操作文案(连接订阅 / 换来源 / 稍后重试),不吞成通用
        // 「创建会话失败」。
        const remoteRouteCode = remoteRouteErrorCode(err);
        if (remoteRouteCode) {
          const msg = err instanceof Error ? err.message : String(err);
          throwIpcError(remoteRouteCode, msg);
        }
        throw err;
      }
      const { session, didInjectOrcaInstructions, didInjectProjectContext } = bootstrapped;

      deps.logCreateSession({
        agentKind: o.agentKind,
        model: o.model,
        fastMode: o.fastMode ?? 'default',
        workDir: o.workingDir,
        providedId: !!o.id,
        usedOrcaInstructions: didInjectOrcaInstructions,
        usedProjectContext: didInjectProjectContext,
        extraDirsCount: o.extraDirs?.length ?? 0,
      });

      if (o.orcaRole === 'lead') {
        await deps.markOrcaRoleIfNeeded(session.id, o.orcaRole);
      }
      deps.markKnownNonOrcaIfApplicable(session.id, o);
      if (o.orcaRole === 'worker' && !o.resumeSessionId) {
        deps.sendWorkerReadyMessage(session);
      }
      deps.broadcastSessionCreated(session.id);

      return {
        sessionId: session.id,
        agentKind: session.agentKind,
        workDir: session.workDir,
        capabilities: session.capabilities,
        usedProjectContext: didInjectProjectContext,
      };
    };

    const explicitSessionId = typeof o.id === 'string' && o.id ? o.id : null;
    return explicitSessionId && deps.withSessionLock
      ? deps.withSessionLock(explicitSessionId, run)
      : run();
  });
}
