/**
 * libraryLegacyReattach.ts — 把裸 id 下遗留的旧作品库换回当前实例。
 * ---------------------------------------------------------------------------
 * namespace 实例键上线后，旧安装卸载再从企业市场重装，会得到新实例键和一个
 * 新的空库，旧库留在裸 id 下没人认领。用户在设置页确认后，这里只换作品库，
 * 插件安装、设置与私有数据都不动：
 *
 *   1. 当前实例的新库（及暂存区）移入作品库回收站（保留 30 天）；
 *   2. 旧库改名到当前实例键（自定义位置由 binding store 搬，它自带日志）；
 *   3. 改旧库与暂存区里记录的身份。
 *
 * 换库期间插件进程停掉、面板卸下，并清掉插件分区的缓存，换完再恢复
 * （withPluginHeldForLibrarySwap）。
 *
 * 动手前先写日志，每一步都可以重跑：中途崩溃后，下次打开作品库前按日志做完。
 * 纯 Node + 依赖注入，单测拿 tmpdir 直测。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isLibraryOwnerId, syncDirectory } from './libraryBinding.js';

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export interface LegacyLibraryReattachJournal {
  version: 1;
  /** 旧库所在的裸 id。 */
  fromId: string;
  /** 当前实例键。 */
  toId: string;
  oldLocation: 'default' | 'custom';
  /** 动手前当前实例新库的目录身份；只有身份仍一致的目录才会被移入回收站。 */
  newLibrary: DirectoryIdentity | null;
  newStaging: DirectoryIdentity | null;
  trashName: string;
}

export interface LegacyLibraryReattachDeps {
  journalFile(): string;
  defaultRoot(id: string): string;
  stagingRoot(id: string): string;
  trashRoot(): string;
  /** 自定义位置：把 binding 与目录一起从 fromId 搬到 toId（重跑时无记录即返回）。 */
  relocateCustomBinding(fromId: string, toId: string): Promise<void>;
  /** 自定义位置：搬之前确认 toId 没有 binding、自定义父目录下也没有同名目录。 */
  assertCustomBindingRelocatable(fromId: string, toId: string): Promise<void>;
  /** 自定义位置下 toId 的库根；没有 binding 时返回 null。 */
  customRoot(id: string): Promise<string | null>;
  relocateMeta(root: string, fromId: string, toId: string): Promise<void>;
  relocateStaging(root: string, fromId: string, toId: string): Promise<void>;
  assertCurrent(): void;
  /** 把目录项刷到磁盘；目录不存在时跳过。测试可注入以检查顺序。 */
  syncDirectory?(dir: string): Promise<void>;
}

async function syncDirectoryIfPresent(dir: string): Promise<void> {
  try {
    await syncDirectory(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function directoryIdentity(dir: string): Promise<DirectoryIdentity | null> {
  try {
    const stat = await fs.promises.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`not a real directory: ${dir}`);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isIdentity(value: unknown): value is DirectoryIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DirectoryIdentity>;
  return typeof identity.dev === 'number' && typeof identity.ino === 'number';
}

function isJournal(value: unknown): value is LegacyLibraryReattachJournal {
  if (!value || typeof value !== 'object') return false;
  const journal = value as Partial<LegacyLibraryReattachJournal>;
  return journal.version === 1 &&
    isLibraryOwnerId(journal.fromId) && isLibraryOwnerId(journal.toId) &&
    journal.fromId !== journal.toId &&
    (journal.oldLocation === 'default' || journal.oldLocation === 'custom') &&
    (journal.newLibrary === null || isIdentity(journal.newLibrary)) &&
    (journal.newStaging === null || isIdentity(journal.newStaging)) &&
    typeof journal.trashName === 'string' && /^[A-Za-z0-9_.-]+$/.test(journal.trashName) &&
    journal.trashName !== '.' && journal.trashName !== '..';
}

export async function readLegacyLibraryReattachJournal(
  file: string,
): Promise<LegacyLibraryReattachJournal | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isJournal(parsed)) throw new Error('library reattach journal is invalid');
  return parsed;
}

async function writeJournal(file: string, journal: LegacyLibraryReattachJournal): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, file);
  // The journal entry must be on disk before any library moves.
  await syncDirectory(path.dirname(file));
}

