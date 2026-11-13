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
  /** 名称与目录的对应关系变了(不看顺序) —— 需要让服务端知道。 */
  mappingChanged: boolean;
}

export const MAX_PROJECT_WORKSPACES = 64;
const MAX_RETIRED_ALIASES = 64;
const MAX_NAME_CODE_POINTS = 32;
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
  if (isUsableName(base) && isFree(base)) return base;
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

  const projects: ProjectCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const project of input.projects) {
    const key = keyOf(project.path);
    if (seen.has(key)) continue;
    seen.add(key);
    projects.push(project);
    if (projects.length === MAX_PROJECT_WORKSPACES) break;
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
      !taken.has(existing) &&
      stillFits(existing, project, bases[index]!)
    ) {
      assigned.set(index, existing);
      taken.add(existing);
    }
  });
  const renames: ProjectWorkspaceRename[] = [];
  projects.forEach((project, index) => {
    if (assigned.has(index)) return;
    const name = pickName(project, bases[index]!, isFreeFor(keyOf(project.path)));
    assigned.set(index, name);
    taken.add(name);
    const previous = currentAliasByKey.get(keyOf(project.path));
    if (previous !== undefined && previous !== name) renames.push({ from: previous, to: name });
  });

  const workspaces: Record<string, string> = {};
  projects.forEach((project, index) => {
    workspaces[assigned.get(index)!] = project.path;
  });

  // retired: 旧的在前、本次改名的在后; 只留仍在清单里的目录, 且不与现用名称相撞。
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
  for (const rename of renames) pushRetired(rename.from, input.current[rename.from]!);
  const retired: Record<string, string> = {};
  for (const [alias, directory] of retiredEntries.slice(-MAX_RETIRED_ALIASES)) retired[alias] = directory;

  const mappingChanged = !sameRecord(workspaces, input.current, false);
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
