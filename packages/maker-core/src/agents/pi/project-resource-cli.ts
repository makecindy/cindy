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
 * 兜底:软链 namespace 不枚举(可越界/成环)这条规则在 Windows 上也必须成立。 */
function isSymlinkEntry(entry: fs.Dirent, absPath: string): boolean {
  return entry.isSymbolicLink() || (entry.isDirectory() && isSymlinkDirectory(absPath));
}

function hasSkillFile(dir: string): boolean {
  return ['SKILL.md', 'skill.md'].some((name) => isFile(path.join(dir, name)));
}

/**
 * 走一遍 skills 根的两层树(collector 的枚举深度,不往更深处看)。
 * 先判清单(2 次 stat)再决定是否枚举 namespace:skill 目录不必付 readdir 代价。
 */
function collectSkillDirs(repoRoot: string, skillsDir: string, bucket: Set<string>): void {
  const resolvedDir = realpathOrNull(skillsDir);
  if (!resolvedDir || !isDir(resolvedDir) || !isWithinRoot(repoRoot, resolvedDir)) return;

  // 清单经 realpath 后须仍在仓内,否则这个目录不算本项目的 skill。
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
    if (isSymlinkEntry(entry, candidatePath)) continue;
    if (shouldPruneSkillScanDirectory(entry.name)) continue; // node_modules/dist 等生成目录

    // At most one namespace/author level: <root>/<namespace>/<skill>.
    for (const nested of listDir(realFolder)) {
      if (nested.name.startsWith('.') || /\.bak\.\d+$/.test(nested.name)) continue;
      const nestedFolder = realpathOrNull(path.join(realFolder, nested.name));
      if (!nestedFolder || !isDir(nestedFolder) || !isWithinRoot(repoRoot, nestedFolder)) continue;
      if (hasSkillFile(nestedFolder)) addSkill(nestedFolder);
    }
  }
}

/**
 * 收集 Pi CLI 需要加载的项目资源路径。这是 argv 资源段的**唯一产出点** ——
 * 漂移检测也复用同一个函数(见 piProjectResourcesDrifted),所以「检测」与
 * 「实际使用」不可能描述同一份事实两次。
 */
export function collectPiProjectResourceCliPaths(workingDir: string): PiProjectResourceCliPaths {
  if (!workingDir || !path.isAbsolute(workingDir) || !isDir(workingDir)) {
    return emptyPiProjectResourceCliPaths();
  }
  const scanRoot = realpathOrNull(workingDir) ?? path.resolve(workingDir);
  const repoRoot = findNearestGitRoot(scanRoot) ?? scanRoot;
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

/**
 * 启动快照 = spawn 时**实际交给 CLI 的资源路径集合** + 比较口径。
 *
 * 刻意只有这两样:任何额外的「基线」都是对 collector 消费方式的手写镜像,而镜像
 * 与实现必然随时间分歧(2026-11-10 六轮 review 的六类漏检全部来自这种分歧:身份
 * 采样晚于收集、窗口复核比错基线、软链键跳读过头、清单 TOCTOU、剪枝目录全列表、
 * 软链 namespace 全列表)。没有镜像就没有分歧。
 */
export interface PiProjectResourceLaunchSnapshot {
  readonly workingDir: string;
  /** spawn 时 argv 里的资源路径集合。漂移 = 现在采集一遍是否仍等于它。 */
  readonly paths: PiProjectResourceCliPaths;
  /** 采集 → argv 的唯一口径(受邀者裁剪 + 停用技能过滤)。启动与比较都用它:
   * 少了它,受邀者会拿全量比裁剪基线恒判漂移(回收死循环),停用技能的增删会
   * 被当成漂移(白等一次冷启动)。 */
  readonly toCliPaths: ((collected: PiProjectResourceCliPaths) => PiProjectResourceCliPaths) | null;
}

export function snapshotPiProjectResourceLaunch(
  workingDir: string,
  paths: PiProjectResourceCliPaths,
  toCliPaths?: (collected: PiProjectResourceCliPaths) => PiProjectResourceCliPaths,
): PiProjectResourceLaunchSnapshot {
  return Object.freeze({ workingDir, paths, toCliPaths: toCliPaths ?? null });
}

function samePiResourceList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * 盘上项目资源是否已偏离运行时实际使用的 argv。
 *
 * 判定 = 用 collector 采集一遍,与快照里的集合逐项相等比较。**没有任何其他信号**:
 * - argv 的输入是路径集合,不是内容 → 集合相等即无需回收(改文件内容/在已收集的
 *   skill 目录里加文件都不影响 argv);
 * - 采集按 realpath 出路径 → 软链改指到别处(哪怕 mtime 逐位相同)必然改变集合;
 * - 清单后落地、模板目标移动、扩展目录补 index.ts → 都直接改变集合;
 * - 与时间戳无关 → 同一 tick 内的增删不会漏(不需要 mtime 或条目指纹)。
 *
 * 代价:每次空闲发送前一次采集(约「每目录 1 readdir + 每资源 3~5 stat」,与过去
 * 那套 mtime/身份快检的 syscall 数量同量级)。这是买「结构上不可能分歧」付的钱;
 * 若将来资源规模大到有感知,应当减采集范围,不要恢复基线镜像。
 */
export function piProjectResourcesDrifted(snapshot: PiProjectResourceLaunchSnapshot): boolean {
  const fresh = collectPiProjectResourceCliPaths(snapshot.workingDir);
  const compare = snapshot.toCliPaths ? snapshot.toCliPaths(fresh) : fresh;
  return !(
    samePiResourceList(compare.skills, snapshot.paths.skills)
    && samePiResourceList(compare.promptTemplates, snapshot.paths.promptTemplates)
    && samePiResourceList(compare.extensions, snapshot.paths.extensions)
  );
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
