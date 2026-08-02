/**
 * useCodexAuth — ChatGPT/OpenAI OAuth UI hook（走 maker.auth.* Codex IPC）。
 *
 * 系统 Codex CLI 与 Cindy 管理的 OpenAI 连接拥有不同生命周期；本 hook 只管理后者的
 * renderer 状态。登录进度、持久失效原因和初始快照通过确定性状态机合并，避免异步
 * 事件到达顺序改变最终 UI。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import {
  acquireCodexLogin,
  invalidatePendingCodexLogin,
  onCodexLoginStarted,
  type CodexLoginLease,
  type CodexLoginResult,
} from './codexAuthLogin';
import { isCodexOAuthReconnectRequired } from './codexAuthRecovery';

export type CodexUiState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | {
      kind: 'login-pending';
      mode: 'browser' | 'device-code';
      deviceCode?: { verificationUrl: string; userCode: string };
    }
  | {
      kind: 'authenticated';
      identity?: string;
      expiresAt?: number;
      authSource?: 'oauth' | 'api-key';
      credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
    }
  | {
      kind: 'reconnect-required';
      reason: string;
      credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
    }
  | { kind: 'error'; message: string };

export type CodexLoginOutcome = 'authenticated' | 'cancelled' | 'failed' | 'unverified';
export type CodexRecoveryCheck = 'idle' | 'checking' | 'failed';

type CodexAuthMachineState = {
  ui: CodexUiState;
  reconnectReason: string | null;
  reconnectCredentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  /** 成功登录、明确断开或失效广播等持久认证变化的序号。 */
  authRevision: number;
  /** 登录进度和暂时失败也会推进，用于判断初始快照能否替换当前显示。 */
  eventRevision: number;
};

type InitialSnapshotRevision = Pick<CodexAuthMachineState, 'authRevision' | 'eventRevision'>;

type CodexAuthMachineEvent =
  | { type: 'initial-state'; result: CodexLoginResult; requestedAt: InitialSnapshotRevision }
  | { type: 'initial-state-failed'; requestedAt: InitialSnapshotRevision }
  | { type: 'observer-disabled' }
  | {
      type: 'recovery-hint';
      reason: string;
      credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
    }
  | { type: 'state-changed'; result: CodexLoginResult }
  | {
      type: 'login-pending';
      mode: 'browser' | 'device-code';
      deviceCode?: { verificationUrl: string; userCode: string };
    }
  | { type: 'login-progress-error'; message: string }
  | { type: 'login-result'; result: CodexLoginResult }
  | { type: 'login-threw'; message: string }
  | { type: 'recovery-verification-failed' }
  | { type: 'cancelled' }
  | { type: 'logout-success' }
  | { type: 'refreshed-state'; result: CodexLoginResult };

const AGENT_KIND = 'codex' as const;

function createInitialMachineState(): CodexAuthMachineState {
  return {
    ui: { kind: 'loading' },
    reconnectReason: null,
    authRevision: 0,
    eventRevision: 0,
  };
}

function toCodexUiState(raw: CodexLoginResult, preserveGenericError = false): CodexUiState {
  if (raw.authenticated && raw.recoveryRequiredReason) {
    return {
      kind: 'reconnect-required',
      reason: raw.recoveryRequiredReason,
      ...(raw.credentialScope ? { credentialScope: raw.credentialScope } : {}),
    };
  }
  if (raw.authenticated) {
    return {
      kind: 'authenticated',
      identity: raw.identity,
      expiresAt: raw.expiresAt,
      authSource: raw.authSource,
      ...(raw.credentialScope ? { credentialScope: raw.credentialScope } : {}),
    };
  }
  const reason = raw.errorReason;
  if (reason && isCodexOAuthReconnectRequired(reason)) {
    return {
      kind: 'reconnect-required',
      reason,
      ...(raw.credentialScope ? { credentialScope: raw.credentialScope } : {}),
    };
  }
  if (preserveGenericError && reason) {
    return { kind: 'error', message: reason };
  }
  return { kind: 'unauthenticated' };
}

