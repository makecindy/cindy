/**
 * Git safe.directory 的所有权台账与声明式对账。
 *
 * Cindy 只在 Git 明确报 dubious ownership 时写全局配置。写入前先持久化 pending
 * 记录，写入后再根据全局配置的精确 value + origin 确认所有权。清理时只删除：
 *   A. 台账能证明由 Cindy 独占写入；
 *   B. 当前全局配置仍只有这一条精确记录；
 *   C. 已不存在需要它的 Cindy worktree 或普通任务。
 *
 * pending、并发产生的重复项、来源不明或读取失败都按保守方向保留，绝不使用
 * `--unset-all`。台账、profile 进程快照与 mutation 锁都位于跨 profile 的共享
 * appData 作用域；创建声明、台账和全局配置变更统一经过这一个严格跨进程锁。
 */

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import fs from 'node:fs/promises';

import { app } from 'electron';
import Store from 'electron-store';

import {
  withSecurityBoundaryLock,
  type FileLockOptions,
  type LockStatus,
} from '../device-link/crossProcessLock';
import { createLogger } from '../logger';
import { loadLiveSessionPathKeys, type LiveSessionPathKeys } from './liveSessionRefs';
import * as worktreeStore from './worktreeStore';

import type { WorktreeMeta } from './types';

const log = createLogger('worktreeSafeDirectory');

type SafeDirectoryGrantState = 'pending' | 'owned' | 'ambiguous';

interface SafeDirectoryGrantRecord {
  id: string;
  value: string;
  state: SafeDirectoryGrantState;
  createdAt: string;
  /** owned 状态下 Cindy 写入记录所在的精确配置文件。 */
  origin?: string;
  /**
   * Cindy 最后一次改动该配置文件后留下的见证。只要文件被外部重写，即使同值
   * safe.directory 又出现，也不再把它当成 Cindy 原先写入的那一条。
   */
  originWitness?: ConfigFileWitness;
  /** ambiguous 状态下观测到的候选文件，仅用于确认记录是否已由外部清除。 */
  candidateOrigins?: string[];
}

interface ConfigFileWitness {
  realPath: string;
  device: string;
  inode: string;
  mode: string;
  size: string;
  modifiedAtNs: string;
  changedAtNs: string;
  sha256: string;
  /** 最终路径本身是符号链接时，同时锁定链接身份与 link text。 */
  symbolicLink?: ConfigSymbolicLinkWitness;
}

interface ConfigSymbolicLinkWitness {
  target: string;
  device: string;
  inode: string;
  mode: string;
  size: string;
  modifiedAtNs: string;
  changedAtNs: string;
}

interface SafeDirectoryLedgerShape {
  version: number;
  grants: SafeDirectoryGrantRecord[];
  profileRetentions: SafeDirectoryProfileRetentionRecord[];
  profileRetentionRevision: number;
}

interface SafeDirectoryLedgerStore {
  readonly path: string;
  get(key: 'grants', defaultValue: SafeDirectoryGrantRecord[]): unknown;
  get(key: 'profileRetentions', defaultValue: SafeDirectoryProfileRetentionRecord[]): unknown;
  get(key: 'profileRetentionRevision', defaultValue: number): unknown;
  set(key: 'grants', value: SafeDirectoryGrantRecord[]): void;
  set(key: 'profileRetentions', value: SafeDirectoryProfileRetentionRecord[]): void;
  set(key: 'profileRetentionRevision', value: number): void;
}

interface GitConfigResult {
  stdout: string;
  stderr: string;
}

type GitConfigRunner = (
  args: readonly string[],
  extraEnv?: Record<string, string>,
) => Promise<GitConfigResult>;

interface GlobalSafeDirectoryEntry {
  origin: string;
  filePath: string | null;
  value: string;
}

type RetentionMode = 'exact' | 'subtree';

interface RetentionRoot {
  path: string;
  mode: RetentionMode;
}

interface RetentionSnapshot {
  roots: RetentionRoot[];
  /** null 表示会话引用无法确认；删除必须 fail closed。 */
  liveSessionPathKeys: LiveSessionPathKeys;
}

interface SafeDirectoryProfileRetentionRecord {
  profilePath: string;
  processId: number;
  roots: RetentionRoot[];
  /** null 表示该 profile 的会话引用无法确认；全局删除必须 fail closed。 */
  liveSessionPaths: string[] | null;
}

export interface SafeDirectoryRetention {
  /** 保留与该路径完全相同的 safe.directory（用于 base repository）。 */
  addExact(value: string): Promise<void>;
  /** 保留该目录及其内部仓库的 safe.directory（用于 linked worktree）。 */
  addSubtree(value: string): Promise<void>;
}

export type SafeDirectoryRecoveryMode = 'persistent' | 'command';

interface LocalSafeDirectoryRetention {
  addExact(value: string): boolean;
  addSubtree(value: string): boolean;
  release(): void;
}

type CrossProcessLockRunner = <T>(
  lockPath: string,
  options: FileLockOptions,
  task: (status: LockStatus) => Promise<T>,
) => Promise<T>;

type ProcessLiveness = 'alive' | 'missing' | 'unknown';
type GlobalConfigWriteOriginProvider = (
  extraEnv?: Record<string, string>,
) => Promise<string | null>;

class GitConfigError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = 'GitConfigError';
    this.exitCode = exitCode;
  }
}

let ledgerStore: SafeDirectoryLedgerStore | null = null;
let gitConfigRunner: GitConfigRunner = runGitConfig;
let activeWorktreesProvider: () => readonly WorktreeMeta[] = () => worktreeStore.getAll();
type SessionRuntimeAliveProvider = (sessionId: string) => boolean | undefined;
let sessionRuntimeAliveProvider: SessionRuntimeAliveProvider | null = null;
const loadCurrentLiveSessionPathKeys = (): Promise<LiveSessionPathKeys> =>
  loadLiveSessionPathKeys({
    excludeDialoguePaths: true,
    ...(sessionRuntimeAliveProvider ? { isSessionRuntimeAlive: sessionRuntimeAliveProvider } : {}),
  });
let liveSessionPathKeysProvider: () => Promise<LiveSessionPathKeys> =
  loadCurrentLiveSessionPathKeys;
let crossProcessLockRunner: CrossProcessLockRunner = withSecurityBoundaryLock;
let sharedStateRootProvider: () => string = () =>
  resolveSafeDirectorySharedStateRoot(app.getPath('appData'));
let currentProfilePathProvider: () => string = () => app.getPath('userData');
let currentProcessIdProvider: () => number = () => process.pid;
let processLivenessProvider: (processId: number) => ProcessLiveness = probeProcessLiveness;
let globalConfigWriteOriginProvider: GlobalConfigWriteOriginProvider =
  resolveGlobalConfigWriteOrigin;
let homePathProvider: () => string = () => app.getPath('home');
let operationTail: Promise<void> = Promise.resolve();

const inflightRetentionRoots = new Map<string, RetentionRoot & { count: number }>();
const publishedUsagePaths = new Set<string>();
let inflightRetentionGeneration = 0;

const GIT_CONFIG_TIMEOUT_MS = 10_000;
// 两阶段对账的最终提交最多只包一条 Git 配置 mutation（受上面的 10 秒 deadline
// 约束）与本地见证刷新。声明发布等待一个提交窗口，不会沿用严格锁默认的 3 秒
// 后直接失败。
const MUTATION_LOCK_WAIT_MS = 30_000;

export function resolveSafeDirectorySharedStateRoot(appDataPath: string): string {
  if (!isAbsolutePath(appDataPath)) {
    throw new Error('safe.directory appData path must be absolute');
  }
  return path.join(appDataPath, 'CindyShared');
}

