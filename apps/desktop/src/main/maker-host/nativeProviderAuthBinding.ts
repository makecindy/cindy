import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { lockSync } from 'proper-lockfile';

import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

type NativeProviderId = 'anthropic' | 'openai' | 'xai';
type CredentialRejectionProviderId = 'anthropic';
const NATIVE_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'xai',
] as const satisfies readonly NativeProviderId[];
type BindingFile = Partial<Record<NativeProviderId, string>> & {
  legacyClaimOwner?: string;
  /**
   * 被**显式登出**过、且尚未重新授权的 provider（值 = 执行登出的 owner，仅供诊断）。
   *
   * 登出会先删凭证再解绑，但删除是 best-effort 的（Anthropic 的文件删除吞 ENOENT 之外的
   * 错误、`logoutGrok` 忽略 secret store 的失败返回）。删除失败时 slot 已空、凭证却还在，
   * 自动认领会立刻把它绑回来——等于悄悄撤销用户刚做的登出。
   *
   * 判定**不比对 owner**：标记说的是「这份残留凭证已被弃用」，而凭证存在共享的系统
   * keychain / CLI 里，换个账号它也还是登出那个账号的凭证——按 owner 比对等于给下一个
   * 账号开了继承别人凭证的口子（PR #548 review）。解除只有一条路：用户再次显式授权
   * （`bindNativeProviderAuth` 清除），那时凭证已由本人重新写入。
   */
  revoked?: Partial<Record<NativeProviderId, string>>;
  /**
   * 由**用户在 Cindy 里亲自完成授权**而绑定的 provider（值 = 执行授权的 owner）。
   *
   * 与自动认领（`claimDetectedNativeProviderAuth`，继承本机 CLI 已有凭证）区分开来。两者
   * 结果相同（provider 绑到当前 owner、凭证可用），但**来路**不同，而来路是用户可见文案的
   * 依据：「已沿用这台电脑上登录的账号」只对继承成立；对刚在 Cindy 里点过授权的用户说这句话
   * 是错的（PR #1076 review 第三轮）。
   *
   * 判定不比对 owner —— 有值即说明这份凭证是经 Cindy 的登录流程写入的，不是「先于 Cindy
   * 就存在」。登出时清除（那之后的凭证若还在，就回到「可被继承」的语义）。
   */
  selfAuthorized?: Partial<Record<NativeProviderId, string>>;
};

function bindingPath(): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.json');
}

const BINDING_WRITE_LOCK_TARGET = '.native-provider-auth.write';
export const NATIVE_PROVIDER_AUTH_BINDING_LOCK_STALE_MS = 15_000;
const BINDING_WRITE_LOCK_UPDATE_MS = 5_000;

export interface NativeProviderAuthOwnerFence {
  dataOwnerId: string;
  generation: number;
}

export interface NativeProviderAuthOperationFence extends NativeProviderAuthOwnerFence {
  operationId: string;
  intent: 'authorize' | 'revoke' | 'invalidate';
}

function operationIntentPath(provider: NativeProviderId): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.intent', `${provider}.json`);
}

function pendingRevocationPath(provider: NativeProviderId): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.pending', `${provider}.json`);
}

const CREDENTIAL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function credentialRejectionPath(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
): string {
  if (!CREDENTIAL_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('invalid native provider credential fingerprint');
  }
  return path.join(
    app.getPath('userData'),
    'native-provider-auth.rejected',
    provider,
    `${fingerprint}.json`,
  );
}

function credentialRejectionRecoveryPath(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): string {
  if (!CREDENTIAL_FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new Error('invalid native provider credential fingerprint');
  }
  const revision = normalizedAuthorizationRevision(authorizationRevision);
  const revisionKey = crypto
    .createHash('sha256')
    .update(JSON.stringify(revision), 'utf8')
    .digest('hex');
  return path.join(
    app.getPath('userData'),
    'native-provider-auth.rejected-recovery',
    provider,
    fingerprint,
    `${revisionKey}.json`,
  );
}

type PendingRevocationRead =
  | { kind: 'absent' }
  | {
      kind: 'present';
      owner: NativeProviderAuthOwnerFence;
      intent: 'revoke' | 'authorize';
      operationId: string | null;
      fallbackRevocation: {
        owner: NativeProviderAuthOwnerFence;
        operationId: string | null;
      } | null;
    }
  | { kind: 'unreadable' };

type OperationIntentRead =
  | { kind: 'absent' }
  | { kind: 'present'; operation: NativeProviderAuthOperationFence }
  | { kind: 'unreadable' };

type CredentialRejectionRead =
  | { kind: 'absent' }
  | {
      kind: 'present';
      authorizationRevision: string | null;
      rejected: boolean;
      rejectionObserved: boolean;
    }
  | { kind: 'unreadable' };

type CredentialRejectionRecoveryRead =
  { kind: 'absent' } | { kind: 'present' } | { kind: 'unreadable' };

export type NativeProviderCredentialRejectionState = 'allowed' | 'rejected' | 'unreadable';
export interface NativeProviderCredentialRejectionDecision {
  state: NativeProviderCredentialRejectionState;
  /** Authorization epoch captured while the same binding lock was held. */
  effectiveAuthorizationRevision: string | null;
}

type AtomicStateFileSnapshot =
  { kind: 'absent' } | { kind: 'present'; raw: string } | { kind: 'unreadable' };

let bindingMutationLockDepth = 0;

/**
 * A normal main-file read stays side-effect free. Backup-only recovery is
 * allowed only inside the binding mutation lock; unlocked readers fail closed
 * instead of racing a writer's two-rename Windows swap.
 */
function readAtomicStateFileSnapshot(file: string): AtomicStateFileSnapshot {
  try {
    return { kind: 'present', raw: fs.readFileSync(file, 'utf8') };
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      return { kind: 'unreadable' };
    }
  }
  try {
    fs.statSync(`${file}.bak`);
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  if (bindingMutationLockDepth === 0) return { kind: 'unreadable' };
  try {
    const restored = readAtomicFileSync(file);
    return restored === null ? { kind: 'unreadable' } : { kind: 'present', raw: restored };
  } catch {
    return { kind: 'unreadable' };
  }
}

