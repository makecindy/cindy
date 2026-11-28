// Live-instance scan of a userData's `.dev-instances` registry and Chromium SingletonLock, moved
// unchanged out of ownerNamespaceMigration.ts so the Node Host can load it (that file imports
// Electron). The module state (staleProcessProofs, and the functions that read and write it) is
// per process: the desktop's callers and the Host each use the copy in their own process; nothing
// here is shared across processes.
import path from 'node:path';

import { createLogger } from './logger.js';
import { readProcessIdentities, type ProcessIdentitySnapshot } from './processIdentity.js';

/** The members of ownerNamespaceMigration's MigrationDeps that the scan reads. */
export interface ConcurrentInstanceScanDeps {
  readFile(file: string): Promise<string>;
  lstat(file: string): Promise<{
    isDirectory(): boolean;
    isFile?: () => boolean;
    isSymbolicLink?: () => boolean;
    mtimeMs?: number;
  }>;
  readdir(dir: string): Promise<string[]>;
  readlink(file: string): Promise<string>;
  selfPid(): number;
  isPidAlive(pid: number): boolean;
  readProcessIdentity?(pid: number): ProcessIdentitySnapshot | null;
  /**
   * 删除已证死的注册表记录（可选）。desktop 的 productionDeps 与 Host 的
   * profile-coexistence ports 都带 `unlink`；没带的调用方行为与从前一致：残留记录留在
   * 盘上，靠 60s 证明 TTL 挡日志刷屏，每轮扫描继续完整查证。
   */
  unlink?(file: string): Promise<void>;
}

interface RegisteredInstanceRecord {
  pid?: number;
  userDataDir?: string;
  startedAtMs?: number;
  rootDir?: string;
}

interface RegisteredInstanceCandidate {
  pid: number;
  userDataDir: string | undefined;
  recordedAtMs: number | undefined;
  rootDir: string | undefined;
}

export type ProcessIdentityReader = (pid: number) => ProcessIdentitySnapshot | null;

const log = createLogger('ownerNamespaceMigration');
// Process start timestamps are reported at one-second precision by `ps` on
// Unix. Keep only enough tolerance for that rounding (plus modest clock
// sampling skew): a large window would permanently classify a PID reused
// shortly after the record was written as the old Cindy process.
const PID_REUSE_TOLERANCE_MS = 2_000;
const STALE_PROCESS_PROOF_TTL_MS = 60_000;
const MAX_TRACKED_STALE_PROOFS = 256;
const staleProcessProofs = new Map<string, number>();
const loggedStaleProcessProofs = new Set<string>();

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function looksLikeCindyRuntime(command: string, rootDir?: string): boolean {
  const normalizedCommand = command.replaceAll('\\', '/').toLowerCase();
  const normalizedRoot = rootDir?.replaceAll('\\', '/').toLowerCase();
  if (normalizedRoot && normalizedCommand.includes(normalizedRoot)) return true;

  const resourcesMarker = '/contents/resources/';
  const resourcesIndex = normalizedRoot?.indexOf(resourcesMarker) ?? -1;
  if (
    normalizedRoot &&
    resourcesIndex > 0 &&
    normalizedCommand.includes(normalizedRoot.slice(0, resourcesIndex))
  ) {
    return true;
  }

  return (
    normalizedCommand.includes('/cindy.app/') ||
    normalizedCommand.includes('/electron.app/') ||
    /(^|[\s/])cindy(?:\.exe)?(?:\s|$)/.test(normalizedCommand) ||
    /(^|[\s/])electron(?:\.exe)?(?:\s|$)/.test(normalizedCommand)
  );
}

export function readProcessIdentitySafely(
  reader: ProcessIdentityReader,
  pid: number,
): ProcessIdentitySnapshot | null {
  try {
    return reader(pid);
  } catch {
    return null;
  }
}

async function readProcessIdentitiesForPids(
  pids: readonly number[],
  reader?: ProcessIdentityReader,
): Promise<ReadonlyMap<number, ProcessIdentitySnapshot | null>> {
  if (!reader) return readProcessIdentities(pids);
  return new Map(pids.map((pid) => [pid, readProcessIdentitySafely(reader, pid)] as const));
}

export function processProofKey(
  userDataDir: string,
  kind: 'registry' | 'singleton-lock',
  fingerprint: string,
): string {
  return `${path.resolve(userDataDir)}\u0000${kind}\u0000${fingerprint}`;
}

