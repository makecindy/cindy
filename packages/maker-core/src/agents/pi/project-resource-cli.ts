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

/**
 * 启动快照:spawn 时冻结的项目资源清单 + watch root 的 mtime 基线。
 * paths 是未经禁用过滤的原始收集结果(与后续 fresh collect 同口径可比)。
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
   * 嵌套目录 git init 在无实际资源变化时多余回收。必须与 watchRootMtimes 同批采样
   * (都先于 paths 收集),否则窗口内新旧边界会与路径集合错配。 */
  readonly state: { repoRoot: string };
}

/**
 * 收集漂移快检要盯的目录 mtime 基线。目录集合必须覆盖 collector 实际枚举的
 * 每一层目录:在已存在的子目录内增删条目只改该子目录自身的 mtime,父目录不动,
 * 漏盯哪层就在哪层漏检(如已有 namespace 下增删 skill、已有扩展目录内补 index.ts、
 * 已有 skill 目录内删 SKILL.md):
 * - `<wd>/.pi` 本身 + `.pi/skills` / `.pi/prompts` / `.pi/extensions`
 * - `.pi/skills` 与 `.agents/skills` 各自的两层 skill 树(skills 根、namespace 级、
 *   namespace 内 skill 级;与 collector 的枚举深度一致,不往更深处看)
 * - `.pi/extensions` 的每个子目录(index.ts 增删只改子目录 mtime)
 * - cwd→git root 链上每级的 `.agents` + `.agents/skills`
 * 不含 workingDir 本身:往项目根丢无关文件不应触发全量重扫。
 */
