/**
 * claude-credentials-store —— 读/写系统 Claude Code 的 OAuth 凭证(claudeAiOauth)。
 *
 * 设计目标:'oauth' 模式下与**本地已登录的 Claude Code 自动兼容**(像 Codex reconcile
 * ~/.codex/auth.json 那样),并让 Cindy 的浏览器授权结果落到同一处,cc 子进程原生读取。
 *
 * 存储位置(与 cc-code utils/secureStorage 完全一致,默认 config dir = ~/.claude):
 *   - macOS  → 系统 Keychain 的 generic-password,service = "Claude Code-credentials"
 *              (经 /usr/bin/security CLI 读写 —— 与 cc 同一访问者二进制,不触发额外 ACL 弹窗)
 *   - 其它   → <~/.claude>/.credentials.json 明文文件
 *
 * blob 形态(顶层对象,可能含 cc 写的其它字段,**读改写时保留**):
 *   { "claudeAiOauth": { accessToken, refreshToken, expiresAt, scopes, subscriptionType, ... }, ... }
 *
 * 我们只读 / 写 `claudeAiOauth` 这一段。token 到期刷新由 host 负责(claude-oauth-refresh,
 * 刷新结果写回本 store)—— cc >= 2.1.198 在 CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST 下不再
 * 自读本凭证库,凭证经 env 显式递入子进程,cc 侧无 refresh token 可用(见 auth-adapters)。
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lockSync } from 'proper-lockfile';

import { renameSyncWithRetry, unlinkSyncWithRetry } from '../utils/atomicWriteFile.js';
import { desktopMakerLogger } from './logger-adapter.js';
import {
  blobRoundtrips,
  decideKeychainWriteMode,
  planClaudeAiOAuthClear,
} from './claude-credentials-blob.js';
import {
  getNativeProviderAuthBindingState,
  getNativeProviderAuthBindingStateForCredentialTransaction,
  invalidateNativeProviderAuthWithoutIntent,
  markNativeProviderAuthCredentialRejected,
  markNativeProviderAuthCredentialRejectionRecovery,
  resolveNativeProviderAuthCredentialRejection,
  resolveNativeProviderAuthCredentialRejectionForBindingTransaction,
  resolveNativeProviderAuthCredentialRejectionForStorageMutation,
  runWithNativeProviderAuthCredentialRejectionForStorageMutation,
  type NativeProviderAuthOwnerFence,
} from './nativeProviderAuthBinding.js';

const log = desktopMakerLogger.child('claude-credentials-store');

/** 默认 config dir(prod、无 CLAUDE_CONFIG_DIR override 时)= ~/.claude。 */
function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** macOS Keychain service 名 —— 对齐 cc getMacOsKeychainStorageServiceName(prod 默认目录无后缀)。 */
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Claude Code 2.1.219 secureStorage.mutate 使用的同名 proper-lockfile 目标。 */
const CREDENTIAL_WRITE_LOCK_TARGET = '.storage-write';
const CREDENTIAL_WRITE_LOCK_STALE_MS = 15_000;
const CREDENTIAL_WRITE_LOCK_UPDATE_MS = 5_000;
/** Only a later lock holder may reap a crashed writer's staged secret. */
const CREDENTIAL_TEMP_STALE_MS = 60_000;
/** 必须短于 lock stale;同步 security 调用期间事件循环无法执行 lock heartbeat。 */
const SECURITY_COMMAND_TIMEOUT_MS = 2_000;

interface ActiveCredentialStorageLock {
  assertOwned(): void;
}

let activeCredentialStorageLock: ActiveCredentialStorageLock | null = null;

function refreshCredentialStorageLock(): void {
  activeCredentialStorageLock?.assertOwned();
}

function keychainAccount(): string {
  try {
    return process.env.USER || os.userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

function credentialsFilePath(): string {
  return path.join(claudeConfigDir(), '.credentials.json');
}

function credentialBackupPath(): string {
  return `${credentialsFilePath()}.bak`;
}

/** Restore the only surviving snapshot, but only while `.storage-write` is held. */
function recoverCredentialBackupIfMainMissingLocked(): void {
  const file = credentialsFilePath();
  const backup = credentialBackupPath();
  if (fs.existsSync(file) || !fs.existsSync(backup)) return;
  if (!activeCredentialStorageLock) {
    throw new Error('claude credential backup requires the shared storage lock for recovery');
  }
  renameSyncWithRetry(backup, file);
}

/** A valid main file proves any concurrently visible backup is stale. */
function cleanupCredentialBackupAfterValidReadLocked(): void {
  if (process.platform === 'darwin' || !activeCredentialStorageLock) return;
  unlinkSyncWithRetry(credentialBackupPath());
}

/** Delete backup first so a later recovery can never undo an explicit clear. */
function deleteCredentialFileAndBackupLocked(): void {
  unlinkSyncWithRetry(credentialBackupPath());
  unlinkSyncWithRetry(credentialsFilePath());
}

function cleanupStaleCredentialTempFiles(): void {
  const dir = claudeConfigDir();
  const prefix = `${path.basename(credentialsFilePath())}.`;
  const managedSuffix =
    /^\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/i;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      log.warn('failed to scan stale claude credential temp files', {
        code:
          error && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code)
            : 'unknown',
      });
    }
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length);
    if (!managedSuffix.test(suffix)) continue;
    const candidate = path.join(dir, entry.name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || now - stat.mtimeMs < CREDENTIAL_TEMP_STALE_MS) continue;
      fs.unlinkSync(candidate);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        log.warn('failed to reap stale claude credential temp file', {
          code:
            error && typeof error === 'object' && 'code' in error
              ? String((error as NodeJS.ErrnoException).code)
              : 'unknown',
        });
      }
    }
  }
}

/** OAuth 凭证段(claudeAiOauth)。 */
export interface ClaudeAiOAuth {
  accessToken: string;
  refreshToken?: string | null;
  /**
   * Non-secret nonce written only after Cindy browser authorization. It makes
   * two grants that happen to return the same token bytes distinct across
   * concurrently running Cindy processes.
   */
  cindyAuthorizationRevision?: string | null;
  expiresAt?: number | null;
  scopes?: string[];
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  [k: string]: unknown;
}

/**
 * Opaque proof for destructive cleanup. Token bytes stay in memory and must
 * never be logged; the optional non-secret authorization revision is already
 * stored beside the credential. Together they prove that the rejected grant
 * is still the one in the shared store when the delete lock is held.
 */
export interface ClaudeAiOAuthCredentialIdentity {
  accessToken: string;
  refreshToken?: string | null;
  /** See ClaudeAiOAuth.cindyAuthorizationRevision. Missing and null are equivalent. */
  cindyAuthorizationRevision?: string | null;
  /**
   * Internal read-time epoch used only by the durable rejection sidecar. It is
   * never written into Claude's credential blob or compared by destructive CAS.
   */
  cindyCredentialRejectionRevision?: string | null;
}