function pruneExpiredStaleProcessProofs(now: number): void {
  for (const [key, expiresAt] of staleProcessProofs) {
    if (expiresAt <= now) staleProcessProofs.delete(key);
  }
}

/** Records a fresh stale-PID proof and returns true only the first time this fingerprint is logged. */
function rememberStaleProcessProof(key: string): boolean {
  const now = Date.now();
  pruneExpiredStaleProcessProofs(now);
  staleProcessProofs.delete(key);
  staleProcessProofs.set(key, now + STALE_PROCESS_PROOF_TTL_MS);
  while (staleProcessProofs.size > MAX_TRACKED_STALE_PROOFS) {
    const oldest = staleProcessProofs.keys().next().value;
    if (oldest === undefined) break;
    staleProcessProofs.delete(oldest);
    loggedStaleProcessProofs.delete(oldest);
  }
  if (loggedStaleProcessProofs.has(key)) return false;
  loggedStaleProcessProofs.add(key);
  while (loggedStaleProcessProofs.size > MAX_TRACKED_STALE_PROOFS) {
    const oldest = loggedStaleProcessProofs.keys().next().value;
    if (oldest === undefined) break;
    loggedStaleProcessProofs.delete(oldest);
  }
  return true;
}

function forgetStaleProcessProof(key: string, observedLiveIdentity: boolean): void {
  staleProcessProofs.delete(key);
  // Keep log dedup intact across `() => null` discovery passes (for example Host's two-pass scan);
  // clear it only when an actual live process identity is observed for this key.
  if (observedLiveIdentity) loggedStaleProcessProofs.delete(key);
}

export function hasFreshStaleProcessProof(key: string): boolean {
  const expiresAt = staleProcessProofs.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    staleProcessProofs.delete(key);
    return false;
  }
  return true;
}

/**
 * 这份文件是不是本应用写的实例登记（schema≥1 且带 instanceId，文件名就是 `<pid>.json`）。
 * 不认得的格式一律不动：只删自己认得的东西，别把目录里的其它文件当残留清掉。
 */
function isCindyInstanceRecord(raw: string, fileName: string, pid: number): boolean {
  if (fileName !== `${pid}.json`) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object') return false;
  const record = parsed as { schemaVersion?: unknown; instanceId?: unknown };
  if (typeof record.schemaVersion !== 'number' || record.schemaVersion < 1) return false;
  return typeof record.instanceId === 'string' && record.instanceId.length > 0;
}

/**
 * 就地清理一条已证死的注册表记录（`<pid>.json` 与它的原子备份 `.bak`）。能走到这里的记录
 * 都满足完整 provenance：属主进程已退出、PID 被一个更晚启动的非 Cindy 进程复用——文件再
 * 没有人会读，删掉之后后续扫描的 readdir 里不再出现，不再为同一条残留反复 readFile /
 * 存活探测 / ps 查证。best-effort：删除失败（只读卷、竞争方已删等）只损失这一次的后续
 * 收益，60s 证明 TTL 仍挡住日志刷屏，本轮判定不受影响。SingletonLock 属 Chromium 自管，
 * 不在此清理。
 */
async function cleanupStaleRegistryRecord(
  deps: ConcurrentInstanceScanDeps,
  registryDir: string,
  fileName: string,
  staleRaw: string,
  pid: number,
): Promise<void> {
  const unlink = deps.unlink;
  if (!unlink) return;
  if (!isCindyInstanceRecord(staleRaw, fileName, pid)) return;
  // 证死之后到删除之前隔着身份查询，同一 PID 可能已被新实例登记重写。删除前重读
  // 并与证死的那份原文比对：内容一致才删，已被替换（或读不了、已不在）就放弃——
  // 宁可留一份残档，不能误删活实例的注册（Windows 没有 SingletonLock 兜底）。
  for (const name of [fileName, `${fileName}.bak`]) {
    const filePath = path.join(registryDir, name);
    let current: string;
    try {
      current = await deps.readFile(filePath);
    } catch {
      continue;
    }
    if (current !== staleRaw) continue;
    try {
      await unlink(filePath);
    } catch {
      // ENOENT = 已被清理（属主退出路径或另一台扫描器先删）；其余错误同样吞掉。
    }
  }
}