function getLedgerStore(): SafeDirectoryLedgerStore {
  if (ledgerStore) return ledgerStore;
  const sharedStateRoot = sharedStateRootProvider();
  if (!isAbsolutePath(sharedStateRoot)) {
    throw new Error('safe.directory shared state root must be absolute');
  }
  ledgerStore = new Store<SafeDirectoryLedgerShape>({
    name: 'git-safe-directory-grants',
    cwd: sharedStateRoot,
    defaults: { version: 2, grants: [], profileRetentions: [], profileRetentionRevision: 0 },
    schema: {
      version: { type: 'number' },
      grants: { type: 'array' },
      profileRetentions: { type: 'array' },
      profileRetentionRevision: { type: 'number', minimum: 0 },
    },
    clearInvalidConfig: true,
  }) as unknown as SafeDirectoryLedgerStore;
  return ledgerStore;
}

type SafeDirectoryLockKind = 'mutation';

function crossProcessLockPath(kind: SafeDirectoryLockKind): string {
  const storePath = getLedgerStore().path;
  if (!isAbsolutePath(storePath)) {
    throw new Error('safe.directory ledger path must be absolute');
  }
  return `${storePath}.${kind}.lock`;
}

function runWithCrossProcessLock<T>(
  kind: SafeDirectoryLockKind,
  task: (status: LockStatus) => Promise<T>,
): Promise<T> {
  return crossProcessLockRunner(
    crossProcessLockPath(kind),
    { label: `safe.directory ${kind}`, waitMs: MUTATION_LOCK_WAIT_MS },
    task,
  );
}

function runWithRequiredCrossProcessLock<T>(
  kind: SafeDirectoryLockKind,
  task: () => Promise<T>,
): Promise<T> {
  return runWithCrossProcessLock(kind, (status) => {
    if (!status.held) {
      throw new Error(`safe.directory ${kind} lock ${status.reason}`);
    }
    return task();
  });
}

function serializeMutationOperation<T>(operation: () => Promise<T>): Promise<T> {
  return serializeOperation(() => runWithRequiredCrossProcessLock('mutation', operation));
}

async function runReconciliationWithMutationLock<T>(task: () => Promise<T>): Promise<T | null> {
  return runWithCrossProcessLock('mutation', async (status) => {
    if (!status.held) {
      log.warn(`[safe.directory] skipped reconciliation: mutation lock ${status.reason}`);
      return null;
    }
    return task();
  });
}

function isAbsolutePath(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && !value.includes('\0') && path.isAbsolute(value)
  );
}

function isGrantState(value: unknown): value is SafeDirectoryGrantState {
  return value === 'pending' || value === 'owned' || value === 'ambiguous';
}

function parseConfigFileWitness(value: unknown): ConfigFileWitness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ConfigFileWitness>;
  const decimalFields = [
    candidate.device,
    candidate.inode,
    candidate.mode,
    candidate.size,
    candidate.modifiedAtNs,
    candidate.changedAtNs,
  ];
  if (
    !isAbsolutePath(candidate.realPath) ||
    decimalFields.some((field) => typeof field !== 'string' || !/^\d+$/.test(field)) ||
    typeof candidate.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.sha256)
  ) {
    return null;
  }
  let symbolicLink: ConfigSymbolicLinkWitness | undefined;
  if (candidate.symbolicLink !== undefined) {
    const parsed = parseConfigSymbolicLinkWitness(candidate.symbolicLink);
    if (!parsed) return null;
    symbolicLink = parsed;
  }
  return {
    ...(candidate as ConfigFileWitness),
    ...(symbolicLink ? { symbolicLink } : {}),
  };
}

function parseConfigSymbolicLinkWitness(value: unknown): ConfigSymbolicLinkWitness | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<ConfigSymbolicLinkWitness>;
  const decimalFields = [
    candidate.device,
    candidate.inode,
    candidate.mode,
    candidate.size,
    candidate.modifiedAtNs,
    candidate.changedAtNs,
  ];
  if (
    typeof candidate.target !== 'string' ||
    !candidate.target ||
    candidate.target.includes('\0') ||
    decimalFields.some((field) => typeof field !== 'string' || !/^\d+$/.test(field))
  ) {
    return null;
  }
  return candidate as ConfigSymbolicLinkWitness;
}

function parseGrantRecord(value: unknown): SafeDirectoryGrantRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<SafeDirectoryGrantRecord>;
  if (
    typeof candidate.id !== 'string' ||
    !candidate.id ||
    !isAbsolutePath(candidate.value) ||
    !isGrantState(candidate.state) ||
    typeof candidate.createdAt !== 'string'
  ) {
    return null;
  }

  const origins = Array.isArray(candidate.candidateOrigins)
    ? [...new Set(candidate.candidateOrigins.filter(isAbsolutePath))]
    : undefined;
  const origin = isAbsolutePath(candidate.origin) ? candidate.origin : undefined;
  const originWitness = parseConfigFileWitness(candidate.originWitness);
  if (candidate.state === 'owned' && (!origin || !originWitness)) return null;

  return {
    id: candidate.id,
    value: candidate.value,
    state: candidate.state,
    createdAt: candidate.createdAt,
    ...(origin ? { origin } : {}),
    ...(originWitness ? { originWitness } : {}),
    ...(origins && origins.length > 0 ? { candidateOrigins: origins } : {}),
  };
}

function readLedger(): SafeDirectoryGrantRecord[] {
  const raw = getLedgerStore().get('grants', []);
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseGrantRecord)
    .filter((record): record is SafeDirectoryGrantRecord => record !== null);
}

function writeLedger(records: readonly SafeDirectoryGrantRecord[]): void {
  getLedgerStore().set('grants', [...records]);
}

function parseRetentionRoot(value: unknown): RetentionRoot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RetentionRoot>;
  if (!isAbsolutePath(candidate.path)) return null;
  if (candidate.mode !== 'exact' && candidate.mode !== 'subtree') return null;
  return { path: path.resolve(candidate.path), mode: candidate.mode };
}

function parseProfileRetentionRecord(value: unknown): SafeDirectoryProfileRetentionRecord | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<SafeDirectoryProfileRetentionRecord>;
  if (!isAbsolutePath(candidate.profilePath)) return null;
  if (!Number.isSafeInteger(candidate.processId) || (candidate.processId ?? 0) <= 0) return null;
  if (!Array.isArray(candidate.roots)) return null;
  const roots = candidate.roots.map(parseRetentionRoot);
  if (roots.some((root) => root === null)) return null;
  let liveSessionPaths: string[] | null;
  if (candidate.liveSessionPaths === null) {
    liveSessionPaths = null;
  } else if (Array.isArray(candidate.liveSessionPaths)) {
    liveSessionPaths = candidate.liveSessionPaths
      .filter(isAbsolutePath)
      .map((entry) => path.resolve(entry));
    if (liveSessionPaths.length !== candidate.liveSessionPaths.length) return null;
  } else {
    return null;
  }
  return {
    profilePath: path.resolve(candidate.profilePath),
    processId: candidate.processId as number,
    roots: roots as RetentionRoot[],
    liveSessionPaths,
  };
}

/** null 表示任一跨 profile 快照格式不可信；删除必须 fail closed。 */
function readProfileRetentions(): SafeDirectoryProfileRetentionRecord[] | null {
  const raw = getLedgerStore().get('profileRetentions', []);
  if (!Array.isArray(raw)) return null;
  const records = raw.map(parseProfileRetentionRecord);
  if (records.some((record) => record === null)) return null;
  const parsed = records as SafeDirectoryProfileRetentionRecord[];
  const instances = new Set<string>();
  for (const record of parsed) {
    const key = `${comparablePath(record.profilePath)}\0${record.processId}`;
    if (instances.has(key)) return null;
    instances.add(key);
  }
  return parsed;
}

interface ProfileRetentionState {
  records: SafeDirectoryProfileRetentionRecord[];
  revision: number;
}

function readProfileRetentionRevision(): number | null {
  const value = getLedgerStore().get('profileRetentionRevision', 0);
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : null;
}

