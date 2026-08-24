/**
 * Forge pack 产物的 Host 侧 staging 与一次性完整 ticket。
 *
 * 被注入的 agent 能在用户确认前改写 workdir 里的 `.cindy`。安装链路因此
 * 绝不能从那条路径回读：必须把内存里的 `built.buf` 直接写进 Host 生成的
 * staging。本模块只负责直写、加固、签发与失效；inspect / install 消费
 * ticket 是下一步，这里不做。
 *
 * 不在 import 时创建目录或写文件。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { ActiveAppSession } from '../appSessionState.js';

export const FORGE_PACK_TICKET_TTL_MS = 10 * 60 * 1000;
/** Extra grace so a long confirm wait plus clock skew is not swept as stale. */
export const FORGE_PACK_STAGING_SWEEP_GRACE_MS = 60 * 1000;
/**
 * Cross-instance sweep threshold: pack TTL + continuation TTL + grace.
 * Another Cindy process sharing OS temp must not delete a live confirm wait.
 */
export const FORGE_PACK_STAGING_SWEEP_MAX_AGE_MS =
  FORGE_PACK_TICKET_TTL_MS + FORGE_PACK_TICKET_TTL_MS + FORGE_PACK_STAGING_SWEEP_GRACE_MS;
const FORGE_PACK_LEASE_MARKER = '.cindy-forge-lease';

export type ForgePackOperationKind = 'install' | 'update';

export interface ForgePackIntegrityTicket {
  owner: ActiveAppSession;
  /**
   * Hint / audit only. Captured at pack time from the then-current install list.
   * Between pack and consume the same id may be installed or removed by another
   * entry, so a consumer **must not** treat this as an immutable reject
   * condition. Real install-vs-update classification happens after the consume
   * entry takes the install lock and is allowed to differ from this value.
   *
   * Strong, one-shot bindings are owner, stagingPath, packageSha256, and
   * manifestId — not this field.
   */
  operationKind: ForgePackOperationKind;
  stagingPath: string;
  packageSha256: string;
  manifestId: string;
  /**
   * Wall-clock pack expiry pinned before the lease marker. Continuation must
   * inherit `packExpiresAt + ttl` as a hard cap and must not re-base from
   * issue-time `now()`.
   */
  packExpiresAt: number;
}

export interface StageBuiltGhostPackageInput {
  buf: Buffer;
  manifestId: string;
  owner: ActiveAppSession;
  operationKind: ForgePackOperationKind;
}

export interface StageBuiltGhostPackageResult {
  ticket: string;
  stagingPath: string;
  taskDir: string;
  packageSha256: string;
}

export interface ForgePackStagingController {
  stage(input: StageBuiltGhostPackageInput): StageBuiltGhostPackageResult;
  peek(token: string): ForgePackIntegrityTicket | null;
  /**
   * Atomically take the ticket out of the map. Staging files stay until
   * `invalidate` / `releaseStaging` — inspect consumes so the pack ticket
   * cannot be replayed, but install still needs the bytes.
   */
  consume(token: string): ForgePackIntegrityTicket | null;
  consumeMatchingStagingPath(stagingPath: string): ForgePackIntegrityTicket | null;
  peekMatchingStagingPath(stagingPath: string): ForgePackIntegrityTicket | null;
  wasStagingPathConsumed(stagingPath: string): boolean;
  /**
   * After inspect consumes the pack ticket, issue a one-shot install continuation.
   * Returns null (and deletes staging) when `now()` is already past the inherited
   * hard deadline — never mint a ticket younger than the lease marker.
   */
  issueInstallContinuation(ticket: ForgePackIntegrityTicket): string | null;
  consumeInstallContinuation(token: string): ForgePackIntegrityTicket | null;
  invalidate(token: string): boolean;
  releaseStaging(stagingPath: string): void;
  invalidateMismatchedOwners(current: ActiveAppSession): void;
  invalidateAll(): void;
}

export interface CreateForgePackStagingControllerOptions {
  getTempDir(): string;
  now?: () => number;
  ttlMs?: number;
  randomId?: () => string;
  scheduleTimeout?: (ms: number, callback: () => void) => { cancel(): void };
}

function isSameOwner(a: ActiveAppSession, b: ActiveAppSession): boolean {
  return a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function noFollowFlag(): number {
  return typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
}

function assertManagedDirectory(dirPath: string, expectedRealParent: string): void {
  const stat = fs.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Forge pack staging parent is not a real directory');
  }
  const realDir = fs.realpathSync.native(dirPath);
  const realParent = fs.realpathSync.native(expectedRealParent);
  if (path.dirname(realDir) !== realParent) {
    throw new Error('Forge pack staging escaped its temp parent');
  }
}