export type ClaudeAiOAuthCredentialMatchState = 'same' | 'changed' | 'absent' | 'unreadable';
export type ClaudeAiOAuthCredentialGuardResult<T> =
  { state: 'current'; value: T } | { state: 'changed' };

export type ConditionalClaudeAiOAuthClearResult = 'cleared' | 'absent' | 'changed';
export type ConditionalClaudeAiOAuthBindingClearResult =
  ConditionalClaudeAiOAuthClearResult | 'binding-changed';
export type ConditionalClaudeAiOAuthReplaceResult = 'written' | 'absent' | 'changed';
export type ClaudeAiOAuthConditionalUpdateKind = 'refresh' | 'profile';
export type ClaudeAiOAuthBindingCommitClearResult = 'cleared' | 'absent' | 'binding-changed';

interface RejectedClaudeAiOAuthFence {
  fingerprint: string;
  authorizationRevision: string | null;
}

/** In-memory fallback; hashes only. The durable source of truth lives under Electron userData. */
const rejectedClaudeAiOAuthIdentities: RejectedClaudeAiOAuthFence[] = [];
const credentialRejectionRevisionEvidence = new WeakMap<object, string | null>();
/** Explicit callback baseline for a credential that predates Cindy authorization epochs. */
export const CLAUDE_AI_OAUTH_UNATTRIBUTED_SESSION_REVISION = 'cindy-unattributed-v1';

function authorizationRevision(identity: ClaudeAiOAuthCredentialIdentity): string | null {
  const revision = identity.cindyAuthorizationRevision;
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

function rejectionRevision(identity: ClaudeAiOAuthCredentialIdentity): string | null {
  if (Object.prototype.hasOwnProperty.call(identity, 'cindyCredentialRejectionRevision')) {
    const revision = identity.cindyCredentialRejectionRevision;
    return typeof revision === 'string' && revision.length > 0 ? revision : null;
  }
  return authorizationRevision(identity);
}

/** Capture the binding-locked epoch before an async refresh request begins. */
export function getClaudeAiOAuthCredentialRejectionRevision(
  identity: ClaudeAiOAuthCredentialIdentity,
): string | null {
  return credentialRejectionRevisionEvidence.has(identity)
    ? (credentialRejectionRevisionEvidence.get(identity) ?? null)
    : rejectionRevision(identity);
}

/**
 * Every spawned session needs a baseline, including a first-run CLI credential
 * whose durable rejection sidecar does not exist yet. Missing the env value is
 * reserved for older hosts; this sentinel makes "markerless r1" distinguishable
 * from a later explicit same-token r2 authorization.
 */
export function getClaudeAiOAuthSessionAuthorizationRevision(
  identity: ClaudeAiOAuthCredentialIdentity,
): string {
  return (
    getClaudeAiOAuthCredentialRejectionRevision(identity) ??
    CLAUDE_AI_OAUTH_UNATTRIBUTED_SESSION_REVISION
  );
}

/** Preserve read-time epoch evidence on an in-memory refreshed value without serializing it. */
export function inheritClaudeAiOAuthCredentialRejectionRevision(
  source: ClaudeAiOAuthCredentialIdentity,
  target: ClaudeAiOAuth,
): void {
  credentialRejectionRevisionEvidence.set(
    target,
    getClaudeAiOAuthCredentialRejectionRevision(source),
  );
}

/** One-way token-pair fingerprint. Never persist or log the source token bytes. */
export function fingerprintClaudeAiOAuthCredentialIdentity(
  identity: ClaudeAiOAuthCredentialIdentity,
): string {
  const refreshToken =
    typeof identity.refreshToken === 'string' && identity.refreshToken.length > 0
      ? identity.refreshToken
      : null;
  // invalid_grant is a verdict on the refresh grant. Access tokens may rotate
  // while the same refresh token remains authoritative; keying the fence by
  // the pair would let an older access-token backup evade that verdict.
  const rejectionKey = refreshToken
    ? (['refresh-token', refreshToken] as const)
    : (['access-token', identity.accessToken] as const);
  return crypto.createHash('sha256').update(JSON.stringify(rejectionKey), 'utf8').digest('hex');
}

function getClaudeAiOAuthIdentityMatchState(
  current: ClaudeAiOAuthCredentialIdentity,
  expected: ClaudeAiOAuthCredentialIdentity,
  storageMutation = false,
): 'same' | 'changed' | 'unreadable' {
  const currentRefreshToken =
    typeof current.refreshToken === 'string' && current.refreshToken.length > 0
      ? current.refreshToken
      : null;
  const expectedRefreshToken =
    typeof expected.refreshToken === 'string' && expected.refreshToken.length > 0
      ? expected.refreshToken
      : null;
  // Refresh/profile compare-and-swap must match the exact token pair. A
  // standalone Claude process may rotate only the access token while keeping
  // the grant; treating that as unchanged would overwrite its newer result.
  if (
    current.accessToken !== expected.accessToken ||
    currentRefreshToken !== expectedRefreshToken
  ) {
    return 'changed';
  }
  return getClaudeAiOAuthAuthorizationRevisionMatchState(current, expected, storageMutation);
}

function getClaudeAiOAuthRejectedGrantMatchState(
  current: ClaudeAiOAuthCredentialIdentity,
  expected: ClaudeAiOAuthCredentialIdentity,
  storageMutation = false,
): 'same' | 'changed' | 'unreadable' {
  const currentRefreshToken =
    typeof current.refreshToken === 'string' && current.refreshToken.length > 0
      ? current.refreshToken
      : null;
  const expectedRefreshToken =
    typeof expected.refreshToken === 'string' && expected.refreshToken.length > 0
      ? expected.refreshToken
      : null;
  // invalid_grant revokes the refresh grant, not one access-token rotation.
  // When both snapshots carry that grant, a different access token is still
  // the same destructive-cleanup identity. Access token remains authoritative
  // only for credentials that have no refresh token at all.
  if (currentRefreshToken !== null || expectedRefreshToken !== null) {
    if (currentRefreshToken !== expectedRefreshToken) return 'changed';
  } else if (current.accessToken !== expected.accessToken) {
    return 'changed';
  }
  return getClaudeAiOAuthAuthorizationRevisionMatchState(current, expected, storageMutation);
}

function getClaudeAiOAuthAuthorizationRevisionMatchState(
  current: ClaudeAiOAuthCredentialIdentity,
  expected: ClaudeAiOAuthCredentialIdentity,
  storageMutation: boolean,
): 'same' | 'changed' | 'unreadable' {
  const resolveRejection = storageMutation
    ? resolveNativeProviderAuthCredentialRejectionForStorageMutation
    : resolveNativeProviderAuthCredentialRejection;
  const decision = resolveRejection(
    'anthropic',
    fingerprintClaudeAiOAuthCredentialIdentity(current),
    authorizationRevision(current),
  );
  if (decision.state === 'unreadable') return 'unreadable';
  return decision.effectiveAuthorizationRevision ===
    getClaudeAiOAuthCredentialRejectionRevision(expected)
    ? 'same'
    : 'changed';
}

function isRejectedClaudeAiOAuthCredential(
  current: ClaudeAiOAuth,
  bindingTransaction = false,
): boolean {
  const fingerprint = fingerprintClaudeAiOAuthCredentialIdentity(current);
  const revision = authorizationRevision(current);
  const decision = bindingTransaction
    ? resolveNativeProviderAuthCredentialRejectionForBindingTransaction(
        'anthropic',
        fingerprint,
        revision,
      )
    : resolveNativeProviderAuthCredentialRejection('anthropic', fingerprint, revision);
  if (decision.state === 'unreadable') return true;
  if (
    rejectedClaudeAiOAuthIdentities.some(
      (identity) =>
        identity.fingerprint === fingerprint &&
        identity.authorizationRevision === decision.effectiveAuthorizationRevision,
    )
  ) {
    return true;
  }
  if (decision.state === 'allowed') {
    credentialRejectionRevisionEvidence.set(current, decision.effectiveAuthorizationRevision);
  }
  return decision.state !== 'allowed';
}

/** Persist the one-way rejection marker; callers that retry lock contention use this directly. */
export function persistClaudeAiOAuthCredentialRejection(
  identity: ClaudeAiOAuthCredentialIdentity,
): boolean {
  return markNativeProviderAuthCredentialRejected(
    'anthropic',
    fingerprintClaudeAiOAuthCredentialIdentity(identity),
    getClaudeAiOAuthCredentialRejectionRevision(identity),
  );
}

export function persistClaudeAiOAuthCredentialRejectionRecovery(
  identity: ClaudeAiOAuthCredentialIdentity,
): boolean {
  return markNativeProviderAuthCredentialRejectionRecovery(
    'anthropic',
    fingerprintClaudeAiOAuthCredentialIdentity(identity),
    getClaudeAiOAuthCredentialRejectionRevision(identity),
  );
}

/** In-memory only: never log or persist either token. */
export function rejectClaudeAiOAuthCredentialIdentity(
  identity: ClaudeAiOAuthCredentialIdentity,
): boolean {
  const fingerprint = fingerprintClaudeAiOAuthCredentialIdentity(identity);
  const revision = getClaudeAiOAuthCredentialRejectionRevision(identity);
  let changed = false;
  if (
    !rejectedClaudeAiOAuthIdentities.some(
      (existing) =>
        existing.fingerprint === fingerprint && existing.authorizationRevision === revision,
    )
  ) {
    rejectedClaudeAiOAuthIdentities.push({
      fingerprint,
      authorizationRevision: revision,
    });
    changed = true;
  }
  // The in-memory fence above is already installed if this write throws. The
  // refresher retries ELOCKED independently of owner/session changes; adapter
  // cleanup remains a second exact-CAS fallback.
  return persistClaudeAiOAuthCredentialRejection(identity) || changed;
}

/** Explicit browser authorization is the only authority that may accept the same identity again. */
export function acceptClaudeAiOAuthCredentialIdentity(
  identity: ClaudeAiOAuthCredentialIdentity,
): void {
  const fingerprint = fingerprintClaudeAiOAuthCredentialIdentity(identity);
  for (let index = rejectedClaudeAiOAuthIdentities.length - 1; index >= 0; index -= 1) {
    const rejected = rejectedClaudeAiOAuthIdentities[index];
    if (rejected.fingerprint === fingerprint) {
      rejectedClaudeAiOAuthIdentities.splice(index, 1);
    }
  }
}

// ── 整个 blob 的读写(保留 claudeAiOauth 以外的字段) ───────────────────────────

type RawBlobReadResult =
  { kind: 'value'; raw: string } | { kind: 'absent' } | { kind: 'unreadable'; cause: unknown };

type BlobReadResult =
  | { kind: 'value'; value: Record<string, unknown>; raw: string }
  | { kind: 'absent' }
  | { kind: 'unreadable'; cause: unknown };

type BlobWriteMode = 'create' | 'update';

export type BoundClaudeAiOAuthState = 'present' | 'absent' | 'unreadable' | 'binding-unreadable';

function securityEnvironment(): NodeJS.ProcessEnv {
  // `security` 的 exit status 只有 OSStatus 的低 8 位,不能单独证明 errSecItemNotFound。
  // 固定英文 stderr 后才能把 status 44 + 明确的 Keychain not-found 文本作为双重证据。
  return { ...process.env, LC_ALL: 'C', LANG: 'C' };
}

function errorStderr(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return '';
  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') return stderr;
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8');
  return '';
}

function isMacKeychainItemNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('status' in error)) return false;
  const status = (error as { status?: unknown }).status;
  if (status !== 44) return false;
  const stderr = errorStderr(error);
  return (
    stderr.includes('SecKeychainSearchCopyNext') &&
    stderr.includes('The specified item could not be found in the keychain.')
  );
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code,
  );
}

function errnoCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : 'unknown';
}

function unreadableStoreError(cause: unknown): Error {
  return new Error('claude credential store read failed; refusing to modify shared credentials', {
    cause,
  });
}

/**
 * execFile errors normally repeat the full argv in `message`. Large Keychain
 * writes put the complete credential blob in `-X <hex>`, so never propagate
 * that raw error (or attach it as a cause that an error-chain logger can walk).
 */
function safeMacKeychainWriteError(error: unknown): Error {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? (error as { status?: unknown }).status
      : undefined;
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
  const stderr = errorStderr(error).toLowerCase();
  const reason = stderr.includes('user interaction is not allowed')
    ? 'interaction-not-allowed'
    : stderr.includes('already exists in the keychain')
      ? 'item-exists'
      : stderr.includes('could not be found in the keychain')
        ? 'item-not-found'
        : stderr.includes('authorization was denied')
          ? 'authorization-denied'
          : null;
  const diagnostic = [
    typeof code === 'string' && code.length > 0 ? `code=${code}` : null,
    typeof status === 'number' ? `status=${status}` : null,
    reason ? `reason=${reason}` : null,
  ].filter(Boolean);
  return new Error(
    `claude keychain credential write failed${diagnostic.length > 0 ? ` (${diagnostic.join(', ')})` : ''}`,
  );
}