/**
 * PID liveness alone is insufficient: macOS and Windows routinely reuse old
 * PIDs. Ignore a registration only when OS provenance proves that the current
 * process started well after the record and is not another Cindy/Electron
 * runtime. Missing or ambiguous provenance remains live (fail closed).
 */
export function recordedPidMayStillBeLive(
  recordedAtMs: number | undefined,
  rootDir: string | undefined,
  identity: ProcessIdentitySnapshot | null,
): boolean {
  if (
    typeof recordedAtMs !== 'number' ||
    !Number.isFinite(recordedAtMs) ||
    recordedAtMs <= 0 ||
    identity === null
  ) {
    return true;
  }
  if (identity.startedAtMs <= recordedAtMs + PID_REUSE_TOLERANCE_MS) return true;
  return looksLikeCindyRuntime(identity.command, rootDir);
}

/**
 * Windows(含盘符)与 macOS 的默认卷都是大小写不敏感文件系统,仅按字节比较会把
 * 大小写不同、实际同一目录的记录误判为「别的 userData」而漏掉活实例——漏判方向
 * 是数据事故。反向(在大小写敏感卷上把两个真不同的目录折叠成同一)的误判方向只是
 * 多推迟一轮迁移,保守安全,因此 win32/darwin 一律折叠。Linux 默认大小写敏感,
 * 保持字节精确。
 */
export function isSameUserDataDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return platform === 'win32' || platform === 'darwin'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

function instancePidFromRecordName(name: string): number | null {
  const match = /^(\d+)\.json$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function parseRegisteredInstanceCandidate(
  raw: string,
  fileName: string,
): RegisteredInstanceCandidate | null {
  const filePid = instancePidFromRecordName(fileName);
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as RegisteredInstanceRecord;
      if (typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0) {
        if (filePid !== null && record.pid !== filePid) {
          return {
            pid: filePid,
            userDataDir: undefined,
            recordedAtMs: undefined,
            rootDir: undefined,
          };
        }
        return {
          pid: record.pid,
          userDataDir: typeof record.userDataDir === 'string' ? record.userDataDir : undefined,
          recordedAtMs:
            typeof record.startedAtMs === 'number' ? record.startedAtMs : undefined,
          rootDir: typeof record.rootDir === 'string' ? record.rootDir : undefined,
        };
      }
    }
  } catch {
    // A torn payload still has a process identity in its canonical filename.
  }

  return filePid === null
    ? null
    : { pid: filePid, userDataDir: undefined, recordedAtMs: undefined, rootDir: undefined };
}

/**
 * Other live Cindy instances sharing this userData, discovered via the
 * `.dev-instances/<pid>.json` runtime provenance registry (devStartupStatus;
 * written by dev AND packaged builds — dev/release share the userData by
 * design with per-flavor single-instance lock scopes, so packaged instances
 * must be visible to this scan too). A userData never touched by this build
 * line resolves to an empty list.
 *
 * Error posture is asymmetric on purpose: a record file that VANISHES
 * (ENOENT) means that instance exited — skip it; a record file that exists
 * but cannot be READ (EACCES, I/O errors) may hide a live instance — fail
 * closed by rethrowing so the caller defers the destructive claim. If a
 * record reads but has an invalid or mismatched payload, its `<pid>.json`
 * filename still keeps a live process visible; dead-PID leftovers remain
 * safely ignorable.
 */