function replaceUi(
  machine: CodexAuthMachineState,
  ui: CodexUiState,
  revision: 'snapshot' | 'event' | 'auth',
): CodexAuthMachineState {
  let reconnectReason = machine.reconnectReason;
  let reconnectCredentialScope = machine.reconnectCredentialScope;
  if (ui.kind === 'reconnect-required') {
    reconnectReason = ui.reason;
    reconnectCredentialScope = ui.credentialScope;
  }
  if (ui.kind === 'authenticated' || ui.kind === 'unauthenticated') {
    reconnectReason = null;
    reconnectCredentialScope = undefined;
  }

  return {
    ui,
    reconnectReason,
    ...(reconnectCredentialScope ? { reconnectCredentialScope } : {}),
    authRevision: machine.authRevision + (revision === 'auth' ? 1 : 0),
    eventRevision: machine.eventRevision + (revision === 'snapshot' ? 0 : 1),
  };
}

function restoreReconnectOr(
  machine: CodexAuthMachineState,
  fallback: CodexUiState,
): CodexAuthMachineState {
  return replaceUi(
    machine,
    machine.reconnectReason
      ? {
          kind: 'reconnect-required',
          reason: machine.reconnectReason,
          ...(machine.reconnectCredentialScope
            ? { credentialScope: machine.reconnectCredentialScope }
            : {}),
        }
      : fallback,
    'event',
  );
}

/**
 * 合并 main 快照、push 广播和本地登录动作的纯状态机。
 *
 * `login-pending` 只是瞬时进度，不能让初始快照完全失效。快照若随后带回持久的
 * OAuth 失效原因，状态机只在后台记住原因并保持 pending 画面；cancel/timeout 到达后
 * 再恢复 reconnect-required。真正较新的成功、失效或明确断开广播仍会让旧快照失效。
 */
function reduceCodexAuthMachine(
  machine: CodexAuthMachineState,
  event: CodexAuthMachineEvent,
): CodexAuthMachineState {
  switch (event.type) {
    case 'observer-disabled':
      // A disabled observer intentionally misses auth broadcasts. Drop the previous
      // activation's snapshot so re-enabling cannot expose stale recovery state while
      // the new authoritative getState() request is still pending.
      if (
        machine.ui.kind === 'loading' &&
        machine.reconnectReason === null &&
        machine.reconnectCredentialScope === undefined &&
        machine.authRevision === 0 &&
        machine.eventRevision === 0
      ) {
        return machine;
      }
      return createInitialMachineState();
    case 'recovery-hint': {
      const reconnectCredentialScope = event.credentialScope ?? machine.reconnectCredentialScope;
      if (machine.ui.kind === 'loading' || machine.ui.kind === 'login-pending') {
        return {
          ...machine,
          reconnectReason: event.reason,
          ...(reconnectCredentialScope ? { reconnectCredentialScope } : {}),
          eventRevision: machine.eventRevision + 1,
        };
      }
      return replaceUi(
        machine,
        {
          kind: 'reconnect-required',
          reason: event.reason,
          ...(reconnectCredentialScope ? { credentialScope: reconnectCredentialScope } : {}),
        },
        'event',
      );
    }
    case 'initial-state': {
      if (machine.authRevision !== event.requestedAt.authRevision) return machine;
      const snapshot = toCodexUiState(event.result);

      if (snapshot.kind === 'reconnect-required') {
        const withReason =
          machine.reconnectReason === snapshot.reason &&
          machine.reconnectCredentialScope === snapshot.credentialScope
            ? machine
            : {
                ...machine,
                reconnectReason: snapshot.reason,
                reconnectCredentialScope: snapshot.credentialScope,
              };
        if (machine.ui.kind === 'login-pending') return withReason;
        return replaceUi(withReason, snapshot, 'snapshot');
      }

      // 进度或暂时失败比请求发起时更新；普通快照不能把当前画面切回去。
      if (
        machine.ui.kind === 'login-pending' ||
        machine.eventRevision !== event.requestedAt.eventRevision
      ) {
        return machine;
      }
      return replaceUi(machine, snapshot, 'snapshot');
    }
    case 'initial-state-failed':
      if (
        machine.authRevision !== event.requestedAt.authRevision ||
        machine.eventRevision !== event.requestedAt.eventRevision ||
        machine.ui.kind === 'login-pending'
      ) {
        return machine;
      }
      return replaceUi(machine, { kind: 'unauthenticated' }, 'snapshot');
    case 'state-changed': {
      if (!event.result.authenticated && event.result.errorReason?.includes('login_cancelled')) {
        return restoreReconnectOr(machine, { kind: 'unauthenticated' });
      }
      const next = toCodexUiState(event.result, true);
      if (next.kind === 'error') return restoreReconnectOr(machine, next);
      return replaceUi(machine, next, 'auth');
    }
    case 'login-pending': {
      const deviceCode =
        event.deviceCode ??
        (machine.ui.kind === 'login-pending' && machine.ui.mode === event.mode
          ? machine.ui.deviceCode
          : undefined);
      return replaceUi(machine, { kind: 'login-pending', mode: event.mode, deviceCode }, 'event');
    }
    case 'login-progress-error': {
      const next = toCodexUiState({ authenticated: false, errorReason: event.message }, true);
      if (next.kind === 'reconnect-required') return replaceUi(machine, next, 'event');
      return restoreReconnectOr(machine, next);
    }
    case 'login-result': {
      if (event.result.authenticated) {
        return replaceUi(machine, toCodexUiState(event.result), 'auth');
      }
      const reason = event.result.errorReason ?? 'login_failed';
      if (reason === 'login_cancelled') {
        return restoreReconnectOr(machine, { kind: 'unauthenticated' });
      }
      const next = toCodexUiState({ ...event.result, errorReason: reason }, true);
      if (next.kind === 'reconnect-required') return replaceUi(machine, next, 'auth');
      return restoreReconnectOr(machine, next);
    }
    case 'login-threw':
      if (event.message.includes('login_cancelled')) {
        return restoreReconnectOr(machine, { kind: 'unauthenticated' });
      }
      return restoreReconnectOr(
        machine,
        toCodexUiState({ authenticated: false, errorReason: event.message }, true),
      );
    case 'recovery-verification-failed':
      return restoreReconnectOr(machine, { kind: 'unauthenticated' });
    case 'cancelled':
      return restoreReconnectOr(machine, { kind: 'unauthenticated' });
    case 'logout-success':
      return replaceUi(machine, { kind: 'unauthenticated' }, 'auth');
    case 'refreshed-state':
      return replaceUi(machine, toCodexUiState(event.result), 'auth');
  }
}