function withCredentialWriteLock<T>(mutation: () => T): T {
  const dir = claudeConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  let compromised: unknown = null;
  let release: () => void;
  try {
    release = lockSync(path.join(dir, CREDENTIAL_WRITE_LOCK_TARGET), {
      realpath: false,
      stale: CREDENTIAL_WRITE_LOCK_STALE_MS,
      update: CREDENTIAL_WRITE_LOCK_UPDATE_MS,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (cause) {
    const message = isErrno(cause, 'ELOCKED')
      ? 'claude credential store is busy; refusing to modify shared credentials'
      : 'failed to acquire claude credential write lock; refusing to modify shared credentials';
    throw new Error(message, { cause });
  }
  const lock: ActiveCredentialStorageLock = {
    assertOwned(): void {
      if (compromised) throw compromised;
    },
  };
  const previousActiveLock = activeCredentialStorageLock;
  activeCredentialStorageLock = lock;

  const noFailure = Symbol('no-failure');
  let failure: unknown | typeof noFailure = noFailure;
  let value!: T;
  try {
    lock.assertOwned();
    cleanupStaleCredentialTempFiles();
    value = mutation();
    lock.assertOwned();
  } catch (error) {
    failure = error;
  } finally {
    activeCredentialStorageLock = previousActiveLock;
  }
  try {
    release();
  } catch (error) {
    // mutation 的原始错误比随后释放失败更有诊断价值;成功路径则不能把释放失败谎报成成功。
    if (failure === noFailure) failure = error;
    else {
      log.warn('claude credential write lock release failed after mutation error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (failure !== noFailure) throw failure;
  return value;
}

/**
 * Read-only counterpart to the mutation lock. Contention and lock/read errors
 * are a normal fail-closed `null` for status/spawn callers, never a UI or agent
 * startup exception. A missing config directory confirms absence for file-backed
 * stores; macOS still checks the independent legacy Keychain item without
 * creating the directory. The lock target/order still matches writers exactly.
 */
function withCredentialSnapshotLock<T>(snapshot: () => T, directoryAbsent: T): T | null {
  const dir = claudeConfigDir();
  try {
    // Provider/status snapshots must not create the user's Claude directory.
    // A missing directory is a confirmed absence until a writer creates it;
    // every other stat failure remains fail-closed.
    if (!fs.statSync(dir).isDirectory()) return null;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      if (process.platform !== 'darwin') return directoryAbsent;

      // Historical macOS writers stored credentials only in Keychain, so the
      // absence of ~/.claude does not prove the Keychain item is absent. Read
      // without creating the directory, then reject the result if a current
      // cooperating writer created the lock directory while the read ran.
      let value: T | null = null;
      try {
        value = snapshot();
      } catch (snapshotError) {
        log.warn('claude credential snapshot failed closed', {
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        });
      }
      try {
        fs.statSync(dir);
        return null;
      } catch (recheckError) {
        if (isErrno(recheckError, 'ENOENT')) return value;
        log.warn('claude credential snapshot directory recheck unavailable', {
          code: errnoCode(recheckError),
        });
        return null;
      }
    }
    log.warn('claude credential snapshot directory unavailable', {
      code: errnoCode(error),
    });
    return null;
  }
  let compromised: unknown = null;
  let release: () => void;
  try {
    release = lockSync(path.join(dir, CREDENTIAL_WRITE_LOCK_TARGET), {
      realpath: false,
      stale: CREDENTIAL_WRITE_LOCK_STALE_MS,
      update: CREDENTIAL_WRITE_LOCK_UPDATE_MS,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (error) {
    if (!isErrno(error, 'ELOCKED')) {
      log.warn('claude credential snapshot lock unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }

  const lock: ActiveCredentialStorageLock = {
    assertOwned(): void {
      if (compromised) throw compromised;
    },
  };
  const previousActiveLock = activeCredentialStorageLock;
  activeCredentialStorageLock = lock;
  let value: T | null = null;
  try {
    lock.assertOwned();
    value = snapshot();
    lock.assertOwned();
  } catch (error) {
    log.warn('claude credential snapshot failed closed', {
      error: error instanceof Error ? error.message : String(error),
    });
    value = null;
  } finally {
    activeCredentialStorageLock = previousActiveLock;
    try {
      release();
    } catch (error) {
      log.warn('claude credential snapshot lock release failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return value;
}

/** 读 keychain 条目的**原始文本值**(JSON 字符串),严格区分缺失与不可读。 */
function readBlobRawMac(): RawBlobReadResult {
  refreshCredentialStorageLock();
  try {
    const out = execFileSync(
      'security',
      ['find-generic-password', '-a', keychainAccount(), '-w', '-s', KEYCHAIN_SERVICE],
      {
        encoding: 'utf-8',
        env: securityEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: SECURITY_COMMAND_TIMEOUT_MS,
      },
    );
    const text = out.trim();
    return text.length > 0
      ? { kind: 'value', raw: text }
      : { kind: 'unreadable', cause: new Error('keychain item returned an empty value') };
  } catch (error) {
    return isMacKeychainItemNotFound(error)
      ? { kind: 'absent' }
      : { kind: 'unreadable', cause: error };
  } finally {
    refreshCredentialStorageLock();
  }
}

/**
 * 写 keychain 条目。
 *
 * 历史坑:原实现固定走 `security -i`(stdin 交互模式,目的是 hex 不出现在 ps/argv)。但该
 * 交互解释器输入行缓冲 ~4096B,**大 blob 会被静默截断**写入损坏值并 exit 1 —— 用户在同一
 * keychain 条目里存了多个 cc mcpOAuth token 时极易触发(登录 / 登出都中招)。
 * 现按整行命令长度分流:不超限走 stdin(保留隐私属性),超限改走直接 argv 传 hex
 * (ARG_MAX≈1MB,不截断),代价仅是大 blob 时 hex 短暂出现在同用户可见的 argv(规则 9:
 * 用代码确保写入确定性,而非赌 blob 不会变大)。
 */
function writeBlobMac(blob: Record<string, unknown>, mode: BlobWriteMode): void {
  const json = JSON.stringify(blob);
  const hex = Buffer.from(json, 'utf-8').toString('hex');
  const account = keychainAccount();
  const updateFlag = mode === 'update' ? ' -U' : '';
  const interactiveCmd = `add-generic-password${updateFlag} -a "${account}" -s "${KEYCHAIN_SERVICE}" -X "${hex}"\n`;
  // `security -i` parses a command string rather than an argv array. Restrict
  // it to account names that need no escaping; unusual names stay a single,
  // literal argv element and cannot alter the command structure.
  const interactiveAccountSafe = /^[A-Za-z0-9._@+-]+$/.test(account);
  refreshCredentialStorageLock();
  try {
    if (interactiveAccountSafe && decideKeychainWriteMode(interactiveCmd.length) === 'stdin') {
      execFileSync('security', ['-i'], {
        env: securityEnvironment(),
        input: interactiveCmd,
        stdio: ['pipe', 'ignore', 'pipe'],
        timeout: SECURITY_COMMAND_TIMEOUT_MS,
      });
    } else {
      const args = ['add-generic-password'];
      if (mode === 'update') args.push('-U');
      args.push('-a', account, '-s', KEYCHAIN_SERVICE, '-X', hex);
      execFileSync('security', args, {
        env: securityEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: SECURITY_COMMAND_TIMEOUT_MS,
      });
    }
  } catch (error) {
    throw safeMacKeychainWriteError(error);
  } finally {
    refreshCredentialStorageLock();
  }
}

function deleteItemMac(): void {
  refreshCredentialStorageLock();
  try {
    execFileSync(
      'security',
      ['delete-generic-password', '-a', keychainAccount(), '-s', KEYCHAIN_SERVICE],
      {
        env: securityEnvironment(),
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: SECURITY_COMMAND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    // 读取后到删除前,Claude CLI 可能已先删掉同一条目;此时目标状态已经达成。
    if (!isMacKeychainItemNotFound(error)) throw error;
  } finally {
    refreshCredentialStorageLock();
  }
}

/** 读 ~/.claude/.credentials.json 的**原始文本值**,仅 ENOENT 算缺失。 */
function readBlobRawFile(): RawBlobReadResult {
  try {
    recoverCredentialBackupIfMainMissingLocked();
    const text = fs.readFileSync(credentialsFilePath(), 'utf-8').trim();
    return text.length > 0
      ? { kind: 'value', raw: text }
      : { kind: 'unreadable', cause: new Error('credential file is empty') };
  } catch (error) {
    return isErrno(error, 'ENOENT') ? { kind: 'absent' } : { kind: 'unreadable', cause: error };
  }
}

function writeBlobFile(blob: Record<string, unknown>, mode: BlobWriteMode): void {
  const file = credentialsFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = JSON.stringify(blob, null, 2);
  // Both initial creation and replacement stage complete bytes in a unique
  // same-directory file first. In particular, writing the final create-only
  // path directly can leave a truncated-but-existing credential store after
  // ENOSPC/EIO or a process crash, permanently trapping fail-closed readers.
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    // Windows FlushFileBuffers (used by fsyncSync) requires a writable handle.
    const descriptor = fs.openSync(tmp, 'r+');
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    if (mode === 'create') {
      // link is an atomic no-overwrite publication on the same volume: a
      // concurrent creator wins with EEXIST, while the visible final inode is
      // complete from its first instant. Never fall back to a direct write or
      // copy, which would recreate the partial-final failure mode.
      fs.linkSync(tmp, file);
    } else {
      try {
        renameSyncWithRetry(tmp, file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'EPERM' && code !== 'EEXIST') throw error;

        const backup = credentialBackupPath();
        // The main blob was parsed successfully under `.storage-write`, so an
        // older backup is stale and must be gone before starting a new swap.
        unlinkSyncWithRetry(backup);
        renameSyncWithRetry(file, backup);
        try {
          renameSyncWithRetry(tmp, file);
        } catch (swapError) {
          try {
            renameSyncWithRetry(backup, file);
          } catch {
            // backup-only remains recoverable by the next locked reader.
          }
          throw swapError;
        }
        try {
          unlinkSyncWithRetry(backup);
        } catch (cleanupError) {
          log.warn('stale claude credential backup cleanup deferred', {
            code: errnoCode(cleanupError),
          });
        }
      }
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        // Do not include the credential path or platform error message: both
        // can expose local identity/path details in uploaded diagnostics.
        log.warn('failed to remove staged claude credential temp file', {
          code:
            error && typeof error === 'object' && 'code' in error
              ? String((error as NodeJS.ErrnoException).code)
              : 'unknown',
        });
      }
    }
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

/** 平台分流读原始文本。 */
function readBlobRaw(): RawBlobReadResult {
  return process.platform === 'darwin' ? readBlobRawMac() : readBlobRawFile();
}

function readBlob(): BlobReadResult {
  const result = readBlobRaw();
  if (result.kind !== 'value') return result;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.raw);
  } catch {
    // Node's SyntaxError includes a slice of the rejected JSON. Credential
    // blobs contain tokens, so never attach that parser error to a cause chain.
    return {
      kind: 'unreadable',
      cause: new Error('claude credential store contains malformed JSON'),
    };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'unreadable',
      cause: new Error('credential store root must be a JSON object'),
    };
  }
  cleanupCredentialBackupAfterValidReadLocked();
  return { kind: 'value', value: parsed as Record<string, unknown>, raw: result.raw };
}

/**
 * 共享 blob 在首次读取后可能被 Claude CLI 改写。已有值的 mutation 在落盘前至少要求连续
 * 两次读取同一原始快照;检测到变化就以新快照继续确认,而不是拿旧副本覆盖新字段。
 *
 * `security` / 普通文件没有 compare-and-swap,无法阻止另一进程恰好在最后确认后写入;这里
 * 收窄并检测可观察到的竞争窗口。absent 不需要连续确认,后续 create-only 本身会原子拒绝抢占。
 */
function stabilizeExistingBlob(
  initial: BlobReadResult,
): Exclude<BlobReadResult, { kind: 'unreadable' }> {
  if (initial.kind === 'unreadable') throw unreadableStoreError(initial.cause);
  if (initial.kind === 'absent') return initial;
  let previous = initial;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = readBlob();
    if (latest.kind === 'unreadable') throw unreadableStoreError(latest.cause);
    if (latest.kind === 'absent') return latest;
    if (latest.raw === previous.raw) return latest;
    previous = latest;
  }
  throw new Error(
    'claude credential store changed repeatedly; refusing to overwrite shared credentials',
  );
}

/**
 * 写 blob 并**写后回读校验**。任一后端若写入被截断 / 部分写,回读对不上即抛 ——
 * 绝不让损坏值静默留在凭证库(本 bug 根因正是「写失败 + 留下截断值」无人察觉)。
 * 校验通过才返回,失败则抛,由调用方决定如何反馈。
 */
function writeBlob(blob: Record<string, unknown>, mode: BlobWriteMode): void {
  if (process.platform === 'darwin') writeBlobMac(blob, mode);
  else writeBlobFile(blob, mode);
  const verification = readBlobRaw();
  if (
    !blobRoundtrips(JSON.stringify(blob), verification.kind === 'value' ? verification.raw : null)
  ) {
    throw new Error(
      'claude credential store write verification failed (value missing or corrupted after write)',
    );
  }
}

// ── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 读取当前 Claude.ai OAuth 凭证(claudeAiOauth 段);无 / 解析失败 → null。
 * getState 自动兼容本地登录 + 登录后状态判定都用它。
 */
export function readClaudeAiOAuth(): ClaudeAiOAuth | null {
  return withCredentialSnapshotLock<ClaudeAiOAuth | null>(() => {
    // Writers finalize in storage→binding order. Holding the storage lock while
    // checking binding prevents owner A from passing a stale binding check and
    // then reading token B after another process completes login.
    if (getNativeProviderAuthBindingStateForCredentialTransaction('anthropic') !== 'bound') {
      return null;
    }
    const result = readBlob();
    if (result.kind !== 'value') return null;
    const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
    if (!oauth || typeof oauth.accessToken !== 'string' || oauth.accessToken.length === 0) {
      return null;
    }
    if (isRejectedClaudeAiOAuthCredential(oauth)) return null;
    // Protect against the remaining binding-only legacy claim/unbind paths.
    if (getNativeProviderAuthBindingStateForCredentialTransaction('anthropic') !== 'bound') {
      return null;
    }
    return oauth;
  }, null);
}

/** 是否存在可用的 Claude.ai OAuth 登录(有 accessToken)。 */
export function hasClaudeAiOAuth(): boolean {
  return readClaudeAiOAuth() != null;
}

/**
 * Recovery-only identity probe that intentionally ignores the ownership
 * binding. An invalid_grant transaction can fail after the main binding was
 * already committed, so its caller needs to distinguish that completed clear
 * from a positively observed replacement token without exposing token bytes.
 */
export function getClaudeAiOAuthCredentialMatchState(
  expected: ClaudeAiOAuthCredentialIdentity,
): ClaudeAiOAuthCredentialMatchState {
  const state = withCredentialSnapshotLock<ClaudeAiOAuthCredentialMatchState>(() => {
    const result = readBlob();
    if (result.kind === 'unreadable') return 'unreadable';
    if (result.kind === 'absent') return 'absent';
    const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
    if (!current || typeof current.accessToken !== 'string' || current.accessToken.length === 0) {
      return 'absent';
    }
    return getClaudeAiOAuthRejectedGrantMatchState(current, expected);
  }, 'absent');
  return state ?? 'unreadable';
}

/**
 * Run one synchronous follow-up only while a cooperating Cindy login cannot
 * replace the rejected credential. The storage lock stays held through the
 * callback; callbacks may take the binding lock (the established
 * storage→binding order) but must not re-enter the credential store or return
 * a Promise. Confirmed absence still counts as current: the refresher may have
 * already completed its exact-clear fallback before owner/UI cleanup runs.
 */
export function runWithClaudeAiOAuthCredentialNotReplaced<T>(
  expected: ClaudeAiOAuthCredentialIdentity,
  action: () => T,
): ClaudeAiOAuthCredentialGuardResult<T> {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind === 'value') {
      const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
      if (current && typeof current.accessToken === 'string' && current.accessToken.length > 0) {
        const match = getClaudeAiOAuthRejectedGrantMatchState(current, expected, true);
        if (match === 'unreadable') {
          throw new Error('claude credential authorization epoch is unreadable during guard');
        }
        if (match === 'changed') return { state: 'changed' };
      }
    }
    return { state: 'current', value: action() };
  });
}

/**
 * Run one synchronous account-scoped mutation only while the expected Claude
 * grant is positively present. Unlike the invalid_grant recovery guard above,
 * absence is a changed boundary: model/catalog state must never be published
 * after another process has already cleared the credential. The storage lock
 * remains held through `action`, so a cooperating login cannot replace the
 * grant between the comparison and the in-memory/cache commit.
 */
export function runWithClaudeAiOAuthCredentialCurrent<T>(
  expected: ClaudeAiOAuthCredentialIdentity,
  action: () => T,
): ClaudeAiOAuthCredentialGuardResult<T> {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind !== 'value') return { state: 'changed' };
    const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
    if (!current || typeof current.accessToken !== 'string' || current.accessToken.length === 0) {
      return { state: 'changed' };
    }
    const currentRefreshToken =
      typeof current.refreshToken === 'string' && current.refreshToken.length > 0
        ? current.refreshToken
        : null;
    const expectedRefreshToken =
      typeof expected.refreshToken === 'string' && expected.refreshToken.length > 0
        ? expected.refreshToken
        : null;
    if (currentRefreshToken !== null || expectedRefreshToken !== null) {
      if (currentRefreshToken !== expectedRefreshToken) return { state: 'changed' };
    } else if (current.accessToken !== expected.accessToken) {
      return { state: 'changed' };
    }
    return runWithNativeProviderAuthCredentialRejectionForStorageMutation(
      'anthropic',
      fingerprintClaudeAiOAuthCredentialIdentity(current),
      authorizationRevision(current),
      (decision) => {
        if (decision.state === 'unreadable') {
          throw new Error(
            'claude credential authorization epoch is unreadable during current guard',
          );
        }
        const fingerprint = fingerprintClaudeAiOAuthCredentialIdentity(current);
        if (
          rejectedClaudeAiOAuthIdentities.some(
            (identity) =>
              identity.fingerprint === fingerprint &&
              identity.authorizationRevision === decision.effectiveAuthorizationRevision,
          )
        ) {
          return { state: 'changed' };
        }
        if (
          decision.state !== 'allowed' ||
          decision.effectiveAuthorizationRevision !==
            getClaudeAiOAuthCredentialRejectionRevision(expected)
        ) {
          return { state: 'changed' };
        }
        return { state: 'current', value: action() };
      },
    );
  });
}

/**
 * Read-only counterpart used by untrusted provider snapshots. It holds the
 * same cross-process storage lock through `action`, but never creates the
 * Claude config directory and never performs mutation-only stale-temp cleanup.
 * The binding/rejection lock is held second so token, owner and authorization
 * epoch remain one atomic snapshot. `action` must stay synchronous and must not
 * re-enter either credential or binding storage.
 */
export function runWithClaudeAiOAuthCredentialSnapshotCurrent<T>(
  expected: ClaudeAiOAuthCredentialIdentity,
  action: () => T,
): ClaudeAiOAuthCredentialGuardResult<T> {
  let actionError: unknown;
  let actionFailed = false;
  const guarded = withCredentialSnapshotLock<ClaudeAiOAuthCredentialGuardResult<T>>(
    () => {
      const result = readBlob();
      if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
      if (result.kind !== 'value') return { state: 'changed' };
      const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
      if (!current || typeof current.accessToken !== 'string' || current.accessToken.length === 0) {
        return { state: 'changed' };
      }
      const currentRefreshToken =
        typeof current.refreshToken === 'string' && current.refreshToken.length > 0
          ? current.refreshToken
          : null;
      const expectedRefreshToken =
        typeof expected.refreshToken === 'string' && expected.refreshToken.length > 0
          ? expected.refreshToken
          : null;
      if (currentRefreshToken !== null || expectedRefreshToken !== null) {
        if (currentRefreshToken !== expectedRefreshToken) return { state: 'changed' };
      } else if (current.accessToken !== expected.accessToken) {
        return { state: 'changed' };
      }
      return runWithNativeProviderAuthCredentialRejectionForStorageMutation(
        'anthropic',
        fingerprintClaudeAiOAuthCredentialIdentity(current),
        authorizationRevision(current),
        (decision) => {
          // This callback already owns the binding lock. The plain state reader
          // is intentionally lock-free; do not call the transaction variant.
          if (getNativeProviderAuthBindingState('anthropic') !== 'bound') {
            return { state: 'changed' as const };
          }
          if (decision.state === 'unreadable') return { state: 'changed' as const };
          const fingerprint = fingerprintClaudeAiOAuthCredentialIdentity(current);
          if (
            rejectedClaudeAiOAuthIdentities.some(
              (identity) =>
                identity.fingerprint === fingerprint &&
                identity.authorizationRevision === decision.effectiveAuthorizationRevision,
            )
          ) {
            return { state: 'changed' as const };
          }
          if (
            decision.state !== 'allowed' ||
            decision.effectiveAuthorizationRevision !==
              getClaudeAiOAuthCredentialRejectionRevision(expected)
          ) {
            return { state: 'changed' as const };
          }
          try {
            return { state: 'current' as const, value: action() };
          } catch (error) {
            actionFailed = true;
            actionError = error;
            throw error;
          }
        },
      );
    },
    { state: 'changed' },
  );
  // Snapshot readers normally fail closed. A caller projection error is not
  // credential uncertainty and must retain its original semantics.
  if (actionFailed) throw actionError;
  return guarded ?? { state: 'changed' };
}

/** Run a synchronous cleanup only while the shared credential is still absent. */
export function runWithClaudeAiOAuthCredentialAbsent<T>(
  action: () => T,
): ClaudeAiOAuthCredentialGuardResult<T> {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind === 'value') {
      const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
      if (current && typeof current.accessToken === 'string' && current.accessToken.length > 0) {
        return { state: 'changed' };
      }
    }
    return { state: 'current', value: action() };
  });
}

/**
 * Mutation callers must distinguish a confirmed absence from an unreadable
 * shared store. Read-only status paths intentionally keep using the nullable
 * API above so a transient Keychain failure does not throw across the UI.
 */
export function getBoundClaudeAiOAuthState(): BoundClaudeAiOAuthState {
  const bindingState = getNativeProviderAuthBindingState('anthropic');
  if (bindingState === 'unreadable') return 'binding-unreadable';
  if (bindingState === 'unbound') return 'absent';
  const result = readBlob();
  if (result.kind === 'unreadable') return 'unreadable';
  if (result.kind === 'absent') return 'absent';
  const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  return typeof oauth?.accessToken === 'string' &&
    oauth.accessToken.length > 0 &&
    !isRejectedClaudeAiOAuthCredential(oauth)
    ? 'present'
    : 'absent';
}

/** Legacy upgrade probe; intentionally bypasses owner binding once at migration time. */
export function hasClaudeAiOAuthUnbound(): boolean {
  const result = readBlob();
  if (result.kind !== 'value') return false;
  const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  return (
    typeof oauth?.accessToken === 'string' &&
    oauth.accessToken.length > 0 &&
    !isRejectedClaudeAiOAuthCredential(oauth)
  );
}

/** Binding-locked auto-claim variant; never call outside claim/migration callbacks. */
export function hasClaudeAiOAuthUnboundForBindingTransaction(): boolean {
  const result = readBlob();
  if (result.kind !== 'value') return false;
  const oauth = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  return (
    typeof oauth?.accessToken === 'string' &&
    oauth.accessToken.length > 0 &&
    !isRejectedClaudeAiOAuthCredential(oauth, true)
  );
}

/**
 * 写入 Claude.ai OAuth 凭证 —— 读改写,保留 blob 里 claudeAiOauth 以外的字段
 * (cc 可能存了其它内容)。失败抛错让上层反馈。
 */
function writeClaudeAiOAuthLocked(
  oauth: ClaudeAiOAuth,
): Exclude<BlobReadResult, { kind: 'unreadable' }> {
  let result = readBlob();
  if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
  result = stabilizeExistingBlob(result);
  if (result.kind === 'value') {
    writeBlob({ ...result.value, claudeAiOauth: oauth }, 'update');
  } else {
    try {
      writeBlob({ claudeAiOauth: oauth }, 'create');
    } catch (createError) {
      // create-only 仍防御不遵守 Claude 锁协议的旧进程:抢占时重读新值再合并。
      const raced = stabilizeExistingBlob(readBlob());
      if (raced.kind !== 'value') throw createError;
      result = raced;
      writeBlob({ ...raced.value, claudeAiOauth: oauth }, 'update');
    }
  }
  return result;
}

function restoreBlobLocked(previous: Exclude<BlobReadResult, { kind: 'unreadable' }>): void {
  if (previous.kind === 'value') {
    writeBlob(previous.value, 'update');
    return;
  }
  if (process.platform === 'darwin') {
    deleteItemMac();
    return;
  }
  deleteCredentialFileAndBackupLocked();
}

function logClaudeAiOAuthWritten(oauth: ClaudeAiOAuth): void {
  log.info('claude oauth credential written', {
    storage: process.platform === 'darwin' ? 'keychain' : 'file',
    hasRefresh: Boolean(oauth.refreshToken),
  });
}

export function writeClaudeAiOAuth(oauth: ClaudeAiOAuth): void {
  withCredentialWriteLock(() => {
    writeClaudeAiOAuthLocked(oauth);
    logClaudeAiOAuthWritten(oauth);
  });
}

/**
 * Finalize an explicit OAuth login under one fixed lock order:
 * credential storage → ownership binding. A competing login may replace the
 * authorization marker before this writer reaches the binding lock; in that
 * case the token write is rolled back before the storage lock is released.
 * A thrown binding error deliberately leaves the staged token in place: the
 * durable authorization marker still makes it unusable, whereas rolling back
 * after an ambiguous lock-release error could undo a binding that did commit.
 */
export function writeClaudeAiOAuthWithBindingCommit(
  oauth: ClaudeAiOAuth,
  commitBinding: () => boolean,
): boolean {
  return withCredentialWriteLock(() => {
    const previous = writeClaudeAiOAuthLocked(oauth);
    const committed = commitBinding();
    if (!committed) {
      restoreBlobLocked(previous);
      return false;
    }
    logClaudeAiOAuthWritten(oauth);
    return true;
  });
}

function mergeConditionalClaudeAiOAuthUpdate(
  current: ClaudeAiOAuth,
  next: ClaudeAiOAuth,
  kind: ClaudeAiOAuthConditionalUpdateKind,
): ClaudeAiOAuth {
  if (kind === 'profile') {
    return {
      ...current,
      subscriptionType: current.subscriptionType ?? next.subscriptionType,
      rateLimitTier: current.rateLimitTier ?? next.rateLimitTier,
    };
  }
  return {
    ...current,
    accessToken: next.accessToken,
    refreshToken: next.refreshToken,
    expiresAt: next.expiresAt,
    scopes: next.scopes,
  };
}

/**
 * Replace a refreshed credential only if the shared store still contains the
 * exact credential used for the refresh request. Comparison and write happen
 * under `.storage-write`, closing the final read→write race with standalone
 * Claude Code or another Cindy process.
 */
export function replaceClaudeAiOAuthIfMatches(
  expected: ClaudeAiOAuthCredentialIdentity,
  next: ClaudeAiOAuth,
  kind: ClaudeAiOAuthConditionalUpdateKind = 'refresh',
): ConditionalClaudeAiOAuthReplaceResult {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind === 'absent') return 'absent';
    const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
    if (!current || typeof current.accessToken !== 'string' || current.accessToken.length === 0) {
      return 'absent';
    }
    const match = getClaudeAiOAuthIdentityMatchState(current, expected, true);
    if (match === 'unreadable') {
      throw new Error('claude credential authorization epoch is unreadable; refusing replacement');
    }
    if (match === 'changed') return 'changed';
    const merged = mergeConditionalClaudeAiOAuthUpdate(current, next, kind);
    writeBlob({ ...result.value, claudeAiOauth: merged }, 'update');
    log.info('claude oauth credential conditionally replaced', {
      storage: process.platform === 'darwin' ? 'keychain' : 'file',
      hasRefresh: Boolean(merged.refreshToken),
      kind,
    });
    return 'written';
  });
}