function readProfileRetentionState(): ProfileRetentionState | null {
  const records = readProfileRetentions();
  const revision = readProfileRetentionRevision();
  return records === null || revision === null ? null : { records, revision };
}

function writeProfileRetentions(records: readonly SafeDirectoryProfileRetentionRecord[]): void {
  const revision = readProfileRetentionRevision();
  if (revision === null || revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('safe.directory profile retention revision is invalid');
  }
  // records 先落盘、revision 后提交。锁外读者无论看见新旧哪一半，锁内复核都会因
  // records 或 revision 不同而放弃；进程在两步间退出时，读者评估的仍是实际 records。
  getLedgerStore().set('profileRetentions', [...records]);
  getLedgerStore().set('profileRetentionRevision', revision + 1);
}

function currentProfilePath(): string {
  const value = currentProfilePathProvider();
  if (!isAbsolutePath(value)) {
    throw new Error('safe.directory profile path must be absolute');
  }
  return path.resolve(value);
}

function currentProcessId(): number {
  const value = currentProcessIdProvider();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('safe.directory process id must be a positive integer');
  }
  return value;
}

function probeProcessLiveness(processId: number): ProcessLiveness {
  if (processId === process.pid) return 'alive';
  try {
    process.kill(processId, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'missing' : 'unknown';
  }
}

function sameRetentionInstance(
  record: SafeDirectoryProfileRetentionRecord,
  profilePath: string,
  processId: number,
): boolean {
  return (
    record.processId === processId &&
    comparablePath(record.profilePath) === comparablePath(profilePath)
  );
}

function retentionRecordToSnapshot(record: SafeDirectoryProfileRetentionRecord): RetentionSnapshot {
  return {
    roots: record.roots,
    liveSessionPathKeys: record.liveSessionPaths === null ? null : new Set(record.liveSessionPaths),
  };
}

function writeCurrentProfileRetention(
  snapshot: RetentionSnapshot,
  extraLivePaths: readonly string[] = [],
  preserveExistingLivePaths = false,
): void {
  const records = readProfileRetentions();
  if (records === null) {
    throw new Error('safe.directory profile retention ledger is malformed');
  }
  const profilePath = currentProfilePath();
  const processId = currentProcessId();
  const normalizedExtraPaths = extraLivePaths.map(normalizeRetentionPath);
  if (normalizedExtraPaths.some((value) => value === null)) {
    throw new Error('safe.directory retention path must be absolute');
  }
  const previous = records.find((record) => sameRetentionInstance(record, profilePath, processId));
  const liveSessionPaths =
    snapshot.liveSessionPathKeys === null
      ? null
      : [
          ...new Set([
            ...snapshot.liveSessionPathKeys,
            ...(preserveExistingLivePaths && previous?.liveSessionPaths
              ? previous.liveSessionPaths
              : []),
            ...(normalizedExtraPaths as string[]),
          ]),
        ];
  const next: SafeDirectoryProfileRetentionRecord = {
    profilePath,
    processId,
    roots: snapshot.roots,
    liveSessionPaths,
  };
  writeProfileRetentions([
    ...records.filter((record) => !sameRetentionInstance(record, profilePath, processId)),
    next,
  ]);
}

/**
 * 只在 OS 明确证明 PID 不存在（ESRCH）时回收实例快照。PID 复用、权限错误或探测
 * 不可用都会保守保留，因此 liveness 误判最多延迟回收，不会误删仍在使用的授权。
 */
function compactExitedProcessRetentions(
  records: readonly SafeDirectoryProfileRetentionRecord[],
): SafeDirectoryProfileRetentionRecord[] {
  const profilePath = currentProfilePath();
  const processId = currentProcessId();
  const next = records.filter((record) => {
    if (sameRetentionInstance(record, profilePath, processId)) return true;
    return processLivenessProvider(record.processId) !== 'missing';
  });
  if (next.length !== records.length) {
    writeProfileRetentions(next);
  }
  return next;
}

function runGitConfig(
  args: readonly string[],
  extraEnv?: Record<string, string>,
): Promise<GitConfigResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: GIT_CONFIG_TIMEOUT_MS,
        windowsHide: true,
        env: extraEnv ? { ...process.env, ...extraEnv } : undefined,
      },
      (err, stdout, stderr) => {
        const stdoutText = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const stderrText = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (err) {
          const code = (err as unknown as { code?: unknown }).code;
          reject(
            new GitConfigError(
              stderrText.trim() || err.message,
              typeof code === 'number' ? code : null,
            ),
          );
          return;
        }
        resolve({ stdout: stdoutText, stderr: stderrText });
      },
    );
  });
}

function exitCodeOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const exitCode = (error as { exitCode?: unknown }).exitCode;
  if (typeof exitCode === 'number') return exitCode;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'number' ? code : null;
}

function parseNullFields(stdout: string): string[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

function filePathFromOrigin(origin: string): string | null {
  if (!origin.startsWith('file:')) return null;
  const candidate = origin.slice('file:'.length);
  return isAbsolutePath(candidate) ? candidate : null;
}

function parseGlobalEntries(stdout: string): GlobalSafeDirectoryEntry[] {
  if (!stdout) return [];
  const fields = parseNullFields(stdout);
  if (fields.length % 2 !== 0) {
    throw new Error('git config returned malformed --show-origin --null output');
  }

  const entries: GlobalSafeDirectoryEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const origin = fields[index];
    const value = fields[index + 1];
    entries.push({ origin, filePath: filePathFromOrigin(origin), value });
  }
  return entries;
}

function effectiveGlobalEntries(
  entries: readonly GlobalSafeDirectoryEntry[],
): readonly GlobalSafeDirectoryEntry[] {
  // Git 按配置读取顺序解释 safe.directory；空值会清空此前累积的信任列表。
  // 因而“重置前已有同值”不能阻止我们在真实 dubious error 后追加有效条目。
  let lastReset = -1;
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].value === '') lastReset = index;
  }
  return entries.slice(lastReset + 1);
}

async function listGlobalEntries(
  extraEnv?: Record<string, string>,
): Promise<GlobalSafeDirectoryEntry[]> {
  try {
    const { stdout } = await gitConfigRunner(
      [
        'config',
        '--global',
        '--includes',
        '--show-origin',
        '--null',
        '--get-all',
        'safe.directory',
      ],
      extraEnv,
    );
    return parseGlobalEntries(stdout);
  } catch (error) {
    // `git config --get-all` 用 exit 1 表示 key 不存在，不是读取失败。
    if (exitCodeOf(error) === 1) return [];
    throw error;
  }
}

async function listValuesAtOrigin(origin: string): Promise<string[]> {
  if (!isAbsolutePath(origin)) throw new Error('invalid safe.directory config origin');
  try {
    const { stdout } = await gitConfigRunner([
      'config',
      '--file',
      origin,
      '--null',
      '--get-all',
      'safe.directory',
    ]);
    return parseNullFields(stdout);
  } catch (error) {
    if (exitCodeOf(error) === 1) return [];
    throw error;
  }
}

function serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function replaceRecord(
  records: readonly SafeDirectoryGrantRecord[],
  replacement: SafeDirectoryGrantRecord,
): SafeDirectoryGrantRecord[] {
  return records.map((record) => (record.id === replacement.id ? replacement : record));
}

function uniqueFileOrigins(entries: readonly GlobalSafeDirectoryEntry[]): string[] {
  return [
    ...new Set(
      entries.map((entry) => entry.filePath).filter((origin): origin is string => origin !== null),
    ),
  ];
}

function sameConfigFileWitness(
  left: ConfigFileWitness | undefined,
  right: ConfigFileWitness | null | undefined,
): boolean {
  return (
    left !== undefined &&
    right != null &&
    left.realPath === right.realPath &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs &&
    left.sha256 === right.sha256 &&
    sameConfigSymbolicLinkWitness(left.symbolicLink, right.symbolicLink)
  );
}

