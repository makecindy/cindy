import {
  canReuseCodexHostForCredentialMode,
  canReuseHostForCredentialMode,
  isCindyProviderCodexRemoteCompactionRoute,
  resolveAgentCredentialMode,
  type AgentCredentialMode,
  type AgentKind,
} from '@cindy/maker-core';

import { claudeToolSearchMode } from './claude-behavior-flags.js';
import {
  CODEX_CINDY_COMPACT_PROVIDER_ID,
  CODEX_GATEWAY_PROVIDER_ID,
  CODEX_OPENAI_COMPACT_PROVIDER_ID,
} from './codex-gateway-config.js';
import type { CodexProxyAuthInjection } from './codex-proxy-host.js';
import { withRehydrateCloseSuppressed } from './rehydrateCloseSuppression.js';

export interface ShouldCloseSessionForCredentialSwitchInput {
  agentKind: AgentKind;
  remoteHostId?: string | null;
  currentProviderId: string | null;
  nextProviderId: string | null;
  currentModel: string;
  nextModel: string;
  /**
   * 当前 Codex host 是否明确经 loopback proxy 出口。
   * provider-oauth 依赖 proxy 做供应商 OAuth 注入和 model rewrite；未知状态按 false 处理。
   */
  currentCodexProxyActive?: boolean | null;
  /**
   * 当前 Codex thread 由 app-server 的 start/resume 响应确认的 model provider。
   * 它是 thread 级冻结身份，不能用可能已被 UI 提前覆盖的 provider store 代替。
   */
  currentCodexThreadModelProviderId?: string | null;
  /** 当前 host 的独立 Subagent 路由是否兼容 Cindy Codex 远程压缩。 */
  currentCodexCindyRemoteCompactionCompatible?: boolean | null;
  /**
   * 当前本地 Codex app-server spawn 的鉴权注入形态(getCodexProxyAuthInjectionState())。
   * 用于把隐式来源(resolveAgentCredentialMode 解析出 undefined)落到实际凭证家族,
   * 让「远端压缩身份边界」判定更精确。不传 / null 时按未知处理:隐式一侧无法证明
   * 不跨边界,凡与另一侧家族不同即保守关会话重建(正确性优先于热切)。
   */
  codexAuthInjection?: CodexProxyAuthInjection | null;
}

/** spawn 鉴权注入形态 → 会话凭证家族(与 resolveAgentCredentialMode 值域同构)。 */
function credentialFamilyFromAuthInjection(
  injection: CodexProxyAuthInjection | null | undefined,
): AgentCredentialMode | undefined {
  if (injection === 'oauth-bearer') return 'oauth-bearer';
  if (injection === 'env-key') return 'gateway-key';
  if (injection === 'provider-oauth') return 'provider-oauth';
  return undefined;
}

interface LocalAgentSession {
  id: string;
  agentKind: AgentKind;
  remoteHostId?: string | null;
  isTurnRunning?: () => boolean;
}

interface LocalCredentialModeSwitchMaker {
  listActiveSessions: () => LocalAgentSession[];
  closeSession: (sessionId: string) => Promise<void>;
}

export interface PrepareLocalCodexCredentialModeSwitchInput {
  maker: LocalCredentialModeSwitchMaker;
  isSessionInTurn?: (sessionId: string) => boolean;
  signal?: AbortSignal;
  /** 仅用于错误信息可观测性:本次切换的方向(fromMode → toMode)。 */
  fromMode?: string;
  /** 当前 host 的归一化生效形态(fromMode 是原始登记值,隐式来源时为 undefined)。 */
  fromModeEffective?: string;
  toMode?: string;
}

export interface PrepareLocalCodexCredentialModeSwitchResult {
  closedSessionIds: string[];
}

export interface PrepareLocalSessionCredentialModeSwitchInput {
  maker: LocalCredentialModeSwitchMaker;
  sessionId: string;
  isSessionInTurn?: (sessionId: string) => boolean;
  signal?: AbortSignal;
}

export interface PrepareLocalSessionCredentialModeSwitchResult {
  closedSessionIds: string[];
}

export class CredentialModeSwitchBusyError extends Error {
  readonly sessionIds: string[];

