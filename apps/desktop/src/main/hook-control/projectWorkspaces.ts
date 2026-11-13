/**
 * hook-control/projectWorkspaces.ts
 * ---------------------------------------------------------------------------
 * 官方 IM 机器人可选的项目 = 侧栏的本机项目。本模块把项目清单投影成协议里的
 * 「名称 -> 本地目录」表(store.workspaces), 不再有单独维护的目录映射。
 *
 *   - 名称跟随侧栏: 用户改过名就用改后的名字, 否则用目录名; 同名时依次退到
 *     `上级目录/目录名`、`名称 2`。已经在用的名称只要仍然说得通就不动, 免得多一个
 *     同名项目就让旧项目在 IM 里换了叫法。
 *   - 名称变了(升级前手填的别名、侧栏里改名)时旧名称进 retired: 服务端的会话
 *     选择与目录偏好还按旧名称存着, 派发与偏好读取凭它找回同一个目录。retired
 *     只做查找, 不出现在 hello 与选择卡里。
 *   - 路径不出本机: 协议里仍然只有名称。
 *
 * 规划是纯函数(planProjectWorkspaces), 读取项目清单与落盘由调用方注入。
 */

import {
  HOOK_CHAT_WORKSPACE_ALIAS,
  HOOK_WORKSPACE_ALIAS_RE,
} from '../../shared/hookControlIpc.js';
import { projectKeyComparisonKey } from '../../shared/projectKeys.js';

/** 侧栏项目的一行, 按最近使用排在前。 */
export interface ProjectCatalogEntry {
  /** 项目目录(本机绝对路径)。 */
  path: string;
  /** 侧栏显示的名字: 用户改过的名字, 否则目录名。 */
  name: string;
  /** 最近一次使用(unix ms)。 */
  lastUsedAtMs?: number;
}

export interface ProjectWorkspaceRename {
  from: string;
  to: string;
}

export interface ProjectWorkspacePlan {
  /** 名称 -> 目录, 顺序即 IM 里列出的顺序。 */
  workspaces: Record<string, string>;
  /** 旧名称 -> 目录, 只用于查找。 */
  retired: Record<string, string>;
  /** 本次改了名的项目。 */
  renames: ProjectWorkspaceRename[];
  /** 清单或 retired 与输入不同(含顺序)。 */
  changed: boolean;
  /**
   * 需要让服务端知道: 名称与目录的对应关系变了, 或排在最前、服务端选择卡会列出来的那一批
   * 项目换了成员。只是这一批内部换了先后不算 —— 每次用另一个项目都重发握手没有必要。
   */
  mappingChanged: boolean;
}

const MAX_NAME_CODE_POINTS = 32;
/** 各服务端的项目选择卡只列清单最前面的若干个(目前最多 24 个)。 */
const SERVER_PICKER_WINDOW = 24;
const RESERVED_NAMES = new Set([
  HOOK_CHAT_WORKSPACE_ALIAS,
  '__proto__',
  'prototype',
  'constructor',
]);

function truncate(value: string, max: number): string {
  return Array.from(value).slice(0, max).join('').trim();
}

/** 把侧栏名字收成协议允许的名称: 不含控制字符、不像绝对路径、最多 32 个字。 */
export function projectWorkspaceBaseName(name: string): string {
  let value = name
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\/+/, '');
  if (/^[A-Za-z]:\//.test(value) || /^file:/i.test(value)) value = value.replace(/:/g, ' ');
  value = truncate(value.replace(/\s+/g, ' '), MAX_NAME_CODE_POINTS);
  return value || 'project';
}

function parentSegment(directory: string): string | null {
  const segments = directory.split(/[\\/]/).filter(Boolean);
  return segments.length >= 2 ? (segments[segments.length - 2] ?? null) : null;
}

function isUsableName(name: string): boolean {
  return HOOK_WORKSPACE_ALIAS_RE.test(name) && !RESERVED_NAMES.has(name);
}

/**
 * 纯数字的名称(如 `123`)不当现用名称: 清单是按插入顺序排的对象, 而这类键在对象里恒排最前,
 * 会打乱「最近使用在前」的顺序, 把别的项目挤出服务端只列前若干个的选择卡。这种项目退到
 * `上级目录/123` 或 `123 2`; 升级前手填的纯数字别名照样留作查找。
 */
function isIndexKey(name: string): boolean {
  return /^(0|[1-9]\d*)$/.test(name);
}

function withParent(project: ProjectCatalogEntry, base: string): string | null {
  const parent = parentSegment(project.path);
  if (!parent) return null;
  const candidate = `${projectWorkspaceBaseName(parent)}/${base}`;
  return Array.from(candidate).length <= MAX_NAME_CODE_POINTS && isUsableName(candidate)
    ? candidate
    : null;
}