function readOperationIntent(provider: NativeProviderId): OperationIntentRead {
  const snapshot = readAtomicStateFileSnapshot(operationIntentPath(provider));
  if (snapshot.kind !== 'present') return snapshot;
  try {
    const value = JSON.parse(snapshot.raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unreadable' };
    const dataOwnerId = (value as { dataOwnerId?: unknown }).dataOwnerId;
    const generation = (value as { generation?: unknown }).generation;
    const operationId = (value as { operationId?: unknown }).operationId;
    const intent = (value as { intent?: unknown }).intent;
    return typeof dataOwnerId === 'string' &&
      typeof generation === 'number' &&
      typeof operationId === 'string' &&
      operationId.length > 0 &&
      (intent === 'authorize' || intent === 'revoke' || intent === 'invalidate')
      ? {
          kind: 'present',
          operation: { dataOwnerId, generation, operationId, intent },
        }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

function sameOperation(
  actual: NativeProviderAuthOperationFence,
  expected: NativeProviderAuthOperationFence,
): boolean {
  return (
    actual.dataOwnerId === expected.dataOwnerId &&
    actual.generation === expected.generation &&
    actual.operationId === expected.operationId &&
    actual.intent === expected.intent
  );
}

function readPendingRevocation(provider: NativeProviderId): PendingRevocationRead {
  const snapshot = readAtomicStateFileSnapshot(pendingRevocationPath(provider));
  if (snapshot.kind !== 'present') return snapshot;
  try {
    const value = JSON.parse(snapshot.raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'unreadable' };
    const owner = (value as { dataOwnerId?: unknown }).dataOwnerId;
    const generation = (value as { generation?: unknown }).generation;
    const intent = (value as { intent?: unknown }).intent;
    const operationId = (value as { operationId?: unknown }).operationId;
    const fallbackRevocation = (value as { fallbackRevocation?: unknown }).fallbackRevocation;
    let parsedFallback: {
      owner: NativeProviderAuthOwnerFence;
      operationId: string | null;
    } | null = null;
    if (fallbackRevocation !== undefined) {
      if (
        !fallbackRevocation ||
        typeof fallbackRevocation !== 'object' ||
        Array.isArray(fallbackRevocation)
      ) {
        return { kind: 'unreadable' };
      }
      const fallbackOwner = (fallbackRevocation as { dataOwnerId?: unknown }).dataOwnerId;
      const fallbackGeneration = (fallbackRevocation as { generation?: unknown }).generation;
      const fallbackOperationId = (fallbackRevocation as { operationId?: unknown }).operationId;
      if (
        typeof fallbackOwner !== 'string' ||
        typeof fallbackGeneration !== 'number' ||
        (fallbackOperationId !== undefined &&
          (typeof fallbackOperationId !== 'string' || fallbackOperationId.length === 0))
      ) {
        return { kind: 'unreadable' };
      }
      parsedFallback = {
        owner: { dataOwnerId: fallbackOwner, generation: fallbackGeneration },
        operationId: typeof fallbackOperationId === 'string' ? fallbackOperationId : null,
      };
    }
    return typeof owner === 'string' &&
      typeof generation === 'number' &&
      (operationId === undefined || (typeof operationId === 'string' && operationId.length > 0)) &&
      (intent === 'revoke' || intent === 'authorize')
      ? {
          kind: 'present',
          owner: { dataOwnerId: owner, generation },
          intent,
          operationId: typeof operationId === 'string' ? operationId : null,
          fallbackRevocation: parsedFallback,
        }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

function readCredentialRejection(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
): CredentialRejectionRead {
  const snapshot = readAtomicStateFileSnapshot(credentialRejectionPath(provider, fingerprint));
  if (snapshot.kind !== 'present') return snapshot;
  try {
    const value = JSON.parse(snapshot.raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'unreadable' };
    }
    const version = (value as { version?: unknown }).version;
    const authorizationRevision = (value as { authorizationRevision?: unknown })
      .authorizationRevision;
    const rejected = (value as { rejected?: unknown }).rejected;
    const rejectionObserved = (value as { rejectionObserved?: unknown }).rejectionObserved;
    if (
      version !== 1 ||
      (authorizationRevision !== null &&
        (typeof authorizationRevision !== 'string' || authorizationRevision.length === 0)) ||
      typeof rejected !== 'boolean' ||
      typeof rejectionObserved !== 'boolean'
    ) {
      return { kind: 'unreadable' };
    }
    return {
      kind: 'present',
      authorizationRevision,
      rejected,
      rejectionObserved,
    };
  } catch {
    return { kind: 'unreadable' };
  }
}

function readCredentialRejectionRecovery(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): CredentialRejectionRecoveryRead {
  const revision = normalizedAuthorizationRevision(authorizationRevision);
  const snapshot = readAtomicStateFileSnapshot(
    credentialRejectionRecoveryPath(provider, fingerprint, revision),
  );
  if (snapshot.kind !== 'present') return snapshot;
  try {
    const value = JSON.parse(snapshot.raw) as unknown;
    return value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as { version?: unknown }).version === 1 &&
      (value as { authorizationRevision?: unknown }).authorizationRevision === revision &&
      (value as { rejected?: unknown }).rejected === true
      ? { kind: 'present' }
      : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2));
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort */
  }
}

function normalizedAuthorizationRevision(revision: string | null | undefined): string | null {
  return typeof revision === 'string' && revision.length > 0 ? revision : null;
}

function writeCredentialRejection(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision: string | null,
  rejected: boolean,
  rejectionObserved: boolean,
): void {
  atomicWriteJson(credentialRejectionPath(provider, fingerprint), {
    version: 1,
    authorizationRevision,
    rejected,
    rejectionObserved,
    updatedAt: Date.now(),
  });
}

function acceptNativeProviderAuthCredentialRevisionUnlocked(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision: string,
): void {
  if (!authorizationRevision) {
    throw new Error('explicit native provider authorization requires a non-empty revision');
  }
  const current = readCredentialRejection(provider, fingerprint);
  const rejectionObserved =
    current.kind === 'present' ? current.rejectionObserved : current.kind !== 'absent';
  // One fingerprint has one current authorization epoch. Keeping historical
  // revisions would let an old credential backup become valid again after a
  // later epoch was rejected. A prior rejection remains historical evidence
  // that markerless copies are ambiguous even after explicit reauthorization.
  writeCredentialRejection(provider, fingerprint, authorizationRevision, false, rejectionObserved);
}

function resolveNativeProviderAuthCredentialRejectionUnlocked(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): NativeProviderCredentialRejectionDecision {
  const current = readCredentialRejection(provider, fingerprint);
  const rawRevision = normalizedAuthorizationRevision(authorizationRevision);
  let decision: NativeProviderCredentialRejectionDecision;
  if (current.kind === 'absent') {
    decision = { state: 'allowed', effectiveAuthorizationRevision: rawRevision };
  } else if (current.kind === 'unreadable') {
    decision = { state: 'unreadable', effectiveAuthorizationRevision: null };
  } else if (current.rejected) {
    decision = {
      state: 'rejected',
      effectiveAuthorizationRevision: current.authorizationRevision,
    };
  } else if (rawRevision === null && current.rejectionObserved) {
    decision = {
      state: 'rejected',
      effectiveAuthorizationRevision: current.authorizationRevision,
    };
  } else if (rawRevision !== null && rawRevision !== current.authorizationRevision) {
    // Claude's bundled CLI currently strips Cindy's unknown revision field. A
    // markerless blob is therefore attributed to the current epoch under this
    // lock. A positively different revision is an old rollback and stays closed.
    decision = { state: 'rejected', effectiveAuthorizationRevision: rawRevision };
  } else {
    decision = {
      state: 'allowed',
      effectiveAuthorizationRevision: current.authorizationRevision,
    };
  }

  if (decision.state === 'rejected') return decision;
  const recoveryRevision = decision.effectiveAuthorizationRevision ?? rawRevision;
  const recovery = readCredentialRejectionRecovery(provider, fingerprint, recoveryRevision);
  if (recovery.kind === 'present') {
    return { state: 'rejected', effectiveAuthorizationRevision: recoveryRevision };
  }
  if (recovery.kind === 'unreadable') {
    return { state: 'unreadable', effectiveAuthorizationRevision: null };
  }
  return decision;
}

/**
 * Cross-process, restart-safe verdict for one irreversible credential fingerprint.
 * Missing authorization metadata is allowed only until this fingerprint has
 * actually received an invalid_grant; afterwards only explicit Cindy revisions
 * recorded under the same lock may use it again.
 */
export function getNativeProviderAuthCredentialRejectionState(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): NativeProviderCredentialRejectionState {
  return resolveNativeProviderAuthCredentialRejection(provider, fingerprint, authorizationRevision)
    .state;
}

export function resolveNativeProviderAuthCredentialRejection(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): NativeProviderCredentialRejectionDecision {
  try {
    return withBindingMutationLock(() =>
      resolveNativeProviderAuthCredentialRejectionUnlocked(
        provider,
        fingerprint,
        authorizationRevision,
      ),
    );
  } catch {
    return { state: 'unreadable', effectiveAuthorizationRevision: null };
  }
}

/**
 * Storage mutations already fail loudly and can retry lock contention. Keep
 * the binding-lock error (including its nested ELOCKED code) intact instead of
 * collapsing it into an unreadable verdict, otherwise a rotated refresh token
 * could be returned in memory without ever reaching durable storage.
 */
export function resolveNativeProviderAuthCredentialRejectionForStorageMutation(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): NativeProviderCredentialRejectionDecision {
  return withBindingMutationLock(() =>
    resolveNativeProviderAuthCredentialRejectionUnlocked(
      provider,
      fingerprint,
      authorizationRevision,
    ),
  );
}

/**
 * Credential-store callers already hold `.storage-write`. Keep the binding
 * lock through their synchronous follow-up so a rejection marker or explicit
 * authorization cannot interleave between the decision and the guarded
 * account-scoped commit. The callback must not re-enter binding state.
 */
export function runWithNativeProviderAuthCredentialRejectionForStorageMutation<T>(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision: string | null | undefined,
  action: (decision: NativeProviderCredentialRejectionDecision) => T,
): T {
  return withBindingMutationLock(() =>
    action(
      resolveNativeProviderAuthCredentialRejectionUnlocked(
        provider,
        fingerprint,
        authorizationRevision,
      ),
    ),
  );
}

/**
 * Auto-claim callbacks already execute under the binding lock. Re-entering
 * proper-lockfile would report ELOCKED and incorrectly hide every credential;
 * this narrow probe reuses only that synchronous critical section.
 */
export function getNativeProviderAuthCredentialRejectionStateForBindingTransaction(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): NativeProviderCredentialRejectionState {
  return resolveNativeProviderAuthCredentialRejectionForBindingTransaction(
    provider,
    fingerprint,
    authorizationRevision,
  ).state;
}

export function resolveNativeProviderAuthCredentialRejectionForBindingTransaction(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): NativeProviderCredentialRejectionDecision {
  if (bindingMutationLockDepth === 0) {
    return { state: 'unreadable', effectiveAuthorizationRevision: null };
  }
  try {
    return resolveNativeProviderAuthCredentialRejectionUnlocked(
      provider,
      fingerprint,
      authorizationRevision,
    );
  } catch {
    return { state: 'unreadable', effectiveAuthorizationRevision: null };
  }
}

/** Record invalid_grant without persisting token bytes; only a SHA-256 fingerprint is accepted. */
export function markNativeProviderAuthCredentialRejected(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): boolean {
  return withBindingMutationLock(() => {
    const current = readCredentialRejection(provider, fingerprint);
    const rejectedRevision = normalizedAuthorizationRevision(authorizationRevision);
    if (current.kind === 'unreadable') {
      throw new Error('native provider credential rejection state is unreadable');
    }
    if (current.kind === 'present') {
      // A stale request from r1 must not revoke a same-token r2 authorization
      // that committed while the network request was in flight.
      if (current.authorizationRevision !== rejectedRevision) {
        if (current.rejectionObserved) return false;
        writeCredentialRejection(
          provider,
          fingerprint,
          current.authorizationRevision,
          current.rejected,
          true,
        );
        return true;
      }
      if (current.rejected && current.rejectionObserved) return false;
    }
    writeCredentialRejection(provider, fingerprint, rejectedRevision, true, true);
    return true;
  });
}

/**
 * Write-only grant-scoped fallback used when the primary rejection sidecar is
 * temporarily unreadable. It never reads or repairs that sidecar, so a stale
 * r1 callback cannot overwrite an allowed r2 epoch; resolution matches this
 * marker only to its exact fingerprint + authorization revision.
 */
export function markNativeProviderAuthCredentialRejectionRecovery(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision?: string | null,
): boolean {
  return withBindingMutationLock(() => {
    const revision = normalizedAuthorizationRevision(authorizationRevision);
    atomicWriteJson(credentialRejectionRecoveryPath(provider, fingerprint, revision), {
      version: 1,
      authorizationRevision: revision,
      rejected: true,
      updatedAt: Date.now(),
    });
    return true;
  });
}

/** Explicit browser authorization is the sole authority that records an allowed revision. */
export function acceptNativeProviderAuthCredentialRevision(
  provider: CredentialRejectionProviderId,
  fingerprint: string,
  authorizationRevision: string,
): void {
  withBindingMutationLock(() =>
    acceptNativeProviderAuthCredentialRevisionUnlocked(
      provider,
      fingerprint,
      authorizationRevision,
    ),
  );
}

/** Clear stale backup first so a failed clear keeps the main fence intact. */
function clearAtomicStateFile(file: string): void {
  for (const target of [`${file}.bak`, file]) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
    }
  }
}

