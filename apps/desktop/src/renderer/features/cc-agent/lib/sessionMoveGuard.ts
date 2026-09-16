/**
 * 会话移动守卫:worktree 会话的工作区边界就是它自己的 worktree。
 *
 * 「移动到项目 / 选择项目文件夹」只改 `sessions.working_dir`,而会话绑定的 worktree
 * (目录、分支、store 归属与回收义务)不会跟着走:一旦允许改到别处,侧栏按新项目归组,
 * 聊天框底部路径、Git 上下文与 worktree 徽标却仍指旧 worktree,形成「半移动」。
 * 完整的 worktree → Local Handoff 是独立特性(#2190 / #2585,需显式处置未提交改动),
 * 在它落地前 GUI 与 Main(`updateSessionInDb`)同口径拒绝。
 *
 * 判据只认 **Cindy 托管 worktree**(`.cindy-worktrees` / `.xdt-worktrees`)——用户自建的
 * `.worktrees` 不在 Cindy 生命周期内,移动它不构成归属分裂。
 *
 * 比的是**归属根**,不是前缀:同一 worktree 根内的目录调整(`<wt>/src` → `<wt>/tests`)
 * 在共享写路径里本来就允许,GUI 预检不得更严——规则以 Main 的 `managedWorktreeRoot`
 * 为准,这里的纯字符串版本只求口径一致。
 */

import { managedWorktreeBaseRepo } from '@cindy/maker-shared/worktree-paths';

import { workingDirEquals } from '../../../../shared/workingDir';

/** renderer 里判断宿主平台:优先问 bridge,单测(node 环境)回落 `process`。 */
function isWindowsHost(): boolean {
  const bridged = (globalThis as { electronAPI?: { platform?: string } }).electronAPI?.platform;
  if (typeof bridged === 'string') return bridged === 'win32';
  return typeof process !== 'undefined' && process.platform === 'win32';
}

/** 反斜杠是否算分隔符:只有盘符路径(`C:\`)与反斜杠 UNC(`\\server\share`)才算。 */
function usesBackslashSeparator(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/**
 * 纯字符串版的 Main `managedWorktreeRoot`:返回 `<base>/<容器>/<worktree 名>`,worktree
 * 内的子目录一律归到该根;不是托管 worktree 路径时返回 null。不碰文件系统。
 */
export function managedWorktreeRootOf(value: string | null | undefined): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const base = managedWorktreeBaseRepo(value);
  if (base === null) return null;
  const allowBackslash = usesBackslashSeparator(value);
  const segments: Array<{ start: number; end: number }> = [];
  let segmentStart = -1;
  // base 是原串的前缀(共享模块按下标切片),从 base 末尾开始取前两段:
  // 容器目录 + worktree 名;再深的子目录不影响根。
  for (let i = base.length; i <= value.length && segments.length < 2; i += 1) {
    const atEnd = i === value.length;
    const isSeparator = !atEnd && (value[i] === '/' || (allowBackslash && value[i] === '\\'));
    if (!atEnd && !isSeparator) {
      if (segmentStart < 0) segmentStart = i;
      continue;
    }
    if (segmentStart >= 0) {
      segments.push({ start: segmentStart, end: i });
      segmentStart = -1;
    }
  }
  if (segments.length < 2) return null;
  return value.slice(0, segments[1].end);
}

/**
 * 该会话改到某个**已解析出的项目目录**时，是否跨出了它的 worktree 归属。
 *
 * 第一个参数是会话**当前活着的 worktree 绑定路径**（renderer 侧取自
 * WorktreeContext 的 store 镜像，与 main 的 worktreeStore 同源），不是当前 cwd ——
 * worktree 已被回收的会话会留着历史 worktree 路径，拿 cwd 当归属会把它永久拦死；
 * 存量半移动行则相反（cwd 在普通项目、绑定仍在旧 worktree），必须按绑定拦。
 *
 * 只对具体目录比较，不看 target 种类——调用方必须在目标目录确定之后调用
 * (browseProject 要等选完目录)；目标目录为空的情形(尤其是「移到对话」)
 * 根本不改 workingDir，不要拿到这里。
 */
export function crossesWorktreeBoundary(
  boundWorktreePath: string | null | undefined,
  targetWorkingDir: string,
): boolean {
  const ownedRoot = managedWorktreeRootOf(boundWorktreePath);
  if (ownedRoot === null) return false;
  const targetRoot = managedWorktreeRootOf(targetWorkingDir);
  // 比的是同一物理目录:分隔符风格(目录选择器给 `\`、库里存 `/`)与 Windows 盘符/
  // UNC 大小写差异都不算跨根,比较口径与 Main 的守卫一致。
  return targetRoot === null || !workingDirEquals(ownedRoot, targetRoot, { windows: isWindowsHost() });
}

/**
 * 移动预检的最终判定：缓存说要拦时，再向 main 复核一次活绑定。
 *
 * renderer 的绑定表是 main store 的异步镜像（回收后由 `worktree:changed` 触发刷新），
 * 事件落地的间隙里缓存可能还持有已回收的绑定 —— 直接拦会把 Main 本会放行的移动挡在
 * 请求之前。所以只在「缓存判定为拦」时多花一次查询，用复核结果定论（复核也拦才弹
 * toast；复核无绑定则放行，由共享写路径做最终权威判定）。
 */
export async function shouldBlockWorktreeMove(
  cachedBoundWorktreePath: string | null | undefined,
  targetWorkingDir: string,
  revalidateBinding: () => Promise<string | null>,
): Promise<boolean> {
  if (!crossesWorktreeBoundary(cachedBoundWorktreePath, targetWorkingDir)) return false;
  return crossesWorktreeBoundary(await revalidateBinding(), targetWorkingDir);
}
