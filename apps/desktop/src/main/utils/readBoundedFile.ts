/**
 * 不可信目录里单个文件的安全读取:以**同一个文件句柄**完成
 * "拒符号链接 → 校验普通文件与大小 → (可选)根内复核 → 限量读取"。
 *
 * 动机(自定义插件市场):ghost.json 等文件位于用户可写的市场目录,"先检查、
 * 再按路径读"是两次独立打开,并发方能在两次之间把它换成超大文件或指向
 * /dev/zero 的符号链接。这里检查与读取都作用于已打开的 inode,路径再被替换
 * 也影响不到。发现、安装、打包(含 zip 逐文件、SKILL.md、locale 校验)所有
 * 触及不可信目录的读取都必须共用本工具,任何一处按路径裸读都会重开缺口。
 *
 * containWithin 堵的是**中间目录**被换成符号链接的窗口:O_NOFOLLOW 只管最后
 * 一个路径分量,realpath 校验后、open 之前,路径上的某个父目录可被换成指向
 * 根外的链接。open 之后复核"路径此刻仍解析到已打开的 inode(stat dev/ino 与
 * 句柄一致)且 realpath 落在根内"——两个条件同时成立时,句柄对应的就是根内
 * 文件;换链接(realpath 出根)与换回去(inode 不再一致)都会被拒。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * 身份卡(ghost.json)体量上限。合法身份卡远小于此;超限视为非法内容,
 * 发现层跳过、安装/打包层结构化拒绝。
 */
export const GHOST_MANIFEST_MAX_BYTES = 512 * 1024;

export interface ReadBoundedFileOptions {
  /** 仅供测试注入:传 null 模拟无 O_NOFOLLOW 的平台。 */
  noFollowFlag?: number | null;
  /**
   * 已 realpath 的根目录。传入时在 open 之后复核:路径此刻 stat 的 dev/ino
   * 与句柄一致,且 realpath(filePath) 落在该根内;任一不成立返回 null。
   */
  containWithin?: string;
}

/** realpath 产物是否落在同为 realpath 产物的根内(含根本身)。 */
function isWithinRoot(realFilePath: string, realRoot: string): boolean {
  if (realFilePath === realRoot) return true;
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  return realFilePath.startsWith(rootWithSep);
}

/**
 * 路径上的目录项与已打开句柄是否同一 inode。**必须用 BigInt**:
 * NTFS 的 FileId 高位在长期使用的卷上会超过 2^53,number 截断可能让两个不同
 * 文件比相等(误放行)。dev/ino 任一为 0 表示文件系统没提供可信标识(SMB /
 * 网络重定向器 / 部分 FUSE 常见)——此时无法证明"路径仍解析到这个 inode",
 * 一律按不可信拒绝,不让回退闸退化成只剩 isSymbolicLink 一条。
 */