function clearClaudeAiOAuthFromStableBlob(
  result: Exclude<BlobReadResult, { kind: 'unreadable' }>,
): 'cleared' | 'absent' {
  if (result.kind === 'absent') return 'absent';
  const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
  if (!current || typeof current.accessToken !== 'string' || current.accessToken.length === 0) {
    return 'absent';
  }
  const plan = planClaudeAiOAuthClear(result.value);
  switch (plan.action) {
    case 'noop':
      return 'absent';
    case 'delete':
      if (process.platform === 'darwin') deleteItemMac();
      else deleteCredentialFileAndBackupLocked();
      break;
    case 'write':
      writeBlob(plan.next, 'update');
      break;
  }
  log.info('claude oauth credential cleared');
  return 'cleared';
}

/**
 * Clear a credential between validation and finalization of one previously
 * staged ownership revocation, all while holding the shared storage lock. The
 * first callback proves the exact revoke marker still owns this operation. The
 * second commits the main revoked binding and removes that marker only after
 * token deletion succeeds. A crash at either boundary therefore leaves the
 * marker durable and restart-time reads fail-closed.
 */
export function clearClaudeAiOAuthWithBindingCommit(
  validateBinding: () => boolean,
  commitBinding: () => boolean,
): ClaudeAiOAuthBindingCommitClearResult {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (!validateBinding()) return 'binding-changed';
    const cleared = clearClaudeAiOAuthFromStableBlob(result);
    if (!commitBinding()) return 'binding-changed';
    return cleared;
  });
}