  constructor(sessionIds: string[], message = `Cannot switch credential mode while local session(s) are busy: ${sessionIds.join(', ')}`) {
    super(message);
    this.name = 'CredentialModeSwitchBusyError';
    this.sessionIds = sessionIds;
  }
}

export class CodexCredentialModeSwitchBusyError extends CredentialModeSwitchBusyError {
  constructor(
    sessionIds: string[],
    modes?: { fromMode?: string; fromModeEffective?: string; toMode?: string },
  ) {
    // 方向必须进 message:排查"为什么要切"时日志里只有这一条现场证据
    // (2026-07-03 排队假死实报中因缺方向信息多绕了一轮)。fromMode 是原始登记值,
    // 隐式来源会显示成 fallback、掩盖 host 实际钥匙形态 —— 归一化形态可用且与原始
    // 值不同时以它为主、原始值括注(2026-07-04 实排:"fallback -> gateway-key"还得
    // 靠 ps 看进程参数才能确认 host 实际是 OAuth)。
    const fromRaw = modes?.fromMode ?? 'fallback';
    const fromDisplay =
      modes?.fromModeEffective && modes.fromModeEffective !== modes?.fromMode
        ? `${modes.fromModeEffective}(registered: ${fromRaw})`
        : fromRaw;
    const direction = modes?.fromMode || modes?.fromModeEffective || modes?.toMode
      ? ` (${fromDisplay} -> ${modes?.toMode ?? 'fallback'})`
      : '';
    super(
      sessionIds,
      `Cannot switch Codex credential mode${direction} while local Codex session(s) are busy: ${sessionIds.join(', ')}`,
    );
    this.name = 'CodexCredentialModeSwitchBusyError';
  }
}

export function isCredentialModeSwitchBusyError(
  err: unknown,
): err is CredentialModeSwitchBusyError {
  return err instanceof CredentialModeSwitchBusyError;
}

function normalizeProviderId(providerId: string | null | undefined): string | null {
  const trimmed = providerId?.trim();
  return trimmed || null;
}

/**
 * app-server 已确认的 Codex thread provider 是否与指定路由期望的身份冲突。
 *
 * 调用方可把「下一目标路由」传进来判断是否需要重建，也可把「当前 provider store
 * 路由」传进来区分 store/thread 已经错配，避免把仅需关闭单个 thread 的修复扩大成
 * shared-host 凭证切换。
 */
export function isCodexThreadModelProviderIdentityMismatch(
  input: ShouldCloseSessionForCredentialSwitchInput,
): boolean {
  if (
    input.remoteHostId ||
    input.agentKind !== 'codex' ||
    input.currentCodexProxyActive !== true
  ) {
    return false;
  }

  const nextProviderId = normalizeProviderId(input.nextProviderId);
  const nextMode = resolveAgentCredentialMode({
    agentKind: input.agentKind,
    providerId: nextProviderId,
    model: input.nextModel,
  });
  const effectiveNextMode = nextMode ?? credentialFamilyFromAuthInjection(input.codexAuthInjection);
  const expectedThreadModelProviderId =
    isCindyProviderCodexRemoteCompactionRoute({
      providerId: nextProviderId,
      model: input.nextModel,
    })
      ? input.currentCodexCindyRemoteCompactionCompatible === false
        ? CODEX_GATEWAY_PROVIDER_ID
        : CODEX_CINDY_COMPACT_PROVIDER_ID
      : effectiveNextMode === 'oauth-bearer'
      ? CODEX_OPENAI_COMPACT_PROVIDER_ID
      : effectiveNextMode !== undefined
        ? CODEX_GATEWAY_PROVIDER_ID
        : null;
  const actualThreadModelProviderId = normalizeProviderId(
    input.currentCodexThreadModelProviderId,
  );
  const actualThreadIdentityKnown =
    actualThreadModelProviderId === CODEX_OPENAI_COMPACT_PROVIDER_ID ||
    actualThreadModelProviderId === CODEX_CINDY_COMPACT_PROVIDER_ID ||
    actualThreadModelProviderId === CODEX_GATEWAY_PROVIDER_ID;

  return (
    actualThreadIdentityKnown &&
    expectedThreadModelProviderId !== null &&
    actualThreadModelProviderId !== expectedThreadModelProviderId
  );
}

function isLocalSession(session: LocalAgentSession): boolean {
  return !session.remoteHostId;
}