/**
 * Write `buf` to a brand-new file. The destination must not already exist, so
 * there is no replace/rename: `O_CREAT|O_EXCL|O_NOFOLLOW` opens the final name
 * once. A temp+rename pair would let a same-privilege process create the
 * target between lstat and rename and get overwritten.
 */
function writeExclusiveNoFollow(filePath: string, buf: Buffer, managedParent: string): void {
  const parent = path.dirname(filePath);
  if (path.resolve(parent) !== path.resolve(managedParent)) {
    throw new Error('Forge pack staging file is not inside its task directory');
  }
  assertManagedDirectory(parent, path.dirname(parent));
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | noFollowFlag();
  const fd = fs.openSync(filePath, flags, 0o600);
  let written = false;
  try {
    fs.writeSync(fd, buf);
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // Windows ignores POSIX modes.
    }
    written = true;
  } finally {
    fs.closeSync(fd);
    if (!written) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort.
      }
    }
  }
}

function rmTaskDir(taskDir: string): void {
  fs.rmSync(taskDir, { recursive: true, force: true });
}

function tryRmTaskDir(taskDir: string): void {
  try {
    rmTaskDir(taskDir);
  } catch {
    // Best-effort maintenance: a locked leftover must not fail controller init.
  }
}

const FORGE_TASK_DIR_RE =
  /^cindy-forge-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function leaseMarkerPath(taskDir: string): string {
  return path.join(taskDir, FORGE_PACK_LEASE_MARKER);
}

/**
 * One-shot lease file: exclusive create, never rewritten. mtime is the sweep
 * clock. Must be written after the package bytes and hash are done, and after
 * `expiresAt` is pinned, immediately before the ticket is registered.
 */
function writeExclusiveLeaseMarker(taskDir: string): void {
  writeExclusiveNoFollow(leaseMarkerPath(taskDir), Buffer.from('\n'), taskDir);
}