async function assertCustomLibraryRelocatable(root: string | null): Promise<void> {
  if (root === null) throw new Error('old custom library root is unavailable');
  // The binding store moves a custom library by the identity of the library
  // and its parent. A volume without inode numbers cannot be moved, so stop
  // before anything changes.
  for (const dir of [path.dirname(root), root]) {
    const stat = await fs.promises.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0) {
      throw new Error('old custom library cannot be moved on this volume');
    }
  }
}

/** 记下要换的两边，然后执行。日志已存在时拒绝开始新的一次。 */
export async function startLegacyLibraryReattach(
  input: { fromId: string; toId: string; oldLocation: 'default' | 'custom'; now: number },
  deps: LegacyLibraryReattachDeps,
): Promise<void> {
  if (await readLegacyLibraryReattachJournal(deps.journalFile())) {
    throw new Error('another library reattach is unfinished');
  }
  deps.assertCurrent();
  if (input.oldLocation === 'custom') {
    await assertCustomLibraryRelocatable(await deps.customRoot(input.fromId));
    await deps.assertCustomBindingRelocatable(input.fromId, input.toId);
  }
  deps.assertCurrent();
  const journal: LegacyLibraryReattachJournal = {
    version: 1,
    fromId: input.fromId,
    toId: input.toId,
    oldLocation: input.oldLocation,
    newLibrary: await directoryIdentity(deps.defaultRoot(input.toId)),
    newStaging: await directoryIdentity(deps.stagingRoot(input.toId)),
    trashName: `${input.toId}-${input.now}-replaced`,
  };
  deps.assertCurrent();
  await writeJournal(deps.journalFile(), journal);
  await finishLegacyLibraryReattach(journal, deps);
}

/**
 * 只把仍是那个新库的目录移入回收站；已移走或换成别的目录都不动。回收站里已有
 * 目标就算这步做完——不提供 inode 的卷上（ino 为 0）目录身份分不出新旧库。
 */
async function trashIfSame(dir: string, identity: DirectoryIdentity | null, target: string): Promise<void> {
  if (identity === null) return;
  if (await directoryIdentity(target) !== null) return;
  if (!isDeepStrictEqual(await directoryIdentity(dir), identity)) return;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.rename(dir, target);
}

async function moveIfFree(fromDir: string, toDir: string): Promise<void> {
  if (await directoryIdentity(fromDir) === null) return;
  if (await directoryIdentity(toDir) !== null) {
    throw new Error(`library reattach destination already exists: ${toDir}`);
  }
  await fs.promises.rename(fromDir, toDir);
}

/** 按日志做完剩下的步骤；每一步重跑都安全。 */
export async function finishLegacyLibraryReattach(
  journal: LegacyLibraryReattachJournal,
  deps: LegacyLibraryReattachDeps,
): Promise<void> {
  const { fromId, toId } = journal;
  // Paths are owner scoped. Pin this account's journal so a switch midway
  // cannot make the final removal hit another account's journal.
  const journalFile = deps.journalFile();
  const trash = path.join(deps.trashRoot(), journal.trashName);
  deps.assertCurrent();
  await trashIfSame(deps.defaultRoot(toId), journal.newLibrary, trash);
  deps.assertCurrent();
  await trashIfSame(deps.stagingRoot(toId), journal.newStaging, `${trash}-staging`);
  deps.assertCurrent();
  if (journal.oldLocation === 'custom') {
    await deps.relocateCustomBinding(fromId, toId);
  } else {
    await moveIfFree(deps.defaultRoot(fromId), deps.defaultRoot(toId));
  }
  deps.assertCurrent();
  await moveIfFree(deps.stagingRoot(fromId), deps.stagingRoot(toId));
  deps.assertCurrent();
  const root = journal.oldLocation === 'custom' ? await deps.customRoot(toId) : deps.defaultRoot(toId);
  if (root === null) throw new Error('reattached custom library root is unavailable');
  await deps.relocateMeta(root, fromId, toId);
  deps.assertCurrent();
  await deps.relocateStaging(deps.stagingRoot(toId), fromId, toId);
  deps.assertCurrent();
  // Every rename and identity rewrite above must be on disk before the journal
  // goes; otherwise a crash could leave the moves half applied with nothing to
  // finish them from.
  const sync = deps.syncDirectory ?? syncDirectoryIfPresent;
  for (const dir of new Set([
    deps.trashRoot(),
    path.dirname(deps.defaultRoot(toId)),
    path.dirname(deps.stagingRoot(toId)),
    path.join(root, '.cindy-library'),
    path.join(deps.stagingRoot(toId), '.cindy-library'),
  ])) {
    await sync(dir);
  }
  deps.assertCurrent();
  await fs.promises.rm(journalFile, { force: true });
  await sync(path.dirname(journalFile));
}