function withBindingMutationLock<T>(mutation: () => T): T {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  let compromised: unknown = null;
  let release: () => void;
  try {
    release = lockSync(path.join(dir, BINDING_WRITE_LOCK_TARGET), {
      realpath: false,
      stale: NATIVE_PROVIDER_AUTH_BINDING_LOCK_STALE_MS,
      update: BINDING_WRITE_LOCK_UPDATE_MS,
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (cause) {
    const busy =
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      (cause as NodeJS.ErrnoException).code === 'ELOCKED';
    throw new Error(
      busy
        ? 'native provider auth binding is busy; refusing concurrent ownership mutation'
        : 'failed to acquire native provider auth binding lock',
      { cause },
    );
  }

  const noFailure = Symbol('no-failure');
  let failure: unknown | typeof noFailure = noFailure;
  let value!: T;
  try {
    if (compromised) throw compromised;
    bindingMutationLockDepth += 1;
    try {
      value = mutation();
    } finally {
      bindingMutationLockDepth -= 1;
    }
    if (compromised) throw compromised;
  } catch (error) {
    failure = error;
  }
  try {
    release();
  } catch (error) {
    // Keep the mutation's original diagnostic when both mutation and release fail.
    if (failure === noFailure) failure = error;
  }
  if (failure !== noFailure) throw failure;
  return value;
}

export function isNativeProviderAuthOwnerFenceCurrent(
  expected: NativeProviderAuthOwnerFence,
): boolean {
  const session = getActiveAppSession();
  return (
    !isAppSessionBoundaryPending() &&
    session.dataOwnerId === expected.dataOwnerId &&
    session.generation === expected.generation
  );
}

export function captureNativeProviderAuthOwnerFence(): NativeProviderAuthOwnerFence | null {
  const session = getActiveAppSession();
  if (!session.dataOwnerId || isAppSessionBoundaryPending()) return null;
  return { dataOwnerId: session.dataOwnerId, generation: session.generation };
}

function clearPendingRevocation(provider: NativeProviderId): void {
  clearAtomicStateFile(pendingRevocationPath(provider));
}

function clearOperationIntent(
  provider: NativeProviderId,
  expected?: NativeProviderAuthOperationFence,
): boolean {
  if (expected) {
    const current = readOperationIntent(provider);
    if (current.kind !== 'present' || !sameOperation(current.operation, expected)) return false;
  }
  clearAtomicStateFile(operationIntentPath(provider));
  return true;
}

function newOperation(
  owner: NativeProviderAuthOwnerFence,
  intent: NativeProviderAuthOperationFence['intent'],
): NativeProviderAuthOperationFence {
  return { ...owner, intent, operationId: crypto.randomUUID() };
}

function writeOperationIntent(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): void {
  atomicWriteJson(operationIntentPath(provider), {
    ...operation,
    createdAt: Date.now(),
  });
}

/** Register browser authorization before its first await so later user intent can supersede it. */
export function beginNativeProviderAuthAuthorization(
  provider: NativeProviderId,
  expectedOwner: NativeProviderAuthOwnerFence,
): NativeProviderAuthOperationFence | null {
  if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
    const previousIntent = readOperationIntent(provider);
    if (previousIntent.kind === 'unreadable') {
      // An explicit login may repair corrupt ordering state, but merely opening
      // (and then cancelling) the browser must not resurrect the credential
      // that the unreadable operation was suppressing. Preserve a conservative
      // tombstone first; a successful authorization will replace and clear it.
      const existingPending = readPendingRevocation(provider);
      if (existingPending.kind === 'absent' || existingPending.kind === 'unreadable') {
        atomicWriteJson(pendingRevocationPath(provider), {
          intent: 'revoke',
          dataOwnerId: expectedOwner.dataOwnerId,
          generation: expectedOwner.generation,
          createdAt: Date.now(),
        });
      }
    } else if (
      previousIntent.kind === 'present' &&
      previousIntent.operation.intent !== 'authorize'
    ) {
      // begin(revoke/invalidate) is already a durable last-intent fence. Before
      // replacing its nonce with a new browser login, materialize the old fence
      // as a pending tombstone. If the new login fails before staging, its
      // finally block removes only the authorize nonce and this tombstone keeps
      // the residual shared credential fail-closed across restart.
      atomicWriteJson(pendingRevocationPath(provider), {
        intent: 'revoke',
        dataOwnerId: previousIntent.operation.dataOwnerId,
        generation: previousIntent.operation.generation,
        operationId: previousIntent.operation.operationId,
        createdAt: Date.now(),
      });
    }
    const operation = newOperation(expectedOwner, 'authorize');
    // Explicit authorization is the recovery authority for a corrupt ordering
    // record only after it successfully stages and commits. A subsequent
    // logout can still supersede this nonce.
    writeOperationIntent(provider, operation);
    return operation;
  });
}

/** Register explicit logout as the durable last intent for this owner. */
export function beginNativeProviderAuthRevocation(
  provider: NativeProviderId,
  expectedOwner: NativeProviderAuthOwnerFence,
): NativeProviderAuthOperationFence | null {
  if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
    const intent = readOperationIntent(provider);
    if (intent.kind === 'unreadable') return null;
    const read = readBindingsOrFail();
    const recoverableBindings = read.ok
      ? read.bindings
      : read.reason === 'badRevoked'
        ? read.bindings
        : null;
    if (
      recoverableBindings &&
      provider in recoverableBindings &&
      recoverableBindings[provider] !== expectedOwner.dataOwnerId
    ) {
      return null;
    }
    const mainBindingOwnedByCurrent = recoverableBindings?.[provider] === expectedOwner.dataOwnerId;
    if (
      intent.kind === 'present' &&
      intent.operation.dataOwnerId !== expectedOwner.dataOwnerId &&
      !mainBindingOwnedByCurrent
    ) {
      return null;
    }
    const operation = newOperation(expectedOwner, 'revoke');
    writeOperationIntent(provider, operation);
    return operation;
  });
}

