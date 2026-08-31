/** Renderer 内共享的 Codex OAuth 登录结果。 */
import { createLogger } from '@/lib/logger';

const log = createLogger('codexAuthLogin');

export type CodexLoginResult = {
  authenticated: boolean;
  identity?: string;
  expiresAt?: number;
  errorReason?: string;
  authSource?: 'oauth' | 'api-key';
  oauthWritesBlocked?: boolean;
  credentialScope?: 'system-shared' | 'instance-isolated' | 'unknown';
  recoveryRequiredReason?: string;
};

type CodexLoginStartedListener = () => void;

type PendingCodexLogin = {
  mode: 'browser' | 'device-code';
  ownerId: string;
  promise: Promise<CodexLoginResult>;
};

export type CodexLoginLease = {
  promise: Promise<CodexLoginResult>;
  release: (options?: { cancelIfLastOwner?: boolean }) => void;
};

type CodexLoginOwnership = {
  ownerId: string;
  owners: number;
  settled: boolean;
};

let pendingCodexLogin: PendingCodexLogin | null = null;
let loginGeneration = 0;
let loginOwnerSequence = 0;
const loginOwnership = new Map<Promise<CodexLoginResult>, CodexLoginOwnership>();
const loginStartedListeners = new Set<CodexLoginStartedListener>();
const loginOwnerPrefix = (() => {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
    const entropy = new Uint32Array(4);
    globalThis.crypto?.getRandomValues?.(entropy);
    if (entropy.some((value) => value !== 0)) {
      return `renderer-${[...entropy].map((value) => value.toString(16)).join('-')}`;
    }
  } catch {
    // Older Electron/jsdom may not expose the Web Crypto methods.
  }
  // The token is also bound to event.sender in Main, so this fallback supplies uniqueness only.
  return `renderer-${Date.now().toString(36)}`;
})();

const cancelledLoginResult = (): CodexLoginResult => ({
  authenticated: false,
  errorReason: 'login_cancelled',
});

function nextLoginOwnerId(): string {
  loginOwnerSequence += 1;
  return `${loginOwnerPrefix}:${loginOwnerSequence}`;
}

function notifyCodexLoginStarted(): void {
  for (const listener of loginStartedListeners) {
    try {
      listener();
    } catch (error) {
      log.warn('Codex login-start listener failed', error);
    }
  }
}

/** 凭证恢复验证订阅真实登录启动点；同一 shared login 只通知一次。 */
export function onCodexLoginStarted(listener: CodexLoginStartedListener): () => void {
  loginStartedListeners.add(listener);
  return () => loginStartedListeners.delete(listener);
}

function invokeCodexLogin(
  mode: 'browser' | 'device-code',
  ownerId: string,
): Promise<CodexLoginResult> {
  return window.electronAPI.maker.auth.triggerLogin(
    'codex',
    mode === 'device-code' ? { mode, ownerId } : { ownerId },
  );
}

/**
 * 合并 renderer 内所有 ChatGPT 连接入口的并发请求。
 *
 * main adapter 也会复用正在运行的 CLI 登录，但在 renderer 先合并可以避免设置页、
 * 会话横幅等入口重复发 IPC，并避免同一结果重复执行 main handler 的刷新与广播收尾。
 */
function getOrStartCodexLogin(mode: 'browser' | 'device-code' = 'browser'): PendingCodexLogin {
  if (pendingCodexLogin) {
    if (pendingCodexLogin.mode === mode) return pendingCodexLogin;

    const previous = pendingCodexLogin.promise;
    const previousOwnerId = pendingCodexLogin.ownerId;
    const generation = ++loginGeneration;
    const ownerId = nextLoginOwnerId();
    try {
      void window.electronAPI.maker.auth
        .cancelLogin('codex', { releaseOwner: true, ownerId: previousOwnerId })
        .catch(() => undefined);
    } catch {
      // Cancellation is best-effort; synchronous bridge failures must not abort mode switching.
    }
    const queued: Promise<CodexLoginResult> = previous
      .catch(() => undefined)
      .then(() => {
        if (generation !== loginGeneration) return cancelledLoginResult();
        notifyCodexLoginStarted();
        return invokeCodexLogin(mode, ownerId);
      })
      .finally(() => {
        if (pendingCodexLogin?.promise === queued) pendingCodexLogin = null;
      });
    pendingCodexLogin = { mode, ownerId, promise: queued };
    return pendingCodexLogin;
  }

  ++loginGeneration;
  notifyCodexLoginStarted();
  const ownerId = nextLoginOwnerId();
  const run: Promise<CodexLoginResult> = invokeCodexLogin(mode, ownerId).finally(() => {
    if (pendingCodexLogin?.promise === run) pendingCodexLogin = null;
  });
  pendingCodexLogin = { mode, ownerId, promise: run };
  return pendingCodexLogin;
}

export function triggerCodexLoginOnce(
  mode: 'browser' | 'device-code' = 'browser',
): Promise<CodexLoginResult> {
  return getOrStartCodexLogin(mode).promise;
}

/**
 * 获取共享 Codex 登录的一份 owner lease。
 *
 * 同一 renderer 内多个显式入口会复用一个登录 promise；组件卸载时只有最后一个 owner
 * 才能取消它。lease 绑定具体 promise，因此旧模式的 cleanup 不会误杀已排队的新模式。
 */
export function acquireCodexLogin(mode: 'browser' | 'device-code' = 'browser'): CodexLoginLease {
  const pending = getOrStartCodexLogin(mode);
  const { ownerId, promise } = pending;
  let ownership = loginOwnership.get(promise);
  if (!ownership) {
    ownership = { ownerId, owners: 0, settled: false };
    loginOwnership.set(promise, ownership);
    const markSettled = () => {
      ownership!.settled = true;
      if (ownership!.owners === 0 && loginOwnership.get(promise) === ownership) {
        loginOwnership.delete(promise);
      }
    };
    void promise.then(markSettled, markSettled);
  }
  ownership.owners += 1;

  let released = false;
  return {
    promise,
    release(options) {
      if (released) return;
      released = true;
      ownership!.owners = Math.max(0, ownership!.owners - 1);
      if (ownership!.owners !== 0) return;
      if (loginOwnership.get(promise) === ownership) loginOwnership.delete(promise);
      if (
        options?.cancelIfLastOwner !== true ||
        ownership!.settled ||
        pendingCodexLogin?.promise !== promise
      ) {
        return;
      }

      invalidatePendingCodexLogin();
      try {
        void window.electronAPI.maker.auth
          .cancelLogin('codex', { releaseOwner: true, ownerId: ownership!.ownerId })
          .catch(() => undefined);
      } catch {
        // Teardown cancellation is best-effort; a synchronous bridge failure must not escape React.
      }
    },
  };
}

/** 让尚未开始的模式切换失效；main 侧正在运行的登录仍由调用方显式取消。 */
export function invalidatePendingCodexLogin(): void {
  ++loginGeneration;
  pendingCodexLogin = null;
}
