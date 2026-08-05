import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Windows 上 AV / 索引器 / 云同步会短暂占用刚落地的文件,rename 抛
 * EBUSY / EACCES,而不是 POSIX 直觉里的 EPERM / EEXIST。这些是瞬时锁,短退避
 * 重试即可解除;EPERM / EEXIST 属"无法覆盖已存在目标"的语义分歧,不在此列
 * (由调用方的备份交换兜底)。
 */
const TRANSIENT_RENAME_CODES = new Set(['EBUSY', 'EACCES', 'ENOTEMPTY']);

/** 同步小退避。状态文件都很小、重试上限低,阻塞时间可忽略。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** rename 遇瞬时锁短退避重试;EPERM/EEXIST 与其余错误立即上抛。 */
function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= 3 || !code || !TRANSIENT_RENAME_CODES.has(code)) throw error;
      sleepSync(20 * (attempt + 1));
    }
  }
}

/**
 * 尽力删除,绝不外抛。清理残留文件失败(AV 占用)不能掩盖一次**已经成功**的
 * 写入,也不能中断一次尚可继续的写入;残留由下次写入清掉。maxRetries 交给
 * libuv 处理 Windows 的 EBUSY/EPERM/ENOTEMPTY。
 */
function rmSyncQuiet(target: string): void {
  try {
    fs.rmSync(target, { force: true, maxRetries: 3, retryDelay: 20 });
  } catch {
    // 忽略:best-effort 清理。
  }
}

/**
 * 主文件缺失但 `.bak` 仍在、且无法恢复回来。
 *
 * 这种状态下磁盘上唯一的有效快照是那个 `.bak`,任何"按空数据继续"的行为都会把它
 * 永久丢掉(读成空 → 用空数据写入 → 主文件出现 → 下次写入把 .bak 当陈旧残留删掉)。
 * 因此读写两侧都必须 fail loud,把决定权交给上层而不是静默降级。
 */
export class AtomicBackupUnrecoverableError extends Error {
  readonly code = 'ATOMIC_BACKUP_UNRECOVERABLE' as const;

  constructor(readonly filePath: string, cause?: unknown) {
    super(`Cannot restore ${filePath} from its .bak backup`);
    this.name = 'AtomicBackupUnrecoverableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 是否为"备份无法恢复"错误(调用方据此避免降级成空数据)。 */
export function isAtomicBackupUnrecoverable(error: unknown): boolean {
  return error instanceof AtomicBackupUnrecoverableError;
}

/**
 * 主文件缺失且 `.bak` 在场时把备份恢复回主文件。
 *
 * 这是 Windows 备份交换失败后唯一的有效快照。恢复动作必须同时出现在读与写两侧:
 * 只放在写侧时,调用方会先把缺失的主文件读成空数据,再拿这份空数据发起写入 ——
 * 写入前恢复的备份随即被空快照覆盖,数据仍然永久丢失。
 *
 * 返回值必须区分"发现备份"与"恢复成功":恢复失败(Windows 文件锁/杀毒占用)时
 * 按 `restored` 处理会让读取方读成空、写入方拿空数据覆盖,唯一快照照样丢 ——
 * 所以这里抛 `AtomicBackupUnrecoverableError`,由两侧一致地拒绝继续。
 */
function restoreBackupIfMainMissing(filePath: string): 'restored' | 'not-needed' {
  const backupPath = `${filePath}.bak`;
  if (fs.existsSync(filePath) || !fs.existsSync(backupPath)) return 'not-needed';
  try {
    renameSyncWithRetry(backupPath, filePath);
  } catch (error) {
    throw new AtomicBackupUnrecoverableError(filePath, error);
  }
  return 'restored';
}

/**
 * 读取由 `atomicWriteFileSync` 维护的文件:主文件缺失时先从 `.bak` 恢复再读。
 * 文件确实不存在(`ENOENT`)返回 null,由调用方决定空值语义。
 *
 * **只有 ENOENT 才算"不存在"**,其余读取错误一律上抛:文件明明在,只是被
 * Windows 文件锁、权限或瞬时 I/O 挡住时若返回 null,调用方会解释成空状态,
 * 随后那次写入就用空状态派生的快照覆盖原文件,其余来源/安装记录永久丢失。
 *
 * `.bak` 在场但恢复不了时抛 `AtomicBackupUnrecoverableError` —— **不要**把它
 * 降级成 null:那等于把"有一份救得回来的数据"说成"没有数据",后续写入会清掉它。
 */
export function readAtomicFileSync(filePath: string): string | null {
  restoreBackupIfMainMissing(filePath);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * 可回滚的原子文件替换（main 进程本地 JSON 状态文件共用）。
 *
 * 常规路径是 temp 写入 + rename 原子替换。Windows 上 rename 无法覆盖已存在
 * 目标（EPERM/EEXIST），需要兜底；兜底若直接删目标再 rename，第二次 rename
 * 再失败（文件锁/杀毒/瞬时 I/O）会把旧文件与唯一临时副本都删掉，导致配置
 * 全丢。这里兜底改为备份交换：先把旧文件改名 .bak、再让 temp 落位、成功后
 * 删 .bak；任一步失败都从 .bak 恢复，.bak 残留由下次写入时清理。
 *
 * `.bak` 在场但恢复不了时**直接抛错、不写入**（`AtomicBackupUnrecoverableError`）：
 * 那时它是磁盘上唯一有效的快照，继续写入会让它先被忽略、再在下一次写入时当陈旧
 * 残留删掉。宁可这次写失败让上层看见，也不能把唯一副本换成派生自空数据的内容。
 */
export function atomicWriteFileSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  // 上次 temp 落位与恢复都失败时,主文件缺失、.bak 是唯一有效快照:
  // 先把它恢复回主文件,再写入,避免把缺失主文件读成空后覆盖唯一快照。
  // 主文件存在时,.bak 才是陈旧残留,直接清理。恢复不了则抛错,不写入。
  if (restoreBackupIfMainMissing(filePath) === 'not-needed') {
    rmSyncQuiet(backupPath);
  }
  try {
    fs.writeFileSync(tempPath, contents, { mode: 0o600, flag: 'wx' });
    try {
      // 主路径:rename 覆盖已存在目标(Windows/POSIX 均原子替换),瞬时锁重试。
      renameSyncWithRetry(tempPath, filePath);
      return;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      // 只有"无法覆盖已存在目标"(EPERM/EEXIST)才走备份交换;EBUSY/EACCES 已在
      // renameSyncWithRetry 里重试过,到这里仍失败就是真失败,直接上抛。
      if (code !== 'EPERM' && code !== 'EEXIST') {
        throw error;
      }
      // 兜底：备份交换而非直接删目标(两步 rename 都带瞬时锁重试)。
      renameSyncWithRetry(filePath, backupPath);
      try {
        renameSyncWithRetry(tempPath, filePath);
      } catch (swapError) {
        // temp 落位失败：从备份恢复旧文件，避免配置全丢。
        try {
          renameSyncWithRetry(backupPath, filePath);
        } catch {
          // 恢复也失败：.bak 仍在磁盘上,下次写入或启动时可人工/自愈找回。
        }
        throw swapError;
      }
      // 写入已成功;清 .bak 失败(AV 占用)不能反过来把成功报成失败。
      rmSyncQuiet(backupPath);
    }
  } finally {
    rmSyncQuiet(tempPath);
  }
}