/**
 * Start the adapter's combined OAuth/gateway logout without making another
 * owner's provider binding block removal of the current owner's gateway key.
 * A current-generation browser authorization is still superseded under the
 * same lock, even when the main OAuth binding is absent or foreign.
 */
export function beginNativeProviderAuthDisconnect(
  provider: NativeProviderId,
  expectedOwner: NativeProviderAuthOwnerFence,
): NativeProviderAuthOperationFence | 'confirmed-unbound' | null {
  if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
    const intent = readOperationIntent(provider);
    if (intent.kind === 'unreadable') return null;
    const read = readBindingsOrFail();
    const recoverableBindings = read.ok
      ? read.bindings
      : read.reason === 'badRevoked'
        ? read.bindings
        : null;
    if (recoverableBindings) {
      const mainOwner = recoverableBindings[provider];
      const currentAuthorizationInFlight =
        intent.kind === 'present' &&
        intent.operation.intent === 'authorize' &&
        intent.operation.dataOwnerId === expectedOwner.dataOwnerId;
      if (mainOwner !== expectedOwner.dataOwnerId && !currentAuthorizationInFlight) {
        return 'confirmed-unbound';
      }
    }
    // The binding is ours, unreadable, or a current-generation browser login
    // must be cancelled. Record a later revoke nonce so any older login loses.
    const operation = newOperation(expectedOwner, 'revoke');
    writeOperationIntent(provider, operation);
    return operation;
  });
}

/**
 * Register a server-rejection cleanup only when no newer explicit user action
 * is in flight. A later login/logout overwrites this nonce and wins.
 */
export function beginNativeProviderAuthInvalidation(
  provider: NativeProviderId,
  expectedOwner: NativeProviderAuthOwnerFence,
): NativeProviderAuthOperationFence | null {
  if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return null;
    const intent = readOperationIntent(provider);
    if (intent.kind === 'unreadable') {
      throw new Error('native provider auth operation intent is unreadable during invalidation');
    }
    if (intent.kind === 'present' && intent.operation.intent !== 'invalidate') {
      return null;
    }
    const read = readBindingsOrFail();
    if (!read.ok) {
      throw new Error('native provider auth ownership is unreadable during invalidation');
    }
    if (read.bindings[provider] !== expectedOwner.dataOwnerId) return null;
    const operation = newOperation(expectedOwner, 'invalidate');
    writeOperationIntent(provider, operation);
    return operation;
  });
}

/** Clear a failed/cancelled operation only if no later process replaced it. */
export function abandonNativeProviderAuthOperation(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): boolean {
  return withBindingMutationLock(() => clearOperationIntent(provider, operation));
}

/**
 * Durable fail-closed tombstone used when the main ownership file cannot be
 * trusted or updated. Auto-claim treats even an unreadable tombstone as a
 * block; only a later explicit authorization clears it.
 */
export function markNativeProviderAuthRevocationPending(
  provider: NativeProviderId,
  expectedOwner: NativeProviderAuthOwnerFence,
  opts?: {
    supersedeMatchingAuthorization?: boolean;
    operation?: NativeProviderAuthOperationFence;
  },
): boolean {
  if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return false;
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return false;
    if (opts?.operation) {
      const intent = readOperationIntent(provider);
      if (
        (opts.operation.intent !== 'revoke' && opts.operation.intent !== 'invalidate') ||
        opts.operation.dataOwnerId !== expectedOwner.dataOwnerId ||
        opts.operation.generation !== expectedOwner.generation ||
        intent.kind !== 'present' ||
        !sameOperation(intent.operation, opts.operation)
      ) {
        return false;
      }
    }
    const existingPending = readPendingRevocation(provider);
    if (existingPending.kind === 'unreadable') return false;
    const bindingRead = readBindingsOrFail();
    const recoverableBindings = bindingRead.ok
      ? bindingRead.bindings
      : bindingRead.reason === 'badRevoked'
        ? bindingRead.bindings
        : null;
    const mainBindingOwnedByExpected =
      recoverableBindings?.[provider] === expectedOwner.dataOwnerId;
    if (existingPending.kind === 'present') {
      const sameOwner = existingPending.owner.dataOwnerId === expectedOwner.dataOwnerId;
      if (existingPending.intent === 'authorize') {
        // Only an explicit logout may supersede the same data owner's in-flight
        // browser authorization. Session generations are process-local, so two
        // Cindy processes for one owner legitimately carry different values.
        // invalid_grant callbacks omit this option and therefore still cannot
        // cancel a newer login.
        if (!opts?.supersedeMatchingAuthorization || (!sameOwner && !mainBindingOwnedByExpected)) {
          return false;
        }
      } else if (!sameOwner) {
        if (!opts?.supersedeMatchingAuthorization || !mainBindingOwnedByExpected) return false;
      }
    }
    // A stale callback may wait on this lock while another process binds a new
    // owner. Once the main file is readable, refuse a global tombstone unless
    // the slot is empty or still belongs to the fenced owner.
    if (
      recoverableBindings &&
      provider in recoverableBindings &&
      recoverableBindings[provider] !== expectedOwner.dataOwnerId
    ) {
      return false;
    }
    atomicWriteJson(pendingRevocationPath(provider), {
      intent: 'revoke',
      dataOwnerId: expectedOwner.dataOwnerId,
      generation: expectedOwner.generation,
      ...(opts?.operation ? { operationId: opts.operation.operationId } : {}),
      createdAt: Date.now(),
    });
    return true;
  });
}