function numbered(base: string, index: number): string {
  const suffix = ` ${index}`;
  return `${truncate(base, MAX_NAME_CODE_POINTS - suffix.length)}${suffix}`;
}

/** 已有名称是否仍然对得上这个项目的侧栏名字(含同名时的两种退让写法)。 */
function stillFits(alias: string, project: ProjectCatalogEntry, base: string): boolean {
  if (alias === base || alias === withParent(project, base)) return true;
  const match = /^(.*) (\d+)$/.exec(alias);
  return match !== null && Number(match[2]) >= 2 && numbered(base, Number(match[2])) === alias;
}

function pickName(
  project: ProjectCatalogEntry,
  base: string,
  isFree: (name: string) => boolean,
): string {
  if (isUsableName(base) && !isIndexKey(base) && isFree(base)) return base;
  const parent = withParent(project, base);
  if (parent !== null && isFree(parent)) return parent;
  for (let index = 2; ; index += 1) {
    const candidate = numbered(base, index);
    if (isUsableName(candidate) && isFree(candidate)) return candidate;
  }
}

function sameRecord(a: Record<string, string>, b: Record<string, string>, ordered: boolean): boolean {
  const left = Object.entries(a);
  const right = Object.entries(b);
  if (left.length !== right.length) return false;
  if (ordered) return left.every(([key, value], index) => right[index]?.[0] === key && right[index]?.[1] === value);
  return left.every(([key, value]) => Object.hasOwn(b, key) && b[key] === value);
}

export function planProjectWorkspaces(input: {
  current: Readonly<Record<string, string>>;
  retired: Readonly<Record<string, string>>;
  projects: readonly ProjectCatalogEntry[];
  platform?: NodeJS.Platform;
}): ProjectWorkspacePlan {
  const platform = input.platform ?? process.platform;
  const keyOf = (directory: string): string =>
    projectKeyComparisonKey(`local:${directory}`, platform) ?? directory;

  // 清单就是全部侧栏项目, 不按条数截取「最近的前 N 个」: 截取会让项目随使用顺序进出清单,
  // 它的名称、默认项目和按名称存的权限档都跟着时有时无。各服务端的选择卡自己只列前若干个,
  // 其余用 `/project 名称` 指定。
  const projects: ProjectCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const key = keyOf(project.path);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(project);
  }

  const currentAliasByKey = new Map<string, string>();
  for (const [alias, directory] of Object.entries(input.current)) {
    const key = keyOf(directory);
    if (!currentAliasByKey.has(key)) currentAliasByKey.set(key, alias);
  }

  // 一个名称只要还指着清单里的某个项目(现用, 或改名后留作查找的旧名称), 别的项目就不能用它:
  // 服务端的会话还按这个名称记着选的项目, 让它改指另一个目录, 下一条指令就会跑进错的项目。
  // 项目自己可以把旧名称拿回去(改名后又改回来)。
  const catalogKeys = new Set(projects.map((project) => keyOf(project.path)));
  const ownerOfName = new Map<string, string>();
  for (const source of [input.retired, input.current]) {
    for (const [alias, directory] of Object.entries(source)) {
      const key = keyOf(directory);
      if (catalogKeys.has(key)) ownerOfName.set(alias, key);
    }
  }

  const bases = projects.map((project) => projectWorkspaceBaseName(project.name));
  const assigned = new Map<number, string>();
  const taken = new Set<string>();
  const isFreeFor = (projectKey: string) => (name: string): boolean =>
    !taken.has(name) && (ownerOfName.get(name) ?? projectKey) === projectKey;
  // 先留住仍然说得通的现有名称, 再给其余项目取名 —— 新项目不会抢走旧项目的名字。
  projects.forEach((project, index) => {
    const existing = currentAliasByKey.get(keyOf(project.path));
    if (
      existing !== undefined &&
      isUsableName(existing) &&
      !isIndexKey(existing) &&
      !taken.has(existing) &&
      stillFits(existing, project, bases[index]!)
    ) {
      assigned.set(index, existing);
      taken.add(existing);
    }
  });
  projects.forEach((project, index) => {
    if (assigned.has(index)) return;
    const name = pickName(project, bases[index]!, isFreeFor(keyOf(project.path)));
    assigned.set(index, name);
    taken.add(name);
  });
  // 改名: 现用名称里每一个指着这个项目、又不是它新名称的, 都算(升级前的配置允许同一个目录
  // 有两个别名; 默认项目用的可能是其中任意一个, 只记第一个的话另一个会被当成清单外清掉)。
  const nameByKey = new Map(projects.map((project, index) => [keyOf(project.path), assigned.get(index)!] as const));
  const renames: ProjectWorkspaceRename[] = [];
  for (const [alias, directory] of Object.entries(input.current)) {
    const name = nameByKey.get(keyOf(directory));
    if (name !== undefined && name !== alias) renames.push({ from: alias, to: name });
  }

  const workspaces: Record<string, string> = {};
  projects.forEach((project, index) => {
    workspaces[assigned.get(index)!] = project.path;
  });

  // retired: 旧的在前、本次退下来的在后; 只留仍是项目的目录, 且不与现用名称相撞。
  // 不设条数上限: 丢掉一条, 那个名称就可能分给别的项目, 仍按它记着的会话会跑进错的目录。
  // 条数本身有界 —— 只在改名时增加, 项目被移除时一并清掉。
  const pathByKey = new Map(projects.map((project) => [keyOf(project.path), project.path] as const));
  const retiredEntries: Array<[string, string]> = [];
  const pushRetired = (alias: string, directory: string): void => {
    const current = pathByKey.get(keyOf(directory));
    if (current === undefined || Object.hasOwn(workspaces, alias) || !isUsableName(alias)) return;
    const at = retiredEntries.findIndex(([name]) => name === alias);
    if (at !== -1) retiredEntries.splice(at, 1);
    retiredEntries.push([alias, current]);
  };
  for (const [alias, directory] of Object.entries(input.retired)) pushRetired(alias, directory);
  // 现用名称里这次没留下的, 就是改了名的项目的旧名称。
  for (const [alias, directory] of Object.entries(input.current)) pushRetired(alias, directory);
  const retired: Record<string, string> = {};
  for (const [alias, directory] of retiredEntries) retired[alias] = directory;

  const shown = (record: Readonly<Record<string, string>>): string =>
    Object.keys(record).slice(0, SERVER_PICKER_WINDOW).sort().join('\n');
  const mappingChanged =
    !sameRecord(workspaces, input.current, false) || shown(workspaces) !== shown(input.current);
  return {
    workspaces,
    retired,
    renames,
    changed: !sameRecord(workspaces, input.current, true) || !sameRecord(retired, input.retired, false),
    mappingChanged,
  };
}