function sameConfigSymbolicLinkWitness(
  left: ConfigSymbolicLinkWitness | undefined,
  right: ConfigSymbolicLinkWitness | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.target === right.target &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function symbolicLinkWitness(stats: BigIntStats, target: string): ConfigSymbolicLinkWitness {
  return {
    target,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    mode: stats.mode.toString(),
    size: stats.size.toString(),
    modifiedAtNs: stats.mtimeNs.toString(),
    changedAtNs: stats.ctimeNs.toString(),
  };
}

async function captureConfigFileWitness(filePath: string): Promise<ConfigFileWitness | null> {
  if (!isAbsolutePath(filePath)) return null;
  try {
    const beforeEntry = await fs.lstat(filePath, { bigint: true });
    if (!beforeEntry.isFile() && !beforeEntry.isSymbolicLink()) return null;
    const beforeLinkTarget = beforeEntry.isSymbolicLink() ? await fs.readlink(filePath) : null;
    const beforeRealPath = await fs.realpath(filePath);
    const beforeTarget = await fs.stat(filePath, { bigint: true });
    if (!beforeTarget.isFile()) return null;
    const contents = await fs.readFile(filePath);
    const afterEntry = await fs.lstat(filePath, { bigint: true });
    const afterLinkTarget = afterEntry.isSymbolicLink() ? await fs.readlink(filePath) : null;
    const afterRealPath = await fs.realpath(filePath);
    const afterTarget = await fs.stat(filePath, { bigint: true });
    if (
      !afterTarget.isFile() ||
      beforeRealPath !== afterRealPath ||
      !sameFileIdentity(beforeTarget, afterTarget) ||
      beforeEntry.isSymbolicLink() !== afterEntry.isSymbolicLink() ||
      (!beforeEntry.isSymbolicLink() && !afterEntry.isFile()) ||
      (beforeEntry.isSymbolicLink() &&
        (!afterEntry.isSymbolicLink() ||
          beforeLinkTarget !== afterLinkTarget ||
          !sameFileIdentity(beforeEntry, afterEntry)))
    ) {
      return null;
    }

    return {
      realPath: afterRealPath,
      device: afterTarget.dev.toString(),
      inode: afterTarget.ino.toString(),
      mode: afterTarget.mode.toString(),
      size: afterTarget.size.toString(),
      modifiedAtNs: afterTarget.mtimeNs.toString(),
      changedAtNs: afterTarget.ctimeNs.toString(),
      sha256: createHash('sha256').update(contents).digest('hex'),
      ...(afterEntry.isSymbolicLink() && afterLinkTarget !== null
        ? { symbolicLink: symbolicLinkWitness(afterEntry, afterLinkTarget) }
        : {}),
    };
  } catch {
    return null;
  }
}

async function unlinkTemporaryPath(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (!isDefinitivelyMissing(error)) throw error;
  }
}

async function pathIsDefinitivelyMissing(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return false;
  } catch (error) {
    if (isDefinitivelyMissing(error)) return true;
    throw error;
  }
}

function effectiveEnvironmentValue(
  key: string,
  extraEnv?: Record<string, string>,
): string | undefined {
  return extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, key)
    ? extraEnv[key]
    : process.env[key];
}

/** Mirrors Git's documented --global write target selection. */
async function resolveGlobalConfigWriteOrigin(
  extraEnv?: Record<string, string>,
): Promise<string | null> {
  const override = effectiveEnvironmentValue('GIT_CONFIG_GLOBAL', extraEnv);
  if (override !== undefined) return isAbsolutePath(override) ? path.resolve(override) : null;

  const configuredHome = effectiveEnvironmentValue('HOME', extraEnv);
  const home = isAbsolutePath(configuredHome) ? configuredHome : homePathProvider();
  if (!isAbsolutePath(home)) return null;
  const homeConfig = path.join(home, '.gitconfig');
  if (!(await pathIsDefinitivelyMissing(homeConfig))) return homeConfig;

  const configuredXdgHome = effectiveEnvironmentValue('XDG_CONFIG_HOME', extraEnv);
  if (configuredXdgHome !== undefined && !isAbsolutePath(configuredXdgHome)) return null;
  const xdgHome = configuredXdgHome || path.join(home, '.config');
  const xdgConfig = path.join(xdgHome, 'git', 'config');
  return (await pathIsDefinitivelyMissing(xdgConfig)) ? homeConfig : xdgConfig;
}

/**
 * 用 Git 约定的 `<config>.lock` 封闭配置变更。变更先在同目录副本上交给 Git
 * 自己解析，再在锁内重验 origin；只有原文件未变化才原子替换。
 */