/**
 * Stage an explicit browser authorization before writing its shared token.
 * Unlike a stale revocation callback, this user action is allowed to replace a
 * previous owner's binding. The marker still blocks auto-claim if the process
 * crashes before bindNativeProviderAuth commits the new owner.
 */
export function stageNativeProviderAuthAuthorization(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): boolean {
  if (operation.intent !== 'authorize' || !isNativeProviderAuthOwnerFenceCurrent(operation)) {
    return false;
  }
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(operation)) return false;
    const intent = readOperationIntent(provider);
    if (intent.kind !== 'present' || !sameOperation(intent.operation, operation)) return false;
    const previousPending = readPendingRevocation(provider);
    const fallbackRevocation =
      previousPending.kind === 'unreadable'
        ? { owner: operation, operationId: null }
        : previousPending.kind === 'present' && previousPending.intent === 'revoke'
          ? {
              owner: previousPending.owner,
              operationId: previousPending.operationId,
            }
          : previousPending.kind === 'present'
            ? (previousPending.fallbackRevocation ?? {
                owner: previousPending.owner,
                operationId: previousPending.operationId,
              })
            : null;
    // Explicit authorization is the recovery authority for this provider, so
    // it may atomically replace a corrupt/stale staging marker.
    atomicWriteJson(pendingRevocationPath(provider), {
      intent: 'authorize',
      dataOwnerId: operation.dataOwnerId,
      generation: operation.generation,
      operationId: operation.operationId,
      ...(fallbackRevocation
        ? {
            fallbackRevocation: {
              dataOwnerId: fallbackRevocation.owner.dataOwnerId,
              generation: fallbackRevocation.owner.generation,
              ...(fallbackRevocation.operationId
                ? { operationId: fallbackRevocation.operationId }
                : {}),
            },
          }
        : {}),
      createdAt: Date.now(),
    });
    return true;
  });
}

/**
 * Remove only the exact authorize tombstone whose credential write was
 * definitively rolled back. A later login may already have replaced either
 * the operation intent or the pending marker; matching the random operationId
 * prevents the losing finalizer from clearing that newer login's fence.
 */
export function clearNativeProviderAuthAuthorizationPending(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): boolean {
  if (operation.intent !== 'authorize') return false;
  return withBindingMutationLock(() => {
    const pending = readPendingRevocation(provider);
    if (
      pending.kind !== 'present' ||
      pending.intent !== 'authorize' ||
      pending.owner.dataOwnerId !== operation.dataOwnerId ||
      pending.owner.generation !== operation.generation ||
      pending.operationId !== operation.operationId
    ) {
      return false;
    }
    if (pending.fallbackRevocation) {
      // This login had superseded an older crash/logout tombstone. Its token
      // write was rolled back, so restore fail-closed revocation semantics
      // instead of reviving the credential that predated the failed login.
      atomicWriteJson(pendingRevocationPath(provider), {
        intent: 'revoke',
        dataOwnerId: pending.fallbackRevocation.owner.dataOwnerId,
        generation: pending.fallbackRevocation.owner.generation,
        ...(pending.fallbackRevocation.operationId
          ? { operationId: pending.fallbackRevocation.operationId }
          : {}),
        createdAt: Date.now(),
      });
    } else {
      clearPendingRevocation(provider);
    }
    return true;
  });
}

/**
 * Read-only preflight for a staged logout. It runs under the binding lock and
 * proves both the exact revoke operation and the main owner before a caller
 * removes anything from the shared credential store. The already-revoked case
 * is recovery from a crash after the main-file commit but before sidecar clear.
 */
export function validateNativeProviderAuthRevocationPending(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): boolean {
  if (operation.intent !== 'revoke' || !isNativeProviderAuthOwnerFenceCurrent(operation)) {
    return false;
  }
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(operation)) return false;
    const intent = readOperationIntent(provider);
    if (intent.kind !== 'present' || !sameOperation(intent.operation, operation)) return false;
    const pending = readPendingRevocation(provider);
    if (
      pending.kind !== 'present' ||
      pending.intent !== 'revoke' ||
      pending.owner.dataOwnerId !== operation.dataOwnerId ||
      pending.owner.generation !== operation.generation ||
      pending.operationId !== operation.operationId
    ) {
      return false;
    }
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    return (
      read.bindings[provider] === operation.dataOwnerId ||
      (!(provider in read.bindings) && read.bindings.revoked?.[provider] === operation.dataOwnerId)
    );
  });
}

/** Exact preflight for an invalid_grant cleanup before compare-and-clear. */
export function validateNativeProviderAuthInvalidation(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): boolean {
  if (operation.intent !== 'invalidate' || !isNativeProviderAuthOwnerFenceCurrent(operation)) {
    return false;
  }
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(operation)) return false;
    const intent = readOperationIntent(provider);
    if (intent.kind !== 'present' || !sameOperation(intent.operation, operation)) return false;
    const read = readBindingsOrFail();
    return read.ok && read.bindings[provider] === operation.dataOwnerId;
  });
}

/**
 * 读绑定文件，**区分「确实还没有这个文件」与「有但读不出来」**。
 *
 * 只读判定（isNativeProviderAuthBound）两者都当空处理即可——空 = 未绑定 = fail-closed。
 * 但认领路径不行：把损坏 / 不可读一律当成「名额空着」，等于在归属信息丢失的那一刻
 * 把共享 keychain 里的凭证判给当前账号，而且随后的 writeBindings 会把损坏文件连同
 * 里面原有的归属一起覆盖掉，永久失去恢复依据（PR #548 review）。
 */
type BindingRead =
  | { ok: true; bindings: BindingFile }
  /** 文件本身读不出来 / 根不是对象：整份归属都无从判断，没有可挽救的部分。 */
  | { ok: false; reason: 'unreadable' }
  /** 根有效、各 provider 归属可信，只有 revoked 这个字段被改坏。 */
  | { ok: false; reason: 'badRevoked'; bindings: Omit<BindingFile, 'revoked'> };