function sameInode(a: fs.BigIntStats, b: fs.BigIntStats): boolean {
  if (a.dev === 0n || a.ino === 0n || b.dev === 0n || b.ino === 0n) return false;
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * 在已打开句柄上循环读满已校验的长度。网络盘/FUSE 上单次 read() 不保证填满
 * 请求区间,单次读会把合法文件截断成解析失败。EOF 早于已校验长度(并发截断)
 * 时按实际读到的字节返回,交由上层解析/校验自然拒绝。
 */
async function readToLength(
  handle: fs.promises.FileHandle,
  size: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

/** open 之后的根内复核(异步侧),失败一律按不可信拒绝。 */
async function verifyStillWithinRoot(
  handleStat: fs.BigIntStats,
  filePath: string,
  realRoot: string,
): Promise<boolean> {
  try {
    const [pathStat, realFilePath] = await Promise.all([
      fs.promises.stat(filePath, { bigint: true }),
      fs.promises.realpath(filePath),
    ]);
    if (!sameInode(pathStat, handleStat)) return false;
    return isWithinRoot(realFilePath, realRoot);
  } catch {
    return false;
  }
}

/**
 * 读取一个"必须是普通文件"的文件,拒绝符号链接,限量读取。
 *
 * - 非普通文件 / 超过 maxBytes / 符号链接或根内复核不过 → 返回 null;
 * - open 失败(含 O_NOFOLLOW 平台对 symlink 的 ELOOP 拒绝、ENOENT)→ 抛出,
 *   由调用方决定语义。
 *
 * Windows 没有 O_NOFOLLOW(open 会跟随链接),回退为:open 之后 lstat 路径,
 * 链接一律拒;再比对 lstat 与句柄 stat 的 dev/ino,确认路径上的目录项就是已
 * 打开的 inode,堵"open 之后换文件"的窗口。语义与 POSIX 侧一致:该文件不允许
 * 是符号链接,无论目标指向哪里。
 */
export async function readBoundedFileNoFollow(
  filePath: string,
  maxBytes: number,
  options?: ReadBoundedFileOptions,
): Promise<Buffer | null> {
  const noFollow =
    options?.noFollowFlag !== undefined
      ? options.noFollowFlag
      : (fs.constants.O_NOFOLLOW ?? null);
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (noFollow ?? 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) > maxBytes) return null;
    if (noFollow === null) {
      let linkStat: fs.BigIntStats;
      try {
        linkStat = await fs.promises.lstat(filePath, { bigint: true });
      } catch {
        // 路径条目已消失,无从证明句柄对应目录项 → 按不可信拒绝。
        return null;
      }
      if (linkStat.isSymbolicLink()) return null;
      if (!sameInode(linkStat, stat)) return null;
    }
    if (options?.containWithin !== undefined) {
      if (!(await verifyStillWithinRoot(stat, filePath, options.containWithin))) return null;
    }
    return await readToLength(handle, Number(stat.size));
  } finally {
    await handle.close();
  }
}

/**
 * 跟随符号链接的变体:仅供"路径已经是 realpath 产物、链接目标已被根包含校验
 * 管住"的调用方使用(市场清单 marketplace.json)。类型与大小闸、根内复核、
 * 读满循环与主变体一致。
 */
export async function readBoundedFileFollowLinks(
  filePath: string,
  maxBytes: number,
  options?: Pick<ReadBoundedFileOptions, 'containWithin'>,
): Promise<Buffer | null> {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || Number(stat.size) > maxBytes) return null;
    if (options?.containWithin !== undefined) {
      if (!(await verifyStillWithinRoot(stat, filePath, options.containWithin))) return null;
    }
    return await readToLength(handle, Number(stat.size));
  } finally {
    await handle.close();
  }
}

/**
 * 同步变体,语义与 readBoundedFileNoFollow 完全一致(拒链接、限量、根内复核、
 * 读满)。供无法转异步的同步校验链路(目录 locale 校验、已装插件摘要)使用。
 */
export function readBoundedFileNoFollowSync(
  filePath: string,
  maxBytes: number,
  options?: ReadBoundedFileOptions,
): Buffer | null {
  const noFollow =
    options?.noFollowFlag !== undefined
      ? options.noFollowFlag
      : (fs.constants.O_NOFOLLOW ?? null);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (noFollow ?? 0));
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || Number(stat.size) > maxBytes) return null;
    if (noFollow === null) {
      let linkStat: fs.BigIntStats;
      try {
        linkStat = fs.lstatSync(filePath, { bigint: true });
      } catch {
        return null;
      }
      if (linkStat.isSymbolicLink()) return null;
      if (!sameInode(linkStat, stat)) return null;
    }
    if (options?.containWithin !== undefined) {
      try {
        const pathStat = fs.statSync(filePath, { bigint: true });
        const realFilePath = fs.realpathSync(filePath);
        if (!sameInode(pathStat, stat)) return null;
        if (!isWithinRoot(realFilePath, options.containWithin)) return null;
      } catch {
        return null;
      }
    }
    const size = Number(stat.size);
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = fs.readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}