function isLocalCodexSession(session: LocalAgentSession): boolean {
  return session.agentKind === 'codex' && !session.remoteHostId;
}

/**
 * 本地会话「凭证切换视角」的 busy 判定:live session 自报 turn 运行中,或宿主的
 * turn 活动 tracker 认为在 turn 内。runtimeSetModel / PendingCredentialSwitchService
 * 与本模块共用这一份定义 —— busy 语义变化(如未来纳入 steer/interrupt 中间态)
 * 只改这里。
 */
export function isLocalSessionBusy(
  session: Pick<LocalAgentSession, 'id' | 'isTurnRunning'>,
  isSessionInTurn?: (sessionId: string) => boolean,
): boolean {
  return session.isTurnRunning?.() === true || isSessionInTurn?.(session.id) === true;
}

const isSessionBusy = isLocalSessionBusy;

function throwIfCredentialSwitchAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('credential mode switch aborted');
  }
}

/**
 * Pi loopback proxy identity that must agree across request header
 * `x-cindy-pi-provider-id`, `registerPiProxySession`, and `sessions.provider_id`.
 *
 * Cindy gateway (`xd` / `cindy` / unset) sends no provider header. Native
 * subscription and BYOM sources pin that id. Pi `set_model` does not reread
 * spawn-time `models.json`, so crossing this identity on a live process leaves
 * a stale header and the proxy returns 403 `pi_provider_mismatch`.
 */
export function piProxyProviderIdentity(
  providerId: string | null | undefined,
): string | null {
  const normalized = normalizeProviderId(providerId);
  if (!normalized || normalized === 'xd' || normalized === 'cindy') return null;
  return normalized;
}

/**
 * 判断运行中的本地会话是否必须关闭后重建。
 *
 * provider route 可以在空闲时或 turn 边界热切，但 agent 子进程的凭证形态是 spawn-time 状态；
 * 只要旧/新来源解析出的 credential family 不同，就不能继续复用当前进程。
 * Pi 还要额外对齐 proxy 供应商身份：Grok/xAI 与 GPT/OpenAI 同属
 * `provider-oauth`，但活进程仍会带旧 `x-cindy-pi-provider-id`。
 */
export function shouldCloseSessionForCredentialSwitch(
  input: ShouldCloseSessionForCredentialSwitchInput,
): boolean {
  if (input.remoteHostId) return false;

  const currentProviderId = normalizeProviderId(input.currentProviderId);
  const nextProviderId = normalizeProviderId(input.nextProviderId);
  if (
    input.agentKind === 'pi'
    && piProxyProviderIdentity(currentProviderId) !== piProxyProviderIdentity(nextProviderId)
  ) {
    return true;
  }
  const currentMode = resolveAgentCredentialMode({
    agentKind: input.agentKind,
    providerId: currentProviderId,
    model: input.currentModel,
  });
  const nextMode = resolveAgentCredentialMode({
    agentKind: input.agentKind,
    providerId: nextProviderId,
    model: input.nextModel,
  });

  // Tool Search 是 Claude 子进程的 spawn-time env。跨越上游 capability 边界时即使
  // provider-oauth 凭证家族可复用，也必须重建本会话，不能把旧 flag 热切到新来源。
  if (
    input.agentKind === 'claude-code' &&
    claudeToolSearchMode(currentProviderId, currentMode) !==
      claudeToolSearchMode(nextProviderId, nextMode)
  ) {
    return true;
  }

  // ── 远端压缩身份边界(codex, proxy-active)────────────────────────────────
  // oauth spawn 的订阅直连 thread 以 OpenAI 身份 provider 创建(codex 据此走
  // OpenAI 远端压缩),而 provider 身份是 thread 级冻结、settings/update 改不了;
  // 网关 / xAI 等上游不支持远端压缩且失败无本地回退。因此凡切换跨过
  // oauth-bearer(订阅直连)家族边界,必须关会话、由下一次发送按新路由 resume
  // 重建 thread(resume 会按新家族重新决定 provider 身份)。这有意收窄了
  // 方案 A 的「oauth 超集 host 热切 gateway-key / provider-oauth 会话」范围:
  // host 仍复用不重建,只是该会话自身要走关闭重建。隐式来源解析不出家族且
  // 未提供 codexAuthInjection 时按未知处理 → 与另一侧不同即保守关闭。
  if (input.agentKind === 'codex' && input.currentCodexProxyActive === true) {
    const fallbackFamily = credentialFamilyFromAuthInjection(input.codexAuthInjection);
    const effCurrent = currentMode ?? fallbackFamily;
    const effNext = nextMode ?? fallbackFamily;

    // provider store 可能先于运行时切换被 UI/持久层覆盖。此时仅比较 currentMode/nextMode
    // 会把两边误判为同一家族，并在仍绑定 cindy_openai 的 thread 上热切 DeepSeek/xAI/XD。
    // start/resume 响应才是 thread 身份的事实源；与目标身份不一致就必须 close + resume。
    if (isCodexThreadModelProviderIdentityMismatch(input)) {
      return true;
    }
    const mayTouchRemoteCompaction =
      effCurrent === 'oauth-bearer' || effNext === 'oauth-bearer' ||
      effCurrent === undefined || effNext === undefined;
    if (effCurrent !== effNext && mayTouchRemoteCompaction) return true;
  }

  if (
    input.agentKind === 'codex' &&
    nextMode === 'provider-oauth' &&
    currentMode !== 'provider-oauth' &&
    input.currentCodexProxyActive !== true
  ) {
    return true;
  }
  if (
    input.agentKind === 'codex' &&
    nextMode === 'provider-oauth' &&
    input.currentCodexProxyActive === true
  ) {
    return false;
  }

  if (input.agentKind === 'codex' && input.currentCodexProxyActive === true) {
    // 方案 A:proxy-active 的 oauth-bearer host 是订阅超集,可直接承载 gateway-key
    // 会话；反向仍不成立。provider-oauth 的既有热切语义由上方分支保留。
    return !canReuseCodexHostForCredentialMode(currentMode, nextMode);
  }

  return !canReuseHostForCredentialMode(currentMode, nextMode);
}