function readBindingsOrFail(): BindingRead {
  const snapshot = readAtomicStateFileSnapshot(bindingPath());
  // 文件不存在 = 合法的首次状态（还没有任何人绑定过）；其它读失败（EACCES / EIO 等）
  // 说明归属不明，不能当成空。backup-only 也是仍有唯一快照，不能按空处理。
  if (snapshot.kind === 'absent') return { ok: true, bindings: {} };
  if (snapshot.kind === 'unreadable') return { ok: false, reason: 'unreadable' };
  try {
    const value = JSON.parse(snapshot.raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'unreadable' };
    }
    // revoked 也要验型:下游用 `provider in bindings.revoked` 判定,而 `in` 的右操作数是
    // 原始值时直接抛 TypeError —— 一个被手工修坏的字段会让认领、迁移、登出乃至重新授权
    // 全部炸在这里(PR #548 review)。
    //
    // 但坏的只是这一个字段:同一份文件里各 provider 的归属仍然是可信的,要单独交出来。
    // 认领 / 迁移 / 登出照样得 fail-closed(不知道谁被撤销过就不能认领),而显式授权可以
    // 只修 revoked、保住其余归属 —— 否则一次「修复」会把别人的 owner 抹掉,反倒开出新的
    // 误认领口子(PR #548 review)。
    const revoked = (value as { revoked?: unknown }).revoked;
    if (
      revoked !== undefined &&
      (typeof revoked !== 'object' || revoked === null || Array.isArray(revoked))
    ) {
      const rest = { ...(value as BindingFile) };
      delete rest.revoked;
      return { ok: false, reason: 'badRevoked', bindings: rest };
    }
    return { ok: true, bindings: value as BindingFile };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

function writeBindings(value: BindingFile): void {
  atomicWriteJson(bindingPath(), value);
}

export type NativeProviderAuthBindingState = 'bound' | 'unbound' | 'unreadable';

/**
 * Mutation paths must preserve an unreadable ownership file as an unknown state.
 * Collapsing it into `unbound` can make logout/invalidation skip the shared
 * credential cleanup and operate on the unrelated gateway credential instead.
 */
function getNativeProviderAuthBindingStateUnlocked(
  provider: NativeProviderId,
): NativeProviderAuthBindingState {
  const read = readBindingsOrFail();
  if (!read.ok) return 'unreadable';
  const operationIntent = readOperationIntent(provider);
  if (
    operationIntent.kind === 'unreadable' ||
    (operationIntent.kind === 'present' && operationIntent.operation.intent !== 'authorize')
  ) {
    return 'unreadable';
  }
  if (readPendingRevocation(provider).kind !== 'absent') return 'unreadable';
  const bindings = read.bindings;
  // Revocation describes the credential itself, not the current app owner. It must therefore
  // remain authoritative during signed-out/bootstrap reads too; otherwise a residual local token
  // can be treated as bound before an owner session has committed.
  if (bindings.revoked && provider in bindings.revoked) return 'unbound';
  const owner = getActiveAppSession().dataOwnerId;
  // Claude's shared credential must never become visible before an owner
  // boundary is committed. Keep the established Codex/xAI bootstrap behavior:
  // those providers intentionally remain readable before an app session exists.
  if (provider === 'anthropic') {
    if (isAppSessionBoundaryPending()) return 'unreadable';
    if (!owner) return 'unbound';
  } else if (!owner) {
    return 'bound';
  }
  return bindings[provider] === owner ? 'bound' : 'unbound';
}

export function getNativeProviderAuthBindingState(
  provider: NativeProviderId,
): NativeProviderAuthBindingState {
  return getNativeProviderAuthBindingStateUnlocked(provider);
}

/**
 * Credential-store transactions already hold `.storage-write`; take the
 * binding lock second so token and owner are observed in the same lock order as
 * login/logout writers. Never call this from a binding-locked callback.
 */
export function getNativeProviderAuthBindingStateForCredentialTransaction(
  provider: NativeProviderId,
): NativeProviderAuthBindingState {
  return withBindingMutationLock(() => getNativeProviderAuthBindingStateUnlocked(provider));
}

/**
 * Inspect the main binding after registering an exact operation, ignoring that
 * operation's own fail-closed intent. If another process superseded the nonce,
 * return unreadable rather than using a stale pre-operation observation.
 */
export function getNativeProviderAuthBindingStateForOperation(
  provider: NativeProviderId,
  operation: NativeProviderAuthOperationFence,
): NativeProviderAuthBindingState {
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(operation)) return 'unreadable';
    const intent = readOperationIntent(provider);
    if (intent.kind !== 'present' || !sameOperation(intent.operation, operation)) {
      return 'unreadable';
    }
    const read = readBindingsOrFail();
    if (!read.ok || readPendingRevocation(provider).kind !== 'absent') return 'unreadable';
    if (read.bindings.revoked && provider in read.bindings.revoked) return 'unbound';
    const owner = getActiveAppSession().dataOwnerId;
    if (!owner) return 'unbound';
    return read.bindings[provider] === owner ? 'bound' : 'unbound';
  });
}

/** Return true only when the native OAuth credential is explicitly bound to this owner. */
export function isNativeProviderAuthBound(provider: NativeProviderId): boolean {
  return getNativeProviderAuthBindingState(provider) === 'bound';
}

/** Whether an explicit durable revocation currently suppresses this provider credential. */
export function isNativeProviderAuthRevoked(provider: NativeProviderId): boolean {
  const intent = readOperationIntent(provider);
  if (
    intent.kind === 'unreadable' ||
    (intent.kind === 'present' && intent.operation.intent !== 'authorize')
  ) {
    return true;
  }
  if (readPendingRevocation(provider).kind !== 'absent') return true;
  const read = readBindingsOrFail();
  return !read.ok || Boolean(read.bindings.revoked && provider in read.bindings.revoked);
}

/** Bind newly completed native OAuth to the current data owner. */
export function bindNativeProviderAuth(
  provider: NativeProviderId,
  expectedOperation?: NativeProviderAuthOperationFence,
  credentialFingerprint?: string,
): boolean {
  return withBindingMutationLock(() => {
    const session = getActiveAppSession();
    const owner = session.dataOwnerId;
    if (!owner) throw new Error('cannot bind native provider auth without an active data owner');
    if (isAppSessionBoundaryPending()) return false;
    if (
      expectedOperation &&
      (expectedOperation.intent !== 'authorize' ||
        !isNativeProviderAuthOwnerFenceCurrent(expectedOperation))
    ) {
      return false;
    }
    if (credentialFingerprint) {
      if (!expectedOperation) {
        throw new Error(
          'credential fingerprint commit requires an explicit authorization operation',
        );
      }
      if (provider !== 'anthropic') {
        throw new Error('credential rejection epochs are only supported for Anthropic OAuth');
      }
      credentialRejectionPath('anthropic', credentialFingerprint);
    }
    if (expectedOperation) {
      const intent = readOperationIntent(provider);
      const pending = readPendingRevocation(provider);
      if (
        intent.kind !== 'present' ||
        !sameOperation(intent.operation, expectedOperation) ||
        pending.kind !== 'present' ||
        pending.intent !== 'authorize' ||
        pending.owner.dataOwnerId !== expectedOperation.dataOwnerId ||
        pending.owner.generation !== expectedOperation.generation ||
        pending.operationId !== expectedOperation.operationId
      ) {
        return false;
      }
    }
    const read = readBindingsOrFail();
    if (read.ok) {
      const bindings = read.bindings;
      // 显式授权 = 用户重新表达了「我要连它」，撤销标记就此作废。
      if (bindings.revoked && provider in bindings.revoked) {
        const revoked = { ...bindings.revoked };
        delete revoked[provider];
        bindings.revoked = revoked;
      }
      // 记下「这是用户自己在 Cindy 里授权的」——继承类文案据此不再对它成立。
      writeBindings({
        ...bindings,
        selfAuthorized: { ...bindings.selfAuthorized, [provider]: owner },
        [provider]: owner,
      });
      if (credentialFingerprint && expectedOperation) {
        acceptNativeProviderAuthCredentialRevisionUnlocked(
          'anthropic',
          credentialFingerprint,
          expectedOperation.operationId,
        );
      }
      clearPendingRevocation(provider);
      if (expectedOperation) clearOperationIntent(provider, expectedOperation);
      else clearOperationIntent(provider);
      return true;
    }
    // 归属信息有损:用户正在显式授权,不写等于让他连不上,所以必须写;但写法要保守。
    //
    //   · badRevoked —— 各 provider 的归属仍然可信,原样保留。直接重写成「只有本次授权的这
    //     一家」会抹掉别人的 owner,那份凭证下一次就被自动认领给当前账号,等于用一次修复换
    //     来一个新的越权口子。
    //   · unreadable —— 连 legacyClaimOwner 带各家 owner 一起没了,无可保留;同样不能就这么
    //     写一份「只有我」的干净文件,那会让其余 provider 的残留凭证在文件恢复可读后立刻可被
    //     认领(PR #548 review)。
    //
    // 两种情形共用同一条保守收尾:凡是归属无从确认的 provider,一律按「撤销过」对待,自动继承
    // 就此关闭 —— 无从得知谁被撤销过时,丢弃标记等于给所有残留凭证放行。用户对它们各自显式
    // 授权即可恢复。
    const salvaged = read.reason === 'badRevoked' ? read.bindings : {};
    const suppressed: Partial<Record<NativeProviderId, string>> = {};
    for (const other of NATIVE_PROVIDER_IDS) {
      if (other !== provider) suppressed[other] = owner;
    }
    writeBindings({
      ...salvaged,
      revoked: suppressed,
      selfAuthorized: { ...salvaged.selfAuthorized, [provider]: owner },
      [provider]: owner,
    });
    if (credentialFingerprint && expectedOperation) {
      acceptNativeProviderAuthCredentialRevisionUnlocked(
        'anthropic',
        credentialFingerprint,
        expectedOperation.operationId,
      );
    }
    clearPendingRevocation(provider);
    if (expectedOperation) clearOperationIntent(provider, expectedOperation);
    else clearOperationIntent(provider);
    return true;
  });
}