export function collectPiProjectResourceWatchRootMtimes(workingDir: string, repoRootHint?: string): Map<string, number> {
  const roots = new Map<string, number>();
  const scanRoot = realpathOrNull(workingDir) ?? path.resolve(workingDir);
  if (!isDir(scanRoot)) return roots;
  const repoRoot = repoRootHint ?? (findNearestGitRoot(scanRoot) ?? scanRoot);
  const piDir = path.join(scanRoot, '.pi');
  roots.set(piDir, statMtimeMs(piDir));
  watchPiSkillTreeMtimes(roots, path.join(piDir, 'skills'));
  watchPiPromptTargets(roots, path.join(piDir, 'prompts'), repoRoot);
  watchPiExtensionChildMtimes(roots, path.join(piDir, 'extensions'));
  let current = scanRoot;
  while (true) {
    const agentsDir = path.join(current, '.agents');
    roots.set(agentsDir, statMtimeMs(agentsDir));
    watchPiSkillTreeMtimes(roots, path.join(agentsDir, 'skills'));
    if (current === repoRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/**
 * stat 一个 skills 根及其下 collector 实际枚举的两层子目录。statSync 跟随符号
 * 链接:软链 skill 的增删由父目录 mtime 捕获,软链目标内的 SKILL.md 增删由目标
 * 目录 mtime 捕获,与 realpath 收集口径一致。跳过 collector 不枚举的子树
 * (隐藏/bak、软链 namespace、剪枝名),避免无关变化触发无谓重扫。
 */
function watchPiSkillTreeMtimes(roots: Map<string, number>, skillsDir: string): void {
  roots.set(skillsDir, statMtimeMs(skillsDir));
  if (!isDir(skillsDir)) return;
  for (const entry of listDir(skillsDir)) {
    if (entry.name.startsWith('.') || /\.bak\.\d+$/.test(entry.name)) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const childPath = path.join(skillsDir, entry.name);
    roots.set(childPath, statMtimeMs(childPath));
    const realChild = realpathOrNull(childPath);
    if (!realChild || !isDir(realChild)) continue;
    // 清单本体无论当前是否解析都盯住:悬空链(目标尚不存在)落地成 skill 时,
    // 改动的只是未盯视的目标处,盯住链接自身才能检出(与 prompts 同款)。
    // 直链 skill 根同样适用:其 SKILL.md 为二级软链时,目标移动/删除只改目标处,
    // 跟随后的目录与 skills 根 mtime 都不动,必须先记清单本体再跳过软链目录。
    watchPiSkillManifestTargets(roots, realChild);
    if (entry.isSymbolicLink()) continue;
    if (hasSkillFile(realChild)) continue; // skill 目录:collector 不再往里枚举
    if (shouldPruneSkillScanDirectory(entry.name)) continue; // collector 剪枝的 namespace
    for (const nested of listDir(realChild)) {
      if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
      if (!nested.isDirectory() && !nested.isSymbolicLink()) continue;
      const nestedPath = path.join(realChild, nested.name);
      roots.set(nestedPath, statMtimeMs(nestedPath));
      const realNested = realpathOrNull(nestedPath);
      if (!realNested || !isDir(realNested)) continue;
      // 同上层:悬空的嵌套清单(.pi/skills/@scope/foo/SKILL.md 为悬空软链)也要盯住本体
      watchPiSkillManifestTargets(roots, realNested);
    }
  }
}

/** 软链清单本体:SKILL.md/skill.md 为指向仓内目标的软链时,目标移动/删除不改变
 * skill 目录自身 mtime,只有盯住解析后的文件才能检出(与 prompts 同款)。悬空链
 * 盯链接自身,目标落地即检出。 */
function watchPiSkillManifestTargets(roots: Map<string, number>, realFolder: string): void {
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
    roots.set(realManifest ?? manifestPath, statMtimeMs(realManifest ?? manifestPath));
  }
}

/** stat 一个 extensions 根及其子目录:已有扩展目录内 index.ts 增删只改子目录 mtime。 */
function watchPiExtensionChildMtimes(roots: Map<string, number>, extDir: string): void {
  roots.set(extDir, statMtimeMs(extDir));
  if (!isDir(extDir)) return;
  for (const entry of listDir(extDir)) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const childPath = path.join(extDir, entry.name);
    roots.set(childPath, statMtimeMs(childPath));
    const realChild = realpathOrNull(childPath);
    if (!realChild || !isDir(realChild)) continue;
    // 软链 index.ts 的目标增删只改目标处,collector 按解析路径收集,盯住解析后的本体。
    const realIndex = path.join(realChild, 'index.ts');
    roots.set(realIndex, statMtimeMs(realIndex));
  }
}

/**
 * stat 一个 prompts 根及其中 collector 实际接受的每个模板文件的**解析后目标**:
 * `.pi/prompts/foo.md` 为仓内符号链接时,链接自身的增删由 prompts 根 mtime 捕获,
 * 但目标文件的移动/删除只改目标处。statSync 跟随软链,目标缺失时为 -1,与
 * realpath 收集口径一致。枚举条件与 collector 逐条对应(隐藏/非 .md 跳过)。
 */
function watchPiPromptTargets(roots: Map<string, number>, promptsDir: string, repoRoot: string): void {
  roots.set(promptsDir, statMtimeMs(promptsDir));
  if (!isDir(promptsDir)) return;
  for (const entry of listDir(promptsDir)) {
    if (entry.name.startsWith('.') || !entry.name.endsWith('.md')) continue;
    const entryPath = path.join(promptsDir, entry.name);
    const realFile = realpathOrNull(entryPath);
    if (!realFile || !isFile(realFile) || !isWithinRoot(repoRoot, realFile)) {
      // 悬空软链(或目标越界):把链接自身入盯视 —— 目标落地时 statSync 解析到
      // 新 mtime(未盯视目录里的变化也能触发重扫);普通文件不存在此形态。
      if (entry.isSymbolicLink()) roots.set(entryPath, statMtimeMs(entryPath));
      continue;
    }
    roots.set(realFile, statMtimeMs(realFile));
  }
}

/**
 * 冻结一份启动快照。watchRootMtimes 与 repoRoot 必须由调用方在收集 paths **之前**
 * 采样传入(见 pi/index.ts 调用点):三样同批且基线在前,采样窗口内新增的资源只会
 * 让首次快检多一次重扫后收敛;反过来(先收集后采样)会漏掉窗口内新增的资源,或让
 * 新旧边界与路径集合错配,静默漏检。
 */
export function snapshotPiProjectResourceLaunch(
  workingDir: string,
  paths: PiProjectResourceCliPaths,
  watchRootMtimes: Map<string, number>,
  repoRoot: string,
): PiProjectResourceLaunchSnapshot {
  return Object.freeze({
    workingDir,
    paths,
    watchRootMtimes,
    state: { repoRoot },
  });
}

function samePiResourceList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * 盘上项目资源相对启动快照是否已漂移(argv 重算后会不同)。结构性契约:
 * **每次调用至多一次全量路径收集**。两级信号 → 一次收集 → 一次比较:
 * 1. stat 扫描(零收集):所有 watch root 的 mtime 与基线全等(含缺失态 -1)且
 *    git 边界未变 → 无漂移;任一不等或有信号 → 进入下一步。信号源:
 *    - watch root mtime 变化(资源增删只改所在目录自身 mtime,基线必须覆盖
 *      collector 实际枚举的每一层目录);
 *    - git 边界变化(更近的 .git 出现/消失会改变 collector 的枚举链,但不动
 *      任何被盯目录的 mtime)。
 * 2. 全量重扫,按最终路径集合判定(argv 的输入是集合,不是内容):
 *    - 集合不同 → 漂移,返回 true(不动基线,调用方将回收运行时并重建快照);
 *    - 集合相同(触碰无关目录 / git init 未截断任何资源)→ 不算漂移,就地重建
 *      整张基线(新建的空 namespace / 空扩展目录纳入盯视)并更新边界持有者,
 *      下一次快检恢复零收集。
 */
export function piProjectResourcesDrifted(snapshot: PiProjectResourceLaunchSnapshot): boolean {
  // 本次调用只解析一次 git root,贯穿传给所有收集器;独立探测会在重扫窗口内
  // 采出不一致的边界+盯视面(.git 消失时 watch 面停在旧根、集合来自新根)。
  const repoRoot = resolvePiResourceRepoRoot(snapshot.workingDir);
  const boundaryChanged = repoRoot !== snapshot.state.repoRoot;
  let mtimeChanged = false;
  for (const [dir, mtimeAtLaunch] of snapshot.watchRootMtimes) {
    if (statMtimeMs(dir) !== mtimeAtLaunch) {
      mtimeChanged = true;
      break;
    }
  }
  if (!boundaryChanged && !mtimeChanged) return false;

  // 重扫与启动同序:先采样 watch 基线,再收集路径 —— 重扫窗口内新增的资源落在
  // 基线之后,下次快检仍会检出;反序(先路径后基线)会把新 mtime 与旧集合固化在
  // 一起,静默漏检。
  const freshRoots = collectPiProjectResourceWatchRootMtimes(snapshot.workingDir, repoRoot);
  const fresh = collectPiProjectResourceCliPaths(snapshot.workingDir, repoRoot);
  if (!(
    samePiResourceList(fresh.skills, snapshot.paths.skills)
    && samePiResourceList(fresh.promptTemplates, snapshot.paths.promptTemplates)
    && samePiResourceList(fresh.extensions, snapshot.paths.extensions)
  )) {
    return true;
  }

  // 有信号但集合未变:整表重建(新建的空目录/解析后的 prompt 目标纳入盯视)
  // 并更新边界持有者,下一次快检恢复零收集。重建后复核边界:重扫窗口内
  // .git 又动了就按漂移交回收路径重建(下次快检从一致的新快照出发),
  // 不把混合口径的基线/边界写回快照。
  if (resolvePiResourceRepoRoot(snapshot.workingDir) !== repoRoot) return true;
  snapshot.watchRootMtimes.clear();
  for (const [dir, mtime] of freshRoots) snapshot.watchRootMtimes.set(dir, mtime);
  snapshot.state.repoRoot = repoRoot;
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
