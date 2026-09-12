/**
 * ignoreNames — 忽略名单的**纯数据**面(VCS/OS 垃圾 + 依赖/构建产物/缓存)。
 *
 * 拆出来只有一个原因:desktop renderer 也要用同一份名单。切「显示被忽略的
 * 目录」开关时,renderer 要立刻把 reveal 态根列表里「隐藏态会被忽略」的一级
 * 目录滤掉 —— 否则关开关后这些行要等新 matcher 的数据回来才消失,慢通道
 * (SSH / device-link)下会有数秒「开关关了却还看得见」的窗口。
 *
 * 因此本文件必须保持零依赖:不 import 任何东西、不碰 fs。它经
 * `@cindy/file-browser-core/ignoreNames` 子路径导出给 renderer,而包根入口
 * (index.ts)会把 node:fs 拖进浏览器 bundle(同类说明见 desktop 的
 * shared/textFileExts.ts)。名单只此一份:ignore.ts 的两宿主 matcher 从这里
 * import。
 *
 * ⚠️ 改名单要同时想清楚三处消费:
 *   1. loadIgnoreMatcher —— 两宿主列目录的过滤口径;
 *   2. createEventIgnoreMatcher —— daemon 事件侧的恒真层;
 *   3. desktop renderer 切开关的首帧过滤 —— 只认这里的一级目录名。
 * 第 3 处只覆盖内置名单:`.gitignore` / `.p4ignore` 里的自定义条目拿不到
 * (renderer 不读盘),要等新 matcher 的数据回来才生效 —— 不为它加一条 IPC。
 */

/**
 * Folder names (last path segment) that should never be walked into,
 * regardless of vcs ignore files. Patterns are folder-name-only (no globs)
 * because `ignore` lib treats them as "match anywhere in the path".
 *
 * 分两层,因为「用户看得见的工程目录」和「纯噪音」不是一回事:
 *   - ALWAYS:VCS 元数据与 OS 垃圾 —— 任何设置下都不列、不递归。
 *   - REVEALABLE:依赖 / 构建产物 / 缓存 / IDE 缓存 —— 默认隐藏(Unity 的
 *     Library 之类目录动辄数十万条,默认列出会让文件树不可用),但用户可在
 *     设置里开「显示被忽略的目录」放行。
 */
export const BUILTIN_IGNORE_ALWAYS = [
  // VCS metadata: never part of the project's own file tree.
  '.git/',
  '.svn/',
  '.hg/',
  // OS junk
  '.DS_Store',
  'Thumbs.db',
];

export const BUILTIN_IGNORE_REVEALABLE = [
  // Package managers
  'node_modules/',
  '__pycache__/',
  'vendor/',
  '.venv/',
  '.cache/',
  // Editor / IDE caches
  '.vs/',
  '.idea/',
  '.vscode-test/',
  // Generic build outputs
  'dist/',
  'build/',
  'out/',
  '.next/',
  'target/',
  'bin/',
  'obj/',
  // Unity-specific (huge caches; .gitignore usually has them but be defensive)
  'Library/',
  'Temp/',
  'Logs/',
  'UserSettings/',
  // Project-internal generated dirs (seen on real Unity workdirs)
  'AssetDepotOutput/',
  'ChuangXiangEditorCache/',
  // .meta files (Unity per-asset metadata) — rendered behind a "show meta"
  // user toggle; defaulting to hidden cuts ~47% of typical Unity entries.
  // Toggle is honored by Matcher.shouldShowMeta below.
  // Note: NOT added here — handled separately because it's user-toggleable
  // per session via `hideMetaFiles`.
];

/**
 * 「可以列出、但不实时 watch」的目录名 —— 与 BUILTIN_IGNORE_REVEALABLE 正交的
 * 一层:即使开了「显示被忽略的目录」(它们会出现在文件树里),事件侧也要丢掉
 * 它们内部的改动。
 *
 * 理由:node_modules 动辄数十万条目,Unity 的 Library 需要真正的资源依赖分析
 * ——原生递归 watch 的代价与收益不成比例,手动刷新已够用。两个宿主的**事件**
 * 过滤都必须吃这份清单(desktop 的 parcel 预过滤 + daemon 的事件过滤),但
 * **列目录不看它**(listDir 只问 BUILTIN_IGNORE_*)。
 */
export const WATCH_ALWAYS_IGNORE = ['node_modules', 'Library'] as const;

/**
 * `BUILTIN_IGNORE_REVEALABLE` 的目录名集合（去掉名单里的尾斜杠）。用于判断某个
 * relPath 是否落在「只有 reveal 态才可见」的目录内部 —— 事件侧按可见性分流时需要
 * 它（见 desktop `device-op.ts` 的 device-link 转发）。
 *
 * 与 `WATCH_ALWAYS_IGNORE` 的分工：后者是「永远不 watch 内部」的一层（daemon 不会
 * 发它们的事件）；本集合是「隐藏态不可见、reveal 态可见」的一层 —— daemon 在并集
 * matcher 下会发它们的事件，订阅方要自己按自己的可见性滤。
 */
export const REVEALABLE_IGNORE_DIR_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_IGNORE_REVEALABLE.map((name) => name.replace(/\/$/, '')),
);
