/**
 * 插件市场来源身份用到的两个小型本机文件（来源标识密钥、取包记录）的异步读写。
 *
 * 两者都会在市场列表、详情、远程目录这些 IPC 读路径上被读到，所以一律走异步 I/O，不阻塞主线程。
 * 两者都可重建：写失败或读不到只让来源身份缺省，不影响插件可用性，因此不需要 atomicWriteFileSync 那套
 * `.bak` 备份交换；这里只保证「要么是旧内容，要么是完整的新内容」。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 同目录 0600 临时文件（排他创建）+ rename 落位。`createDir` 为 false 时目录必须已存在（例如只往已有的
 * `.git/` 里写，不替调用方造出目录）。失败时抛错，临时文件总会清掉。
 */
export async function writePrivateFileAtomic(
  file: string,
  contents: string,
  options: { createDir: boolean },
): Promise<void> {
  if (options.createDir) await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temp, contents, { mode: 0o600, flag: 'wx' });
    await fs.promises.rename(temp, file);
  } finally {
    await fs.promises.rm(temp, { force: true }).catch(() => undefined);
  }
}

/**
 * 读一个普通文件的文本。不存在返回 'missing'；存在但不是普通文件或读不到（文件锁、权限、瞬时 I/O）
 * 返回 'unreadable'，调用方不能把它当成缺失去覆盖。
 */
export async function readPrivateFile(file: string): Promise<{ text: string } | 'missing' | 'unreadable'> {
  try {
    if (!(await fs.promises.lstat(file)).isFile()) return 'unreadable';
    return { text: await fs.promises.readFile(file, 'utf8') };
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/** 目录是否存在（异步）。 */
export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
