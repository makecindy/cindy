/**
 * 不可信目录里单个文件的安全读取:以**同一个文件句柄**完成
 * "拒符号链接 → 校验普通文件与大小 → 限量读取"。
 *
 * 动机(自定义插件市场):ghost.json 位于用户可写的市场目录,"先检查、再按路
 * 径读"是两次独立打开,并发方能在两次之间把它换成超大文件或指向 /dev/zero 的
 * 符号链接。这里检查与读取都作用于已打开的 inode,路径再被替换也影响不到。
 * 发现、安装、打包三条链路必须共用本工具,任何一条按路径裸读都会重开缺口。
 */
import fs from 'node:fs';

/**
 * 身份卡(ghost.json)体量上限。合法身份卡远小于此;超限视为非法内容,
 * 发现层跳过、安装/打包层结构化拒绝。
 */
export const GHOST_MANIFEST_MAX_BYTES = 512 * 1024;

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
    const buffer = Buffer.alloc(Number(stat.size));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