/**
 * 这份 provider 凭证是不是**用户在 Cindy 里亲自授权**得来的(而非继承本机 CLI 已有凭证)。
 * 只回 boolean,供用户可见文案取舍(见 `selfAuthorized` 字段注释)。读不出绑定文件时按
 * `true` 保守处理 —— 「说不清来路」时不要声称「已沿用你本机的登录」。
 */
export function isNativeProviderAuthSelfAuthorized(provider: NativeProviderId): boolean {
  const read = readBindingsOrFail();
  if (!read.ok && read.reason === 'unreadable') return true;
  return read.bindings.selfAuthorized?.[provider] !== undefined;
}

/**
 * Remove the current owner binding after logout/invalidation.
 *
 * `revoked: true` 会留下持久标记，挡住后续自动认领。用户显式登出始终传；服务端作废凭证
 * （401 invalidate）在凭证确认清除后不传，让用户之后从本机 CLI 重登时仍可自动继承，
 * 但清除失败或共享凭证不可读时必须传，避免旧凭证恢复可读后被重新认领。
 */
export function unbindNativeProviderAuth(
  provider: NativeProviderId,
  opts?: {
    revoked?: boolean;
    ifOwnedByCurrentSession?: boolean;
    expectedOwner?: NativeProviderAuthOwnerFence;
    expectedOperation?: NativeProviderAuthOperationFence;
    /** Finalize only the exact durable revoke operation staged by this owner generation. */
    requirePendingRevocation?: boolean;
  },
): boolean {
  // 归属读不出来时放弃写入。用户的意图是「登出这一个 provider」,不是「把其余 provider 的
  // 归属清空」—— 而把损坏文件覆盖成一份只剩撤销标记的新文件正是后者,其余 provider 从此
  // 无主,下一次可信读取就会把它们的残留凭证认领给当前账号(PR #548 review)。
  //
  // 不写也是安全的:文件读不出来时 isNativeProviderAuthBound 已经一律 false(用户看到的就是
  // 未连接),claimDetectedNativeProviderAuth 也已在同一条件下拒绝认领 —— 撤销标记要挡的那
  // 件事,此刻本来就发生不了。凭证删除在调用方,不受这里影响。
  return withBindingMutationLock(() => {
    if (opts?.expectedOwner && !isNativeProviderAuthOwnerFenceCurrent(opts.expectedOwner)) {
      return false;
    }
    if (opts?.expectedOperation) {
      if (!isNativeProviderAuthOwnerFenceCurrent(opts.expectedOperation)) return false;
      const intent = readOperationIntent(provider);
      if (intent.kind !== 'present' || !sameOperation(intent.operation, opts.expectedOperation)) {
        return false;
      }
    }
    if (opts?.requirePendingRevocation) {
      const pending = readPendingRevocation(provider);
      const expected = opts.expectedOperation ?? opts.expectedOwner;
      if (
        !expected ||
        pending.kind !== 'present' ||
        pending.intent !== 'revoke' ||
        pending.owner.dataOwnerId !== expected.dataOwnerId ||
        pending.owner.generation !== expected.generation ||
        (opts.expectedOperation && pending.operationId !== opts.expectedOperation.operationId)
      ) {
        return false;
      }
    }
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    const bindings = read.bindings;
    const owner = getActiveAppSession().dataOwnerId;
    const expectedOwnerId =
      opts?.expectedOperation?.dataOwnerId ?? opts?.expectedOwner?.dataOwnerId ?? owner;
    // Recovery after a crash between the atomic main-file write and sidecar
    // unlink: the exact revoke marker and matching main revoked owner prove the
    // binding commit already happened. Finish by clearing the stale sidecar;
    // the caller may then safely complete credential deletion.
    if (
      opts?.requirePendingRevocation &&
      expectedOwnerId &&
      !(provider in bindings) &&
      bindings.revoked?.[provider] === expectedOwnerId
    ) {
      clearPendingRevocation(provider);
      if (opts.expectedOperation) clearOperationIntent(provider, opts.expectedOperation);
      return true;
    }
    // A caller that previously observed an unreadable binding can race with the
    // file recovering. Re-check ownership under the mutation lock and never
    // delete a different owner's binding.
    if (
      (opts?.ifOwnedByCurrentSession || opts?.expectedOwner || opts?.expectedOperation) &&
      (!expectedOwnerId || bindings[provider] !== expectedOwnerId)
    ) {
      return false;
    }
    if (provider in bindings && (!owner || bindings[provider] !== owner)) return false;
    const marking = opts?.revoked === true && !!owner;
    const hadSelfAuthorized = bindings.selfAuthorized?.[provider] !== undefined;
    if (!(provider in bindings) && !marking && !hadSelfAuthorized) {
      if (opts?.expectedOperation) clearOperationIntent(provider, opts.expectedOperation);
      return true;
    }
    delete bindings[provider];
    // 授权来路随绑定一起作废:登出之后这份凭证若还在本机,它对 Cindy 就重新是「外部已有的
    // 凭证」，继承语义（及其文案）重新成立。
    if (hadSelfAuthorized) {
      const selfAuthorized = { ...bindings.selfAuthorized };
      delete selfAuthorized[provider];
      bindings.selfAuthorized = selfAuthorized;
    }
    if (marking) bindings.revoked = { ...(bindings.revoked ?? {}), [provider]: owner as string };
    writeBindings(bindings);
    if (marking || opts?.requirePendingRevocation) clearPendingRevocation(provider);
    if (opts?.expectedOperation) clearOperationIntent(provider, opts.expectedOperation);
    return true;
  });
}