/**
 * 准备切换单个本地 agent 会话的凭证形态。
 *
 * Claude Code 是 per-session 子进程：只需要关当前会话，下一次 send 会按新来源重建。
 */
export async function prepareLocalSessionCredentialModeSwitch(
  input: PrepareLocalSessionCredentialModeSwitchInput,
): Promise<PrepareLocalSessionCredentialModeSwitchResult> {
  throwIfCredentialSwitchAborted(input.signal);
  const session = input.maker
    .listActiveSessions()
    .find((candidate) => candidate.id === input.sessionId);
  if (!session || !isLocalSession(session)) return { closedSessionIds: [] };
  if (isSessionBusy(session, input.isSessionInTurn)) {
    throw new CredentialModeSwitchBusyError([session.id]);
  }

  await withRehydrateCloseSuppressed(session.id, async () => {
    throwIfCredentialSwitchAborted(input.signal);
    await input.maker.closeSession(session.id);
  });
  return { closedSessionIds: [session.id] };
}

/**
 * 准备切换本地 Codex shared app-server 的凭证形态。
 *
 * shared host 被替换前，所有本地 Codex live session 都必须先退出订阅；
 * 否则底层 host.retire 会杀进程但不会走 Session.close，UI 会留下 busy/stale 状态。
 */
export async function prepareLocalCodexCredentialModeSwitch(
  input: PrepareLocalCodexCredentialModeSwitchInput,
): Promise<PrepareLocalCodexCredentialModeSwitchResult> {
  throwIfCredentialSwitchAborted(input.signal);
  const localCodexSessions = input.maker
    .listActiveSessions()
    .filter(isLocalCodexSession);
  const busySessions = localCodexSessions.filter((session) => isSessionBusy(session, input.isSessionInTurn));
  if (busySessions.length > 0) {
    throw new CodexCredentialModeSwitchBusyError(
      busySessions.map((session) => session.id),
      {
        fromMode: input.fromMode,
        fromModeEffective: input.fromModeEffective,
        toMode: input.toMode,
      },
    );
  }

  const closedSessionIds: string[] = [];
  for (const session of localCodexSessions) {
    throwIfCredentialSwitchAborted(input.signal);
    await withRehydrateCloseSuppressed(session.id, async () => {
      throwIfCredentialSwitchAborted(input.signal);
      await input.maker.closeSession(session.id);
    });
    closedSessionIds.push(session.id);
  }
  return { closedSessionIds };
}