function forgePackLeaseAgeMs(taskDir: string, nowMs: number): number | null {
  const marker = leaseMarkerPath(taskDir);
  try {
    const stat = fs.lstatSync(marker);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return Math.max(0, nowMs - Number(stat.mtimeMs));
  } catch {
    // No marker means there is no consumable ticket yet. Sweeping such a dir
    // can at worst fail an in-flight pack (including one frozen long enough
    // that directory mtime exceeds the threshold); it cannot revive or
    // invalidate an already-issued ticket.
    try {
      const dirStat = fs.lstatSync(taskDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
      return Math.max(0, nowMs - Number(dirStat.mtimeMs));
    } catch {
      return null;
    }
  }
}

/**
 * Restart / crash recovery: drop leftover Host staging dirs under tempRoot.
 * Only enumerates direct children that match `cindy-forge-<v4 UUID>`. Symlinks
 * and non-directories are skipped; real parent must still be tempRoot.
 * Only dirs older than pack TTL + continuation TTL + grace are removed, so a
 * sibling Cindy process waiting on confirm is not deleted.
 */
export function sweepStaleForgePackStagingDirs(
  tempRoot: string,
  options?: { now?: number; maxAgeMs?: number },
): void {
  const nowMs = options?.now ?? Date.now();
  const maxAgeMs = options?.maxAgeMs ?? FORGE_PACK_STAGING_SWEEP_MAX_AGE_MS;
  let realTempRoot: string;
  try {
    realTempRoot = fs.realpathSync.native(tempRoot);
  } catch {
    return;
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(realTempRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of entries) {
    if (!FORGE_TASK_DIR_RE.test(name)) continue;
    const taskDir = path.join(realTempRoot, name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(taskDir);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    try {
      assertManagedDirectory(taskDir, realTempRoot);
    } catch {
      continue;
    }
    const ageMs = forgePackLeaseAgeMs(taskDir, nowMs);
    if (ageMs === null || ageMs < maxAgeMs) continue;
    tryRmTaskDir(taskDir);
  }
}

export function createForgePackStagingController(
  options: CreateForgePackStagingControllerOptions,
): ForgePackStagingController {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? FORGE_PACK_TICKET_TTL_MS;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((ms, callback) => {
      const handle = setTimeout(callback, ms);
      return { cancel: () => clearTimeout(handle) };
    });

  type Entry = {
    ticket: ForgePackIntegrityTicket;
    expiresAt: number;
    timeout: { cancel(): void };
  };
  const tickets = new Map<string, Entry>();
  const installContinuations = new Map<string, Entry>();
  const consumedStagingPaths = new Set<string>();

  const forgetConsumedPath = (stagingPath: string): void => {
    consumedStagingPaths.delete(path.resolve(stagingPath));
  };

  const drop = (token: string, removeFiles: boolean): boolean => {
    const entry = tickets.get(token);
    if (!entry) return false;
    tickets.delete(token);
    entry.timeout.cancel();
    if (removeFiles) {
      forgetConsumedPath(entry.ticket.stagingPath);
      rmTaskDir(path.dirname(entry.ticket.stagingPath));
    }
    return true;
  };

  return {
    stage(input) {
      const tempRoot = options.getTempDir();
      const taskDir = path.join(tempRoot, `cindy-forge-${randomId()}`);
      fs.mkdirSync(taskDir, { recursive: false, mode: 0o700 });
      try {
        fs.chmodSync(taskDir, 0o700);
      } catch {
        // Windows ignores POSIX modes.
      }
      assertManagedDirectory(taskDir, tempRoot);
      const stagingPath = path.join(taskDir, 'package.cindy');
      try {
        writeExclusiveNoFollow(stagingPath, input.buf, taskDir);
      } catch (error) {
        rmTaskDir(taskDir);
        throw error;
      }
      const token = randomId();
      const packageSha256 = sha256Hex(input.buf);
      const timeout = scheduleTimeout(ttlMs, () => {
        drop(token, true);
      });
      // Pin expiry before the lease mtime exists. A freeze between the marker
      // write and Map insert must not mint a ticket younger than the marker.
      const expiresAt = now() + ttlMs;
      const ticket: ForgePackIntegrityTicket = {
        owner: {
          mode: input.owner.mode,
          dataOwnerId: input.owner.dataOwnerId,
          generation: input.owner.generation,
        },
        operationKind: input.operationKind,
        stagingPath,
        packageSha256,
        manifestId: input.manifestId,
        packExpiresAt: expiresAt,
      };
      try {
        writeExclusiveLeaseMarker(taskDir);
      } catch (error) {
        timeout.cancel();
        rmTaskDir(taskDir);
        throw error;
      }
      tickets.set(token, { ticket, expiresAt, timeout });
      return { ticket: token, stagingPath, taskDir, packageSha256 };
    },

    peek(token) {
      const entry = tickets.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        drop(token, true);
        return null;
      }
      return entry.ticket;
    },

    consume(token) {
      const entry = tickets.get(token);
      if (!entry) return null;
      tickets.delete(token);
      entry.timeout.cancel();
      if (entry.expiresAt <= now()) {
        rmTaskDir(path.dirname(entry.ticket.stagingPath));
        return null;
      }
      return entry.ticket;
    },

    consumeMatchingStagingPath(stagingPath) {
      const target = path.resolve(stagingPath);
      for (const [token, entry] of tickets) {
        if (path.resolve(entry.ticket.stagingPath) === target) {
          tickets.delete(token);
          entry.timeout.cancel();
          consumedStagingPaths.add(target);
          if (entry.expiresAt <= now()) {
            consumedStagingPaths.delete(target);
            rmTaskDir(path.dirname(entry.ticket.stagingPath));
            return null;
          }
          return entry.ticket;
        }
      }
      return null;
    },

    peekMatchingStagingPath(stagingPath) {
      const target = path.resolve(stagingPath);
      for (const [token, entry] of tickets) {
        if (path.resolve(entry.ticket.stagingPath) !== target) continue;
        if (entry.expiresAt <= now()) {
          drop(token, true);
          return null;
        }
        return entry.ticket;
      }
      return null;
    },

    wasStagingPathConsumed(stagingPath) {
      return consumedStagingPaths.has(path.resolve(stagingPath));
    },

    issueInstallContinuation(ticket) {
      const issueNow = now();
      const hardDeadline = ticket.packExpiresAt + ttlMs;
      if (issueNow >= hardDeadline) {
        forgetConsumedPath(ticket.stagingPath);
        rmTaskDir(path.dirname(ticket.stagingPath));
        return null;
      }
      const expiresAt = Math.min(issueNow + ttlMs, hardDeadline);
      const token = randomId();
      const timeout = scheduleTimeout(Math.max(0, expiresAt - issueNow), () => {
        const entry = installContinuations.get(token);
        if (!entry) return;
        installContinuations.delete(token);
        entry.timeout.cancel();
        forgetConsumedPath(ticket.stagingPath);
        rmTaskDir(path.dirname(ticket.stagingPath));
      });
      installContinuations.set(token, { ticket, expiresAt, timeout });
      return token;
    },

    consumeInstallContinuation(token) {
      const entry = installContinuations.get(token);
      if (!entry) return null;
      installContinuations.delete(token);
      entry.timeout.cancel();
      if (entry.expiresAt <= now()) {
        forgetConsumedPath(entry.ticket.stagingPath);
        rmTaskDir(path.dirname(entry.ticket.stagingPath));
        return null;
      }
      return entry.ticket;
    },

    invalidate(token) {
      const continuation = installContinuations.get(token);
      if (continuation) {
        installContinuations.delete(token);
        continuation.timeout.cancel();
        forgetConsumedPath(continuation.ticket.stagingPath);
        rmTaskDir(path.dirname(continuation.ticket.stagingPath));
        return true;
      }
      return drop(token, true);
    },

    releaseStaging(stagingPath) {
      forgetConsumedPath(stagingPath);
      rmTaskDir(path.dirname(stagingPath));
    },

    invalidateMismatchedOwners(current) {
      for (const [token, entry] of [...tickets]) {
        if (!isSameOwner(entry.ticket.owner, current)) drop(token, true);
      }
      for (const [token, entry] of [...installContinuations]) {
        if (!isSameOwner(entry.ticket.owner, current)) {
          installContinuations.delete(token);
          entry.timeout.cancel();
          forgetConsumedPath(entry.ticket.stagingPath);
          rmTaskDir(path.dirname(entry.ticket.stagingPath));
        }
      }
    },

    invalidateAll() {
      for (const token of [...tickets.keys()]) drop(token, true);
      for (const [token, entry] of [...installContinuations]) {
        installContinuations.delete(token);
        entry.timeout.cancel();
        forgetConsumedPath(entry.ticket.stagingPath);
        rmTaskDir(path.dirname(entry.ticket.stagingPath));
      }
      consumedStagingPaths.clear();
    },
  };
}

let productionController: ForgePackStagingController | null = null;
let getProductionTempDir: (() => string) | null = null;

export function configureForgePackStagingForTests(
  options: CreateForgePackStagingControllerOptions,
): ForgePackStagingController {
  productionController?.invalidateAll();
  productionController = createForgePackStagingController(options);
  getProductionTempDir = options.getTempDir;
  return productionController;
}

export function resetForgePackStagingForTests(): void {
  productionController?.invalidateAll();
  productionController = null;
  getProductionTempDir = null;
}

/** Bind Electron temp lazily. Calling this does not create files. */
export function bindForgePackStagingTempDir(getTempDir: () => string): void {
  getProductionTempDir = getTempDir;
}

export function getForgePackStagingController(): ForgePackStagingController {
  return getController();
}

export function getForgePackStagingControllerIfConfigured(): ForgePackStagingController | null {
  if (!productionController && !getProductionTempDir) return null;
  return getController();
}

function getController(): ForgePackStagingController {
  if (!productionController) {
    if (!getProductionTempDir) {
      throw new Error('Forge pack staging temp dir is not configured');
    }
    const getTempDir = getProductionTempDir;
    sweepStaleForgePackStagingDirs(getTempDir());
    productionController = createForgePackStagingController({
      getTempDir,
    });
  }
  return productionController;
}

export function stageBuiltGhostPackage(
  input: StageBuiltGhostPackageInput,
): StageBuiltGhostPackageResult {
  return getController().stage(input);
}

/**
 * Host-only install path + agent-safe filename. Staging never goes back to
 * the agent. `authorCindyPath` is used only for `path.basename` in the agent
 * return; it is never read. Staging bytes always come from `buf`.
 */
export function completeForgePackStaging(input: {
  buf: Buffer;
  manifestId: string;
  owner: ActiveAppSession;
  operationKind: ForgePackOperationKind;
  authorCindyPath: string;
}): {
  ticket: string;
  installPath: string;
  agentCindyPath: string;
  packageSha256: string;
} {
  const staged = stageBuiltGhostPackage({
    buf: input.buf,
    manifestId: input.manifestId,
    owner: input.owner,
    operationKind: input.operationKind,
  });
  return {
    ticket: staged.ticket,
    installPath: staged.stagingPath,
    agentCindyPath: path.basename(input.authorCindyPath),
    packageSha256: staged.packageSha256,
  };
}

export function peekForgePackTicket(token: string): ForgePackIntegrityTicket | null {
  return getController().peek(token);
}

export function consumeForgePackTicket(token: string): ForgePackIntegrityTicket | null {
  return getController().consume(token);
}

export function consumeForgePackTicketForStagingPath(
  stagingPath: string,
): ForgePackIntegrityTicket | null {
  return getController().consumeMatchingStagingPath(stagingPath);
}

export function issueForgePackInstallContinuation(
  ticket: ForgePackIntegrityTicket,
): string | null {
  return getController().issueInstallContinuation(ticket);
}

export function consumeForgePackInstallContinuation(
  token: string,
): ForgePackIntegrityTicket | null {
  return getController().consumeInstallContinuation(token);
}

export function invalidateForgePackTicket(token: string): boolean {
  return productionController?.invalidate(token) ?? false;
}

export function releaseForgePackStaging(stagingPath: string): void {
  productionController?.releaseStaging(stagingPath);
}

export function invalidateForgePackTicketsForOwner(current: ActiveAppSession): void {
  productionController?.invalidateMismatchedOwners(current);
}
