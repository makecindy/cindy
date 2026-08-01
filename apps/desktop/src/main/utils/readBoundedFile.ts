/**
 * 不可信目录里单个文件的安全读取:以**同一个文件句柄**完成
 * "拒符号链接 → 校验普通文件与大小 → 限量读取"。
 *
 * 动机(自定义插件市场):ghost.json 等文件位于用户可写的市场目录,"先检查、
 * 再按路径读"是两次独立打开,并发方能在两次之间把它换成超大文件或指向
 * /dev/zero 的符号链接。这里检查与读取都作用于已打开的 inode,路径再被替换
 * 也影响不到。发现、安装、打包(含 zip 逐文件、SKILL.md、locale 校验)所有
 * 触及不可信目录的读取都必须共用本工具,任何一处按路径裸读都会重开缺口。
 */
import fs from 'node:fs';

/**
 * 身份卡(ghost.json)体量上限。合法身份卡远小于此;超限视为非法内容,
 * 发现层跳过、安装/打包层结构化拒绝。
 */
export const GHOST_MANIFEST_MAX_BYTES = 512 * 1024;

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

/**
 * 读取一个"必须是普通文件"的文件,拒绝符号链接,限量读取。
 *
 * - 非普通文件 / 超过 maxBytes / 符号链接校验不过 → 返回 null;
 * - open 失败(含 O_NOFOLLOW 平台对 symlink 的 ELOOP 拒绝、ENOENT)→ 抛出,
 *   由调用方决定语义。
 *
 * Windows 没有 O_NOFOLLOW(open 会跟随链接),回退为:open 之后 lstat 路径,
 * 链接一律拒;再比对 lstat 与句柄 stat 的 dev/ino,确认路径上的目录项就是已
 * 打开的 inode,堵"open 之后换文件"的窗口。语义与 POSIX 侧一致:该文件不允许
 * 是符号链接,无论目标指向哪里。
 *
 * @param noFollowFlag 仅供测试注入:传 null 模拟无 O_NOFOLLOW 的平台。
 */
export async function readBoundedFileNoFollow(
  filePath: string,
  maxBytes: number,
  noFollowFlag?: number | null,
): Promise<Buffer | null> {
  const noFollow =
    noFollowFlag !== undefined ? noFollowFlag : (fs.constants.O_NOFOLLOW ?? null);
  const handle = await fs.promises.open(
    filePath,
    fs.constants.O_RDONLY | (noFollow ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    if (noFollow === null) {
      let linkStat: fs.Stats;
      try {
        linkStat = await fs.promises.lstat(filePath);
      } catch {
        // 路径条目已消失,无从证明句柄对应目录项 → 按不可信拒绝。
        return null;
      }
      if (linkStat.isSymbolicLink()) return null;
      if (linkStat.dev !== stat.dev || linkStat.ino !== stat.ino) return null;
    }
    return await readToLength(handle, Number(stat.size));
  } finally {
    await handle.close();
  }
}

/**
 * 跟随符号链接的变体:仅供"路径已经是 realpath 产物、链接目标已被根包含校验
 * 管住"的调用方使用(市场清单 marketplace.json)。类型与大小闸、读满循环与
 * 主变体一致。
 */
export async function readBoundedFileFollowLinks(
  filePath: string,
  maxBytes: number,
): Promise<Buffer | null> {
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return await readToLength(handle, Number(stat.size));
  } finally {
    await handle.close();
  }
}

/**
 * 同步变体,语义与 readBoundedFileNoFollow 完全一致(拒链接、限量、读满)。
 * 供无法转异步的同步校验链路(目录 locale 校验)使用。
 *
 * @param noFollowFlag 仅供测试注入:传 null 模拟无 O_NOFOLLOW 的平台。
 */
export function readBoundedFileNoFollowSync(
  filePath: string,
  maxBytes: number,
  noFollowFlag?: number | null,
): Buffer | null {
  const noFollow =
    noFollowFlag !== undefined ? noFollowFlag : (fs.constants.O_NOFOLLOW ?? null);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (noFollow ?? 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    if (noFollow === null) {
      let linkStat: fs.Stats;
      try {
        linkStat = fs.lstatSync(filePath);
      } catch {
        return null;
      }
      if (linkStat.isSymbolicLink()) return null;
      if (linkStat.dev !== stat.dev || linkStat.ino !== stat.ino) return null;
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