/** ChatGPT 连接只认 OAuth；Cindy AI API key 不能让 OpenAI provider 显示为已连接。 */
export function isChatGptConnectionConnected(
  state: CodexUiState,
  providerConnected: boolean,
): boolean {
  if (state.kind === 'loading') return providerConnected;
  return state.kind === 'authenticated' && state.authSource === 'oauth';
}

export type CodexRecoveryVerification =
  | { status: 'verified' }
  | { status: 'invalid'; state: CodexLoginResult }
  | { status: 'failed' }
  | { status: 'stale' };

type CodexRecoveryVerificationFlight = {
  epoch: number;
  promise: Promise<CodexRecoveryVerification>;
};

let codexCredentialEpoch = 0;
let codexRecoveryVerificationInFlight: CodexRecoveryVerificationFlight | null = null;
const observedCodexAuthEvents = new WeakSet<object>();
let lastObservedCodexAuthFingerprint: string | null = null;

function codexAuthFingerprint(result: CodexLoginResult): string {
  return JSON.stringify([
    result.authenticated,
    result.identity ?? null,
    result.expiresAt ?? null,
    result.errorReason ?? null,
    result.authSource ?? null,
    result.credentialScope ?? null,
    result.recoveryRequiredReason ?? null,
  ]);
}

function observeCodexAuthSnapshot(result: CodexLoginResult): void {
  const fingerprint = codexAuthFingerprint(result);
  if (lastObservedCodexAuthFingerprint === fingerprint) return;
  lastObservedCodexAuthFingerprint = fingerprint;
  codexCredentialEpoch += 1;
}

/** 新登录动作产生新的凭证候选；旧账号级探测即使随后成功也不能证明这次登录已恢复。 */
function beginCodexAuthCredentialAttempt(): void {
  codexCredentialEpoch += 1;
}

onCodexLoginStarted(beginCodexAuthCredentialAttempt);

/** preload 会把同一个 payload fan-out 给多个 hook；按对象去重，只推进一次全局凭证代次。 */
function observeCodexAuthStateEvent(payload: object, result: CodexLoginResult): void {
  if (observedCodexAuthEvents.has(payload)) return;
  observedCodexAuthEvents.add(payload);
  if (result.authenticated || !isCodexOAuthReconnectRequired(result.errorReason)) {
    observeCodexAuthSnapshot(result);
    return;
  }
  lastObservedCodexAuthFingerprint = codexAuthFingerprint(result);
  codexCredentialEpoch += 1;
}

