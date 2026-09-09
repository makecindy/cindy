import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { platform as hostPlatform } from 'node:os';
import path from 'node:path';

import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  LOCAL_DATA_OWNER_ID,
} from '../appSessionState.js';
import { createBetterSqliteDatabase } from '../localDb/betterSqliteFactory.js';
import {
  isConnectionSourceKind,
  NATIVE_PROVIDER_CONNECTION_SOURCE,
  type ConnectionSourceKind,
  type NativeHarnessInheritedProviderId,
  type NativeProviderId,
} from './model-discovery/connection-source.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';

// Link-reconciliation tests override process.platform to exercise POSIX and
// Windows topology semantics. Durability capabilities belong to the actual
// host filesystem, so capture them before any such override can occur.
const NATIVE_BINDING_HOST_PLATFORM = hostPlatform();

const NATIVE_PROVIDER_IDS = [
  'anthropic',
  'openai',
  'xai',
] as const satisfies readonly NativeProviderId[];
type BindingFile = Partial<Record<NativeProviderId, string>> & {
  legacyClaimOwner?: string;
  legacyClaimToken?: string;
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
  /** 授权来源审计；旧文件缺失时继续由 selfAuthorized / provider 迁移语义兼容。 */
  sources?: Partial<Record<NativeProviderId, ConnectionSourceKind>>;
  /**
   * 已当场验证为系统共享凭证的 owner。存量 POSIX 与 Windows hardlink 在系统 auth.json
   * 原子换代后都会退化成普通 file；这份独立 provenance 让下次启动仍能把旧 inode 迁回
   * 系统新凭证，且不覆盖 sources 里真实的「最初由 Cindy 显式授权」来路。
   */
  sharedSystemCredential?: Partial<Record<NativeProviderId, string>>;
  /**
   * 已在登录收尾当场确认是实例隔离普通文件的 owner。旧 selfAuthorized / sources 只证明
   * owner 曾显式授权，不能证明眼前文件没有先被共享成 hardlink 再因系统换代而断链。
   */
  instanceIsolatedCredential?: Partial<Record<NativeProviderId, string>>;
};