export type NativeProviderAuthRejectedCredentialInvalidationResult<T> =
  { state: 'committed'; value: T } | { state: 'changed' };

/**
 * Complete one server-rejected credential cleanup without first persisting a
 * provider-global operation intent. The caller already holds the credential
 * storage lock, so this takes the binding lock second and keeps it through the
 * synchronous credential clear and owner unbind.
 *
 * Crash ordering is intentional: before `clearCredentialLocked` there is no
 * durable binding mutation; after it, a crash can leave only an empty
 * credential slot with the old owner binding. A later, different standalone
 * credential can therefore recover normally instead of being hidden forever
 * by a stale generic invalidate intent.
 */
export function invalidateNativeProviderAuthWithoutIntent<T>(
  provider: NativeProviderId,
  expectedOwner: NativeProviderAuthOwnerFence,
  clearCredentialLocked: () => T,
): NativeProviderAuthRejectedCredentialInvalidationResult<T> {
  if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return { state: 'changed' };
  return withBindingMutationLock(() => {
    if (!isNativeProviderAuthOwnerFenceCurrent(expectedOwner)) return { state: 'changed' };

    const intent = readOperationIntent(provider);
    if (intent.kind === 'unreadable') {
      throw new Error('native provider auth operation intent is unreadable during invalidation');
    }
    if (intent.kind === 'present') return { state: 'changed' };

    const pending = readPendingRevocation(provider);
    if (pending.kind === 'unreadable') {
      throw new Error('native provider auth revocation state is unreadable during invalidation');
    }
    if (pending.kind === 'present') return { state: 'changed' };

    const read = readBindingsOrFail();
    if (!read.ok) {
      throw new Error('native provider auth ownership is unreadable during invalidation');
    }
    const bindings = read.bindings;
    if (
      bindings[provider] !== expectedOwner.dataOwnerId ||
      bindings.revoked?.[provider] !== undefined
    ) {
      return { state: 'changed' };
    }

    const value = clearCredentialLocked();
    delete bindings[provider];
    if (bindings.selfAuthorized?.[provider] !== undefined) {
      const selfAuthorized = { ...bindings.selfAuthorized };
      delete selfAuthorized[provider];
      bindings.selfAuthorized = selfAuthorized;
    }
    writeBindings(bindings);
    return { state: 'committed', value };
  });
}

/**
 * Claim pre-binding native OAuth credentials for the first verified cloud
 * owner. The durable marker prevents a later account from inheriting a
 * credential that was left in a shared CLI/keychain store after logout.
 */
export function migrateLegacyNativeProviderAuthBindings(
  ownerId: string,
  available: Partial<Record<NativeProviderId, boolean>>,
): void {
  // 同 claimDetectedNativeProviderAuth:一次性迁移也是写路径,归属读不出来就不能推进
  // (还会把 legacyClaimOwner 名额一起消费掉,损失不可逆)。
  withBindingMutationLock(() => {
    const read = readBindingsOrFail();
    if (!read.ok) return;
    const bindings = read.bindings;
    if (bindings.legacyClaimOwner) return;

    const next: BindingFile = { ...bindings, legacyClaimOwner: ownerId };
    for (const provider of NATIVE_PROVIDER_IDS) {
      // 显式登出过或存在未决撤销的 provider 一律跳过。
      if (bindings.revoked && provider in bindings.revoked) continue;
      if (readOperationIntent(provider).kind !== 'absent') continue;
      if (readPendingRevocation(provider).kind !== 'absent') continue;
      if (available[provider] && !next[provider]) next[provider] = ownerId;
    }
    writeBindings(next);
  });
}

/**
 * Claim an auto-detected local CLI credential for the current owner.
 *
 * Applies to every native provider, not just Codex. Two independent holes make
 * the intended first-owner auto-connect strand forever without this repair:
 *   - the one-shot legacy migration above can consume `legacyClaimOwner` while a
 *     credential is not visible yet (the Codex ~/.codex reconcile hardlink is
 *     created after startup, so its probe reads false);
 *   - the migration only runs for cloud owners that hold the legacy namespace
 *     claim, so local-mode owners — and cloud owners whose claim marker is
 *     absent — never get a chance to inherit at all, no matter how visible the
 *     credential is. Anthropic and xAI read their credential synchronously and
 *     are therefore immune to the first hole but not to the second.
 *
 * This repairs exactly that: only when the slot has no owner, the credential
 * exists, and no OTHER account won the legacy claim. An existing binding is
 * never overwritten, so account switches stay fail-closed like
 * migrateLegacyNativeProviderAuthBindings.
 */
export function claimDetectedNativeProviderAuth(
  provider: NativeProviderId,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) return false;
  // A session boundary in flight means `owner` is about to be replaced: writing
  // now would hand the outgoing account's credential to the incoming one.
  // Callers reached from an async settle (Codex reconcile) additionally pin an
  // owner+generation snapshot; this guard is the floor every caller gets.
  if (isAppSessionBoundaryPending()) return false;
  return withBindingMutationLock(() => {
    if (getActiveAppSession().dataOwnerId !== owner || isAppSessionBoundaryPending()) return false;
    // 归属文件读不出来 = 归属不明,一律不认领:这条路径是**写**路径,把损坏当空会把共享
    // keychain 里可能属于别人的凭证判给当前账号,并覆盖掉原有归属(PR #548 review)。
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    if (readOperationIntent(provider).kind !== 'absent') return false;
    if (readPendingRevocation(provider).kind !== 'absent') return false;
    const bindings = read.bindings;
    // Key-presence, not truthiness: a corrupted/empty-string slot must count as
    // "claimed by unknown" and fail closed, never as re-claimable (matches
    // unbindNativeProviderAuth's `in` pattern).
    if (provider in bindings) return false;
    if ('legacyClaimOwner' in bindings && bindings.legacyClaimOwner !== owner) return false;
    // 被显式登出过就绝不自动认领,且**不比对 owner**:凭证在共享的系统 keychain / CLI 里,
    // 换个账号它仍是登出那个账号的凭证 —— 按 owner 比对等于给下一个账号开了继承别人凭证
    // 的口子。解除只有「用户再次显式授权」一条路(PR #548 review)。
    if (bindings.revoked && provider in bindings.revoked) return false;
    if (!hasCredential()) return false;
    if (getActiveAppSession().dataOwnerId !== owner || isAppSessionBoundaryPending()) return false;
    writeBindings({ ...bindings, [provider]: owner });
    return true;
  });
}

/**
 * Restore a provider binding only for the owner that was using the credential when it was
 * invalidated. This is intentionally narrower than generic auto-claim: a renewed shared system
 * credential is recovery of an existing owner relationship, so `legacyClaimOwner` must not strand
 * that owner, while account switches and explicit revocation still fail closed.
 */
export function restoreNativeProviderAuthForRecovery(
  provider: NativeProviderId,
  expectedOwner: string,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner || owner !== expectedOwner || isAppSessionBoundaryPending()) return false;
  return withBindingMutationLock(() => {
    if (getActiveAppSession().dataOwnerId !== expectedOwner || isAppSessionBoundaryPending()) {
      return false;
    }
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    if (readOperationIntent(provider).kind !== 'absent') return false;
    if (readPendingRevocation(provider).kind !== 'absent') return false;
    const bindings = read.bindings;
    if (bindings.revoked && provider in bindings.revoked) return false;
    if (!hasCredential()) return false;
    if (provider in bindings) return bindings[provider] === expectedOwner;
    writeBindings({ ...bindings, [provider]: expectedOwner });
    return true;
  });
}
