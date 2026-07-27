/**
 * maker:auth:* IPC 的纯 handler body。
 *
 * Electron adapter 只负责注入 registry 和 broadcast，这里维护参数校验、Maker 调用和
 * push payload 归一化。
 */

import type { AgentKind, AgentLoginMode, AuthState, Maker } from '@cindy/maker-core';

import { optionalEnum, requireEnum, requireObject, throwIpcError } from '../utils/ipcValidate.js';
import { createLogger } from '../logger.js';
import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

const log = createLogger('maker-ipc:authHandlers');

/** main → renderer 的 push 广播能力。 */
export type MakerIpcBroadcast = (channel: string, payload: unknown) => void;

/** IPC 允许的 agent 种类；运行时枚举校验不能靠 TypeScript 强转替代。 */
const AGENT_KINDS = ['claude-code', 'codex'] as const satisfies readonly AgentKind[];
const AGENT_LOGIN_MODES = ['browser', 'device-code'] as const satisfies readonly AgentLoginMode[];
const MAX_LOGIN_PROGRESS_CHARS = 16_384;
const ANSI_SEQUENCE = new RegExp(
  `${String.fromCodePoint(27)}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);

export interface CodexDeviceCodeProgress {
  verificationUrl: string;
  userCode: string;
}

/** Codex CLI 输出带 ANSI 色码；Renderer 只应收到可展示的纯文本。 */
function stripAnsi(value: string): string {
  return value.replace(ANSI_SEQUENCE, '');
}

/**
 * CLI 会把 URL 嵌在自然语言里，句末标点不属于验证地址。成对括号仍可能是 URL
 * 路径的一部分，只移除没有对应左括号的尾部闭合符。
 */
function trimTrailingUrlPunctuation(value: string): string {
  let candidate = value.replace(/[.,;:!?]+$/g, '');
  const pairs = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ] as const;

  while (candidate.length > 0) {
    const pair = pairs.find(([, close]) => candidate.endsWith(close));
    if (!pair) break;
    const [open, close] = pair;
    const openCount = candidate.split(open).length - 1;
    const closeCount = candidate.split(close).length - 1;
    if (closeCount <= openCount) break;
    candidate = candidate.slice(0, -1).replace(/[.,;:!?]+$/g, '');
  }

  return candidate;
}

/**
 * 从 `codex login --device-auth` 的渐进输出提取验证页与一次性代码。
 * 输入可以是不完整的多 chunk 累积文本；两项没齐时返回 null。
 */
export function parseCodexDeviceCodeProgress(text: string): CodexDeviceCodeProgress | null {
  const clean = stripAnsi(text);
  const codeMatch = clean.match(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8})+\b/);
  if (!codeMatch) return null;
  for (const match of clean.matchAll(/https:\/\/[^\s<>"']+/gi)) {
    try {
      const url = new URL(trimTrailingUrlPunctuation(match[0]));
      if (url.protocol === 'https:' && url.hostname === 'auth.openai.com') {
        return { verificationUrl: url.toString(), userCode: codeMatch[0] };
      }
    } catch {
      // CLI prose may trail punctuation after a URL; keep scanning later candidates.
    }
  }
  return null;
}

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
  const loginRequestGeneration = new Map<AgentKind, number>();
  const loginCancellationGeneration = new Map<AgentKind, number>();
  const logoutFinalizations = new Map<AgentKind, Promise<void>>();
  const activeLoginOperations = new Map<
    AgentKind,
    { settled: Promise<void>; requiresDurableDisconnect: boolean }
  >();
  const beginMutation = (kind: AgentKind): number => {
    const generation = (mutationGeneration.get(kind) ?? 0) + 1;
    mutationGeneration.set(kind, generation);
    return generation;
  };
  const isMutationCurrent = (kind: AgentKind, generation: number): boolean =>
    (mutationGeneration.get(kind) ?? 0) === generation;
  const beginLoginRequest = (kind: AgentKind): number => {
    const generation = (loginRequestGeneration.get(kind) ?? 0) + 1;
    loginRequestGeneration.set(kind, generation);
    return generation;
  };
  const isLoginRequestCurrent = (kind: AgentKind, generation: number): boolean =>
    (loginRequestGeneration.get(kind) ?? 0) === generation;
  const beginLoginCancellation = (kind: AgentKind): number => {
    const generation = (loginCancellationGeneration.get(kind) ?? 0) + 1;
    loginCancellationGeneration.set(kind, generation);
    return generation;
  };
  const currentLoginCancellation = (kind: AgentKind): number =>
    loginCancellationGeneration.get(kind) ?? 0;
  const waitForLatestLogoutFinalization = async (kind: AgentKind): Promise<void> => {
    while (true) {
      const observed = logoutFinalizations.get(kind);
      if (!observed) return;
      await observed.catch(() => undefined);
      // A later logout may replace the entry while this login is waiting. Only proceed
      // after the most recently observed finalization has itself settled.
      if (logoutFinalizations.get(kind) === observed) return;
    }
  };

  registry.handle(MAKER_INVOKE.AUTH_GET_STATE, async (_e, agentKind: unknown): Promise<AuthState> => {
    return maker.getAgentAuthState(requireAgentKind(agentKind));
  });

  // presence-only:只回「有没有配 key」,绝不回密钥本体。device-link 控制端(手机 / 远程桌面)
  // 用它决定折扣版(codex/)行是否置灰 —— key 与请求都在被控端,这里才是判定真相。
  registry.handle(MAKER_INVOKE.API_KEY_PRESENT, async (): Promise<{ present: boolean }> => {
    return { present: !!readApiKey() };
  });

  registry.handle(
    MAKER_INVOKE.AUTH_TRIGGER_LOGIN,
    async (_e, agentKind: unknown, rawOptions?: unknown): Promise<AuthState> => {
      const kind = requireAgentKind(agentKind);
      const mode = requireLoginMode(kind, rawOptions);
      let settleOperation!: () => void;
      const activeOperation = {
        settled: new Promise<void>((resolve) => {
          settleOperation = resolve;
        }),
        requiresDurableDisconnect: false,
      };
      activeLoginOperations.set(kind, activeOperation);
      try {
        // 先登记请求再等待注销收尾，使等待期间到达的 Cancel 也能作废这次登录。
        // 此 generation 与 auth mutation 分离，避免排队登录反过来提前作废正在收尾的 logout。
        const loginGeneration = beginLoginRequest(kind);
        const cancellationGeneration = currentLoginCancellation(kind);
        const invalidatedState = (): AuthState =>
          currentLoginCancellation(kind) !== cancellationGeneration
            ? cancelledAuthState()
            : supersededAuthState();
        // Adapter 会把注销期间到达的登录排在 CLI logout 后面；这里还必须等主进程完成
        // credential bridge / model snapshot 的注销收尾，再建立新的 mutation generation。
        // 否则新登录会提前作废旧 generation，导致注销回调被跳过。
        await waitForLatestLogoutFinalization(kind);
        if (!isLoginRequestCurrent(kind, loginGeneration)) return invalidatedState();
        const generation = beginMutation(kind);
        const isCurrent = (): boolean =>
          isLoginRequestCurrent(kind, loginGeneration) && isMutationCurrent(kind, generation);
        const progressText = { stdout: '', stderr: '', other: '' };
        let emittedDeviceCode = '';
        const result = await maker.triggerAgentLogin(kind, {
          mode,
          onProgress: (msg) => {
            if (!isCurrent()) return;
            broadcast(MAKER_PUSH.AUTH_LOGIN_PROGRESS, toLoginProgressPayload(kind, msg, mode));
            if (kind !== 'codex' || mode !== 'device-code') return;

            const stream = progressStream(msg);
            progressText[stream] = (progressText[stream] + progressDetail(msg)).slice(
              -MAX_LOGIN_PROGRESS_CHARS,
            );
            // stdout / stderr 是互相独立的字节流，只在两条流之间加分隔；同一流的
            // data chunk 必须原样拼接，chunk 边界可能恰好落在 URL 或设备码中间。
            const deviceCode = parseCodexDeviceCodeProgress(
              [progressText.stdout, progressText.stderr, progressText.other].join('\n'),
            );
            if (!deviceCode) return;
            const signature = `${deviceCode.verificationUrl}\n${deviceCode.userCode}`;
            if (signature === emittedDeviceCode) return;
            emittedDeviceCode = signature;
            broadcast(MAKER_PUSH.AUTH_LOGIN_PROGRESS, {
              agentKind: kind,
              phase: 'device-code',
              mode,
              ...deviceCode,
            });
          },
        });
        // Adapter 已返回 OAuth 成功后，pending login 会被清掉；若 Cancel 落在后续模型刷新/
        // bridge 收口阶段，只有 handler 能再建立 durable disconnect。Adapter 自己返回
        // login_cancelled 的路径已在 finalize 内完成必要清理，不能重复 logout。
        activeOperation.requiresDurableDisconnect =
          result.authenticated && result.authSource === 'oauth';
        if (!isCurrent()) return invalidatedState();
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
          if (!isCurrent()) return invalidatedState();
          await onCodexAuthChange?.(true, liveModelsApplied, isCurrent);
          if (!isCurrent()) return invalidatedState();
        }
        broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, ...result });
        return result;
      } finally {
        if (activeLoginOperations.get(kind) === activeOperation) {
          activeLoginOperations.delete(kind);
        }
        settleOperation();
      }
    },
  );

  registry.handle(MAKER_INVOKE.AUTH_CANCEL_LOGIN, async (_e, agentKind: unknown): Promise<void> => {
    const kind = requireAgentKind(agentKind);
    const activeOperation = activeLoginOperations.get(kind);
    // 无在途登录的迟到 Cancel 是彻底的 no-op：既不能翻转已认证状态，也不能推进
    // generation 后误作废正在收尾的 logout。
    if (!activeOperation) return;
    // Cancel is an auth mutation too: invalidate handler-level refresh/finalization work even
    // when the CLI process has already exited and the adapter is reconciling credentials. The
    // separate login request generation also covers a request still queued behind logout.
    beginLoginCancellation(kind);
    const loginGeneration = beginLoginRequest(kind);
    const generation = beginMutation(kind);
    const isCurrent = (): boolean =>
      isLoginRequestCurrent(kind, loginGeneration) && isMutationCurrent(kind, generation);
    maker.cancelAgentLogin(kind);

    // 等被取消 handler 完全退出（含 adapter finalize / model refresh checkpoint），再建立
    // 唯一的取消收口边界。否则旧 handler 可能在这次清理之后迟到写回缓存或成功广播。
    await activeOperation.settled;
    if (!isCurrent()) return;
    if (kind === 'codex') {
      if (activeOperation.requiresDurableDisconnect) {
        try {
          // Cancel 可能落在 adapter 已返回成功、handler 正刷新模型的窗口；此时 adapter 的
          // cancelLogin 已无 pending process，必须显式走 durable logout 才不会留下新 token。
          await maker.logoutAgent(kind);
        } catch (err) {
          throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
        }
      }
      if (!isCurrent()) return;
      await onCodexAuthChange?.(false, false, isCurrent);
    }
    if (!isCurrent()) return;
    broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, {
      agentKind: kind,
      ...cancelledAuthState(),
    });
  });

  registry.handle(MAKER_INVOKE.AUTH_LOGOUT, async (_e, agentKind: unknown): Promise<void> => {
    const kind = requireAgentKind(agentKind);
    const generation = beginMutation(kind);
    const isCurrent = (): boolean => isMutationCurrent(kind, generation);
    const finalization = (async (): Promise<void> => {
      try {
        await maker.logoutAgent(kind);
      } catch (err) {
        throwIpcError('INTERNAL', err instanceof Error ? err.message : String(err));
      }
      if (!isCurrent()) return;
      if (kind === 'codex') await onCodexAuthChange?.(false, false, isCurrent);
      if (!isCurrent()) return;
      broadcast(MAKER_PUSH.AUTH_STATE_CHANGED, { agentKind: kind, authenticated: false });
    })();
    logoutFinalizations.set(kind, finalization);
    try {
      await finalization;
    } finally {
      if (logoutFinalizations.get(kind) === finalization) {
        logoutFinalizations.delete(kind);
      }
    }
  });
}

/** 被更新的 auth mutation 作废时，旧 IPC 调用方不得再把过期成功结果写回 UI。 */
function supersededAuthState(): AuthState {
  return { authenticated: false, errorReason: 'auth_mutation_superseded' };
}

function cancelledAuthState(): AuthState {
  return { authenticated: false, errorReason: 'login_cancelled' };
}

function requireAgentKind(value: unknown): AgentKind {
  return requireEnum(value, AGENT_KINDS, 'agentKind');
}

function requireLoginMode(agentKind: AgentKind, value: unknown): AgentLoginMode {
  const mode =
    value === undefined
      ? 'browser'
      : (optionalEnum(requireObject(value, 'options').mode, AGENT_LOGIN_MODES, 'login mode') ??
        'browser');
  if (agentKind !== 'codex' && mode === 'device-code') {
    throwIpcError('INVALID_PARAMS', 'device-code login is only supported by codex');
  }
  return mode;
}

function progressDetail(msg: string): string {
  if (msg.startsWith('stdout:')) return stripAnsi(msg.slice('stdout:'.length));
  if (msg.startsWith('stderr:')) return stripAnsi(msg.slice('stderr:'.length));
  return stripAnsi(msg);
}

function progressStream(msg: string): 'stdout' | 'stderr' | 'other' {
  if (msg.startsWith('stdout:')) return 'stdout';
  if (msg.startsWith('stderr:')) return 'stderr';
  return 'other';
}

function toLoginProgressPayload(
  agentKind: AgentKind,
  msg: string,
  mode: AgentLoginMode,
): Record<string, unknown> {
  // Codex CLI 会把 OAuth URL 打到 stdout/stderr，两路都归一成 login-pending。
  if (msg.startsWith('stdout:')) {
    return { agentKind, phase: 'login-pending', mode, detail: progressDetail(msg).trim() };
  }
  if (msg.startsWith('stderr:')) {
    return { agentKind, phase: 'login-pending', mode, detail: progressDetail(msg).trim() };
  }
  return { agentKind, phase: stripAnsi(msg), mode };
}
