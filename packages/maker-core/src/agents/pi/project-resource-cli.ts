/**
 * Collect project Skill / prompt / extension paths for explicit Pi CLI flags.
 *
 * Local root tasks keep `--no-approve` (so `.pi/settings.json` stays unread)
 * and pass original in-repo paths via `--skill`, `--prompt-template`, and
 * `--extension`. Review, Bot, fork, and remote sessions do not use this.
 */

import fs from 'node:fs';
import path from 'node:path';
import { shouldPruneSkillScanDirectory } from '../shared/skill-scan-limits.js';

export interface PiProjectResourceCliPaths {
  readonly skills: readonly string[];
  readonly promptTemplates: readonly string[];
  readonly extensions: readonly string[];
}

export function emptyPiProjectResourceCliPaths(): PiProjectResourceCliPaths {
  return Object.freeze({
    skills: Object.freeze([]),
    promptTemplates: Object.freeze([]),
    extensions: Object.freeze([]),
  });
}

function realpathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function hasGitMarker(dir: string): boolean {
  try {
    const marker = fs.statSync(path.join(dir, '.git'));
    return marker.isDirectory() || marker.isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

function findNearestGitRoot(workingDir: string): string | null {
  let current = workingDir;
  while (true) {
    if (hasGitMarker(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** collector 与漂移快检共用的 git 边界解析(同输入必同输出,才能恒等比较)。 */
export function resolvePiResourceRepoRoot(workingDir: string): string {
  const scanRoot = realpathOrNull(workingDir) ?? path.resolve(workingDir);
  return findNearestGitRoot(scanRoot) ?? scanRoot;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isSymlinkDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/** readdir 把 Windows junction 报成目录时 Dirent.isSymbolicLink 为 false,需 lstat
 * 兜底。collector 与 watcher 必须共用同一判定:口径分叉会让盯视面混入 collector
 * 永不枚举的目标树键(无谓重扫 + 基线带脏键)。 */
function isSymlinkEntry(entry: fs.Dirent, absPath: string): boolean {
  return entry.isSymbolicLink() || (entry.isDirectory() && isSymlinkDirectory(absPath));
}

/** 从同一次 readdir 的条目里判定 skill 清单存在性(collector 口径:isFile 跟随
 * 软链)。软链清单要先解析目标是否为文件—— 这次读发生在该键基线之后,只会让
 * argv 领先基线,下次快检观察差异后收敛,不会永久漏检。 */
function skillManifestIn(dir: string, dirents: readonly fs.Dirent[]): boolean {
  for (const entry of dirents) {
    if (entry.name !== 'SKILL.md' && entry.name !== 'skill.md') continue;
    if (entry.isFile()) return true;
    if (entry.isSymbolicLink() && isFile(path.join(dir, entry.name))) return true;
  }
  return false;
}

/**
 * 项目资源表面 = argv 路径集合 + 盯视基线,**同一次遍历**产出。
 *
 * 结构不变量(逐键,2026-11-10 根因收口):一个键的基线字段与该键上的 argv 判断
 * 出自**同一次采样**(samplePiWatchKey),判断不早于基线、也不另发读。任何采样后
 * 的变化都会被快检观察为差异 → 重扫 → 集合相同则刷新基线后收敛;不存在「基线已
 * 含新状态、argv 还是旧状态」的永久漏检。
 *
 * 历史教训:collector 与 watcher 曾是两套手写遍历(口径靠注释),后又只合并了
 * 遍历但保留键内两次读 —— 两次都是同一病根:同一事实产生两次,漂移检测就在两者
 * 之间漏。条目模式由**结构**决定(见 PiWatchEntriesMode),不看内容。
 */
export interface PiProjectResourceSurface {
  /** 本遍历认定的 git root(枚举链终点;调用方作为快照边界基线传入)。 */
  readonly repoRoot: string;
  readonly paths: PiProjectResourceCliPaths;
  readonly watch: PiProjectResourceLaunchWatch;
}

/** 把一个 skill 目录登记进集合(collector 口径:清单经 realpath 后须在仓内,
 * realFolder 本身入集合)。此次校验性读发生在该键基线之后 —— 安全方向。 */
function addPiSkill(repoRoot: string, realFolder: string, bucket: Set<string>): void {
  for (const name of ['SKILL.md', 'skill.md']) {
    const manifestPath = path.join(realFolder, name);
    if (!isFile(manifestPath)) continue;
    const realMd = realpathOrNull(manifestPath);
    if (realMd && isWithinRoot(repoRoot, realMd)) {
      bucket.add(realFolder);
      return;
    }
  }
}

/**
 * 走一遍 skills 根的两层树:每个键先采样(基线 + 判断输入),再用采样返回值做
 * collector 的集合判定 —— 全程不再发第二次读。
 */
function walkPiSkillTree(
  sample: PiProjectResourceLaunchWatch,
  repoRoot: string,
  skillsDir: string,
  bucket: Set<string>,
): void {
  const root = samplePiWatchKey(sample, skillsDir, 'dir', repoRoot);
  if (!root.inRepoDir || !root.resolved) return;

  for (const entry of root.dirents ?? []) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const candidatePath = path.join(root.resolved, entry.name);
    // 模式只由**结构**定(不看内容 —— 读内容定模式会重新造出两次读窗口):
    // 软链一层 collector 要么收为直链 skill、要么直接跳过(不走 namespace),
    // 只消费清单存在性 → 'skill'(两次 stat;仓内大目录也不拖快检);
    // 真实目录 collector 会枚举 namespace → 'dir'(完整列表,同刻新增的嵌套
    // skill 目录才检得出)。
    const isSymlink = isSymlinkEntry(entry, candidatePath);
    const child = samplePiWatchKey(sample, candidatePath, isSymlink ? 'skill' : 'dir', repoRoot);
    if (!child.inRepoDir || !child.resolved) continue;
    // 清单本体无论当前是否解析都盯住:悬空链(目标尚不存在)落地成 skill 时,
    // 改动的只是未盯视的目标处,盯住链接自身才能检出(与 prompts 同款)。
    // 直链 skill 根同样适用:其 SKILL.md 为二级软链时,目标移动/删除只改目标处。
    watchPiSkillManifestTargets(sample, child.resolved, repoRoot);
    // 判断输入与基线同源(Greptile P2:先 hasManifest 再记基线 → 中间写入的
    // SKILL.md 被固化进基线、argv 漏收 → 永久漏检);软链用采样时的清单存在性,
    // 真实目录用采样时的同一次 readdir 条目。
    const hasManifest = isSymlink
      ? child.manifest
      : skillManifestIn(child.resolved, child.dirents ?? []);
    if (hasManifest) {
      addPiSkill(repoRoot, child.resolved, bucket);
      continue;
    }
    // 软链 namespace collector 明文不走(可越界/成环);剪枝名同理。
    if (isSymlink || shouldPruneSkillScanDirectory(entry.name)) continue;

    // At most one namespace/author level: <root>/<namespace>/<skill>.
    for (const nested of child.dirents ?? []) {
      if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
      if (!nested.isDirectory() && !nested.isSymbolicLink()) continue;
      const nestedPath = path.join(child.resolved, nested.name);
      // 嵌套层 collector 只 stat 清单存在性、不再下行 → 'skill'(两次 stat)。
      const nestedSample = samplePiWatchKey(sample, nestedPath, 'skill', repoRoot);
      if (!nestedSample.inRepoDir || !nestedSample.resolved) continue;
      watchPiSkillManifestTargets(sample, nestedSample.resolved, repoRoot);
      if (nestedSample.manifest) addPiSkill(repoRoot, nestedSample.resolved, bucket);
    }
  }
}

/** 走一遍 prompts 根:根的采样条目既进基线也驱动枚举;每个模板以**链接路径**
 * 采样(stat 跟随软链:悬空时 mtime=-1,目标落地即变),resolved 直接作为 argv
 * 路径 —— 不再单独 realpath 后再比。 */
function walkPiPromptTargets(
  sample: PiProjectResourceLaunchWatch,
  repoRoot: string,
  promptsDir: string,
  bucket: Set<string>,
): void {
  const root = samplePiWatchKey(sample, promptsDir, 'dir', repoRoot);
  if (!root.inRepoDir || !root.resolved) return;
  for (const entry of root.dirents ?? []) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
    const entryPath = path.join(root.resolved, entry.name);
    const target = samplePiWatchKey(sample, entryPath, 'none', repoRoot);
    // 悬空/越界目标不收集;链接自身已入盯视(mtime 跟随目标,落地即检出)。
    if (!target.isFile || !target.resolved || !isWithinRoot(repoRoot, target.resolved)) continue;
    bucket.add(target.resolved);
  }
}

/** 走一遍 extensions 根:根条目同时驱动基线/枚举;子键与 index.ts 以 'none' 采样
 * (文件键;缺失时 mtime=-1 → 同刻落地也必变),判断直接用采样返回值。 */
function walkPiExtensionTree(
  sample: PiProjectResourceLaunchWatch,
  repoRoot: string,
  extDir: string,
  bucket: Set<string>,
): void {
  const root = samplePiWatchKey(sample, extDir, 'dir', repoRoot);
  if (!root.inRepoDir || !root.resolved) return;
  for (const entry of root.dirents ?? []) {
    if (entry.name.startsWith('.')) continue;
    const childPath = path.join(root.resolved, entry.name);
    const child = samplePiWatchKey(sample, childPath, 'none', repoRoot);
    if (!child.resolved || !isWithinRoot(repoRoot, child.resolved)) continue;
    if (child.isFile && child.resolved.endsWith('.ts')) {
      bucket.add(child.resolved);
      continue;
    }
    if (!child.isDir) continue;
    const index = samplePiWatchKey(sample, path.join(child.resolved, 'index.ts'), 'none', repoRoot);
    if (index.isFile && index.resolved && isWithinRoot(repoRoot, index.resolved)) {
      bucket.add(index.resolved);
    }
  }
}

/**
 * 项目资源表面:argv 路径集合与盯视基线的**唯一产出点**。生产调用方(spawn 采样、
 * 重扫)必须经此一次调用取两样 —— 分两次调用会重新造出「集合与基线不同批」的
 * 永久漏检窗口(Codex P2,2026-11-10)。
 */
export function collectPiProjectResourceSurface(workingDir: string, repoRootHint?: string): PiProjectResourceSurface {
  const watch: PiProjectResourceLaunchWatch = {
    scanRootResolved: realpathOrNull(workingDir),
    mtimes: new Map(),
    entries: new Map(),
    resolved: new Map(),
  };
  const skills = new Set<string>();
  const promptTemplates = new Set<string>();
  const extensions = new Set<string>();
  if (!workingDir || !path.isAbsolute(workingDir) || !isDir(workingDir)) {
    return freezePiProjectResourceSurface(
      repoRootHint ?? watch.scanRootResolved ?? path.resolve(workingDir), skills, promptTemplates, extensions, watch);
  }
  const scanRoot = watch.scanRootResolved ?? path.resolve(workingDir);
  const repoRoot = repoRootHint ?? (findNearestGitRoot(scanRoot) ?? scanRoot);
  const piDir = path.join(scanRoot, '.pi');
  recordWatchKey(watch, piDir, 'dir', repoRoot);
  walkPiSkillTree(watch, repoRoot, path.join(piDir, 'skills'), skills);
  walkPiPromptTargets(watch, repoRoot, path.join(piDir, 'prompts'), promptTemplates);
  walkPiExtensionTree(watch, repoRoot, path.join(piDir, 'extensions'), extensions);
  let current = scanRoot;
  while (true) {
    const agentsDir = path.join(current, '.agents');
    recordWatchKey(watch, agentsDir, 'dir', repoRoot);
    walkPiSkillTree(watch, repoRoot, path.join(agentsDir, 'skills'), skills);
    if (current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return freezePiProjectResourceSurface(repoRoot, skills, promptTemplates, extensions, watch);
}

function freezePiProjectResourceSurface(
  repoRoot: string,
  skills: Set<string>,
  promptTemplates: Set<string>,
  extensions: Set<string>,
  watch: PiProjectResourceLaunchWatch,
): PiProjectResourceSurface {
  return Object.freeze({
    repoRoot,
    paths: Object.freeze({
      skills: Object.freeze([...skills].sort(comparePiResourcePaths)),
      promptTemplates: Object.freeze([...promptTemplates].sort(comparePiResourcePaths)),
      extensions: Object.freeze([...extensions].sort(comparePiResourcePaths)),
    }),
    watch,
  });
}

/** argv 采集的兼容入口(= surface.paths)。生产路径应优先 surface 一次调用。 */
export function collectPiProjectResourceCliPaths(workingDir: string, repoRootHint?: string): PiProjectResourceCliPaths {
  return collectPiProjectResourceSurface(workingDir, repoRootHint).paths;
}

/** 盯视采样的兼容入口(= surface.watch)。生产路径应优先 surface 一次调用。 */
export function collectPiProjectResourceLaunchWatch(workingDir: string, repoRootHint?: string): PiProjectResourceLaunchWatch {
  return collectPiProjectResourceSurface(workingDir, repoRootHint).watch;
}

function statMtimeMs(target: string): number {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return -1;
  }
}

/** 目录条目名指纹:时间戳粒度盲区(同一 tick 内增删,mtime 逐位不变)的第二信号。
 * 文件键/缺失目录 readdir 失败,恒 ''。变化只作重扫信号,判决仍归路径集合。 */
function readDirEntryFingerprint(dir: string): string {
  try {
    return fs.readdirSync(dir).sort().join('\n');
  } catch {
    return '';
  }
}

/**
 * 启动快照:spawn 时冻结的项目资源清单 + watch 面基线(mtime/条目指纹/解析身份)。
 * paths 是未经禁用过滤的原始收集结果(受邀者会话已按 guestRoot 裁剪,与后续
 * fresh collect 经同一 restrict 裁剪后同口径可比)。
 */
export interface PiProjectResourceLaunchSnapshot {
  readonly workingDir: string;
  readonly paths: PiProjectResourceCliPaths;
  /**
   * watch root 的 mtime 基线。Map 值可在重扫确认路径集合未变后就地重建(见
   * piProjectResourcesDrifted),避免 mtime 变化来自无关文件时每条消息重复全量重扫;
   * 路径集合与 paths 一样保持启动口径不变。
   */
  readonly watchRootMtimes: Map<string, number>;
  /** 启动时认定的 git root 可变持有器:更近的 .git 出现/消失会改变 collector 的枚举链
   * (.agents 向上走到 repoRoot),而任何被盯目录的 mtime 都不动,必须单独核对。边界
   * 变化只作重扫信号(见 piProjectResourcesDrifted),确认集合未变后就地更新,避免
   * 嵌套目录 git init 在无实际资源变化时多余回收。必须与 watch 基线同批采样
   * (都先于 paths 收集),否则窗口内新旧边界会与路径集合错配。 */
  readonly state: { repoRoot: string; resolvedWorkingDir: string | null };
  /** 每个 watch root 的解析身份(realpath)。基线不只记 mtime:被盯路径的软链改指
   * 同 mtime 的孪生树时,解析身份是唯一信号;与 watchRootMtimes 同 key 同批。 */
  readonly watchRootsResolved: Map<string, string | null>;
  /** 每个 watch root 的条目基线(完整条目名/清单存在性/null 跳读,按 collector
   * 消费方式定):时间戳粒度盲区的第二信号;与 watchRootMtimes 同 key 同批。 */
  readonly watchRootEntries: Map<string, string | null>;
  /** 受邀者裁剪口径(非受邀者恒 null):重扫后的 fresh 集合先经它裁剪再与 paths
   * 比较 —— 缺了会拿全量比裁剪基线恒判漂移,回收死循环。 */
  readonly restrict: ((paths: PiProjectResourceCliPaths) => PiProjectResourceCliPaths) | null;
}

/**
 * 启动采样的一次遍历产出:每个 watch key 的三样信号 + scanRoot 解析身份。
 * 整份样本必须先于路径收集采样 —— 身份基线晚于 argv 采集,会把「采基线前的
 * 改指」固化成一致基线,永久漏检(Codex P2,2026-11-10);基线在前则窗口内
 * 不一致只会让首次快检多一次重扫后收敛。
 */
export interface PiProjectResourceLaunchWatch {
  /** workingDir 的解析身份,先于所有键采样(键路径都从它拼出)。 */
  readonly scanRootResolved: string | null;
  readonly mtimes: Map<string, number>;
  /** key → 条目基线,由 samplePiWatchKey 与 argv 判断输入同一次采样产出 ——
   * 'L:' 完整条目名列表(collector readdir 的目录)/'M:' 清单存在性(collector
   * 只 stat SKILL.md/skill.md 的键)/null(collector 不消费)。时间戳粒度盲区
   * (同一 tick 内增删)的第二信号;变化只作重扫信号,判决仍归路径集合。 */
  readonly entries: Map<string, string | null>;
  /** key → realpath 解析身份(缺失 null),与 mtimes 同键同次采样。 */
  readonly resolved: Map<string, string | null>;
}

/**
 * 单键采样模式 = collector 在该路径上到底消费什么。由**结构**决定,不看内容:
 * 依赖内容会让「读内容定模式」自身变成新的两次读窗口(2026-11-10 Greptile P2)。
 * - 'dir'   collector 会 readdir 的目录 → 完整条目名列表;
 * - 'skill' collector 只 stat SKILL.md/skill.md 存在性 → 清单存在性;
 * - 'none'  collector 不消费(文件/越界/悬空/只 stat 的子键)→ 跳读。
 * 'dir'/'skill' 都由采样器自行门禁:目标须是仓内真实目录,否则指纹为 null ——
 * 仓外大目录永远不会被 readdir(每条消息一次的快检不会拖着同步 IO 走路)。
 */
export type PiWatchEntriesMode = 'dir' | 'skill' | 'none';

/**
 * 单键采样产出:基线字段 + argv 判断所需的全部输入,均出自这一次采样。
 *
 * **不变量(逐键,2026-11-10 根因收口)**:一个键的基线字段与该键上的 argv 判断,
 * 必须出自同一次采样;判断不得早于该键的基线,也不得另发读操作。
 * 反例(Greptile P2):先 hasSkillFile() 再记基线,安装器在这两步之间写入
 * SKILL.md → 基线记的是写后状态、argv 还是写前 → 后续快检恒等、该 skill 永久
 * 不生效。只靠注释约束不了,所以判断输入统一由采样返回值提供。
 *
 * 采样后发生的任何变化都安全:基线不会比判断更新,快检必然观察差异 → 重扫 →
 * 集合相同则刷新基线后收敛(不会永久漏检,最多多一次重扫)。
 */
export interface PiWatchKeySample {
  /** 解析身份(realpath,跟随软链);缺失 null。 */
  readonly resolved: string | null;
  /** stat mtime(跟随软链);缺失 -1。 */
  readonly mtime: number;
  readonly isFile: boolean;
  readonly isDir: boolean;
  /** 目标是否仓内真实目录(决定 'dir'/'skill' 是否采指纹)。 */
  readonly inRepoDir: boolean;
  /** 'dir' 模式:与条目基线同一次 readdir 的条目;其余 null。 */
  readonly dirents: readonly fs.Dirent[] | null;
  /** 'skill' 模式:与清单基线同一次判断的存在性;其余 false。 */
  readonly manifest: boolean;
}

/**
 * 采样一个 watch 键:一次 realpath + 一次 stat + 至多一次内容读,同时写入基线并
 * 返回给调用方做 argv 判断。基线与判断输入同源,**调用方不得对该键另发读**。
 */
function samplePiWatchKey(
  sample: PiProjectResourceLaunchWatch,
  target: string,
  mode: PiWatchEntriesMode,
  repoRoot: string,
): PiWatchKeySample {
  // 顺序固定:realpath → stat → 内容。基线先落盘,内容读既进指纹也回给调用方。
  const resolved = realpathOrNull(target);
  let stats: fs.Stats | null = null;
  try {
    stats = fs.statSync(target);
  } catch {
    stats = null;
  }
  const isDirectory = stats?.isDirectory() ?? false;
  const inRepoDir = isDirectory && !!resolved && isWithinRoot(repoRoot, resolved);
  let dirents: readonly fs.Dirent[] | null = null;
  let manifest = false;
  let fingerprint: string | null = null;
  if (mode === 'dir' && inRepoDir) {
    try {
      dirents = fs.readdirSync(target, { withFileTypes: true });
    } catch {
      dirents = null;
    }
    fingerprint = `L:${(dirents ?? []).map((entry) => entry.name).sort().join('\n')}`;
  } else if (mode === 'skill' && inRepoDir) {
    const names = ['SKILL.md', 'skill.md'].filter((name) => isFile(path.join(target, name)));
    manifest = names.length > 0;
    fingerprint = `M:${names.join(',')}`;
  }
  sample.resolved.set(target, resolved);
  sample.mtimes.set(target, stats ? stats.mtimeMs : -1);
  sample.entries.set(target, fingerprint);
  return {
    resolved,
    mtime: stats ? stats.mtimeMs : -1,
    isFile: stats?.isFile() ?? false,
    isDir: isDirectory,
    inRepoDir,
    dirents,
    manifest,
  };
}

/** 只记基线、不需要判断输入的键(丢弃采样返回值)。repoRoot 必传 —— 默认成
 * 目标的写法会让仓外目录也走进 readdir,等于把性能 P2 重新埋回。 */
function recordWatchKey(
  sample: PiProjectResourceLaunchWatch,
  target: string,
  mode: PiWatchEntriesMode,
  repoRoot: string,
): void {
  samplePiWatchKey(sample, target, mode, repoRoot);
}

/** 软链目标的清单存在性指纹(namespace↔skill 迁移的同刻信号);文件/缺失恒 ''。 */
function readSkillManifestFingerprint(dir: string): string {
  return ['SKILL.md', 'skill.md'].filter((name) => isFile(path.join(dir, name))).join(',');
}

/** 软链清单本体:SKILL.md/skill.md 为指向仓内目标的软链时,目标移动/删除不改变
 * skill 目录自身 mtime,只有盯住解析后的文件才能检出(与 prompts 同款)。悬空链
 * 盯链接自身,目标落地即检出。 */
function watchPiSkillManifestTargets(
  sample: PiProjectResourceLaunchWatch,
  realFolder: string,
  repoRoot: string,
): void {
  for (const name of ['SKILL.md', 'skill.md']) {
    const manifestPath = path.join(realFolder, name);
    let manifestLstat: fs.Stats;
    try {
      manifestLstat = fs.lstatSync(manifestPath);
    } catch {
      continue;
    }
    if (!manifestLstat.isSymbolicLink()) continue;
    // 目标本体与链接自身各入一键:悬空时 target 为 null 键落到链接本体。
    const target = samplePiWatchKey(sample, manifestPath, 'none', repoRoot);
    if (target.resolved) recordWatchKey(sample, target.resolved, 'none', repoRoot);
  }
}

/**
 * 冻结一份启动快照。watch 采样(含解析身份与 scanRoot 身份)与 repoRoot 必须由
 * 调用方在收集 paths **之前**采样传入(见 pi/index.ts 调用点):身份基线晚于 argv
 * 采集,会把「采基线前的改指」固化成一致基线,永久漏检(Codex P2,2026-11-10);
 * 基线在前则窗口内不一致只会让首次快检多一次重扫后收敛。restrict 传受邀者裁剪
 * 口径:比较对 fresh 集合做与启动相同的裁剪。
 */
export function snapshotPiProjectResourceLaunch(
  workingDir: string,
  paths: PiProjectResourceCliPaths,
  repoRoot: string,
  watch: PiProjectResourceLaunchWatch,
  restrict?: (paths: PiProjectResourceCliPaths) => PiProjectResourceCliPaths,
): PiProjectResourceLaunchSnapshot {
  return Object.freeze({
    workingDir,
    paths,
    watchRootMtimes: watch.mtimes,
    // scanRoot(workingDir 解析后)刻意不是 watch key(不含 workingDir 本身),
    // 解析身份单独成字段;身份出自 watch 采样的最前面 —— 若在这里补采样就退回
    // 「收集后才采身份」的永久漏检窗口(Codex P2)。软链 workingDir 改指同仓
    // 另一目录时,边界与旧物理根 mtime 均不变,这是唯一信号。
    state: {
      repoRoot,
      resolvedWorkingDir: watch.scanRootResolved,
    },
    // 每个 watch root 的解析身份:任意层级(`.pi`、`.agents` 链、namespace、单个
    // skill 目录)改指同 mtime 的孪生树时 mtime 面致盲,唯一完备信号是逐 key 的
    // 解析身份。realpath 含全链路解析,未枚举的嵌套软链同样覆盖。与 mtimes/entries
    // 同 key 同批产出(见 collectPiProjectResourceLaunchWatch)。
    watchRootsResolved: watch.resolved,
    watchRootEntries: watch.entries,
    restrict: restrict ?? null,
  });
}

function samePiResourceList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * 盘上项目资源相对启动快照是否已漂移(argv 重算后会不同)。结构性契约:
 * **每次调用至多一次全量路径收集**。两级信号 → 一次收集 → 一次比较:
 * 1. 轻量信号扫描(每 key 一次 realpath + stat + readdir,无递归):全部与基线
 *    相等且 git 边界未变 → 无漂移;任一不等 → 进入下一步。信号源:
 *    - watch root mtime 变化(资源增删只改所在目录自身 mtime,基线必须覆盖
 *      collector 实际枚举的每一层目录);
 *    - watch root 条目名指纹变化(时间戳粒度盲区:同一 tick 内增删,mtime 与
 *      基线逐位相等,条目名单不同);
 *    - watch root / workingDir 解析身份变化(软链改指同 mtime 孪生树时唯一信号);
 *    - git 边界变化(更近的 .git 出现/消失会改变 collector 的枚举链,但不动
 *      任何被盯目录的 mtime)。
 * 2. 全量重扫,按最终路径集合判定(argv 的输入是集合,不是内容):
 *    - 集合不同 → 漂移,返回 true(不动基线,调用方将回收运行时并重建快照);
 *    - 集合相同(触碰无关目录 / git init 未截断任何资源 / 缺失目录空壳落地 /
 *      不被 collector 枚举的软链 namespace 改指)→ 不算漂移,就地重建整张基线
 *      (新建的空 namespace / 空扩展目录纳入盯视)并更新边界持有者,下一次快检
 *      恢复零收集。解析身份变化只是触发重扫的信号,永远不是漂移判决:
 *      身份变了而集合不变,说明运行时消费的资源没有变。
 */
export function piProjectResourcesDrifted(snapshot: PiProjectResourceLaunchSnapshot): boolean {
  // 本次调用只解析一次 git root,贯穿传给所有收集器;独立探测会在重扫窗口内
  // 采出不一致的边界+盯视面(.git 消失时 watch 面停在旧根、集合来自新根)。
  const repoRoot = resolvePiResourceRepoRoot(snapshot.workingDir);
  const boundaryChanged = repoRoot !== snapshot.state.repoRoot;
  // 软链 workingDir 改指同仓另一目录:边界不变、解析后旧物理根的 mtime 不变,
  // 解析根变化是唯一信号(Codex P2)。解析失败(悬空)与有值不等同。失败信号。
  const resolvedWorkingDir = realpathOrNull(snapshot.workingDir);
  const resolvedWorkingDirChanged = resolvedWorkingDir !== snapshot.state.resolvedWorkingDir;
  // 任一 watch root 的解析身份变化(软链改指同 mtime 的孪生树):mtime 面碰撞
  // 时这是唯一信号;realpath 含全链路,任意层级的改指都会落到某个 key 上。
  // 记录本次采样而非只记信号:窗口复核必须与本轮开头比,不能与启动基线比 ——
  // 否则空目录从 null→存在 会撞上旧基线被误判为「窗口内再次改指」(Greptile P2)。
  const resolvedNow = new Map<string, string | null>();
  let resolvedRootChanged = false;
  for (const [dir, resolvedAtLaunch] of snapshot.watchRootsResolved) {
    const now = realpathOrNull(dir);
    resolvedNow.set(dir, now);
    if (now !== resolvedAtLaunch) resolvedRootChanged = true;
  }
  let mtimeChanged = false;
  for (const [dir, mtimeAtLaunch] of snapshot.watchRootMtimes) {
    if (statMtimeMs(dir) !== mtimeAtLaunch) {
      mtimeChanged = true;
      break;
    }
  }
  // 条目基线:时间戳粒度盲区(同一 tick 内增删,mtime 逐位不变)的第二信号。
  // null = collector 不消费的键,跳读;前缀(L:/M:)选与采集同一函数重算。
  let entriesChanged = false;
  for (const [dir, fingerprintAtLaunch] of snapshot.watchRootEntries) {
    if (fingerprintAtLaunch === null) continue;
    const actual = fingerprintAtLaunch.startsWith('M:')
      ? `M:${readSkillManifestFingerprint(dir)}`
      : `L:${readDirEntryFingerprint(dir)}`;
    if (actual !== fingerprintAtLaunch) {
      entriesChanged = true;
      break;
    }
  }
  if (!boundaryChanged && !resolvedWorkingDirChanged && !resolvedRootChanged && !mtimeChanged && !entriesChanged) return false;

  // 重扫 = 一次 surface 调用:集合与盯视基线同批(与启动同口径),不存在
  // 「基线采完、集合没采到」的窗口。
  const fresh = collectPiProjectResourceSurface(snapshot.workingDir, repoRoot);
  // 受邀者:比较前对 fresh 做与启动相同的裁剪,否则全量比裁剪基线恒判漂移。
  const freshForCompare = snapshot.restrict ? snapshot.restrict(fresh.paths) : fresh.paths;
  if (!(
    samePiResourceList(freshForCompare.skills, snapshot.paths.skills)
    && samePiResourceList(freshForCompare.promptTemplates, snapshot.paths.promptTemplates)
    && samePiResourceList(freshForCompare.extensions, snapshot.paths.extensions)
  )) {
    return true;
  }

  // 有信号但集合未变:整表重建(新建的空目录/解析后的 prompt 目标纳入盯视)
  // 并更新边界持有者,下一次快检恢复零收集。重建后复核边界:重扫窗口内
  // .git 又动了就按漂移交回收路径重建(下次快检从一致的新快照出发),
  // 不把混合口径的基线/边界写回快照。
  if (resolvePiResourceRepoRoot(snapshot.workingDir) !== repoRoot) return true;
  // 重扫窗口内解析根又变了(软链再次改指):按漂移交回收路径重建,不把混合口径
  // 的解析根写回快照。
  if (realpathOrNull(snapshot.workingDir) !== resolvedWorkingDir) return true;
  // 重扫窗口内解析身份又有变化(任意层级再次改指):按漂移交回收路径重建,不把
  // 混合口径的基线写回快照。与本轮开头采样比(同 repoRoot/resolvedWorkingDir)。
  for (const [dir, resolvedAtSignal] of resolvedNow) {
    if (realpathOrNull(dir) !== resolvedAtSignal) return true;
  }
  snapshot.watchRootMtimes.clear();
  for (const [dir, mtime] of fresh.watch.mtimes) snapshot.watchRootMtimes.set(dir, mtime);
  snapshot.watchRootsResolved.clear();
  for (const [dir, resolved] of fresh.watch.resolved) snapshot.watchRootsResolved.set(dir, resolved);
  snapshot.watchRootEntries.clear();
  for (const [dir, fingerprint] of fresh.watch.entries) snapshot.watchRootEntries.set(dir, fingerprint);
  snapshot.state.repoRoot = repoRoot;
  snapshot.state.resolvedWorkingDir = resolvedWorkingDir;
  return false;
}

/** Locale-independent path order so duplicate Skill names pick the same winner everywhere. */
export function comparePiResourcePaths(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Conservative CreateProcess command-line budget; the hard Windows cap is 32767. */
export const PI_WINDOWS_SPAWN_ARGV_BUDGET = 30_000;
/** Leave headroom under typical macOS/Linux ARG_MAX, which is shared with env. */
export const PI_POSIX_SPAWN_ARGV_BUDGET = 128_000;

export function estimateSpawnArgvLength(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): number {
  // 两种口径不一样，不能统一：Windows CreateProcess 的命令行上限是 32767 个
  // UTF-16 字符（lpCommandLine 是 LPCWSTR），按 UTF-8 字节算会把中文路径放大三倍、
  // 误判成超限而拒绝本来能起的会话；POSIX 的 ARG_MAX / MAX_ARG_STRLEN 按字节算，
  // 用字符数算会漏检中文长提示词。
  return args.reduce((total, arg) => total
    + (platform === 'win32' ? arg.length : Buffer.byteLength(arg, 'utf8'))
    + 3, 0);
}

export function piSpawnArgvBudget(platform: NodeJS.Platform): number | null {
  if (platform === 'win32') return PI_WINDOWS_SPAWN_ARGV_BUDGET;
  if (platform === 'darwin' || platform === 'linux') return PI_POSIX_SPAWN_ARGV_BUDGET;
  return null;
}

export function assertPiSpawnArgvFitsPlatform(
  args: readonly string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const budget = piSpawnArgvBudget(platform);
  if (budget === null) return;
  const length = estimateSpawnArgvLength(args, platform);
  if (length <= budget) return;

  let promptLength = 0;
  let resourceLength = 0;
  for (let index = 0; index < args.length - 1; index += 1) {
    const flag = args[index];
    if (flag === '--append-system-prompt' || flag === '--system-prompt') {
      promptLength += estimateSpawnArgvLength(args.slice(index, index + 2), platform);
      index += 1;
    } else if (flag === '--skill' || flag === '--prompt-template' || flag === '--extension') {
      resourceLength += estimateSpawnArgvLength(args.slice(index, index + 2), platform);
      index += 1;
    }
  }
  const unit = platform === 'win32' ? 'UTF-16 code units' : 'UTF-8 bytes';
  throw new Error(
    `Pi launch command line exceeds the ${platform} budget: estimated ${length} ${unit}, limit ${budget} `
    + `(prompt arguments: ${promptLength}; resource arguments: ${resourceLength}; other arguments: ${length - promptLength - resourceLength}).`,
  );
}

export function filterPiProjectCliSkills(
  skills: readonly string[],
  disabledSkillPaths: readonly string[],
): readonly string[] {
  if (disabledSkillPaths.length === 0) return skills;
  const denied = new Set<string>();
  for (const disabled of disabledSkillPaths) {
    const real = realpathOrNull(disabled) ?? path.resolve(disabled);
    denied.add(real);
    if (path.basename(real).toLowerCase() === 'skill.md') denied.add(path.dirname(real));
  }
  return Object.freeze(skills.filter((skillPath) => !denied.has(skillPath)));
}

export function piProjectResourceCliArgs(paths: PiProjectResourceCliPaths): string[] {
  return [
    ...paths.skills.flatMap((skillPath) => ['--skill', skillPath]),
    ...paths.promptTemplates.flatMap((promptPath) => ['--prompt-template', promptPath]),
    ...paths.extensions.flatMap((extensionPath) => ['--extension', extensionPath]),
  ];
}