/**
 * 用账号级 app-server RPC 验证 ChatGPT 登录真的可用；本地 auth.json 存在只算候选，
 * 不能直接把失效横幅切成“已恢复”。并发的设置页/横幅观察者共用一次探测。
 */
export function verifyCodexAuthRecovery(
  candidate: CodexLoginResult,
): Promise<CodexRecoveryVerification> {
  observeCodexAuthSnapshot(candidate);
  const epoch = codexCredentialEpoch;
  if (codexRecoveryVerificationInFlight?.epoch === epoch) {
    return codexRecoveryVerificationInFlight.promise;
  }
  const run = (async (): Promise<CodexRecoveryVerification> => {
    let accountRpcVerified = false;
    try {
      await window.electronAPI.maker.usage.getCodexRateLimits();
      accountRpcVerified = true;
    } catch {
      // 继续读取 authoritative auth state：明确再次失效时应立刻返回 invalid；其它失败保留
      // 原提示与手动“重新检测”入口。
    }
    try {
      const state = (await window.electronAPI.maker.auth.getState(AGENT_KIND)) as CodexLoginResult;
      if (epoch !== codexCredentialEpoch) return { status: 'stale' };
      if (!state.authenticated && isCodexOAuthReconnectRequired(state.errorReason)) {
        return { status: 'invalid', state };
      }
      // Main 只有在账号 RPC 对应的 owner / marker / credential 仍未变化，且恢复边界成功
      // 持久化后才会清掉 recoveryRequiredReason。RPC resolve 本身不等于恢复已提交。
      if (accountRpcVerified && state.authenticated && !state.recoveryRequiredReason) {
        return { status: 'verified' };
      }
    } catch {
      // 状态也读不到时仍归为检测失败，保留原失效提示与手动“重新检测”入口。
    }
    return epoch === codexCredentialEpoch ? { status: 'failed' } : { status: 'stale' };
  })().finally(() => {
    if (codexRecoveryVerificationInFlight?.promise === run) {
      codexRecoveryVerificationInFlight = null;
    }
  });
  codexRecoveryVerificationInFlight = { epoch, promise: run };
  return run;
}

/**
 * 将共享 Codex 登录绑定到真实发起它的 React owner。
 *
 * 观察型 useCodexAuth 实例不会获得 lease，因此卸载时不会取消别的窗口发起的登录。
 */
export function useOwnedCodexLogin(): (
  mode?: 'browser' | 'device-code',
) => Promise<CodexLoginResult> {
  const leasesRef = useRef(new Set<CodexLoginLease>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const lease of leasesRef.current) {
        lease.release({ cancelIfLastOwner: true });
      }
      leasesRef.current.clear();
    };
  }, []);

  return useCallback((mode: 'browser' | 'device-code' = 'browser') => {
    if (!mountedRef.current) {
      return Promise.resolve({
        authenticated: false,
        errorReason: 'login_cancelled',
      });
    }
    const lease = acquireCodexLogin(mode);
    leasesRef.current.add(lease);
    return lease.promise
      .then(
        (result) =>
          mountedRef.current ? result : { authenticated: false, errorReason: 'login_cancelled' },
        (error) => {
          if (!mountedRef.current) {
            return { authenticated: false, errorReason: 'login_cancelled' };
          }
          throw error;
        },
      )
      .finally(() => {
        if (!leasesRef.current.delete(lease)) return;
        lease.release();
      });
  }, []);
}