export async function findConcurrentLiveInstancePids(
  deps: ConcurrentInstanceScanDeps,
  userDataDir: string,
): Promise<number[]> {
  const registryDir = path.join(userDataDir, '.dev-instances');
  let names: string[];
  try {
    names = await deps.readdir(registryDir);
  } catch (error) {
    if (!isMissing(error)) throw error;
    names = []; // 注册表目录不存在 ≠ 无并发:下方 SingletonLock 探测仍要跑。
  }
  const selfPid = deps.selfPid();
  const candidates: Array<{
    raw: string;
    fileName: string;
    pid: number;
    recordedAtMs: number | undefined;
    rootDir: string | undefined;
  }> = [];
  const recordNames = new Set(
    names.flatMap((name) => {
      if (name.endsWith('.json')) return [name];
      if (name.endsWith('.json.bak')) return [name.slice(0, -'.bak'.length)];
      return [];
    }),
  );
  for (const name of recordNames) {
    const recordPath = path.join(registryDir, name);
    let raw: string | null = null;
    for (let attempt = 0; attempt < 2 && raw === null; attempt += 1) {
      try {
        raw = await deps.readFile(recordPath);
      } catch (error) {
        if (!isMissing(error)) throw error;
        // During atomic backup exchange the canonical record may be absent
        // while `<pid>.json.bak` is the only snapshot. If the writer finishes
        // and removes the backup before this read, retry canonical once before
        // deciding that the instance exited.
        try {
          raw = await deps.readFile(`${recordPath}.bak`);
        } catch (backupError) {
          if (!isMissing(backupError)) throw backupError;
        }
      }
    }
    if (raw === null) continue;
    const candidate = parseRegisteredInstanceCandidate(raw, name);
    if (candidate === null || candidate.pid === selfPid) continue;
    // 只认同一 userData 的记录;userDataDir 不一致说明是异常拷贝进来的残留。
    if (
      candidate.userDataDir !== undefined &&
      !isSameUserDataDir(candidate.userDataDir, userDataDir, process.platform)
    ) {
      continue;
    }
    if (!deps.isPidAlive(candidate.pid)) continue;
    candidates.push({
      raw,
      fileName: name,
      pid: candidate.pid,
      recordedAtMs: candidate.recordedAtMs,
      rootDir: candidate.rootDir,
    });
  }

  const readProcessIdentity = deps.readProcessIdentity;
  const identities = await readProcessIdentitiesForPids(
    candidates.map(({ pid }) => pid),
    readProcessIdentity,
  );
  const pids: number[] = [];
  for (const candidate of candidates) {
    const identity = identities.get(candidate.pid) ?? null;
    const proofKey = processProofKey(userDataDir, 'registry', `${candidate.fileName}\u0000${candidate.raw}`);
    if (recordedPidMayStillBeLive(candidate.recordedAtMs, candidate.rootDir, identity)) {
      forgetStaleProcessProof(proofKey, identity !== null);
      pids.push(candidate.pid);
      continue;
    }
    if (rememberStaleProcessProof(proofKey)) {
      log.info('ignoring stale instance registry record after PID reuse', { pid: candidate.pid });
    }
    await cleanupStaleRegistryRecord(deps, registryDir, candidate.fileName, candidate.raw, candidate.pid);
  }

  // 追溯 fallback:本补丁之前的 packaged build 不写注册表,但 Chromium 单例锁是
  // 它们也一直持有的信号——packaged 的锁域就是 userData 根(bootstrap-electron
  // resolveSingleInstanceLockUserDataDir;dev 锁域在 dev-single-instance-lock/
  // 子目录,不会污染这里)。macOS/Linux 上锁是 SingletonLock symlink,target 形如
  // `<hostname>-<pid>`;解析 pid 做存活探测,stale 残留(崩溃后 pid 已死)自动排除。
  // win32 的 Chromium 用命名 mutex 无文件可查,该平台的历史盲区随 release 升级
  // 消失。best-effort:读不出/解析不出不阻塞(Chromium 自身会清理重建锁)。
  try {
    const lockPath = path.join(userDataDir, 'SingletonLock');
    const lockTarget = await deps.readlink(lockPath);
    const match = /-(\d+)$/.exec(lockTarget);
    const lockPid = match ? Number(match[1]) : null;
    if (
      lockPid !== null &&
      Number.isInteger(lockPid) &&
      lockPid > 0 &&
      lockPid !== selfPid &&
      !pids.includes(lockPid) &&
      deps.isPidAlive(lockPid)
    ) {
      let lockMtimeMs: number | undefined;
      try {
        lockMtimeMs = (await deps.lstat(lockPath)).mtimeMs;
      } catch {
        // Missing provenance keeps the old fail-closed live-PID behavior.
      }
      const identity =
        (await readProcessIdentitiesForPids([lockPid], readProcessIdentity)).get(lockPid) ?? null;
      const proofKey = processProofKey(userDataDir, 'singleton-lock', `${lockTarget}\u0000${lockMtimeMs}`);
      if (recordedPidMayStillBeLive(lockMtimeMs, undefined, identity)) {
        forgetStaleProcessProof(proofKey, identity !== null);
        pids.push(lockPid);
      } else if (rememberStaleProcessProof(proofKey)) {
        log.info('ignoring stale SingletonLock after PID reuse', { pid: lockPid });
      }
    }
  } catch {
    // ENOENT(无 packaged 实例)/EINVAL(非 symlink,如 win32 lockfile)——无信号。
  }
  return pids;
}
