/**
 * libraryTrash.ts — Library 删除通道(宿主级回收站,2026-08-20 定案)。
 * ---------------------------------------------------------------------------
 * 删除用户作品与卸载插件是**两个不同操作**:删除只从设置页独立确认入口进入,
 * 且不直接 rm——先 rename 进 owner 级 `libraries-trash/<ghostId>-<ts>/`
 * 保留 30 天回滚窗(对齐 recycler「先报数后动手」的 v1 哲学;到期清理由
 * 手动触发的维护动作执行,不做后台自动删除)。binding 一并撤销(数据已进
 * 回收站,原位置的自定义 binding 不再有意义)。
 *
 * 纯 Node + 依赖注入,单测拿 tmpdir 直测。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TrashGhostLibraryDeps {
  /** 目标库根绝对路径(调用方经 binding/默认根解析;drift 时传 null)。 */
  resolveLibraryRoot(ghostId: string): Promise<string | null>;
  /** 回收站基目录(生产 = ownerScopedUserDataPath('libraries-trash'))。 */
  trashRoot(): string;
  /** 撤销自定义位置 binding(无 binding 时为空操作)。 */
  removeBinding(ghostId: string): Promise<void>;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  now?(): number;
}

export type TrashGhostLibraryResult =
  | { ok: true; trashedPath: string }
  | { ok: false; errorCode: 'NOT_FOUND' | 'TRASH_NAME_TAKEN' | 'IO'; message: string };

/**
 * 把库根 rename 进回收站(同名冲突 = 返回错误,不覆盖——时间戳碰撞理论
 * 不可达,真发生时让调用方重试)。跨卷 rename 会退化为 copy+rm(fs.rename
 * 跨卷抛 EXDEV;自定义位置可能与回收站不同卷,这里显式回退)。
 */
export async function trashGhostLibrary(
  ghostId: string,
  deps: TrashGhostLibraryDeps,
): Promise<TrashGhostLibraryResult> {
  const root = await deps.resolveLibraryRoot(ghostId);
  if (root === null) {
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Library 根不可用(位置漂移或不存在);请先在设置中恢复位置' };
  }
  let exists = true;
  try {
    await fs.promises.stat(root);
  } catch {
    exists = false;
  }
  if (!exists) {
    // 根不存在:只剩 binding 要撤(数据可能已被用户手工搬走/删除)。
    await deps.removeBinding(ghostId);
    return { ok: false, errorCode: 'NOT_FOUND', message: 'Library 目录不存在(已撤销位置记录)' };
  }
  const stamp = deps.now?.() ?? Date.now();
  const trashedPath = path.join(deps.trashRoot(), `${ghostId}-${stamp}`);
  try {
    await fs.promises.mkdir(deps.trashRoot(), { recursive: true });
    try {
      await fs.promises.rename(root, trashedPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
      // 跨卷:copy 递归 → **逐项对账**(条数/字节)→ 才删源——不校验就 rm
      // 会让半份拷贝顶替原件(review:跨卷删源前先校验)。
      await copyDirRecursive(root, trashedPath);
      const before = await collectTreeStats(root);
      const after = await collectTreeStats(trashedPath);
      if (before.files !== after.files || before.bytes !== after.bytes) {
        throw new Error(`跨卷回收校验失败(${after.files}/${before.files} 文件,${after.bytes}/${before.bytes} 字节);原件保留未动`);
      }
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST' || (err as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
      return { ok: false, errorCode: 'TRASH_NAME_TAKEN', message: '回收站目标名冲突,请重试' };
    }
    return { ok: false, errorCode: 'IO', message: `移入回收站失败:${err instanceof Error ? err.message : String(err)}` };
  }
  await deps.removeBinding(ghostId);
  deps.log?.info('library trashed', { ghostId, trashedPath });
  return { ok: true, trashedPath };
}

/** 目录树统计(跨卷回收入库前的对账口径)。 */
async function collectTreeStats(root: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {
          /* 竞态,跳过 */
        }
      }
    }
  }
  return { files, bytes };
}

/** 递归复制(仅普通文件与目录;链接条目按链接复制,不穿透内容)。 */
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(from, to);
    } else if (entry.isSymbolicLink()) {
      const target = await fs.promises.readlink(from);
      await fs.promises.symlink(target, to).catch(() => {});
    } else if (entry.isFile()) {
      await fs.promises.copyFile(from, to);
    }
  }
}