async function mutateConfigFileAtomically(
  origin: string,
  expectedWitness: ConfigFileWitness | null,
  mutation: (stagingPath: string) => Promise<void>,
  onCommitted?: (afterWitness: ConfigFileWitness) => Promise<void>,
): Promise<ConfigFileWitness> {
  const mutationOrigin = expectedWitness?.realPath ?? origin;
  if (!isAbsolutePath(mutationOrigin)) throw new Error('invalid witnessed config origin');

  const lockPath = `${mutationOrigin}.lock`;
  const stagingPath = `${lockPath}.cindy-${process.pid}-${randomUUID()}`;
  let lockHandle: FileHandle | null = null;
  let lockIdentity: BigIntStats | null = null;
  try {
    const mode = expectedWitness ? Number(BigInt(expectedWitness.mode) & 0o777n) : 0o600;
    lockHandle = await fs.open(lockPath, 'wx', 0o600);
    lockIdentity = await lockHandle.stat({ bigint: true });

    const lockedWitness = await captureConfigFileWitness(origin);
    const unchangedBeforeMutation = expectedWitness
      ? sameConfigFileWitness(expectedWitness, lockedWitness)
      : lockedWitness === null && (await pathIsDefinitivelyMissing(origin));
    if (!unchangedBeforeMutation) {
      throw new Error('safe.directory config changed before mutation lock was acquired');
    }

    const stagingHandle = await fs.open(stagingPath, 'wx', mode);
    await stagingHandle.close();
    if (expectedWitness) await fs.copyFile(mutationOrigin, stagingPath);
    await mutation(stagingPath);

    // 不遵守 Git lockfile 的外部工具仍可能直接替换配置；提交前再 fail closed。
    const commitWitness = await captureConfigFileWitness(origin);
    const unchangedBeforeCommit = expectedWitness
      ? sameConfigFileWitness(expectedWitness, commitWitness)
      : commitWitness === null && (await pathIsDefinitivelyMissing(origin));
    if (!unchangedBeforeCommit) {
      throw new Error('safe.directory config changed while mutation lock was held');
    }
    await fs.rename(stagingPath, mutationOrigin);
    const afterWitness = await captureConfigFileWitness(origin);
    if (!afterWitness) throw new Error('safe.directory config witness unavailable after mutation');
    await onCommitted?.(afterWitness);
    return afterWitness;
  } finally {
    await unlinkTemporaryPath(stagingPath).catch((error) => {
      log.warn(
        '[safe.directory] failed to remove config staging file:',
        error instanceof Error ? error.message : String(error),
      );
    });
    await lockHandle?.close().catch(() => undefined);
    if (lockIdentity) {
      try {
        const currentLock = await fs.lstat(lockPath, { bigint: true });
        if (sameFileIdentity(lockIdentity, currentLock)) await fs.unlink(lockPath);
      } catch (error) {
        if (!isDefinitivelyMissing(error)) {
          log.warn(
            '[safe.directory] failed to release config mutation lock:',
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
  }
}

async function removeOwnedConfigValueAtomically(
  origin: string,
  expectedWitness: ConfigFileWitness,
  value: string,
): Promise<ConfigFileWitness> {
  return mutateConfigFileAtomically(origin, expectedWitness, (stagingPath) =>
    gitConfigRunner([
      'config',
      '--file',
      stagingPath,
      '--fixed-value',
      '--unset',
      'safe.directory',
      value,
    ]).then(() => undefined),
  );
}

async function captureOwnedOriginWitnesses(
  records: readonly SafeDirectoryGrantRecord[],
): Promise<Map<string, ConfigFileWitness | null>> {
  const origins = [
    ...new Set(
      records
        .filter((record) => record.state === 'owned' && record.origin)
        .map((record) => record.origin!),
    ),
  ];
  const witnesses = await Promise.all(origins.map(captureConfigFileWitness));
  return new Map(origins.map((origin, index) => [origin, witnesses[index]]));
}

function refreshOwnedOriginWitnesses(
  records: readonly SafeDirectoryGrantRecord[],
  origin: string,
  before: ConfigFileWitness | null | undefined,
  after: ConfigFileWitness,
): SafeDirectoryGrantRecord[] {
  return records.map((record) =>
    record.state === 'owned' &&
    record.origin !== undefined &&
    sameConfigFile(record.origin, origin) &&
    sameConfigFileWitness(record.originWitness, before)
      ? { ...record, originWitness: after }
      : record,
  );
}

interface OwnedOriginSnapshot {
  witness: ConfigFileWitness;
  safeDirectoryValues: string[];
}

async function captureOwnedOriginSnapshots(
  records: readonly SafeDirectoryGrantRecord[],
): Promise<Map<string, OwnedOriginSnapshot>> {
  const witnesses = await captureOwnedOriginWitnesses(records);
  const snapshots = new Map<string, OwnedOriginSnapshot>();
  await Promise.all(
    [...witnesses].map(async ([origin, witness]) => {
      if (!witness) return;
      try {
        snapshots.set(origin, {
          witness,
          safeDirectoryValues: await listValuesAtOrigin(origin),
        });
      } catch (error) {
        log.warn(
          '[safe.directory] failed to snapshot an owned origin before a global config write:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );
  return snapshots;
}

function sameStringValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function refreshOwnedWitnessesAfterKnownConfigWrite(
  records: readonly SafeDirectoryGrantRecord[],
  before: ReadonlyMap<string, OwnedOriginSnapshot>,
): Promise<void> {
  let refreshed = [...records];
  for (const [origin, snapshot] of before) {
    try {
      const [afterWitness, afterValues] = await Promise.all([
        captureConfigFileWitness(origin),
        listValuesAtOrigin(origin),
      ]);
      if (
        !afterWitness ||
        !sameStringValues(snapshot.safeDirectoryValues, afterValues) ||
        sameConfigFileWitness(snapshot.witness, afterWitness)
      ) {
        continue;
      }
      refreshed = refreshOwnedOriginWitnesses(refreshed, origin, snapshot.witness, afterWitness);
    } catch (error) {
      // 无法证明写入只改了其它 Git 配置时保留旧见证，后续清理自然 fail closed。
      log.warn(
        '[safe.directory] failed to refresh an owned origin after a global config write:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  try {
    writeLedger(refreshed);
  } catch (error) {
    // 见证刷新失败最多留下无法自动回收的授权，不应把已成功的配置修复改判为失败。
    log.warn(
      '[safe.directory] failed to persist refreshed origin witnesses:',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * 包裹 Cindy 已知的、不会修改 safe.directory 的全局 Git 配置写入。Git 会通过
 * lockfile 重写整份配置文件；只有写入前后的 safe.directory 值完全相同，才刷新
 * 仍与写前见证匹配的 owned 记录。写入失败也执行刷新探测，以覆盖“文件已重写但
 * 命令最终报错”的保守边界。
 */
export function withSafeDirectoryWitnessRefresh<T>(mutation: () => Promise<T>): Promise<T> {
  return serializeMutationOperation(async () => {
    const records = readLedger();
    const before = await captureOwnedOriginSnapshots(records);
    let completed = false;
    let result: T | undefined;
    let mutationError: unknown;
    try {
      result = await mutation();
      completed = true;
    } catch (error) {
      mutationError = error;
    }

    await refreshOwnedWitnessesAfterKnownConfigWrite(records, before);
    if (!completed) throw mutationError;
    return result as T;
  });
}

function classifyAddedRecord(
  pending: SafeDirectoryGrantRecord,
  matches: readonly GlobalSafeDirectoryEntry[],
  addSucceeded: boolean,
  originWitness: ConfigFileWitness | null,
  expectedOrigin: string,
): SafeDirectoryGrantRecord {
  if (
    addSucceeded &&
    matches.length === 1 &&
    sameConfigFile(matches[0].filePath, expectedOrigin) &&
    originWitness
  ) {
    return {
      ...pending,
      state: 'owned',
      origin: expectedOrigin,
      originWitness,
      candidateOrigins: undefined,
    };
  }
  return {
    ...pending,
    state: 'ambiguous',
    origin: undefined,
    originWitness: undefined,
    candidateOrigins: uniqueFileOrigins(matches),
  };
}

/**
 * Git 确实报告 dubious ownership 后调用。若同值有效则不取得所有权；若同值只在
 * 空值重置前存在则返回 command，让调用方使用单次 -c 覆写；否则先记 pending，再
 * 新增全局配置并确认 value + origin。所有检查和写入同时经过进程内队列与跨进程
 * mutation 锁，避免跨 profile 实例制造重复项或覆盖共享台账。
 */
export function ensureSafeDirectory(
  repositoryPath: string,
  extraEnv?: Record<string, string>,
): Promise<SafeDirectoryRecoveryMode> {
  if (!isAbsolutePath(repositoryPath)) {
    return Promise.reject(new Error('safe.directory path must be absolute'));
  }

  return serializeMutationOperation(async () => {
    writeCurrentProfileRetention(await collectRetentionSnapshot(), [repositoryPath], true);
    const before = await listGlobalEntries(extraEnv);
    if (effectiveGlobalEntries(before).some((entry) => entry.value === repositoryPath)) {
      return 'persistent';
    }
    // 同值只出现在最后一个空值重置之前时，重新 append 虽能恢复本次 Git，但同一
    // origin 内的两个同值无法用 git config --unset 精确区分。改用本次命令的 -c
    // 覆写，不制造一条以后无法证明并回收的全局授权。
    if (before.some((entry) => entry.value === repositoryPath)) return 'command';

    const writeOrigin = await globalConfigWriteOriginProvider(extraEnv);
    if (!writeOrigin) return 'command';
    const beforeWriteWitness = await captureConfigFileWitness(writeOrigin);
    if (!beforeWriteWitness && !(await pathIsDefinitivelyMissing(writeOrigin))) return 'command';

    const records = readLedger();
    const reusablePending = records.find(
      (record) => record.value === repositoryPath && record.state === 'pending',
    );
    const pending: SafeDirectoryGrantRecord = reusablePending
      ? { ...reusablePending, createdAt: new Date().toISOString() }
      : {
          id: randomUUID(),
          value: repositoryPath,
          state: 'pending',
          createdAt: new Date().toISOString(),
        };
    const withPending = reusablePending ? replaceRecord(records, pending) : [...records, pending];

    // 台账无法落盘时不允许先改 Git；否则将失去“只删除自己写入项”的证明。
    writeLedger(withPending);

    let addError: unknown;
    try {
      await mutateConfigFileAtomically(
        writeOrigin,
        beforeWriteWitness,
        (stagingPath) =>
          gitConfigRunner(
            ['config', '--file', stagingPath, '--add', 'safe.directory', repositoryPath],
            extraEnv,
          ).then(() => undefined),
        async (afterWriteWitness) => {
          try {
            const after = await listGlobalEntries(extraEnv);
            const confirmedWitness = await captureConfigFileWitness(writeOrigin);
            if (!sameConfigFileWitness(afterWriteWitness, confirmedWitness)) {
              log.warn(
                '[safe.directory] global config changed before ownership confirmation; keeping pending grant',
              );
              return;
            }
            const matches = effectiveGlobalEntries(after).filter(
              (entry) => entry.value === repositoryPath,
            );
            const refreshedRecords = refreshOwnedOriginWitnesses(
              withPending,
              writeOrigin,
              beforeWriteWitness,
              afterWriteWitness,
            );
            const finalized = classifyAddedRecord(
              pending,
              matches,
              true,
              afterWriteWitness,
              writeOrigin,
            );
            try {
              writeLedger(replaceRecord(refreshedRecords, finalized));
            } catch (error) {
              // pending 已先持久化；最终状态写失败时宁可永不自动删。
              log.warn(
                '[safe.directory] failed to finalize grant ownership; keeping pending grant:',
                error instanceof Error ? error.message : String(error),
              );
            }
          } catch (error) {
            // 原子写入已完成但无法在同一配置锁内确认；pending 永远不会被自动删除。
            log.warn(
              '[safe.directory] failed to verify global config after add; keeping pending grant:',
              error instanceof Error ? error.message : String(error),
            );
          }
        },
      );
    } catch (error) {
      addError = error;
    }

    if (addError) {
      let matches: GlobalSafeDirectoryEntry[] = [];
      try {
        matches = effectiveGlobalEntries(await listGlobalEntries(extraEnv)).filter(
          (entry) => entry.value === repositoryPath,
        );
      } catch {
        // 无法证明配置未变化，保留 pending。
        return 'persistent';
      }
      if (matches.length === 0) {
        writeLedger(withPending.filter((record) => record.id !== pending.id));
        throw addError;
      }
    }
    return 'persistent';
  });
}

function normalizeRetentionPath(value: string): string | null {
  if (!value || value.includes('\0')) return null;
  try {
    return path.resolve(value);
  } catch {
    return null;
  }
}

function retentionMapKey(value: string, mode: RetentionMode): string {
  const folded = process.platform === 'win32' ? value.toLowerCase() : value;
  return `${mode}\0${folded}`;
}

/**
 * 创建流程在 worktreeStore 落盘前持有的 C 集合补充项，防止启动后台对账与创建竞态。
 */
function beginLocalSafeDirectoryRetention(
  options: {
    exactPaths?: readonly string[];
    subtreePaths?: readonly string[];
  } = {},
): LocalSafeDirectoryRetention {
  const ownedKeys = new Set<string>();
  let released = false;

  const add = (value: string, mode: RetentionMode): boolean => {
    if (released) return false;
    const normalized = normalizeRetentionPath(value);
    if (!normalized) return false;
    const key = retentionMapKey(normalized, mode);
    if (ownedKeys.has(key)) return false;
    ownedKeys.add(key);
    const existing = inflightRetentionRoots.get(key);
    inflightRetentionRoots.set(key, {
      path: normalized,
      mode,
      count: (existing?.count ?? 0) + 1,
    });
    inflightRetentionGeneration += 1;
    return true;
  };

  for (const value of options.exactPaths ?? []) add(value, 'exact');
  for (const value of options.subtreePaths ?? []) add(value, 'subtree');

  return {
    addExact: (value) => add(value, 'exact'),
    addSubtree: (value) => add(value, 'subtree'),
    release: () => {
      if (released) return;
      released = true;
      let changed = false;
      for (const key of ownedKeys) {
        const current = inflightRetentionRoots.get(key);
        if (!current) continue;
        if (current.count <= 1) inflightRetentionRoots.delete(key);
        else inflightRetentionRoots.set(key, { ...current, count: current.count - 1 });
        changed = true;
      }
      ownedKeys.clear();
      if (changed) inflightRetentionGeneration += 1;
    },
  };
}

/**
 * 创建流程的持久声明守卫。mutation 锁只包共享声明的发布／撤销；耗时 Git、checkout
 * 与复制不持锁。共享声明只是全局授权的生命周期优化，发布失败时任务仍继续，后续
 * gitExec 会对每条实际 Git 命令降级为命令作用域授权，不能让台账成为创建硬依赖。
 */
export function withSafeDirectoryRetention<T>(
  options: {
    exactPaths?: readonly string[];
    subtreePaths?: readonly string[];
  },
  task: (retention: SafeDirectoryRetention) => Promise<T>,
): Promise<T> {
  const localRetention = beginLocalSafeDirectoryRetention(options);
  const publishCurrentRetention = async (phase: string): Promise<void> => {
    try {
      await serializeMutationOperation(async () => {
        writeCurrentProfileRetention(await collectRetentionSnapshot(), [], true);
      });
    } catch (error) {
      log.warn(
        `[safe.directory] failed to publish ${phase}; Git can fall back to command-scoped authorization:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const publishAddedRoot = async (value: string, mode: RetentionMode): Promise<void> => {
    const changed =
      mode === 'exact' ? localRetention.addExact(value) : localRetention.addSubtree(value);
    if (!changed) return;
    await publishCurrentRetention('dynamically added creation retention');
  };
  const retention: SafeDirectoryRetention = {
    addExact: (value) => publishAddedRoot(value, 'exact'),
    addSubtree: (value) => publishAddedRoot(value, 'subtree'),
  };
  return (async () => {
    try {
      await publishCurrentRetention('creation retention');
      return await task(retention);
    } finally {
      localRetention.release();
      await serializeMutationOperation(async () => {
        writeCurrentProfileRetention(await collectRetentionSnapshot(), [], true);
      }).catch((error) => {
        // 进入守卫时的持久声明仍会保守保留；最终刷新失败只可能延迟回收，不能误删。
        log.warn(
          '[safe.directory] failed to refresh profile retention after creation:',
          error instanceof Error ? error.message : String(error),
        );
      });
    }
  })();
}

function isDefinitivelyMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function pathMayExist(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch (error) {
    // 权限、瞬时 IO 等无法证明“不存在”，必须保留。
    return !isDefinitivelyMissing(error);
  }
}

async function collectRetentionSnapshot(): Promise<RetentionSnapshot> {
  const roots: RetentionRoot[] = [...inflightRetentionRoots.values()].map(
    ({ path: value, mode }) => ({
      path: value,
      mode,
    }),
  );
  const metas = activeWorktreesProvider();
  const liveSessionPathKeys = await liveSessionPathKeysProvider();

  for (const meta of metas) {
    if (!meta || !isAbsolutePath(meta.path) || !isAbsolutePath(meta.baseRepo)) {
      throw new Error('worktree store contains malformed path data');
    }
    if (meta.quarantinePath !== undefined && !isAbsolutePath(meta.quarantinePath)) {
      throw new Error('worktree store contains malformed quarantine path data');
    }

    const physicalCandidates = meta.quarantinePath ? [meta.path, meta.quarantinePath] : [meta.path];
    const existence = await Promise.all(physicalCandidates.map(pathMayExist));
    if (!existence.some(Boolean)) continue;

    // baseRepo 只能保留它自身；不能把同仓库下已经消失的兄弟 worktree 一并保留。
    roots.push({ path: meta.baseRepo, mode: 'exact' });
    roots.push({ path: meta.path, mode: 'subtree' });
    if (meta.quarantinePath) roots.push({ path: meta.quarantinePath, mode: 'subtree' });
  }
  return { roots, liveSessionPathKeys };
}

/**
 * Git 首次在某个 cwd 运行前发布一次当前 profile 的共享依赖。这样即使另一个 profile
 * 已经添加了同一条 safe.directory，本 profile 没有触发 dubious-ownership 恢复，也会
 * 在命令开始前进入全局 C 集合。后续对账会用 DB/worktree 真值刷新并清掉过期路径。
 */
export function retainSafeDirectoryUsage(workingDirectory: string): Promise<void> {
  const normalized = normalizeRetentionPath(workingDirectory);
  if (!normalized) {
    return Promise.reject(new Error('safe.directory usage path must be absolute'));
  }
  const key = comparablePath(normalized);
  if (publishedUsagePaths.has(key)) return Promise.resolve();

  return serializeMutationOperation(async () => {
    if (publishedUsagePaths.has(key)) return;
    writeCurrentProfileRetention(await collectRetentionSnapshot(), [normalized], true);
    publishedUsagePaths.add(key);
  });
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function pathVariants(value: string): Promise<string[]> {
  const variants = new Set<string>([comparablePath(value)]);
  try {
    variants.add(comparablePath(await fs.realpath(value)));
  } catch {
    // 路径已删除时逻辑路径仍足够完成 A/B/C 对账。
  }
  return [...variants];
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function isGrantRetained(
  value: string,
  snapshot: RetentionSnapshot,
  variantsCache: Map<string, Promise<string[]>>,
): Promise<boolean> {
  // DB 尚未就绪或查询失败时无法证明没有普通任务仍在使用该授权。
  if (snapshot.liveSessionPathKeys === null) return true;

  const variantsFor = (candidate: string) => {
    let pending = variantsCache.get(candidate);
    if (!pending) {
      pending = pathVariants(candidate);
      variantsCache.set(candidate, pending);
    }
    return pending;
  };

  const grantVariants = await variantsFor(value);
  for (const root of snapshot.roots) {
    const rootVariants = await variantsFor(root.path);
    for (const rootVariant of rootVariants) {
      for (const grantVariant of grantVariants) {
        if (
          root.mode === 'exact' ? rootVariant === grantVariant : isInside(rootVariant, grantVariant)
        ) {
          return true;
        }
      }
    }
  }

  // 普通任务可能从仓库的任意子目录启动。safe.directory 记录的是 Git 报告的
  // 仓库根，因此这里按“授权路径包含 workingDir/worktreePath”的方向匹配。
  for (const liveSessionPath of snapshot.liveSessionPathKeys) {
    // archived/deleted 任务会保留历史路径；磁盘已明确不存在时不能继续把它当 C。
    // 权限或瞬时 I/O 无法证明缺失，pathMayExist 会继续保守保留。
    if (!(await pathMayExist(liveSessionPath))) continue;
    const liveSessionVariants = await variantsFor(liveSessionPath);
    for (const grantVariant of grantVariants) {
      for (const liveSessionVariant of liveSessionVariants) {
        if (isInside(grantVariant, liveSessionVariant)) return true;
      }
    }
  }
  return false;
}

/**
 * 锁外证明当前 C 集合不包含 value，并返回证明对应的本进程代次。null 表示仍被
 * 保留、快照未知或探测期间代次持续变化；调用方必须按不可删除处理。
 */
async function prepareRetentionAbsenceGeneration(
  value: string,
  profileRetentions: readonly SafeDirectoryProfileRetentionRecord[],
  variantsCache: Map<string, Promise<string[]>>,
): Promise<number | null> {
  const profilePath = currentProfilePath();
  const processId = currentProcessId();
  const otherInstances = profileRetentions.filter(
    (record) => !sameRetentionInstance(record, profilePath, processId),
  );

  // 当前进程的创建声明可能在异步磁盘探测期间变化。只有前后代次一致，且所有其它
  // profile 的持久快照也都确认不保留，才允许删除；持续变化或未知快照一律保留。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const generation = inflightRetentionGeneration;
    if (await isGrantRetained(value, await collectRetentionSnapshot(), variantsCache)) return null;
    if (generation !== inflightRetentionGeneration) continue;
    for (const record of otherInstances) {
      if (await isGrantRetained(value, retentionRecordToSnapshot(record), variantsCache))
        return null;
    }
    if (generation === inflightRetentionGeneration) return generation;
  }
  return null;
}

async function isGrantRetainedAcrossProfilesNow(
  value: string,
  profileRetentions: readonly SafeDirectoryProfileRetentionRecord[],
  variantsCache: Map<string, Promise<string[]>>,
): Promise<boolean> {
  return (
    (await prepareRetentionAbsenceGeneration(value, profileRetentions, variantsCache)) === null
  );
}

function sameConfigFile(left: string | null, right: string): boolean {
  if (!left) return false;
  try {
    return comparablePath(left) === comparablePath(right);
  } catch {
    return false;
  }
}

async function candidateOriginsAreEmpty(record: SafeDirectoryGrantRecord): Promise<boolean> {
  const origins = record.candidateOrigins ?? [];
  if (origins.length === 0) return true;
  try {
    const values = await Promise.all(origins.map(listValuesAtOrigin));
    return values.every((entries) => !entries.includes(record.value));
  } catch {
    return false;
  }
}

type ReconciliationAction =
  | { kind: 'compact'; record: SafeDirectoryGrantRecord }
  | { kind: 'remove'; record: SafeDirectoryGrantRecord };

function sameGrantRecord(left: SafeDirectoryGrantRecord, right: SafeDirectoryGrantRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameProfileRetentions(
  left: readonly SafeDirectoryProfileRetentionRecord[],
  right: readonly SafeDirectoryProfileRetentionRecord[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameOwnedGrantCore(
  current: SafeDirectoryGrantRecord,
  inspected: SafeDirectoryGrantRecord,
): boolean {
  return (
    current.id === inspected.id &&
    current.value === inspected.value &&
    current.state === 'owned' &&
    inspected.state === 'owned' &&
    current.createdAt === inspected.createdAt &&
    current.origin !== undefined &&
    inspected.origin !== undefined &&
    sameConfigFile(current.origin, inspected.origin)
  );
}

/**
 * 慢速 Git/文件探测不持 mutation 锁，只生成候选动作。候选不是删除授权；真正提交
 * 时会重新读取共享台账、C 集合和 origin 见证，任何变化都放弃本轮动作。
 */
async function inspectReconciliationActions(
  records: readonly SafeDirectoryGrantRecord[],
  profileRetentions: readonly SafeDirectoryProfileRetentionRecord[],
): Promise<ReconciliationAction[]> {
  const globalEntries = await listGlobalEntries();
  const variantsCache = new Map<string, Promise<string[]>>();
  const actions: ReconciliationAction[] = [];

  for (const record of records) {
    if (await isGrantRetainedAcrossProfilesNow(record.value, profileRetentions, variantsCache)) {
      continue;
    }

    const globalMatches = globalEntries.filter((entry) => entry.value === record.value);
    if (record.state !== 'owned' || !record.origin) {
      if (globalMatches.length === 0 && (await candidateOriginsAreEmpty(record))) {
        actions.push({ kind: 'compact', record });
      }
      continue;
    }

    if (globalMatches.length === 0) {
      try {
        if (!(await listValuesAtOrigin(record.origin)).includes(record.value)) {
          actions.push({ kind: 'compact', record });
        }
      } catch {
        // 无法证明 B 与原 origin 都已没有该值，保留台账。
      }
      continue;
    }

    const sameValueClaims = records.filter((candidate) => candidate.value === record.value);
    if (
      globalMatches.length !== 1 ||
      !sameConfigFile(globalMatches[0].filePath, record.origin) ||
      sameValueClaims.length !== 1
    ) {
      continue;
    }

    let valuesAtOrigin: string[];
    try {
      valuesAtOrigin = await listValuesAtOrigin(record.origin);
    } catch (error) {
      log.warn(
        '[safe.directory] failed to inspect owned config entry; preserving:',
        error instanceof Error ? error.message : String(error),
      );
      continue;
    }
    if (valuesAtOrigin.filter((value) => value === record.value).length !== 1) continue;

    const currentWitness = await captureConfigFileWitness(record.origin);
    if (sameConfigFileWitness(record.originWitness, currentWitness)) {
      actions.push({ kind: 'remove', record });
    }
  }

  return actions;
}

interface RetentionAbsenceProof {
  inflightGeneration: number;
  profileRetentionRevision: number;
  profileRetentions: SafeDirectoryProfileRetentionRecord[];
}

async function prepareRetentionAbsenceProof(value: string): Promise<RetentionAbsenceProof | null> {
  const state = readProfileRetentionState();
  if (!state) {
    log.warn('[safe.directory] skipped removal: profile retention ledger is malformed');
    return null;
  }
  const inflightGeneration = await prepareRetentionAbsenceGeneration(
    value,
    state.records,
    new Map<string, Promise<string[]>>(),
  );
  if (inflightGeneration === null) return null;
  return {
    inflightGeneration,
    profileRetentionRevision: state.revision,
    profileRetentions: state.records,
  };
}

async function commitReconciliationAction(action: ReconciliationAction): Promise<void> {
  // compact 不会修改全局 Git 配置；remove 的最终 C 证明则必须在 mutation 锁外完成。
  const retentionProof =
    action.kind === 'remove' ? await prepareRetentionAbsenceProof(action.record.value) : null;
  if (action.kind === 'remove' && !retentionProof) return;

  await serializeOperation(() =>
    runReconciliationWithMutationLock(async () => {
      let records = readLedger();
      const current = records.find((record) => record.id === action.record.id);
      if (!current) return;

      if (action.kind === 'compact') {
        // 只压缩与锁外探测完全相同的不确定记录；任何并发 finalization 都使动作失效。
        if (!sameGrantRecord(current, action.record)) return;
        writeLedger(records.filter((record) => record.id !== current.id));
        return;
      }
      if (!retentionProof) return;

      // 同一 origin 的前一个删除会合法刷新见证，因此 remove 候选允许见证变化，但
      // id/value/state/origin 必须仍是锁外检查过的 owned 记录，且不能出现同值新 claim。
      if (!sameOwnedGrantCore(current, action.record)) return;
      if (records.filter((record) => record.value === current.value).length !== 1) return;

      const retentionState = readProfileRetentionState();
      if (!retentionState) {
        log.warn('[safe.directory] skipped removal: profile retention ledger is malformed');
        return;
      }
      if (
        inflightRetentionGeneration !== retentionProof.inflightGeneration ||
        retentionState.revision !== retentionProof.profileRetentionRevision ||
        !sameProfileRetentions(retentionState.records, retentionProof.profileRetentions)
      ) {
        return;
      }

      const currentWitness = await captureConfigFileWitness(current.origin!);
      if (!currentWitness || !sameConfigFileWitness(current.originWitness, currentWitness)) return;

      try {
        const afterWitness = await removeOwnedConfigValueAtomically(
          current.origin!,
          currentWitness,
          current.value,
        );

        records = records.filter((record) => record.id !== current.id);
        // 原子替换会改变配置文件见证；其它 owned 记录只有仍匹配删除前见证时
        // 才继承新见证。
        records = refreshOwnedOriginWitnesses(
          records,
          current.origin!,
          currentWitness,
          afterWitness,
        );
        writeLedger(records);
      } catch (error) {
        // `--unset` 在重复匹配时会失败；其它写入/锁错误也都只保留，不影响 worktree 清理。
        log.warn(
          '[safe.directory] failed to remove owned config entry; preserving ownership record:',
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );
}

/**
 * 按 A ∩ (B - C) 对账：A 是 Cindy 的跨 profile 所有权台账，B 是当前全局 Git 配置，
 * C 是所有已登记 profile 中仍保留的 worktree、创建声明与任务工作目录的并集。
 */
export function reconcileSafeDirectories(): Promise<void> {
  // 同一进程已有尚未持久化完毕的创建声明时跳过删除，即为安全结果。
  if (inflightRetentionRoots.size > 0) return Promise.resolve();
  return (async () => {
    const generation = inflightRetentionGeneration;
    const snapshot = await collectRetentionSnapshot();
    if (generation !== inflightRetentionGeneration || inflightRetentionRoots.size > 0) return;

    const prepared = await serializeOperation(() =>
      runReconciliationWithMutationLock(async () => {
        // 获取锁期间若本进程开始创建，旧快照不能覆盖它刚发布或即将发布的声明。
        if (generation !== inflightRetentionGeneration || inflightRetentionRoots.size > 0) {
          return { skipped: true as const };
        }
        writeCurrentProfileRetention(snapshot);
        publishedUsagePaths.clear();
        let profileRetentions = readProfileRetentions();
        if (profileRetentions === null) {
          return { malformed: true as const };
        }
        profileRetentions = compactExitedProcessRetentions(profileRetentions);
        return { records: readLedger(), profileRetentions };
      }),
    );
    if (!prepared || 'skipped' in prepared) return;
    if ('malformed' in prepared) {
      log.warn('[safe.directory] skipped reconciliation: profile retention ledger is malformed');
      return;
    }
    if (prepared.records.length === 0) return;

    const actions = await inspectReconciliationActions(
      prepared.records,
      prepared.profileRetentions,
    );
    for (const action of actions) {
      await commitReconciliationAction(action);
    }
  })();
}

/**
 * 由 Desktop 组合根注入 Maker 的运行态真值。未注入或 Maker 尚未就绪时返回
 * undefined，终态会话继续 fail closed 保留；明确 false 后归档/删除任务才退出 C 集合。
 */
export function setSafeDirectorySessionRuntimeAliveProvider(
  provider: SessionRuntimeAliveProvider | null,
): void {
  sessionRuntimeAliveProvider = provider;
}

// ── 测试钩子 ────────────────────────────────────────────────────────────────

export function _setSafeDirectoryLedgerStoreForTests(value: SafeDirectoryLedgerStore | null): void {
  ledgerStore = value;
}

export function _setSafeDirectoryGitRunnerForTests(value: GitConfigRunner | null): void {
  gitConfigRunner = value ?? runGitConfig;
}

export function _setGlobalConfigWriteOriginProviderForTests(
  value: GlobalConfigWriteOriginProvider | null,
): void {
  globalConfigWriteOriginProvider = value ?? resolveGlobalConfigWriteOrigin;
}

export function _setSafeDirectoryHomePathProviderForTests(value: (() => string) | null): void {
  homePathProvider = value ?? (() => app.getPath('home'));
}

export function _setActiveWorktreesProviderForTests(
  value: (() => readonly WorktreeMeta[]) | null,
): void {
  activeWorktreesProvider = value ?? (() => worktreeStore.getAll());
}

export function _setLiveSessionPathKeysProviderForTests(
  value: (() => Promise<LiveSessionPathKeys>) | null,
): void {
  liveSessionPathKeysProvider = value ?? loadCurrentLiveSessionPathKeys;
}

export function _setSafeDirectoryCrossProcessLockRunnerForTests(
  value: CrossProcessLockRunner | null,
): void {
  crossProcessLockRunner = value ?? withSecurityBoundaryLock;
}

export function _setSafeDirectoryProfilePathProviderForTests(value: (() => string) | null): void {
  currentProfilePathProvider = value ?? (() => app.getPath('userData'));
}

export function _setSafeDirectoryProcessProvidersForTests(
  processId: (() => number) | null,
  liveness: ((processId: number) => ProcessLiveness) | null,
): void {
  currentProcessIdProvider = processId ?? (() => process.pid);
  processLivenessProvider = liveness ?? probeProcessLiveness;
}

export function _resetSafeDirectoryStateForTests(): void {
  ledgerStore = null;
  gitConfigRunner = runGitConfig;
  activeWorktreesProvider = () => worktreeStore.getAll();
  sessionRuntimeAliveProvider = null;
  liveSessionPathKeysProvider = loadCurrentLiveSessionPathKeys;
  crossProcessLockRunner = withSecurityBoundaryLock;
  sharedStateRootProvider = () => resolveSafeDirectorySharedStateRoot(app.getPath('appData'));
  currentProfilePathProvider = () => app.getPath('userData');
  currentProcessIdProvider = () => process.pid;
  processLivenessProvider = probeProcessLiveness;
  globalConfigWriteOriginProvider = resolveGlobalConfigWriteOrigin;
  homePathProvider = () => app.getPath('home');
  operationTail = Promise.resolve();
  inflightRetentionRoots.clear();
  publishedUsagePaths.clear();
  inflightRetentionGeneration = 0;
}