/**
 * 清除 Claude.ai OAuth 凭证(登出)。
 * ⚠️ 这是系统级 Claude Code 凭证库,清除会**同时**登出本地 `claude` CLI —— 调用方需在
 * UI confirm 里讲清。读改写删 claudeAiOauth;若 blob 删空了则连条目/文件一起删。
 */
export function clearClaudeAiOAuth(): void {
  withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    clearClaudeAiOAuthFromStableBlob(result);
  });
}

/**
 * Clear only the exact OAuth credential that an invalid_grant response
 * rejected. The comparison and deletion share the Claude Code storage lock,
 * so a late callback for account A cannot delete account B's replacement.
 */
export function clearClaudeAiOAuthIfMatches(
  expected: ClaudeAiOAuthCredentialIdentity,
): ConditionalClaudeAiOAuthClearResult {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    if (result.kind === 'absent') return 'absent';

    const current = result.value.claudeAiOauth as ClaudeAiOAuth | undefined;
    if (!current || typeof current.accessToken !== 'string' || current.accessToken.length === 0) {
      return 'absent';
    }
    const match = getClaudeAiOAuthRejectedGrantMatchState(current, expected, true);
    if (match === 'unreadable') {
      throw new Error('claude credential authorization epoch is unreadable; refusing exact clear');
    }
    if (match === 'changed') return 'changed';

    const plan = planClaudeAiOAuthClear(result.value);
    switch (plan.action) {
      case 'noop':
        return 'absent';
      case 'delete':
        if (process.platform === 'darwin') deleteItemMac();
        else deleteCredentialFileAndBackupLocked();
        break;
      case 'write':
        writeBlob(plan.next, 'update');
        break;
    }
    log.info('claude oauth credential conditionally cleared');
    return 'cleared';
  });
}

