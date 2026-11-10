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

function listDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
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

function hasSkillFile(dir: string): boolean {
  return ['SKILL.md', 'skill.md'].some((name) => isFile(path.join(dir, name)));
}

function collectSkillDirs(repoRoot: string, skillsDir: string, bucket: Set<string>): void {
  const resolvedDir = realpathOrNull(skillsDir);
  if (!resolvedDir || !isDir(resolvedDir) || !isWithinRoot(repoRoot, resolvedDir)) return;

  const addSkill = (realFolder: string): void => {
    const skillMd = ['SKILL.md', 'skill.md']
      .map((name) => path.join(realFolder, name))
      .find(isFile);
    const realMd = skillMd ? realpathOrNull(skillMd) : null;
    if (realMd && isFile(realMd) && isWithinRoot(repoRoot, realMd)) bucket.add(realFolder);
  };

  for (const entry of listDir(resolvedDir)) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    const candidatePath = path.join(resolvedDir, entry.name);
    const realFolder = realpathOrNull(candidatePath);
    if (!realFolder || !isDir(realFolder) || !isWithinRoot(repoRoot, realFolder)) continue;
    if (hasSkillFile(realFolder)) {
      addSkill(realFolder);
      continue;
    }
    // Direct symlinked Skills remain supported above; a symlinked namespace
    // could escape the repo or cycle and is intentionally not walked.
    // lstat must see the unresolved path: a Windows junction may be reported
    // as a directory by readdir and by the resolved realpath.
    const isSymlink = entry.isSymbolicLink()
      || (entry.isDirectory() && isSymlinkDirectory(candidatePath));
    if (isSymlink || shouldPruneSkillScanDirectory(entry.name)) continue;

    // At most one namespace/author level: <root>/<namespace>/<skill>.
    for (const nested of listDir(realFolder)) {
      if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
      const nestedFolder = realpathOrNull(path.join(realFolder, nested.name));
      if (!nestedFolder || !isDir(nestedFolder) || !isWithinRoot(repoRoot, nestedFolder)) continue;
      if (hasSkillFile(nestedFolder)) addSkill(nestedFolder);
    }
  }
}