export function useCodexAuth(options?: {
  enabled?: boolean;
  /** 已经被会话错误证明失效，但 Main 的本地快照可能尚未带 marker。 */
  recoveryHint?: {
    reason: string;
    credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  };
}) {
  const enabled = options?.enabled ?? true;
  const recoveryHintReason = isCodexOAuthReconnectRequired(options?.recoveryHint?.reason)
    ? options?.recoveryHint?.reason
    : undefined;
  const recoveryHintCredentialScope = options?.recoveryHint?.credentialScope;
  const { t } = useTranslation();
  const [machine, setMachine] = useState<CodexAuthMachineState>(createInitialMachineState);
  const [recoveryCheck, setRecoveryCheck] = useState<CodexRecoveryCheck>('idle');
  const machineRef = useRef(machine);
  const verificationGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const observerEpochRef = useRef(0);
  const observerEnabledRef = useRef(enabled);
  const triggerOwnedLogin = useOwnedCodexLogin();

  const transition = useCallback((event: CodexAuthMachineEvent) => {
    const current = machineRef.current;
    const next = reduceCodexAuthMachine(current, event);
    if (next === current) return;
    machineRef.current = next;
    setMachine(next);
  }, []);

  const isObserverActive = useCallback(
    (epoch: number): boolean => observerEnabledRef.current && observerEpochRef.current === epoch,
    [],
  );

  const applyRecoveryHint = useCallback(
    (result: CodexLoginResult): CodexLoginResult => {
      if (
        !recoveryHintReason ||
        result.recoveryRequiredReason ||
        isCodexOAuthReconnectRequired(result.errorReason)
      ) {
        return result;
      }
      if (result.authenticated) {
        return {
          ...result,
          recoveryRequiredReason: recoveryHintReason,
          credentialScope: result.credentialScope ?? recoveryHintCredentialScope ?? 'unknown',
        };
      }
      return {
        ...result,
        errorReason: recoveryHintReason,
        credentialScope: result.credentialScope ?? recoveryHintCredentialScope ?? 'unknown',
      };
    },
    [recoveryHintCredentialScope, recoveryHintReason],
  );

  const verifyRecoveredState = useCallback(
    async (
      result: CodexLoginResult,
      credentialCandidate: CodexLoginResult = result,
    ): Promise<CodexRecoveryVerification['status']> => {
      const observerEpoch = observerEpochRef.current;
      if (!isObserverActive(observerEpoch)) return 'failed';
      const reconnectReason =
        result.recoveryRequiredReason ?? machineRef.current.reconnectReason ?? null;
      const reconnectCredentialScope =
        result.credentialScope ?? machineRef.current.reconnectCredentialScope;
      if (
        result.authenticated &&
        reconnectReason &&
        (machineRef.current.ui.kind !== 'reconnect-required' ||
          machineRef.current.reconnectReason !== reconnectReason ||
          machineRef.current.reconnectCredentialScope !== reconnectCredentialScope)
      ) {
        transition({
          type: 'state-changed',
          result: {
            ...result,
            recoveryRequiredReason: reconnectReason,
            ...(reconnectCredentialScope ? { credentialScope: reconnectCredentialScope } : {}),
          },
        });
      }
      if (!result.authenticated || !reconnectReason) {
        transition({ type: 'state-changed', result });
        setRecoveryCheck('idle');
        return result.authenticated ? 'verified' : 'invalid';
      }

      const generation = verificationGenerationRef.current + 1;
      verificationGenerationRef.current = generation;
      setRecoveryCheck('checking');
      // recoveryHint 只负责把已知的会话错误投影到当前 observer 的 UI，不能参与全局凭证
      // epoch。多个横幅可能携带不同错误字符串，但它们仍在验证同一份 Main auth snapshot。
      const verification = await verifyCodexAuthRecovery(credentialCandidate);
      if (
        !isObserverActive(observerEpoch) ||
        verificationGenerationRef.current !== generation ||
        machineRef.current.reconnectReason !== reconnectReason
      ) {
        return verification.status;
      }
      if (verification.status === 'stale') {
        setRecoveryCheck('idle');
        return verification.status;
      }
      if (verification.status === 'verified') {
        transition({
          type: 'state-changed',
          result: { ...result, recoveryRequiredReason: undefined },
        });
        setRecoveryCheck('idle');
      } else if (verification.status === 'invalid') {
        transition({ type: 'state-changed', result: verification.state });
        setRecoveryCheck('idle');
      } else {
        transition({ type: 'recovery-verification-failed' });
        setRecoveryCheck('failed');
      }
      return verification.status;
    },
    [isObserverActive, transition],
  );

  const refresh = useCallback((): Promise<void> => {
    if (!observerEnabledRef.current) return Promise.resolve();
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const observerEpoch = observerEpochRef.current;
    const requestedAt = {
      authRevision: machineRef.current.authRevision,
      eventRevision: machineRef.current.eventRevision,
    };
    const run = window.electronAPI.maker.auth
      .getState(AGENT_KIND)
      .then(async (raw) => {
        if (!isObserverActive(observerEpoch)) return;
        if (
          machineRef.current.authRevision !== requestedAt.authRevision ||
          machineRef.current.eventRevision !== requestedAt.eventRevision
        ) {
          return;
        }
        const rawResult = raw as CodexLoginResult;
        observeCodexAuthSnapshot(rawResult);
        const result = applyRecoveryHint(rawResult);
        if (
          result.authenticated &&
          (machineRef.current.reconnectReason || result.recoveryRequiredReason)
        ) {
          await verifyRecoveredState(result, rawResult);
          return;
        }
        verificationGenerationRef.current += 1;
        setRecoveryCheck('idle');
        transition({ type: 'refreshed-state', result });
      })
      .catch(() => {
        if (isObserverActive(observerEpoch) && machineRef.current.reconnectReason) {
          setRecoveryCheck('failed');
        }
      })
      .finally(() => {
        if (refreshInFlightRef.current === run) refreshInFlightRef.current = null;
      });
    refreshInFlightRef.current = run;
    return run;
  }, [applyRecoveryHint, isObserverActive, transition, verifyRecoveredState]);

  useEffect(() => {
    observerEnabledRef.current = enabled;
    observerEpochRef.current += 1;
    const observerEpoch = observerEpochRef.current;
    if (!enabled) {
      verificationGenerationRef.current += 1;
      refreshInFlightRef.current = null;
      setRecoveryCheck('idle');
      transition({ type: 'observer-disabled' });
    }
    return () => {
      if (observerEpochRef.current === observerEpoch) observerEpochRef.current += 1;
      observerEnabledRef.current = false;
      verificationGenerationRef.current += 1;
      refreshInFlightRef.current = null;
    };
  }, [enabled, transition]);

  useEffect(() => {
    if (!enabled || !recoveryHintReason) return;
    verificationGenerationRef.current += 1;
    setRecoveryCheck('idle');
    transition({
      type: 'recovery-hint',
      reason: recoveryHintReason,
      ...(recoveryHintCredentialScope ? { credentialScope: recoveryHintCredentialScope } : {}),
    });
  }, [enabled, recoveryHintCredentialScope, recoveryHintReason, transition]);

  // 必须先订阅、再读取初始快照，避免两者之间出现漏事件窗口。
  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== AGENT_KIND) return;
      const rawResult = payload as CodexLoginResult;
      observeCodexAuthStateEvent(payload, rawResult);
      const result = applyRecoveryHint(rawResult);
      if (
        result.authenticated &&
        (machineRef.current.reconnectReason || result.recoveryRequiredReason)
      ) {
        void verifyRecoveredState(result, rawResult);
        return;
      }
      verificationGenerationRef.current += 1;
      setRecoveryCheck('idle');
      transition({ type: 'state-changed', result });
    });
    return off;
  }, [applyRecoveryHint, enabled, transition, verifyRecoveredState]);

  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.electronAPI.maker.auth.onLoginProgress((progress) => {
      if (progress.agentKind !== AGENT_KIND) return;
      if (progress.phase === 'device-code' && progress.verificationUrl && progress.userCode) {
        transition({
          type: 'login-pending',
          mode: 'device-code',
          deviceCode: {
            verificationUrl: progress.verificationUrl,
            userCode: progress.userCode,
          },
        });
      } else if (progress.phase === 'login-pending') {
        transition({
          type: 'login-pending',
          mode: progress.mode === 'device-code' ? 'device-code' : 'browser',
        });
      } else if (progress.phase === 'login-error') {
        transition({ type: 'login-progress-error', message: progress.detail ?? 'unknown' });
      }
    });
    return off;
  }, [enabled, transition]);

  useEffect(() => {
    if (!enabled) return undefined;
    const observerEpoch = observerEpochRef.current;
    let disposed = false;
    const requestedAt = {
      authRevision: machineRef.current.authRevision,
      eventRevision: machineRef.current.eventRevision,
    };
    window.electronAPI.maker.auth
      .getState(AGENT_KIND)
      .then((raw) => {
        if (!disposed && isObserverActive(observerEpoch)) {
          const rawResult = raw as CodexLoginResult;
          observeCodexAuthSnapshot(rawResult);
          const result = applyRecoveryHint(rawResult);
          if (machineRef.current.authRevision !== requestedAt.authRevision) return;
          if (
            result.authenticated &&
            (machineRef.current.reconnectReason || result.recoveryRequiredReason)
          ) {
            void verifyRecoveredState(result, rawResult);
          } else {
            transition({ type: 'initial-state', result, requestedAt });
          }
        }
      })
      .catch(() => {
        if (!disposed && isObserverActive(observerEpoch)) {
          transition({ type: 'initial-state-failed', requestedAt });
        }
      });
    return () => {
      disposed = true;
    };
  }, [applyRecoveryHint, enabled, isObserverActive, transition, verifyRecoveredState]);

  useEffect(() => {
    if (!enabled || machine.ui.kind !== 'reconnect-required') return undefined;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, machine.ui.kind, refresh]);

  const triggerLogin = useCallback(
    async (mode: 'browser' | 'device-code' = 'browser'): Promise<CodexLoginOutcome> => {
      const observerEpoch = observerEpochRef.current;
      if (!isObserverActive(observerEpoch)) return 'cancelled';
      transition({ type: 'login-pending', mode });
      try {
        const result = await triggerOwnedLogin(mode);
        if (!isObserverActive(observerEpoch)) return 'cancelled';
        if (result.authenticated) {
          if (machineRef.current.reconnectReason || result.recoveryRequiredReason) {
            const verification = await verifyRecoveredState(result);
            if (!isObserverActive(observerEpoch)) return 'cancelled';
            if (verification === 'stale') return 'cancelled';
            if (verification !== 'verified') {
              return verification === 'failed' ? 'unverified' : 'failed';
            }
          } else {
            transition({ type: 'login-result', result });
          }
          toast.success(t('logic.toasts.codexConnected'));
          return 'authenticated';
        }
        transition({ type: 'login-result', result });
        return result.errorReason === 'login_cancelled' ? 'cancelled' : 'failed';
      } catch (error) {
        if (!isObserverActive(observerEpoch)) return 'cancelled';
        const message = error instanceof Error ? error.message : 'login_failed';
        transition({ type: 'login-threw', message });
        return message.includes('login_cancelled') ? 'cancelled' : 'failed';
      }
    },
    [isObserverActive, t, transition, triggerOwnedLogin, verifyRecoveredState],
  );

  const cancelLogin = useCallback(async () => {
    invalidatePendingCodexLogin();
    try {
      await window.electronAPI.maker.auth.cancelLogin(AGENT_KIND);
      setRecoveryCheck('idle');
      transition({ type: 'cancelled' });
    } catch (error) {
      // Cancel may race with a just-persisted OAuth token. If durable cleanup failed,
      // keep the UI aligned with Main's authoritative state instead of claiming that
      // the account disconnected.
      try {
        const raw = await window.electronAPI.maker.auth.getState(AGENT_KIND);
        const result = raw as CodexLoginResult;
        observeCodexAuthSnapshot(result);
        transition({ type: 'refreshed-state', result });
        if (result.authenticated && result.recoveryRequiredReason) {
          void verifyRecoveredState(result);
        }
      } catch {
        const message = error instanceof Error ? error.message : 'cancel_login_failed';
        transition({ type: 'login-threw', message });
      }
    }
  }, [transition, verifyRecoveredState]);

  const logout = useCallback(async () => {
    invalidatePendingCodexLogin();
    try {
      await window.electronAPI.maker.auth.logout(AGENT_KIND);
      setRecoveryCheck('idle');
      transition({ type: 'logout-success' });
    } catch (error) {
      // main 可能在 marker 提交前失败（仍已连接），也可能在 marker 提交后的文件清理阶段
      // 失败（已权威断开）。重读一次状态，避免 UI 假报成功或永久停在过期连接态。
      try {
        const raw = await window.electronAPI.maker.auth.getState(AGENT_KIND);
        const result = raw as CodexLoginResult;
        observeCodexAuthSnapshot(result);
        transition({ type: 'refreshed-state', result });
        if (result.authenticated && result.recoveryRequiredReason) {
          void verifyRecoveredState(result);
        }
      } catch {
        // 状态查询也失败时保留当前 UI；原始 logout 错误仍交给调用方展示。
      }
      throw error;
    }
  }, [transition, verifyRecoveredState]);

  return {
    state: machine.ui,
    reconnectCredentialScope: machine.reconnectCredentialScope,
    recoveryCheck,
    refresh,
    triggerLogin,
    cancelLogin,
    logout,
  };
}
