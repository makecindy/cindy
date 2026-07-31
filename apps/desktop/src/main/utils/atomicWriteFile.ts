import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 可回滚的原子文件替换（main 进程本地 JSON 状态文件共用）。
 *
 * 常规路径是 temp 写入 + rename 原子替换。Windows 上 rename 无法覆盖已存在
 * 目标（EPERM/EEXIST），需要兜底；兜底若直接删目标再 rename，第二次 rename
 * 再失败（文件锁/杀毒/瞬时 I/O）会把旧文件与唯一临时副本都删掉，导致配置
 * 全丢。这里兜底改为备份交换：先把旧文件改名 .bak、再让 temp 落位、成功后
 * 删 .bak；任一步失败都从 .bak 恢复，.bak 残留由下次写入时清理。
 */
export function atomicWriteFileSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  // 上次 temp 落位与恢复都失败时,主文件缺失、.bak 是唯一有效快照:
  // 先把它恢复回主文件,再写入,避免把缺失主文件读成空后覆盖唯一快照。
  // 主文件存在时,.bak 才是陈旧残留,直接清理。
  if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
    try {
      fs.renameSync(backupPath, filePath);
    } catch {
      // 恢复失败则仍保留 .bak,写入流程继续以当前磁盘状态为准。
    }
  } else {
    fs.rmSync(backupPath, { force: true });
  }
  try {
    fs.writeFileSync(tempPath, contents, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(tempPath, filePath);
      return;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EEXIST')) {
        throw error;
      }
      // Windows 兜底：备份交换而非直接删目标。
      fs.renameSync(filePath, backupPath);
      try {
        fs.renameSync(tempPath, filePath);
      } catch (swapError) {
        // temp 落位失败：从备份恢复旧文件，避免配置全丢。
        try {
          fs.renameSync(backupPath, filePath);
        } catch {
          // 恢复也失败：.bak 仍在磁盘上,下次写入或启动时可人工/自愈找回。
        }
        throw swapError;
      }
      fs.rmSync(backupPath, { force: true });
    }
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}