/**
 * 现用名称加上 retired: 派发按名称找目录用这一份。按目录反查名称时要现用名称优先,
 * 不能靠这里的键序(纯数字键在对象里恒排最前) —— 调用方另用 retired 名单区分。
 */
export function lookupWorkspaces(
  workspaces: Readonly<Record<string, string>>,
  retired: Readonly<Record<string, string>>,
): Record<string, string> {
  const lookup: Record<string, string> = { ...workspaces };
  for (const [alias, directory] of Object.entries(retired)) {
    if (!Object.hasOwn(lookup, alias)) lookup[alias] = directory;
  }
  return lookup;
}

/** retired 名称各自对应的现用名称(目录相同); 用于把按旧名称存的偏好挪到新名称下。 */
export function retiredAliasPairs(
  workspaces: Readonly<Record<string, string>>,
  retired: Readonly<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): ProjectWorkspaceRename[] {
  const keyOf = (directory: string): string =>
    projectKeyComparisonKey(`local:${directory}`, platform) ?? directory;
  const currentByKey = new Map(
    Object.entries(workspaces).map(([alias, directory]) => [keyOf(directory), alias] as const),
  );
  const pairs: ProjectWorkspaceRename[] = [];
  for (const [alias, directory] of Object.entries(retired)) {
    const to = currentByKey.get(keyOf(directory));
    if (to !== undefined && to !== alias) pairs.push({ from: alias, to });
  }
  return pairs;
}

/**
 * 这次整理之后「不再指着原来那个目录」的名称: 项目从侧栏移除了(名称随之消失), 或名称转给了
 * 另一个目录。按这些名称存的模型 / 权限配置属于原来的项目, 调用方据此清掉 —— 否则日后同名的
 * 新项目会悄悄继承上一个项目的权限档。改名不算: 旧名称留作查找, 仍指着同一个目录。
 */
export function releasedProjectNames(
  before: { workspaces: Readonly<Record<string, string>>; retired: Readonly<Record<string, string>> },
  after: { workspaces: Readonly<Record<string, string>>; retired: Readonly<Record<string, string>> },
  platform: NodeJS.Platform = process.platform,
): string[] {
  const keyOf = (directory: string): string =>
    projectKeyComparisonKey(`local:${directory}`, platform) ?? directory;
  const previous = lookupWorkspaces(before.workspaces, before.retired);
  const next = lookupWorkspaces(after.workspaces, after.retired);
  return Object.entries(previous)
    .filter(([name, directory]) => !Object.hasOwn(next, name) || keyOf(next[name]!) !== keyOf(directory))
    .map(([name]) => name);
}
