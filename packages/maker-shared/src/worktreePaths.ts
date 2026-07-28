/**
 * worktree 路径 → base repo 折叠:桌面与手机共享的唯一事实源。
 *
 * 会话跑在 worktree 里时,它的 workingDir 是 `<base repo>/<容器目录>/<worktree 名>`。
 * worktree 名是随机生成的(见 desktop `worktree/nameGenerator.ts`,docker 风格
 * `形容词-名人`),所以**按 workingDir 原值分组会把每个 worktree 变成一个独立「项目」,
 * 标题显示成 `serene-lovelace` 这类随机名**。项目分组与项目归属判断必须先折叠到 base
 * repo(`groupingWorktreeBaseRepo`,认全部四种容器目录);项目设置读写只对 Cindy 托管
 * worktree 折叠(`managedWorktreeBaseRepo`)——用户自建的 `.worktrees` /
 * `.claude/worktrees` 可能刻意带独立的 `.claude/settings.json`,继承 base repo 会覆盖
 * 掉它的意图。需要真正读写文件的路径一律用会话 workingDir 原值。
 *
 * 本模块只做纯字符串折叠(不碰文件系统),同时接受 `/` 与 `\` 分隔符,并保留输入的
 * 分隔符风格 —— 手机端的项目标题 / 副标题直接展示折叠结果,不能被改写成另一种风格。
 */

/** Cindy 新建托管 worktree 使用的目录名。 */
export const MANAGED_WORKTREE_DIR_NAME = '.cindy-worktrees';

/** 品牌迁移前使用的目录名;只用于识别和恢复既有 worktree。 */
export const LEGACY_MANAGED_WORKTREE_DIR_NAME = '.xdt-worktrees';

/** 所有受 Cindy 生命周期管理的 worktree 目录名,新目录必须排在第一位。 */
export const MANAGED_WORKTREE_DIR_NAMES = [
  MANAGED_WORKTREE_DIR_NAME,
  LEGACY_MANAGED_WORKTREE_DIR_NAME,
] as const;

/** 判断一个目录 basename 是否属于 Cindy 托管的 worktree 根目录。 */
export function isManagedWorktreeDirectoryName(name: string): boolean {
  return MANAGED_WORKTREE_DIR_NAMES.some((candidate) => candidate === name);
}

/** Cindy 托管的 worktree 容器目录(生命周期由 Cindy 管理,项目设置继承 base repo)。 */
const MANAGED_WORKTREE_CONTAINERS: readonly (readonly string[])[] = MANAGED_WORKTREE_DIR_NAMES.map(
  (name) => [name] as const,
);

/**
 * 用户 / 其它工具自己建的 worktree 约定目录。它们可能刻意带独立的
 * `.claude/settings.json`,所以只用于**分组**,不参与项目设置继承。
 */
const CONVENTIONAL_WORKTREE_CONTAINERS: readonly (readonly string[])[] = [
  ['.worktrees'],
  ['.claude', 'worktrees'],
];

const GROUPING_WORKTREE_CONTAINERS: readonly (readonly string[])[] = [
  ...MANAGED_WORKTREE_CONTAINERS,
  ...CONVENTIONAL_WORKTREE_CONTAINERS,
];

interface PathSegment {
  readonly start: number;
  readonly text: string;
}

/**
 * 反斜杠是否算分隔符 —— 只有盘符路径(`C:\`)与反斜杠 UNC(`\\server\share`)才算。
 * POSIX 路径里的反斜杠是**文件名的合法字符**(桌面侧 storage 归一化刻意保留它),
 * 把它当分隔符会让 `/repo/weird\.worktrees/name` 被误折叠成 `/repo/weird`。
 */
function usesBackslashSeparator(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
}

/** 拆出非空路径段并记录每段在原串中的起始下标(折叠时按下标切片,保留原分隔符风格)。 */
function splitPathSegments(value: string, allowBackslash: boolean): PathSegment[] {
  const segments: PathSegment[] = [];
  let start = -1;
  for (let i = 0; i <= value.length; i += 1) {
    if (i < value.length) {
      const code = value.charCodeAt(i);
      const isSeparator = code === 47 /* / */ || (allowBackslash && code === 92 /* \ */);
      if (!isSeparator) {
        if (start < 0) start = i;
        continue;
      }
    }
    if (start >= 0) {
      segments.push({ start, text: value.slice(start, i) });
      start = -1;
    }
  }
  return segments;
}

function isDriveRoot(value: string): boolean {
  return value.length === 2 && value[1] === ':' && /^[A-Za-z]$/.test(value[0]);
}

/**
 * 去掉 base 末尾的分隔符。只去当前路径风格认可的分隔符 —— POSIX 下目录名可以以反斜杠
 * 结尾(`/repo/weird\`),不能顺手削掉。
 */
function stripTrailingSeparators(value: string, allowBackslash: boolean): string {
  let end = value.length;
  while (end > 0) {
    const code = value.charCodeAt(end - 1);
    if (code !== 47 /* / */ && !(allowBackslash && code === 92 /* \ */)) break;
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function resolveWorktreeBase(
  value: string,
  containers: readonly (readonly string[])[],
): string | null {
  const allowBackslash = usesBackslashSeparator(value);
  const segments = splitPathSegments(value, allowBackslash);
  for (let i = 0; i < segments.length; i += 1) {
    for (const container of containers) {
      // 容器目录后面必须还有一段 worktree 名,否则这只是容器目录本身(或它的父级)。
      if (i + container.length >= segments.length) continue;
      let matched = true;
      for (let k = 0; k < container.length; k += 1) {
        if (segments[i + k].text !== container[k]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;

      const markerStart = segments[i].start;
      // 路径以容器目录开头(相对路径)时定不出 base repo,按不折叠处理。
      if (markerStart === 0) continue;
      const base = stripTrailingSeparators(value.slice(0, markerStart), allowBackslash);
      // base 只剩分隔符 → POSIX 根;盘符根(`C:`)要补回一个分隔符,否则 `C:` 会退化成
      // drive-relative 语义。分隔符字符都取自原串,不改写风格。
      if (base === '') return value.slice(0, 1);
      if (isDriveRoot(base)) return `${base}${value[markerStart - 1]}`;
      return base;
    }
  }
  return null;
}

/**
 * 解析 Cindy 托管 worktree 的 base repo(只认 `.cindy-worktrees` / `.xdt-worktrees`)。
 * 不是托管 worktree 路径时返回 null。
 */
export function managedWorktreeBaseRepo(value: string): string | null {
  return resolveWorktreeBase(value, MANAGED_WORKTREE_CONTAINERS);
}

/**
 * 解析用于**项目分组**的 base repo:托管 worktree 加上 `.worktrees/<name>` 与
 * `.claude/worktrees/<name>` 这两种社区约定形态。不是 worktree 路径时返回 null。
 */
export function groupingWorktreeBaseRepo(value: string): string | null {
  return resolveWorktreeBase(value, GROUPING_WORKTREE_CONTAINERS);
}

/** 项目分组用:是 worktree 路径就折叠到 base repo,否则原样返回。 */
export function collapseWorktreeDirForGrouping(value: string): string {
  return groupingWorktreeBaseRepo(value) ?? value;
}