/**
 * A library copied in without host identity (no `.cindy-library/meta.json`)
 * gets the new owner written in; one that has an identity is relocated as
 * usual. Safe to run again: a stop after the folder was made but before the
 * identity landed still finds no meta.json, and a written identity already
 * names the new owner.
 */
export async function relocateOrAdoptLibraryMeta(
  root: string,
  fromId: string,
  toId: string,
  relocate: (root: string, fromId: string, toId: string) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  const hostDir = path.join(root, '.cindy-library');
  const metaFile = path.join(hostDir, 'meta.json');
  const hasMeta = await fs.promises.lstat(metaFile).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (await directoryIdentity(root) === null || hasMeta) {
    await relocate(root, fromId, toId);
    return;
  }
  await fs.promises.mkdir(hostDir, { recursive: true });
  const temporary = `${metaFile}.${randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, ghostId: toId, createdAt: now }), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, metaFile);
  await syncDirectory(hostDir);
}

export interface PluginHoldForLibrarySwapDeps {
  /** 停掉插件运行进程，返回停之前在跑的运行时，供换完后按原样恢复。 */
  stopRuntime(): Promise<{ browser: boolean; node: boolean }>;
  /** 通知各窗口里这个插件的面板：start = 先卸下，done = 从磁盘重新挂上。 */
  notifyPanels(phase: 'start' | 'done'): void;
  /**
   * 关掉这个实例分区里仍开着的页面，等它们真正销毁。面板与后台页之间走同源
   * BroadcastChannel，Main 不在中间，只能把旧页关掉，不能只靠 notifyPanels。
   */
  closePages(): Promise<void>;
  holdLibraries(on: boolean): void;
  disposeLibraries(): Promise<void>;
  /**
   * 清掉这个实例的 Electron 分区存储。分区只在内存里，面板和后台进程都用它；
   * 不清的话，插件会拿换库前的缓存覆盖刚换上来的库。
   */
  clearPartitionStorage(): Promise<void>;
  restartRuntime(running: { browser: boolean; node: boolean }): void;
  warn(message: string, error: unknown): void;
}

/** 换库后旧缓存清不掉：插件保持停止、作品库保持拦截，重启 Cindy 后分区自然清空。 */
export class LibrarySwapNeedsRestartError extends Error {
  constructor(cause: unknown) {
    super('plugin cache could not be cleared after the library swap', { cause });
  }
}

/** 关掉旧页、清掉分区；失败再试一次。返回是否清干净。 */
async function clearStalePluginState(deps: PluginHoldForLibrarySwapDeps): Promise<unknown> {
  let failure: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.closePages();
      await deps.clearPartitionStorage();
      return null;
    } catch (error) {
      failure = error;
      deps.warn('plugin partition storage clear failed after library swap', error);
    }
  }
  return failure ?? new Error('plugin cache clear failed');
}

/**
 * 换库期间插件不能运行、面板不能挂着：进程与面板都可能把旧库的状态写回来。
 * 顺序：停进程、卸面板并关掉旧页 → 换库 → 再关一次旧页、清分区（此时没人在用）
 * → 放行作品库 → 重启进程、挂回面板。清不掉就停在拦截状态，报需要重启。
 */
export async function withPluginHeldForLibrarySwap<T>(
  deps: PluginHoldForLibrarySwapDeps,
  run: () => Promise<T>,
): Promise<T> {
  const running = await deps.stopRuntime();
  deps.notifyPanels('start');
  deps.holdLibraries(true);
  let result: T;
  try {
    await deps.closePages();
    await deps.disposeLibraries();
    result = await run();
  } catch (error) {
    const failure = await clearStalePluginState(deps);
    if (failure !== null) throw new LibrarySwapNeedsRestartError(failure);
    release(deps, running);
    throw error;
  }
  const failure = await clearStalePluginState(deps);
  if (failure !== null) throw new LibrarySwapNeedsRestartError(failure);
  release(deps, running);
  return result;
}

function release(deps: PluginHoldForLibrarySwapDeps, running: { browser: boolean; node: boolean }): void {
  deps.holdLibraries(false);
  deps.restartRuntime(running);
  deps.notifyPanels('done');
}
