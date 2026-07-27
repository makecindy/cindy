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
    }
  | { kind: 'reconnect-required'; reason: string }
  | { kind: 'error'; message: string };

export type CodexLoginOutcome = 'authenticated' | 'cancelled' | 'failed';

type CodexAuthMachineState = {
  ui: CodexUiState;
  reconnectReason: string | null;
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
  | { type: 'state-changed'; result: CodexLoginResult }
  | {
      type: 'login-pending';
      mode: 'browser' | 'device-code';
      deviceCode?: { verificationUrl: string; userCode: string };
    }
  | { type: 'login-progress-error'; message: string }
  | { type: 'login-result'; result: CodexLoginResult }
  | { type: 'login-threw'; message: string }
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
  if (raw.authenticated) {
    return {
      kind: 'authenticated',
      identity: raw.identity,
      expiresAt: raw.expiresAt,
      authSource: raw.authSource,
    };
  }
  const reason = raw.errorReason;
  if (reason && isCodexOAuthReconnectRequired(reason)) {
    return { kind: 'reconnect-required', reason };
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
  if (ui.kind === 'reconnect-required') reconnectReason = ui.reason;
  if (ui.kind === 'authenticated' || ui.kind === 'unauthenticated') reconnectReason = null;

  return {
    ui,
    reconnectReason,
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
      ? { kind: 'reconnect-required', reason: machine.reconnectReason }
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
        machine.authRevision === 0 &&
        machine.eventRevision === 0
      ) {
        return machine;
      }
      return createInitialMachineState();
    case 'initial-state': {
      if (machine.authRevision !== event.requestedAt.authRevision) return machine;
      const snapshot = toCodexUiState(event.result);

      if (snapshot.kind === 'reconnect-required') {
        const withReason =
          machine.reconnectReason === snapshot.reason
            ? machine
            : { ...machine, reconnectReason: snapshot.reason };
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
          mountedRef.current
            ? result
            : { authenticated: false, errorReason: 'login_cancelled' },
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

export function useCodexAuth(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const { t } = useTranslation();
  const [machine, setMachine] = useState<CodexAuthMachineState>(createInitialMachineState);
  const machineRef = useRef(machine);
  const triggerOwnedLogin = useOwnedCodexLogin();

  const transition = useCallback((event: CodexAuthMachineEvent) => {
    const current = machineRef.current;
    const next = reduceCodexAuthMachine(current, event);
    if (next === current) return;
    machineRef.current = next;
    setMachine(next);
  }, []);

  useEffect(() => {
    if (!enabled) transition({ type: 'observer-disabled' });
  }, [enabled, transition]);

  // 必须先订阅、再读取初始快照，避免两者之间出现漏事件窗口。
  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.electronAPI.maker.auth.onStateChanged((payload) => {
      if (payload.agentKind !== AGENT_KIND) return;
      transition({ type: 'state-changed', result: payload as CodexLoginResult });
    });
    return off;
  }, [enabled, transition]);

  useEffect(() => {
    if (!enabled) return undefined;
    const off = window.electronAPI.maker.auth.onLoginProgress((progress) => {
      if (progress.agentKind !== AGENT_KIND) return;
      if (
        progress.phase === 'device-code' &&
        progress.verificationUrl &&
        progress.userCode
      ) {
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
    let disposed = false;
    const requestedAt = {
      authRevision: machineRef.current.authRevision,
      eventRevision: machineRef.current.eventRevision,
    };
    window.electronAPI.maker.auth
      .getState(AGENT_KIND)
      .then((raw) => {
        if (!disposed) {
          transition({ type: 'initial-state', result: raw as CodexLoginResult, requestedAt });
        }
      })
      .catch(() => {
        if (!disposed) transition({ type: 'initial-state-failed', requestedAt });
      });
    return () => {
      disposed = true;
    };
  }, [enabled, transition]);

  const triggerLogin = useCallback(async (
    mode: 'browser' | 'device-code' = 'browser',
  ): Promise<CodexLoginOutcome> => {
    transition({ type: 'login-pending', mode });
    try {
      const result = await triggerOwnedLogin(mode);
      transition({ type: 'login-result', result });
      if (result.authenticated) {
        toast.success(t('logic.toasts.codexConnected'));
        return 'authenticated';
      }
      return result.errorReason === 'login_cancelled' ? 'cancelled' : 'failed';
    } catch (error) {
      const message = error instanceof Error ? error.message : 'login_failed';
      transition({ type: 'login-threw', message });
      return message.includes('login_cancelled') ? 'cancelled' : 'failed';
    }
  }, [t, transition, triggerOwnedLogin]);

  const cancelLogin = useCallback(async () => {
    invalidatePendingCodexLogin();
    try {
      await window.electronAPI.maker.auth.cancelLogin(AGENT_KIND);
      transition({ type: 'cancelled' });
    } catch (error) {
      // Cancel may race with a just-persisted OAuth token. If durable cleanup failed,
      // keep the UI aligned with Main's authoritative state instead of claiming that
      // the account disconnected.
      try {
        const raw = await window.electronAPI.maker.auth.getState(AGENT_KIND);
        transition({ type: 'refreshed-state', result: raw as CodexLoginResult });
      } catch {
        const message = error instanceof Error ? error.message : 'cancel_login_failed';
        transition({ type: 'login-threw', message });
      }
    }
  }, [transition]);

  const logout = useCallback(async () => {
    invalidatePendingCodexLogin();
    try {
      await window.electronAPI.maker.auth.logout(AGENT_KIND);
      transition({ type: 'logout-success' });
    } catch (error) {
      // main 可能在 marker 提交前失败（仍已连接），也可能在 marker 提交后的文件清理阶段
      // 失败（已权威断开）。重读一次状态，避免 UI 假报成功或永久停在过期连接态。
      try {
        const raw = await window.electronAPI.maker.auth.getState(AGENT_KIND);
        transition({ type: 'refreshed-state', result: raw as CodexLoginResult });
      } catch {
        // 状态查询也失败时保留当前 UI；原始 logout 错误仍交给调用方展示。
      }
      throw error;
    }
  }, [transition]);

  return { state: machine.ui, triggerLogin, cancelLogin, logout };
}