/**
 * invalid_grant cleanup transaction: compare the rejected token, validate the
 * exact ownership operation, clear it, then unbind while `.storage-write`
 * remains held. A newer login can replace the operation intent but cannot
 * write its token until this transaction releases the storage lock.
 */
export function clearClaudeAiOAuthIfMatchesWithBindingCommit(
  expected: ClaudeAiOAuthCredentialIdentity,
  validateBinding: () => boolean,
  commitBinding: () => boolean,
): ConditionalClaudeAiOAuthBindingClearResult {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    const current =
      result.kind === 'value'
        ? (result.value.claudeAiOauth as ClaudeAiOAuth | undefined)
        : undefined;
    if (current && typeof current.accessToken === 'string' && current.accessToken.length > 0) {
      const match = getClaudeAiOAuthRejectedGrantMatchState(current, expected, true);
      if (match === 'unreadable') {
        throw new Error('claude credential authorization epoch is unreadable during cleanup');
      }
      if (match === 'changed') return 'changed';
    }
    if (!validateBinding()) return 'binding-changed';
    const cleared = clearClaudeAiOAuthFromStableBlob(result);
    if (!commitBinding()) return 'binding-changed';
    return cleared;
  });
}

/**
 * invalid_grant transaction that confirms the rejected grant under
 * `.storage-write`, then takes the binding lock second and clears token +
 * owner without ever publishing a pre-clear provider-global intent. This
 * closes both live-process interleavings and the crash-then-standalone-writer
 * variant of the former begin→clear window.
 */
export function clearClaudeAiOAuthIfMatchesWithBindingInvalidation(
  expected: ClaudeAiOAuthCredentialIdentity,
  expectedOwner: NativeProviderAuthOwnerFence,
): ConditionalClaudeAiOAuthBindingClearResult {
  return withCredentialWriteLock(() => {
    let result = readBlob();
    if (result.kind === 'unreadable') throw unreadableStoreError(result.cause);
    result = stabilizeExistingBlob(result);
    const current =
      result.kind === 'value'
        ? (result.value.claudeAiOauth as ClaudeAiOAuth | undefined)
        : undefined;
    if (current && typeof current.accessToken === 'string' && current.accessToken.length > 0) {
      const match = getClaudeAiOAuthRejectedGrantMatchState(current, expected, true);
      if (match === 'unreadable') {
        throw new Error('claude credential authorization epoch is unreadable during invalidation');
      }
      if (match === 'changed') return 'changed';
    }

    const bindingResult = invalidateNativeProviderAuthWithoutIntent(
      'anthropic',
      expectedOwner,
      () => clearClaudeAiOAuthFromStableBlob(result),
    );
    return bindingResult.state === 'changed' ? 'binding-changed' : bindingResult.value;
  });
}
