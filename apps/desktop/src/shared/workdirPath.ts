/**
 * workdirPath — workdir 相对路径换算的纯字符串工具(renderer / main 共用)。
 * ---------------------------------------------------------------------------
 * 远程会话链路里「远端绝对路径 → workdir 相对 POSIX 路径」在多处需要:
 *   - main 的 chat-file 编排(fetch / stat 前算 relPath);
 *   - renderer 的目录 chip 点击(把目录定位进侧边栏文件浏览器需要 relPath)。
 * 单一实现避免两侧 Windows 归一 / `..` 拒绝 / `.` 段处理各自漂移。
 * 无 node:path 依赖,双环境可用;不触文件系统。
 */

import { isWindowsPathLike, stripWindowsLongPathPrefix } from './workingDir';

/** 去掉路径里的 `.` 段(`/w/./a` → `/w/a`):renderer 的 join 会保留 `./` 前缀,
 *  不归一会让缓存 identity / file-service relPath 出现同路径两形态。 */
export function dropDotSegments(p: string): string {
  const isAbs = p.startsWith('/');
  const segs = p.split('/').filter((s) => s !== '.' && s !== '');
  return (isAbs ? '/' : '') + segs.join('/');
}

/** POSIX:绝对路径 → workdir 相对路径;不在 workdir 内(含 workdir 自身)/
 *  `..` 逃逸 / 非绝对 → null。 */
export function toWorkdirRelPosix(workdir: string, absPath: string): string | null {
  if (!workdir.startsWith('/') || !absPath.startsWith('/')) return null;
  if (absPath.split('/').includes('..')) return null;
  const base = workdir.replace(/\/+$/, '');
  if (!absPath.startsWith(`${base}/`)) return null;
  const rel = absPath.slice(base.length + 1);
  return rel.length > 0 ? rel : null;
}

/**
 * Windows 风格路径归一(与工作目录入库同一判据:盘符、UNC `\\server` / `//server`、
 * 长路径前缀):分隔符统一为 `/`、去 `.` 段与尾分隔符,保留 UNC 前导 `//`。保留大小写,
 * 比较时由调用方忽略大小写。
 */
function normalizeWindowsPath(p: string): string {
  const s = stripWindowsLongPathPrefix(p).replace(/\\/g, '/');
  const segs = s.split('/').filter((x) => x !== '.' && x !== '');
  return (s.startsWith('//') ? '//' : '') + segs.join('/');
}

/**
 * 绝对路径 → workdir 相对路径(POSIX 分隔),不在 workdir 内(含 workdir 自身)/ `..`
 * 逃逸 / 风格不匹配 → null。Windows 风格(device 被控端,含 UNC 共享)按大小写不敏感
 * 比较,输出仍统一 POSIX 分隔(file-browser 全链路的 relPath 约定)。`.` 段一律归一掉。
 */
export function toWorkdirRel(workdir: string, absPath: string): string | null {
  if (!workdir || !absPath) return null;
  if (isWindowsPathLike(workdir)) {
    if (!isWindowsPathLike(absPath)) return null;
    const w = normalizeWindowsPath(workdir);
    const a = normalizeWindowsPath(absPath);
    if (a.split('/').includes('..')) return null;
    if (!a.toLowerCase().startsWith(`${w.toLowerCase()}/`)) return null;
    const rel = a.slice(w.length + 1);
    return rel.length > 0 ? rel : null;
  }
  if (workdir.startsWith('/')) return toWorkdirRelPosix(workdir, dropDotSegments(absPath));
  return null;
}

/** absPath 是否就是 workdir 本身(与 toWorkdirRel 同一套归一与风格判定)。 */
export function isWorkdirRoot(workdir: string, absPath: string): boolean {
  if (!workdir || !absPath) return false;
  if (isWindowsPathLike(workdir)) {
    return (
      isWindowsPathLike(absPath) &&
      normalizeWindowsPath(absPath).toLowerCase() === normalizeWindowsPath(workdir).toLowerCase()
    );
  }
  return (
    workdir.startsWith('/') &&
    absPath.startsWith('/') &&
    dropDotSegments(absPath) === dropDotSegments(workdir)
  );
}