export function collectPiProjectResourceCliPaths(workingDir: string, repoRootHint?: string): PiProjectResourceCliPaths {
  if (!workingDir || !path.isAbsolute(workingDir) || !isDir(workingDir)) {
    return emptyPiProjectResourceCliPaths();
  }
  const scanRoot = realpathOrNull(workingDir) ?? path.resolve(workingDir);
  const repoRoot = repoRootHint ?? resolvePiResourceRepoRoot(workingDir);
  const skills = new Set<string>();
  const promptTemplates = new Set<string>();
  const extensions = new Set<string>();

  collectSkillDirs(repoRoot, path.join(scanRoot, '.pi', 'skills'), skills);
  let current = scanRoot;
  while (true) {
    collectSkillDirs(repoRoot, path.join(current, '.agents', 'skills'), skills);
    if (current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const realPrompts = realpathOrNull(path.join(scanRoot, '.pi', 'prompts'));
  if (realPrompts && isDir(realPrompts) && isWithinRoot(repoRoot, realPrompts)) {
    for (const entry of listDir(realPrompts)) {
      if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
      const realFile = realpathOrNull(path.join(realPrompts, entry.name));
      if (!realFile || !isFile(realFile) || !isWithinRoot(repoRoot, realFile)) continue;
      promptTemplates.add(realFile);
    }
  }

  const realExt = realpathOrNull(path.join(scanRoot, '.pi', 'extensions'));
  if (realExt && isDir(realExt) && isWithinRoot(repoRoot, realExt)) {
    for (const entry of listDir(realExt)) {
      if (entry.name.startsWith('.')) continue;
      const realChild = realpathOrNull(path.join(realExt, entry.name));
      if (!realChild || !isWithinRoot(repoRoot, realChild)) continue;
      if (isFile(realChild) && realChild.endsWith('.ts')) {
        extensions.add(realChild);
        continue;
      }
      if (!isDir(realChild)) continue;
      const realIndex = realpathOrNull(path.join(realChild, 'index.ts'));
      if (realIndex && isFile(realIndex) && isWithinRoot(repoRoot, realIndex)) {
        extensions.add(realIndex);
      }
    }
  }

  return Object.freeze({
    skills: Object.freeze([...skills].sort(comparePiResourcePaths)),
    promptTemplates: Object.freeze([...promptTemplates].sort(comparePiResourcePaths)),
    extensions: Object.freeze([...extensions].sort(comparePiResourcePaths)),
  });
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
  /** 每个 watch root 的 readdir 条目名指纹:时间戳粒度盲区(同一 tick 内增删,
   * mtime 与基线逐位相等)的第二信号;与 watchRootMtimes 同 key 同批。 */
  readonly watchRootEntries: Map<string, string>;
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
  /** key → readdir 条目名指纹(排序拼接;文件键/缺失恒 '')。时间戳粒度盲区
   * (同一 tick 内增删,mtime 与基线逐位相等)的第二信号;变化只作重扫信号,
   * 判决仍归路径集合。 */
  readonly entries: Map<string, string>;
  /** key → realpath 解析身份(缺失 null),与 mtimes 同 key 同批。 */
  readonly resolved: Map<string, string | null>;
}

function recordWatchKey(sample: PiProjectResourceLaunchWatch, target: string): void {
  // 解析身份先行:身份与 mtime/条目之间的窗口不一致只会多一次重扫,不会固化。
  sample.resolved.set(target, realpathOrNull(target));
  sample.mtimes.set(target, statMtimeMs(target));
  sample.entries.set(target, readDirEntryFingerprint(target));
}

/**
 * 收集漂移快检要盯的目录基线(mtime + 条目指纹 + 解析身份,同一次遍历)。目录
 * 集合必须覆盖 collector 实际枚举的每一层目录:在已存在的子目录内增删条目只改
 * 该子目录自身的 mtime,父目录不动,漏盯哪层就在哪层漏检(如已有 namespace 下
 * 增删 skill、已有扩展目录内补 index.ts、已有 skill 目录内删 SKILL.md):
 * - `<wd>/.pi` 本身 + `.pi/skills` / `.pi/prompts` / `.pi/extensions`
 * - `.pi/skills` 与 `.agents/skills` 各自的两层 skill 树(skills 根、namespace 级、
 *   namespace 内 skill 级;与 collector 的枚举深度一致,不往更深处看)
 * - `.pi/extensions` 的每个子目录(index.ts 增删只改子目录 mtime)
 * - cwd→git root 链上每级的 `.agents` + `.agents/skills`
 * 不含 workingDir 本身:往项目根丢无关文件不应触发全量重扫。
 */
export function collectPiProjectResourceLaunchWatch(workingDir: string, repoRootHint?: string): PiProjectResourceLaunchWatch {
  const sample: PiProjectResourceLaunchWatch = {
    scanRootResolved: realpathOrNull(workingDir),
    mtimes: new Map(),
    entries: new Map(),
    resolved: new Map(),
  };
  const scanRoot = sample.scanRootResolved ?? path.resolve(workingDir);
  if (!isDir(scanRoot)) return sample;
  const repoRoot = repoRootHint ?? (findNearestGitRoot(scanRoot) ?? scanRoot);
  const piDir = path.join(scanRoot, '.pi');
  recordWatchKey(sample, piDir);
  watchPiSkillTreeMtimes(sample, path.join(piDir, 'skills'));
  watchPiPromptTargets(sample, path.join(piDir, 'prompts'), repoRoot);
  watchPiExtensionChildMtimes(sample, path.join(piDir, 'extensions'));
  let current = scanRoot;
  while (true) {
    const agentsDir = path.join(current, '.agents');
    recordWatchKey(sample, agentsDir);
    watchPiSkillTreeMtimes(sample, path.join(agentsDir, 'skills'));
    if (current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return sample;
}

/**
 * stat 一个 skills 根及其下 collector 实际枚举的两层子目录。statSync 跟随符号
 * 链接:软链 skill 的增删由父目录 mtime 捕获,软链目标内的 SKILL.md 增删由目标
 * 目录 mtime 捕获,与 realpath 收集口径一致。跳过 collector 不枚举的子树
 * (隐藏/bak、软链 namespace、剪枝名),避免无关变化触发无谓重扫。
 */
function watchPiSkillTreeMtimes(sample: PiProjectResourceLaunchWatch, skillsDir: string): void {
  recordWatchKey(sample, skillsDir);
  if (!isDir(skillsDir)) return;
  for (const entry of listDir(skillsDir)) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const childPath = path.join(skillsDir, entry.name);
    recordWatchKey(sample, childPath);
    const realChild = realpathOrNull(childPath);
    if (!realChild || !isDir(realChild)) continue;
    // 清单本体无论当前是否解析都盯住:悬空链(目标尚不存在)落地成 skill 时,
    // 改动的只是未盯视的目标处,盯住链接自身才能检出(与 prompts 同款)。
    // 直链 skill 根同样适用:其 SKILL.md 为二级软链时,目标移动/删除只改目标处,
    // 跟随后的目录与 skills 根 mtime 都不动,必须先记清单本体再跳过软链目录。
    watchPiSkillManifestTargets(sample, realChild);
    // 与 collector 同口径判定软链(含 readdir 把 junction 报成目录的形态):
    // 软链 namespace collector 明文不枚举,盯视面不得混入目标树内的键。
    if (isSymlinkEntry(entry, childPath)) continue;
    if (hasSkillFile(realChild)) continue; // skill 目录:collector 不再往里枚举
    if (shouldPruneSkillScanDirectory(entry.name)) continue; // collector 剪枝的 namespace
    for (const nested of listDir(realChild)) {
      if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
      if (!nested.isDirectory() && !nested.isSymbolicLink()) continue;
      const nestedPath = path.join(realChild, nested.name);
      recordWatchKey(sample, nestedPath);
      const realNested = realpathOrNull(nestedPath);
      if (!realNested || !isDir(realNested)) continue;
      // 同上层:悬空的嵌套清单(.pi/skills/@scope/foo/SKILL.md 为悬空软链)也要盯住本体
      watchPiSkillManifestTargets(sample, realNested);
    }
  }
}

/** 软链清单本体:SKILL.md/skill.md 为指向仓内目标的软链时,目标移动/删除不改变
 * skill 目录自身 mtime,只有盯住解析后的文件才能检出(与 prompts 同款)。悬空链
 * 盯链接自身,目标落地即检出。 */
function watchPiSkillManifestTargets(sample: PiProjectResourceLaunchWatch, realFolder: string): void {
  for (const name of ['SKILL.md', 'skill.md']) {
    const manifestPath = path.join(realFolder, name);
    let manifestLstat: fs.Stats;
    try {
      manifestLstat = fs.lstatSync(manifestPath);
    } catch {
      continue;
    }
    if (!manifestLstat.isSymbolicLink()) continue;
    const realManifest = realpathOrNull(manifestPath);
    recordWatchKey(sample, realManifest ?? manifestPath);
  }
}

/** stat 一个 extensions 根及其子目录:已有扩展目录内 index.ts 增删只改子目录 mtime。 */
function watchPiExtensionChildMtimes(sample: PiProjectResourceLaunchWatch, extDir: string): void {
  recordWatchKey(sample, extDir);
  if (!isDir(extDir)) return;
  for (const entry of listDir(extDir)) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const childPath = path.join(extDir, entry.name);
    recordWatchKey(sample, childPath);
    const realChild = realpathOrNull(childPath);
    if (!realChild || !isDir(realChild)) continue;
    // 软链 index.ts 的目标增删只改目标处,collector 按解析路径收集,盯住解析后的本体。
    const realIndex = path.join(realChild, 'index.ts');
    recordWatchKey(sample, realIndex);
  }
}

/**
 * stat 一个 prompts 根及其中 collector 实际接受的每个模板文件的**解析后目标**:
 * `.pi/prompts/foo.md` 为仓内符号链接时,链接自身的增删由 prompts 根 mtime 捕获,
 * 但目标文件的移动/删除只改目标处。statSync 跟随软链,目标缺失时为 -1,与
 * realpath 收集口径一致。枚举条件与 collector 逐条对应(隐藏/非 .md 跳过)。
 */
function watchPiPromptTargets(sample: PiProjectResourceLaunchWatch, promptsDir: string, repoRoot: string): void {
  recordWatchKey(sample, promptsDir);
  if (!isDir(promptsDir)) return;
  for (const entry of listDir(promptsDir)) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
    const entryPath = path.join(promptsDir, entry.name);
    const realFile = realpathOrNull(entryPath);
    if (!realFile || !isFile(realFile) || !isWithinRoot(repoRoot, realFile)) {
      // 悬空软链(或目标越界):把链接自身入盯视 —— 目标落地时 statSync 解析到
      // 新 mtime(未盯视目录里的变化也能触发重扫);普通文件不存在此形态。
      if (entry.isSymbolicLink()) recordWatchKey(sample, entryPath);
      continue;
    }
    recordWatchKey(sample, realFile);
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
  // 条目名指纹:时间戳粒度盲区(同一 tick 内增删,mtime 逐位不变)的第二信号。
  let entriesChanged = false;
  for (const [dir, fingerprintAtLaunch] of snapshot.watchRootEntries) {
    if (readDirEntryFingerprint(dir) !== fingerprintAtLaunch) {
      entriesChanged = true;
      break;
    }
  }
  if (!boundaryChanged && !resolvedWorkingDirChanged && !resolvedRootChanged && !mtimeChanged && !entriesChanged) return false;

  // 重扫与启动同序:先采样 watch 基线,再收集路径 —— 重扫窗口内新增的资源落在
  // 基线之后,下次快检仍会检出;反序(先路径后基线)会把新 mtime 与旧集合固化在
  // 一起,静默漏检。
  const freshRoots = collectPiProjectResourceLaunchWatch(snapshot.workingDir, repoRoot);
  const fresh = collectPiProjectResourceCliPaths(snapshot.workingDir, repoRoot);
  // 受邀者:比较前对 fresh 做与启动相同的裁剪,否则全量比裁剪基线恒判漂移。
  const freshForCompare = snapshot.restrict ? snapshot.restrict(fresh) : fresh;
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
  for (const [dir, mtime] of freshRoots.mtimes) snapshot.watchRootMtimes.set(dir, mtime);
  snapshot.watchRootsResolved.clear();
  for (const [dir, resolved] of freshRoots.resolved) snapshot.watchRootsResolved.set(dir, resolved);
  snapshot.watchRootEntries.clear();
  for (const [dir, fingerprint] of freshRoots.entries) snapshot.watchRootEntries.set(dir, fingerprint);
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