function sharedSystemCredentialOwners(
  bindings: BindingFile,
): Partial<Record<NativeProviderId, string>> {
  const value = bindings.sharedSystemCredential;
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function instanceIsolatedCredentialOwners(
  bindings: BindingFile,
): Partial<Record<NativeProviderId, string>> {
  const value = bindings.instanceIsolatedCredential;
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function bindingPath(): string {
  return path.join(app.getPath('userData'), 'native-provider-auth.json');
}

function hasInvalidProviderOwnerSlot(value: unknown): boolean {
  if (value === undefined) return false;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const owners = value as Record<string, unknown>;
  return NATIVE_PROVIDER_IDS.some(
    (provider) => provider in owners && typeof owners[provider] !== 'string',
  );
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

let nativeBindingMutationLockDepth = 0;

function readBindingsOrFail(): BindingRead {
  const file = bindingPath();
  let raw: string;
  try {
    if (nativeBindingMutationLockDepth > 0) {
      const restored = readAtomicFileSync(file);
      if (restored === null) return { ok: true, bindings: {} };
      raw = restored;
    } else {
      try {
        // The common read path has no filesystem side effects and therefore
        // stays off the synchronous SQLite writer lock.
        raw = fs.readFileSync(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
        if (!fs.existsSync(`${file}.bak`)) return { ok: true, bindings: {} };
        // Restoring `<file>.bak` is a mutation. Acquire the same lock as the
        // writer and recheck inside it so a reader cannot interrupt the
        // Windows backup-exchange window.
        return withNativeBindingMutationLock<BindingRead>(
          { ok: false, reason: 'unreadable' },
          () => readBindingsOrFail(),
        );
      }
    }
  } catch {
    // EACCES / EIO / 无法恢复原子备份都说明归属不明，不能当成空。
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'unreadable' };
    }
    const ownerFields = value as {
      selfAuthorized?: unknown;
      sharedSystemCredential?: unknown;
      instanceIsolatedCredential?: unknown;
    };
    if (
      hasInvalidProviderOwnerSlot(value) ||
      hasInvalidProviderOwnerSlot(ownerFields.selfAuthorized) ||
      hasInvalidProviderOwnerSlot(ownerFields.sharedSystemCredential) ||
      hasInvalidProviderOwnerSlot(ownerFields.instanceIsolatedCredential)
    ) {
      // Owner provenance is an authorization boundary. A syntactically valid JSON value with
      // the wrong runtime type is not proof and must never reach downstream string operations.
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
  const file = bindingPath();
  atomicWriteFileSync(file, JSON.stringify(value, null, 2));
  // Flush the published file on every platform. On Windows this maps to
  // FlushFileBuffers and is the durable barrier available for a renamed
  // file; POSIX additionally flushes the parent directory below.
  // Windows requires a writable handle for FlushFileBuffers. The binding file is
  // created with owner-only permissions, so r+ remains safe on POSIX while also
  // making the post-rename durability barrier work on Windows.
  const finalHandle = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(finalHandle);
  } finally {
    fs.closeSync(finalHandle);
  }
  syncParentDirectory(file);
}

const BINDING_MUTATION_LOCK_DB_SUFFIX = '.mutation-lock.db';

function syncParentDirectory(file: string): void {
  let dirHandle: number | undefined;
  try {
    dirHandle = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dirHandle);
  } catch (error) {
    // Windows does not support opening directories on every filesystem. The
    // final-file FlushFileBuffers above remains the fallback durability
    // barrier in that case; do not turn a successful binding commit into a
    // logout merely because directory fsync is unavailable.
    if (NATIVE_BINDING_HOST_PLATFORM !== 'win32') throw error;
  } finally {
    if (dirHandle !== undefined) fs.closeSync(dirHandle);
  }
}

function withNativeBindingMutationLock<T>(
  fallback: T,
  operation: () => T,
  opts?: { throwOnLockFailure?: boolean },
): T {
  const lockDbPath = `${bindingPath()}${BINDING_MUTATION_LOCK_DB_SUFFIX}`;
  fs.mkdirSync(path.dirname(lockDbPath), { recursive: true });
  let lockDb: ReturnType<typeof createBetterSqliteDatabase> | null = null;
  try {
    lockDb = createBetterSqliteDatabase(lockDbPath);
    lockDb.pragma('busy_timeout = 30000');
    lockDb.exec(
      'CREATE TABLE IF NOT EXISTS binding_mutation_lock (id INTEGER PRIMARY KEY CHECK (id = 1))',
    );
    lockDb.exec('BEGIN IMMEDIATE');
  } catch (error) {
    try {
      lockDb?.close();
    } catch {
      // Preserve the acquisition error; close is best effort on a failed open.
    }
    if (opts?.throwOnLockFailure) {
      throw new Error(
        `failed to acquire native provider binding mutation lock: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return fallback;
  }
  try {
    nativeBindingMutationLockDepth += 1;
    return operation();
  } finally {
    nativeBindingMutationLockDepth -= 1;
    try {
      // The transaction exists only to hold SQLite's cross-process writer
      // lock while the JSON read-modify-write runs; no lock-db state is changed.
      lockDb.exec('ROLLBACK');
    } catch {
      // Closing the connection still releases SQLite's OS-level lock.
    }
    lockDb.close();
  }
}

function withRequiredNativeBindingMutationLock<T>(operation: () => T): T {
  return withNativeBindingMutationLock<T>(undefined as T, operation, {
    throwOnLockFailure: true,
  });
}

export type LegacyNativeProviderAuthReservation =
  'claimed' | 'already-owned' | 'owned-by-other' | 'failed';

export interface LegacyNativeProviderAuthReservationDetails {
  status: LegacyNativeProviderAuthReservation;
  claimToken?: string;
}

export type PendingLegacyNativeProviderAuthRecovery =
  | 'none'
  | 'finalized'
  | 'released'
  | 'failed';

export type LegacyNativeProviderAuthOwnerRead =
  | { status: 'none' }
  | { status: 'owned'; ownerId: string }
  | { status: 'failed' };

/** Read a durable legacy namespace owner without creating or finalizing a claim. */
export function readLegacyNativeProviderAuthOwner(): LegacyNativeProviderAuthOwnerRead {
  const read = readBindingsOrFail();
  if (!read.ok) return { status: 'failed' };
  const bindings = read.bindings;
  if (!('legacyClaimOwner' in bindings)) return { status: 'none' };
  if ('legacyClaimToken' in bindings) return { status: 'failed' };
  const ownerId =
    typeof bindings.legacyClaimOwner === 'string' ? bindings.legacyClaimOwner.trim() : '';
  if (!ownerId || ownerId === LOCAL_DATA_OWNER_ID) return { status: 'failed' };
  return { status: 'owned', ownerId };
}

function reserveLegacyNativeProviderAuthOwnerWithMode(
  ownerId: string,
  provisional: boolean,
): LegacyNativeProviderAuthReservationDetails {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || normalizedOwnerId === LOCAL_DATA_OWNER_ID) {
    return { status: 'failed' };
  }
  // Stable repair and ordinary same-owner refresh both reach this helper. A
  // tokenless matching (or different) owner is a definitive no-op in either
  // mode, so avoid blocking the Electron main thread on the synchronous writer
  // lock. Missing or provisional state still enters the lock and is rechecked.
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return { status: 'failed' };
  const bindings = snapshot.bindings;
  if ('legacyClaimOwner' in bindings) {
    if (bindings.legacyClaimOwner !== normalizedOwnerId) {
      return { status: 'owned-by-other' };
    }
    if (!('legacyClaimToken' in bindings)) {
      return { status: 'already-owned' };
    }
  }
  return withNativeBindingMutationLock<LegacyNativeProviderAuthReservationDetails>(
    { status: 'failed' },
    () => {
      try {
        const read = readBindingsOrFail();
        if (!read.ok) return { status: 'failed' };
        const bindings = read.bindings;
        if ('legacyClaimOwner' in bindings) {
          if (bindings.legacyClaimOwner !== normalizedOwnerId) {
            return { status: 'owned-by-other' };
          }
          if (!provisional && bindings.legacyClaimToken) {
            const next = { ...bindings };
            delete next.legacyClaimToken;
            writeBindings(next);
          }
          return { status: 'already-owned' };
        }
        const claimToken = provisional ? randomUUID() : undefined;
        writeBindings({
          ...bindings,
          legacyClaimOwner: normalizedOwnerId,
          ...(claimToken ? { legacyClaimToken: claimToken } : {}),
        });
        return { status: 'claimed', ...(claimToken ? { claimToken } : {}) };
      } catch {
        return { status: 'failed' };
      }
    },
  );
}

/** Reserve the one-shot native-provider namespace at the verified cloud commit edge. */
export function reserveLegacyNativeProviderAuthOwnerDetailed(
  ownerId: string,
): LegacyNativeProviderAuthReservationDetails {
  return reserveLegacyNativeProviderAuthOwnerWithMode(ownerId, true);
}

/** Reserve or finalize the namespace for an owner whose cloud session is already durable. */
export function reserveCommittedLegacyNativeProviderAuthOwner(
  ownerId: string,
): LegacyNativeProviderAuthReservation {
  return reserveLegacyNativeProviderAuthOwnerWithMode(ownerId, false).status;
}

export function reserveLegacyNativeProviderAuthOwner(
  ownerId: string,
): LegacyNativeProviderAuthReservation {
  return reserveLegacyNativeProviderAuthOwnerDetailed(ownerId).status;
}

export function releaseLegacyNativeProviderAuthOwner(ownerId: string, claimToken: string): boolean {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || !claimToken) return false;
  return withNativeBindingMutationLock(false, () => {
    try {
      const read = readBindingsOrFail();
      if (!read.ok) return false;
      const bindings = read.bindings;
      if (
        bindings.legacyClaimOwner !== normalizedOwnerId ||
        bindings.legacyClaimToken !== claimToken
      ) {
        return false;
      }
      const next = { ...bindings };
      delete next.legacyClaimOwner;
      delete next.legacyClaimToken;
      writeBindings(next);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Settle a durable pre-commit legacy-namespace claim. The token belonging to
 * the currently committed cloud owner is finalized; a token for any other
 * owner is an interrupted reservation and is released. Tokenless ownership is
 * already committed and remains untouched.
 */
export function recoverPendingLegacyNativeProviderAuthOwner(
  committedOwnerId: string | null,
): PendingLegacyNativeProviderAuthRecovery {
  const normalizedCommittedOwnerId = committedOwnerId?.trim() || null;
  // A tokenless binding is already durable ownership, not pending recovery.
  // Read it without taking the synchronous writer lock so stable-owner
  // initialization cannot block the Electron main thread on a no-op.
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return 'failed';
  if (!snapshot.bindings.legacyClaimToken) return 'none';
  return withNativeBindingMutationLock<PendingLegacyNativeProviderAuthRecovery>('failed', () => {
    try {
      const read = readBindingsOrFail();
      if (!read.ok) return 'failed';
      const bindings = read.bindings;
      if (!bindings.legacyClaimToken) return 'none';
      const next = { ...bindings };
      if (bindings.legacyClaimOwner === normalizedCommittedOwnerId) {
        delete next.legacyClaimToken;
        writeBindings(next);
        return 'finalized';
      }
      delete next.legacyClaimOwner;
      delete next.legacyClaimToken;
      writeBindings(next);
      return 'released';
    } catch {
      return 'failed';
    }
  });
}

/** Return true only when the native OAuth credential is explicitly bound to this owner. */
export function isNativeProviderAuthBound(provider: NativeProviderId): boolean {
  const read = readBindingsOrFail();
  if (!read.ok) return false;
  const bindings = read.bindings;
  // Revocation describes the credential itself, not the current app owner. It must therefore
  // remain authoritative during signed-out/bootstrap reads too; otherwise a residual local token
  // can be treated as bound before an owner session has committed.
  if (bindings.revoked && provider in bindings.revoked) return false;
  const owner = getActiveAppSession().dataOwnerId;
  // During unit/bootstrap code paths there may be no committed owner yet.
  // Owner-bound sessions are fail-closed; pre-session callers retain legacy
  // behavior until authentication commits an owner boundary.
  if (!owner) return true;
  return bindings[provider] === owner;
}

/** Whether an explicit durable revocation currently suppresses this provider credential. */
export function isNativeProviderAuthRevoked(provider: NativeProviderId): boolean {
  const read = readBindingsOrFail();
  return Boolean(read.ok && read.bindings.revoked && provider in read.bindings.revoked);
}

/** Bind newly completed native OAuth to the current data owner. */
export function bindNativeProviderAuth(
  provider: NativeProviderId,
  opts?: { instanceIsolated?: boolean },
): void {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) throw new Error('cannot bind native provider auth without an active data owner');
  const written = withNativeBindingMutationLock(false, () => {
    const read = readBindingsOrFail();
    if (read.ok) {
      const bindings = read.bindings;
      const sharedSystemCredential = sharedSystemCredentialOwners(bindings);
      delete sharedSystemCredential[provider];
      const instanceIsolatedCredential = instanceIsolatedCredentialOwners(bindings);
      if (opts?.instanceIsolated) instanceIsolatedCredential[provider] = owner;
      else delete instanceIsolatedCredential[provider];
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
        sources: {
          ...bindings.sources,
          [provider]: 'explicit-provider-oauth',
        },
        sharedSystemCredential,
        instanceIsolatedCredential,
        [provider]: owner,
      });
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
    const sharedSystemCredential = sharedSystemCredentialOwners(salvaged);
    delete sharedSystemCredential[provider];
    const instanceIsolatedCredential = instanceIsolatedCredentialOwners(salvaged);
    if (opts?.instanceIsolated) instanceIsolatedCredential[provider] = owner;
    else delete instanceIsolatedCredential[provider];
    const suppressed: Partial<Record<NativeProviderId, string>> = {};
    for (const other of NATIVE_PROVIDER_IDS) {
      if (other !== provider) suppressed[other] = owner;
    }
    writeBindings({
      ...salvaged,
      revoked: suppressed,
      selfAuthorized: { ...salvaged.selfAuthorized, [provider]: owner },
      sources: {
        ...salvaged.sources,
        [provider]: 'explicit-provider-oauth',
      },
      sharedSystemCredential,
      instanceIsolatedCredential,
      [provider]: owner,
    });
    return true;
  });
  if (!written) throw new Error('cannot acquire native provider binding lease');
}

/**
 * 这份 provider 凭证是不是**用户在 Cindy 里亲自授权**得来的(而非继承本机 CLI 已有凭证)。
 * 只回 boolean,供用户可见文案取舍(见 `selfAuthorized` 字段注释)。读不出绑定文件时按
 * `true` 保守处理 —— 「说不清来路」时不要声称「已沿用你本机的登录」。
 */
export function isNativeProviderAuthSelfAuthorized(provider: NativeProviderId): boolean {
  const read = readBindingsOrFail();
  if (!read.ok && read.reason === 'unreadable') return true;
  return (
    read.bindings.sources?.[provider] === 'explicit-provider-oauth' ||
    read.bindings.selfAuthorized?.[provider] !== undefined
  );
}

function explicitNativeProviderAuthOwner(
  bindings: BindingFile,
  provider: NativeProviderId,
): string | null {
  const boundOwner = bindings[provider]?.trim();
  if (!boundOwner) return null;
  const source = bindings.sources?.[provider];
  const selfAuthorizedOwner = bindings.selfAuthorized?.[provider]?.trim();
  if (source !== undefined && source !== 'explicit-provider-oauth') return null;
  if (selfAuthorizedOwner !== undefined && selfAuthorizedOwner !== boundOwner) return null;
  return source === 'explicit-provider-oauth' || selfAuthorizedOwner === boundOwner
    ? boundOwner
    : null;
}

/**
 * Return the proven owner of a Cindy-explicit OAuth credential without applying the active-owner
 * binding gate. This is intentionally stricter than isNativeProviderAuthSelfAuthorized(): unreadable
 * or contradictory provenance must not turn an unproven local credential into an isolated one.
 */
export function readExplicitNativeProviderAuthOwner(
  provider: NativeProviderId,
): string | null {
  const read = readBindingsOrFail();
  if (!read.ok) return null;
  const boundOwner = explicitNativeProviderAuthOwner(read.bindings, provider);
  if (!boundOwner) return null;
  const isolatedOwner = instanceIsolatedCredentialOwners(read.bindings)[provider]?.trim();
  return isolatedOwner === boundOwner ? boundOwner : null;
}

/** Return a parent-version explicit owner only when neither current provenance marker exists. */
export function readLegacyExplicitNativeProviderAuthOwner(
  provider: NativeProviderId,
): string | null {
  const read = readBindingsOrFail();
  if (!read.ok) return null;
  const owner = explicitNativeProviderAuthOwner(read.bindings, provider);
  if (!owner) return null;
  if (sharedSystemCredentialOwners(read.bindings)[provider] !== undefined) return null;
  if (instanceIsolatedCredentialOwners(read.bindings)[provider] !== undefined) return null;
  return owner;
}

/** Promote an account-distinct parent-version explicit credential without rebinding its owner. */
export function migrateLegacyExplicitNativeProviderAuthToInstanceIsolated(
  provider: NativeProviderId,
  expectedOwner: string,
): boolean {
  return withNativeBindingMutationLock(false, () => {
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    if (explicitNativeProviderAuthOwner(read.bindings, provider) !== expectedOwner) return false;
    if (sharedSystemCredentialOwners(read.bindings)[provider] !== undefined) return false;
    const isolated = instanceIsolatedCredentialOwners(read.bindings);
    if (isolated[provider] !== undefined && isolated[provider] !== expectedOwner) return false;
    if (isolated[provider] === expectedOwner) return true;
    writeBindings({
      ...read.bindings,
      instanceIsolatedCredential: { ...isolated, [provider]: expectedOwner },
    });
    return true;
  });
}

/** Persist that this owner's credential was observed as a healthy system-shared hardlink inode. */
export function markNativeProviderAuthSharedSystemCredential(
  provider: NativeProviderId,
): boolean {
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return false;
  const snapshotOwner = snapshot.bindings[provider]?.trim();
  if (!snapshotOwner) return false;
  if (
    sharedSystemCredentialOwners(snapshot.bindings)[provider]?.trim() === snapshotOwner &&
    instanceIsolatedCredentialOwners(snapshot.bindings)[provider] === undefined
  ) {
    return true;
  }
  return withNativeBindingMutationLock(false, () => {
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    const owner = read.bindings[provider]?.trim();
    if (!owner) return false;
    const sharedSystemCredential = sharedSystemCredentialOwners(read.bindings);
    const instanceIsolatedCredential = instanceIsolatedCredentialOwners(read.bindings);
    if (
      sharedSystemCredential[provider]?.trim() === owner &&
      instanceIsolatedCredential[provider] === undefined
    )
      return true;
    delete instanceIsolatedCredential[provider];
    writeBindings({
      ...read.bindings,
      sharedSystemCredential: { ...sharedSystemCredential, [provider]: owner },
      instanceIsolatedCredential,
    });
    return true;
  });
}

/** Whether the current binding carries owner-consistent proof of a previously shared system inode. */
export function isNativeProviderAuthSharedSystemCredential(provider: NativeProviderId): boolean {
  const read = readBindingsOrFail();
  if (!read.ok) return false;
  const owner = read.bindings[provider]?.trim();
  return Boolean(
    owner && sharedSystemCredentialOwners(read.bindings)[provider]?.trim() === owner,
  );
}

/** 返回当前 owner 绑定的授权来源；归属不明或旧文件未记录时返回 null。 */
export function getNativeProviderAuthSource(
  provider: NativeProviderId,
): ConnectionSourceKind | null {
  if (!isNativeProviderAuthBound(provider)) return null;
  const read = readBindingsOrFail();
  if (!read.ok) return null;
  const explicit = read.bindings.sources?.[provider];
  if (isConnectionSourceKind(explicit)) return explicit;
  if (read.bindings.selfAuthorized?.[provider] !== undefined) return 'explicit-provider-oauth';
  // 旧版 xAI token 只可能由 Cindy 的浏览器 OAuth 写入；不得把缺少来源字段误报成 CLI 继承。
  return NATIVE_PROVIDER_CONNECTION_SOURCE[provider];
}

/**
 * Remove the current owner binding after logout/invalidation.
 *
 * `revoked: true` 只用于**用户显式登出**：它会留下一个持久标记，挡住后续的自动认领。
 * 服务端作废凭证（401 invalidate）不传——那不是用户意图，凭证也已被清掉，用户之后在本机
 * CLI 重新登录时仍应享有设计内的自动继承。
 */
export function unbindNativeProviderAuth(
  provider: NativeProviderId,
  opts?: { revoked?: boolean },
): void {
  // 归属读不出来时放弃写入。用户的意图是「登出这一个 provider」,不是「把其余 provider 的
  // 归属清空」—— 而把损坏文件覆盖成一份只剩撤销标记的新文件正是后者,其余 provider 从此
  // 无主,下一次可信读取就会把它们的残留凭证认领给当前账号(PR #548 review)。
  //
  // 不写也是安全的:文件读不出来时 isNativeProviderAuthBound 已经一律 false(用户看到的就是
  // 未连接),claimDetectedNativeProviderAuth 也已在同一条件下拒绝认领 —— 撤销标记要挡的那
  // 件事,此刻本来就发生不了。凭证删除在调用方,不受这里影响。
  // 服务端失效会先做一次 early-unbind，随后 runLogout 再无 revoked 地收口。第二次若
  // snapshot 已证明 slot、来路字段都不存在，就是确定性 no-op，不要在 Electron main
  // thread 上同步等待跨进程 writer lock。显式登出仍必须进锁并持久化 revoked。
  if (opts?.revoked !== true) {
    const snapshot = readBindingsOrFail();
    if (snapshot.ok) {
      const bindings = snapshot.bindings;
      const hasSelfAuthorized = bindings.selfAuthorized?.[provider] !== undefined;
      const hasSource = bindings.sources?.[provider] !== undefined;
      const hasSharedSystemCredential =
        sharedSystemCredentialOwners(bindings)[provider] !== undefined;
      const hasInstanceIsolatedCredential =
        instanceIsolatedCredentialOwners(bindings)[provider] !== undefined;
      if (
        !(provider in bindings) &&
        !hasSelfAuthorized &&
        !hasSource &&
        !hasSharedSystemCredential &&
        !hasInstanceIsolatedCredential
      )
        return;
    }
  }
  withRequiredNativeBindingMutationLock(() => {
    const read = readBindingsOrFail();
    if (!read.ok) return;
    const bindings = read.bindings;
    const owner = getActiveAppSession().dataOwnerId;
    const marking = opts?.revoked === true && !!owner;
    const hadSelfAuthorized = bindings.selfAuthorized?.[provider] !== undefined;
    const hadSource = bindings.sources?.[provider] !== undefined;
    const sharedSystemCredential = sharedSystemCredentialOwners(bindings);
    const hadSharedSystemCredential = sharedSystemCredential[provider] !== undefined;
    const instanceIsolatedCredential = instanceIsolatedCredentialOwners(bindings);
    const hadInstanceIsolatedCredential = instanceIsolatedCredential[provider] !== undefined;
    if (
      !(provider in bindings) &&
      !marking &&
      !hadSelfAuthorized &&
      !hadSource &&
      !hadSharedSystemCredential &&
      !hadInstanceIsolatedCredential
    )
      return;
    delete bindings[provider];
    // 授权来路随绑定一起作废:登出之后这份凭证若还在本机,它对 Cindy 就重新是「外部已有的
    // 凭证」，继承语义（及其文案）重新成立。
    if (hadSelfAuthorized) {
      const selfAuthorized = { ...bindings.selfAuthorized };
      delete selfAuthorized[provider];
      bindings.selfAuthorized = selfAuthorized;
    }
    if (hadSource) {
      const sources = { ...bindings.sources };
      delete sources[provider];
      bindings.sources = sources;
    }
    if (hadSharedSystemCredential) {
      delete sharedSystemCredential[provider];
      bindings.sharedSystemCredential = sharedSystemCredential;
    }
    if (hadInstanceIsolatedCredential) {
      delete instanceIsolatedCredential[provider];
      bindings.instanceIsolatedCredential = instanceIsolatedCredential;
    }
    if (marking) bindings.revoked = { ...(bindings.revoked ?? {}), [provider]: owner as string };
    writeBindings(bindings);
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
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return;
  if (!needsLegacyNativeProviderAuthMigration(snapshot.bindings, ownerId, available)) return;

  withNativeBindingMutationLock(undefined, () => {
    const read = readBindingsOrFail();
    if (!read.ok) return;
    const bindings = read.bindings;
    if ('legacyClaimOwner' in bindings && bindings.legacyClaimOwner !== ownerId) return;

    const next: BindingFile = { ...bindings };
    let changed = false;
    if (!('legacyClaimOwner' in bindings)) {
      next.legacyClaimOwner = ownerId;
      changed = true;
    }
    for (const provider of NATIVE_PROVIDER_IDS) {
      // 显式登出过的 provider 一律跳过:这条一次性迁移同样不能把用户弃用掉的残留凭证
      // 认领回来(PR #548 review)。
      if (bindings.revoked && provider in bindings.revoked) continue;
      if (available[provider] && !(provider in bindings)) {
        next[provider] = ownerId;
        changed = true;
        next.sources = {
          ...next.sources,
          [provider]: NATIVE_PROVIDER_CONNECTION_SOURCE[provider],
        };
        // xAI 的旧 safeStorage blob 也是 Cindy 自己完成的 OAuth，不是本机 CLI 继承。
        if (provider === 'xai') {
          next.selfAuthorized = { ...next.selfAuthorized, xai: ownerId };
        }
      }
    }
    if (changed) writeBindings(next);
  });
}

function needsLegacyNativeProviderAuthMigration(
  bindings: BindingFile,
  ownerId: string,
  available: Partial<Record<NativeProviderId, boolean>>,
): boolean {
  if ('legacyClaimOwner' in bindings) {
    if (bindings.legacyClaimOwner !== ownerId) return false;
  } else {
    return true;
  }
  return NATIVE_PROVIDER_IDS.some(
    (provider) =>
      !(bindings.revoked && provider in bindings.revoked) &&
      available[provider] === true &&
      !(provider in bindings),
  );
}

/**
 * Move native Harness credentials that were claimed by the account-free local
 * session to the first verified cloud owner.
 *
 * Local mode uses a stable synthetic owner (`local-v1`) so provider reads can
 * still be owner-scoped before login. Once a real Cindy account is verified,
 * those same machine-level Claude/Codex credentials must follow that first
 * cloud owner; otherwise the normal owner equality check correctly (but
 * unexpectedly) hides them after login. This path is intentionally narrower
 * than a generic claim: it only rewrites slots explicitly owned by local-v1,
 * and an existing legacy claim owned by another account remains fail-closed.
 */
export function migrateLocalNativeProviderAuthBindings(ownerId: string): boolean {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId || normalizedOwnerId === LOCAL_DATA_OWNER_ID) return false;
  if (getActiveAppSession().dataOwnerId !== normalizedOwnerId) return false;
  // This helper is called after the durable cloud commit. Keep the same floor
  // as other binding writers for callers that accidentally invoke it during a
  // different owner transition.
  if (isAppSessionBoundaryPending()) return false;

  // Stable-owner initialization commonly reaches this helper from ordinary
  // renderer setup. If the snapshot proves that no local-v1 slot can move and
  // the one-shot namespace is already owned, avoid waiting on the synchronous
  // writer lock; the locked path below still rechecks before any write.
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return false;
  const snapshotBindings = snapshot.bindings;
  if (
    snapshotBindings.legacyClaimOwner === normalizedOwnerId &&
    !(['anthropic', 'openai'] as const).some(
      (provider) =>
        !(snapshotBindings.revoked && provider in snapshotBindings.revoked) &&
        snapshotBindings[provider] === LOCAL_DATA_OWNER_ID,
    )
  ) {
    return false;
  }

  return withNativeBindingMutationLock(false, () => {
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    const bindings = read.bindings;

    // A prior cloud owner winning the legacy claim is authoritative. Do not let
    // a later account inherit any local residue that was not moved at the time.
    if ('legacyClaimOwner' in bindings && bindings.legacyClaimOwner !== normalizedOwnerId) {
      return false;
    }

    const next: BindingFile = { ...bindings };
    let migrated = false;
    for (const provider of ['anthropic', 'openai'] as const) {
      if (bindings.revoked && provider in bindings.revoked) continue;
      if (bindings[provider] !== LOCAL_DATA_OWNER_ID) continue;
      next[provider] = normalizedOwnerId;
      migrated = true;
    }

    // Reserve the one-shot legacy claim for this first cloud owner. This also
    // prevents a later account from claiming another local credential that
    // appears after the initial login.
    if (!('legacyClaimOwner' in next)) next.legacyClaimOwner = normalizedOwnerId;
    if (!migrated && 'legacyClaimOwner' in bindings) return false;
    writeBindings(next);
    return migrated;
  });
}

/**
 * Claim an auto-detected local CLI credential for the current owner.
 *
 * Applies only to Cindy's native Harness providers (Claude Code and Codex). Two independent holes make
 * the intended first-owner auto-connect strand forever without this repair:
 *   - the one-shot legacy migration above can consume `legacyClaimOwner` while a
 *     credential is not visible yet (the Codex ~/.codex reconcile hardlink is
 *     created after startup, so its probe reads false);
 *   - the migration only runs for cloud owners that hold the legacy namespace
 *     claim, so local-mode owners — and cloud owners whose claim marker is
 *     absent — never get a chance to inherit at all, no matter how visible the credential is.
 *
 * xAI is deliberately excluded: it is a downstream provider, not a Cindy Harness. Its token may
 * only be bound by Cindy's explicit OAuth flow (or the one-time migration of a token that Cindy
 * itself stored in an older version), never by generic local-CLI detection.
 *
 * This repairs exactly that: only when the slot has no owner, the credential
 * exists, and no OTHER account won the legacy claim. An existing binding is
 * never overwritten, so account switches stay fail-closed like
 * migrateLegacyNativeProviderAuthBindings.
 */
export function claimDetectedNativeProviderAuth(
  provider: NativeHarnessInheritedProviderId,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner) return false;
  // A session boundary in flight means `owner` is about to be replaced: writing
  // now would hand the outgoing account's credential to the incoming one.
  // Callers reached from an async settle (Codex reconcile) additionally pin an
  // owner+generation snapshot; this guard is the floor every caller gets.
  if (isAppSessionBoundaryPending()) return false;
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return false;
  if (provider in snapshot.bindings) return false;
  if (
    ('legacyClaimOwner' in snapshot.bindings && snapshot.bindings.legacyClaimOwner !== owner) ||
    (snapshot.bindings.revoked && provider in snapshot.bindings.revoked)
  ) {
    return false;
  }
  if (!hasCredential()) return false;

  return withNativeBindingMutationLock(false, () => {
    // 归属文件读不出来 = 归属不明,一律不认领:这条路径是**写**路径,把损坏当空会把共享
    // keychain 里可能属于别人的凭证判给当前账号,并覆盖掉原有归属(PR #548 review)。
    const read = readBindingsOrFail();
    if (!read.ok) return false;
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
    writeBindings({
      ...bindings,
      sources: { ...bindings.sources, [provider]: 'native-harness-inherited' },
      [provider]: owner,
    });
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
  provider: NativeHarnessInheritedProviderId,
  expectedOwner: string,
  hasCredential: () => boolean,
): boolean {
  const owner = getActiveAppSession().dataOwnerId;
  if (!owner || owner !== expectedOwner || isAppSessionBoundaryPending()) return false;
  // Recovery runs on the Electron main thread after Codex reconciliation. Avoid
  // synchronously waiting on the cross-process writer lock when a read-only
  // snapshot already proves that no write is needed. Any potentially writable
  // state is still rechecked under the lock below.
  const snapshot = readBindingsOrFail();
  if (!snapshot.ok) return false;
  const snapshotBindings = snapshot.bindings;
  if (snapshotBindings.revoked && provider in snapshotBindings.revoked) return false;
  if (!hasCredential()) return false;
  if (provider in snapshotBindings) return snapshotBindings[provider] === expectedOwner;

  return withNativeBindingMutationLock(false, () => {
    const read = readBindingsOrFail();
    if (!read.ok) return false;
    const bindings = read.bindings;
    if (bindings.revoked && provider in bindings.revoked) return false;
    if (!hasCredential()) return false;
    if (provider in bindings) return bindings[provider] === expectedOwner;
    writeBindings({
      ...bindings,
      sources: { ...bindings.sources, [provider]: 'native-harness-inherited' },
      [provider]: expectedOwner,
    });
    return true;
  });
}
