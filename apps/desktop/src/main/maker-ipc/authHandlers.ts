/**
 * maker:auth:* IPC 的纯 handler body。
 *
 * Electron adapter 只负责注入 registry 和 broadcast，这里维护参数校验、Maker 调用和
 * push payload 归一化。
 */

import type { AgentKind, AuthState, Maker } from '@cindy/maker-core';

import { requireEnum, throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const log = createLogger('maker-ipc:authHandlers');

/** main → renderer 的 push 广播能力。 */
export type MakerIpcBroadcast = (channel: string, payload: unknown) => void;

/** IPC 允许的 agent 种类；运行时枚举校验不能靠 TypeScript 强转替代。 */
const AGENT_KINDS = ['claude-code', 'codex'] as const satisfies readonly AgentKind[];

export function registerMakerAuthHandlers(
  registry: IpcHandlerRegistry,
  maker: Maker,
  broadcast: MakerIpcBroadcast,
  /** 网关 API key 读取器(host 注入,同 renderer useApiKey 那把 key;handler 只暴露 presence)。 */
  readApiKey: () => string | null,
  /**
   * Codex(OpenAI)账号成功登录/登出后的额外回调(可选,可 async)；参数是边界后的登录态。
   * 生产注入收口(见 auth.ts):live `model/list` 已应用时保留该快照；否则重读
   * models_cache(缺失即清空旧账号清单)。handler 在 AUTH_STATE_CHANGED 广播**之前**
   * await 它 —— renderer 收到广播后 refetch 的必须已是最新目录。
   */
  onCodexAuthChange?: (
    authenticated: boolean,
    liveModelsApplied: boolean,
    isCurrent: () => boolean,
  ) => void | Promise<void>,
): void {
  const mutationGeneration = new Map<AgentKind, number>();
  const beginMutation = (kind: AgentKind): number => {
    const generation = (mutationGeneration.get(kind) ?? 0) + 1;
    mutationGeneration.set(kind, generation);
    return generation;
  };
  const isMutationCurrent = (kind: AgentKind, generation: number): boolean =>
    (mutationGeneration.get(kind) ?? 0) === generation;

  registry.handle(MAKER_INVOKE.AUTH_GET_STATE, async (_e, agentKind: unknown): Promise<AuthState> => {
    return maker.getAgentAuthState(requireAgentKind(agentKind));
  });

  // presence-only:只回「有没有配 key」,绝不回密钥本体。device-link 控制端(手机 / 远程桌面)
  // 用它决定折扣版(codex/)行是否置灰 —— key 与请求都在被控端,这里才是判定真相。
  registry.handle(MAKER_INVOKE.API_KEY_PRESENT, async (): Promise<{ present: boolean }> => {
    return { present: !!readApiKey() };
  });

  registry.handle(MAKER_INVOKE.AUTH_TRIGGER_LOGIN, async (_e, agentKind: unknown): Promise<AuthState> => {
    const kind = requireAgentKind(agentKind);
    const generation = beginMutation(kind);
    const isCurrent = (): boolean => isMutationCurrent(kind, generation);
    const result = await maker.triggerAgentLogin(kind, {
      onProgress: (msg) => {
        if (isCurrent()) {
          broadcast(MAKER_PUSH.AUTH_LOGIN_PROGRESS, toLoginProgressPayload(kind, msg));
        }
      },
    });
    if (!isCurrent()) return supersededAuthState();
    if (kind === 'codex' && result.authenticated && result.authSource === 'oauth') {
      let liveModelsApplied = false;
      try {
        liveModelsApplied = await maker.refreshAgentLocalModels('codex');
      } catch (e) {
        // 登录本身已成功；实时模型发现失败时由 host 回退磁盘快照，不能把登录判失败。
        // 但记异常原因(原先静默吞掉,首登无模型时无从诊断是 app-server 起不来还是
        // model/list RPC 出错)——走统一 logger(规则 12),不影响登录结果。
        log.warn(
          `codex live model refresh threw during login: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      if (!isCurrent()) return supersededAuthState();
      await onCodexAuthChange?.(true, liveModelsApplied, isCurrent);
      if (!isCurrent()) return supersededAuthState();
    }
    broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, ...result });
    return result;
  });

  registry.handle(MAKER_INVOKE.AUTH_CANCEL_LOGIN, async (_e, agentKind: unknown): Promise<void> => {
    maker.cancelAgentLogin(requireAgentKind(agentKind));
  });

  registry.handle(MAKER_INVOKE.AUTH_LOGOUT, async (_e, agentKind: unknown): Promise<void> => {
    const kind = requireAgentKind(agentKind);
    const generation = beginMutation(kind);
    const isCurrent = (): boolean => isMutationCurrent(kind, generation);
    try {
      await maker.logoutAgent(kind);
    } catch (err) {
      throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
    }
    if (!isCurrent()) return;
    if (kind === 'codex') await onCodexAuthChange?.(false, false, isCurrent);
    if (!isCurrent()) return;
    broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, authenticated: false });
  });
}

/** 被更新的 auth mutation 作废时，旧 IPC 调用方不得再把过期成功结果写回 UI。 */
function supersededAuthState(): AuthState {
  return { authenticated: false, errorReason: 'auth_mutation_superseded' };
}

function requireAgentKind(value: unknown): AgentKind {
  return requireEnum(value, AGENT_KINDS, 'agentKind');
}

function toLoginProgressPayload(agentKind: AgentKind, msg: string): Record<string, unknown> {
  // Codex CLI 会把 OAuth URL 打到 stdout/stderr，两路都归一成 login-pending。
  if (msg.startsWith('stdout:')) {
    return { agentKind, phase: 'login-pending', detail: msg.slice('stdout:'.length) };
  }
  if (msg.startsWith('stderr:')) {
    return { agentKind, phase: 'login-pending', detail: msg.slice('stderr:'.length) };
  }
  return { agentKind, phase: msg };
}
