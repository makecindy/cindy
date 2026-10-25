/**
 * worktree-parallel-sessions: worktree include 文件解析与拷贝引擎。
 *
 * 两个文件都位于 baseRepo 根目录, 规则合并生效（任一文件选中即复制）:
 *   - `.xdtworktreeinclude`: Cindy 原有格式, 每行一个 glob, 相对 baseRepo 根目录
 *   - `.worktreeinclude`:    Claude Code 的同名约定, 按 `.gitignore` 语法解析
 * worktree 创建后, 把匹配的(且 git 不跟踪的)文件按相对路径复制到 worktree 路径下,
 * 用于带过去 .env / 本地 build 产物 / IDE 配置等不入库的本地文件。
 *
 * 规则:
 *   - 每行 trim
 *   - 跳过空行 + `#` 开头注释
 *   - 其余作为 glob(支持 `*` `**` `?` 和绝对路径不支持, 仅 baseRepo 相对)
 *   - per file 状态:
 *       skipped-not-exist | skipped-tracked | skipped-existing | copied | copied-symlink | failed
 *
 * 不依赖外部 glob 库——用 node:fs.readdirSync 递归 + 自实现简单 glob match。
 */

import path from "node:path";

import fs from "node:fs";
import type { WorktreeManagerPorts } from "./managerPorts.js";
import { MANAGED_WORKTREE_DIR_NAMES } from "@cindy/maker-shared/worktree-paths";

export type IncludeFileStatus =
  | "skipped-not-exist"
  | "skipped-tracked"
  | "skipped-existing"
  | "skipped-outside"
  | "copied"
  | "copied-symlink"
  | "failed";

export interface CopyWorktreeIncludeOptions {
  /** 默认覆盖目标；恢复脏快照后可关闭，避免覆盖刚还原的未跟踪文件。 */
  overwriteExisting?: boolean;
}

export interface IncludeFileResult {
  /** baseRepo 相对路径(用 / 分隔, 跨平台一致)。 */
  relpath: string;
  status: IncludeFileStatus;
  error?: string;
}

export interface ChangedIncludeFile {
  relpath: string;
  reason:
    | "missing"
    | "type-mismatch"
    | "content-differs"
    | "symlink-differs"
    | "outside"
    /** 只存在于 worktree、base 侧没有的 include 匹配文件（删除会丢，无法从 base 重拷）。 */
    | "dest-only";
}

/** 判断 baseRepo 相对路径(/ 分隔)是否被 include 规则选中。 */
type IncludeMatcher = (relpath: string) => boolean;
export function createWorktreeIncludeEngine(
  ports: Pick<WorktreeManagerPorts, "gitExec">,
) {
  const { gitExec } = ports;

  /**
   * 解析 `.xdtworktreeinclude` 内容, 返回去重后的 pattern 列表。
   * 该函数不读文件——上层先 read 再传给本函数, 便于测试。
   */
  function parseWorktreeIncludePatterns(content: string): string[] {
    return [...new Set(includeRuleLines(content))];
  }

  /** 去掉空行与 `#` 注释后的规则行, 保留重复与原始顺序(`.gitignore` 语法依赖顺序)。 */
  function includeRuleLines(content: string): string[] {
    if (!content) return [];
    return content
      .split(/\r?\n/)
      .map((raw) => raw.trim())
      .filter((line) => line && !line.startsWith("#"));
  }

  /**
   * 把 glob pattern 转为 RegExp。仅支持基本通配:
   *   *  → [^/]*
   *   ** → .*
   *   ?  → [^/]
   *   其他字符按字面 escape
   *
   * 测试覆盖在 nameGenerator 隔壁的 includePatternsEngine.test.ts。
   */
  function globToRegex(glob: string): RegExp {
    // 占位 `**/` 与孤立 `**` 区分开:
    //   `**/foo`   ⇔ 0 或多段目录 + foo  → `(?:.*\/)?foo`
    //   `foo/**`   ⇔ foo/ 下任意路径 + 任意子项 → `foo\/.*`
    //   `a/**/b`   ⇔ 中段 0+ 目录          → `a(?:\/.*)?\/b`
    //   单 `*`     ⇔ 单段不跨 /            → `[^/]*`
    //   单 `?`     ⇔ 单字符不跨 /          → `[^/]`
    //
    // 实现: 先把 `**/` 和 `/**` 替换为占位, 再转义其他字符, 最后还原占位。
    const PH_LEADING = "\u0000DSL\u0000"; // **/ at start
    const PH_TRAILING = "\u0000DST\u0000"; // /** at end / inline
    const PH_BARE = "\u0000DSB\u0000"; // ** alone (无 /)
    let p = glob;
    // 处理顺序: trailing `/**` → leading `**/` → bare `**`
    p = p.replace(/\/\*\*/g, PH_TRAILING);
    p = p.replace(/\*\*\//g, PH_LEADING);
    p = p.replace(/\*\*/g, PH_BARE);
    // 转义正则元字符
    p = p.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // 单星 → 不跨 / 的任意字符
    p = p.replaceAll("*", "[^/]*");
    // 单 ? → 不跨 / 的单字符
    p = p.replaceAll("?", "[^/]");
    // 还原占位:
    //   `**/`  → `(?:.*\/)?` 0 或多段(含尾 /)
    //   `/**`  → `(?:\/.*)?` 0 或多段(含头 /)
    //   `**`   → `.*`
    p = p.replaceAll(PH_LEADING, "(?:.*\\/)?");
    p = p.replaceAll(PH_TRAILING, "(?:\\/.*)?");
    p = p.replaceAll(PH_BARE, ".*");
    return new RegExp(`^${p}$`);
  }

  function globMatcher(patterns: readonly string[]): IncludeMatcher {
    const regexes = patterns.map(globToRegex);
    return (rel) => regexes.some((re) => re.test(rel));
  }

  /**
   * `.gitignore` 语法的 glob → RegExp(与 `.xdtworktreeinclude` 的 globToRegex 分开):
   * 只有独占一段的 `**` 跨目录(开头或中间的 `**` 段表示 0 或多级目录);
   * 段内的 `**`(如 `secret**.json`)与 `*` 相同, 不跨 `/`。
   */
  function gitignoreGlobToRegex(glob: string): RegExp {
    const segments = glob.split("/");
    let out = "";
    segments.forEach((segment, i) => {
      const last = i === segments.length - 1;
      if (segment === "**") {
        out += last ? ".*" : "(?:.*\\/)?";
        return;
      }
      out += segment
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*+/g, "[^/]*")
        .replaceAll("?", "[^/]");
      if (!last) out += "\\/";
    });
    return new RegExp(`^${out}$`);
  }

  /**
   * 按 `.gitignore` 语法匹配(Claude Code 的 `.worktreeinclude` 约定):
   *   - 不含 `/` 的规则匹配任意层级; 含 `/`(或以 `/` 开头)时相对仓库根目录
   *   - 末尾 `/` 只匹配目录; 选中目录即包含其下全部文件; 末尾 `/**` 只选目录里的内容
   *   - `!` 取反, 后面的规则覆盖前面的(规则须保留重复与原始顺序)
   * `[...]` 字符类与 `\` 转义不支持, 按字面处理。
   */
  function gitignoreMatcher(patterns: readonly string[]): IncludeMatcher {
    const rules: { re: RegExp; negate: boolean; dirOnly: boolean }[] = [];
    for (const raw of patterns) {
      const negate = raw.startsWith("!");
      let p = negate ? raw.slice(1) : raw;
      // `config/**` 等价于根目录下的 `config/`: 只选目录内容, 不选同名普通文件。
      const contentsOnly = p.endsWith("/**");
      if (contentsOnly) p = p.slice(0, -3);
      const dirOnly = contentsOnly || p.endsWith("/");
      if (p.endsWith("/")) p = p.slice(0, -1);
      const anchored = contentsOnly || p.includes("/");
      if (p.startsWith("/")) p = p.slice(1);
      if (!p) {
        // 单独的 `/**` 是仓库根目录里的全部内容。
        if (contentsOnly) rules.push({ re: /^.+$/, negate, dirOnly: false });
        continue;
      }
      rules.push({
        re: gitignoreGlobToRegex(anchored ? p : `**/${p}`),
        negate,
        dirOnly,
      });
    }
    return (rel) => {
      const segments = rel.split("/");
      const dirs = segments
        .slice(1)
        .map((_, i) => segments.slice(0, i + 1).join("/"));
      let included = false;
      for (const rule of rules) {
        const hit =
          (!rule.dirOnly && rule.re.test(rel)) ||
          dirs.some((dir) => rule.re.test(dir));
        if (hit) included = !rule.negate;
      }
      return included;
    };
  }

  const INCLUDE_FILES = [
    { name: ".xdtworktreeinclude", toMatcher: globMatcher },
    { name: ".worktreeinclude", toMatcher: gitignoreMatcher },
  ] as const;

  /** 读取 baseRepo 根目录的 include 文件并合并规则; 都没有有效规则时返回 null。 */
  function readIncludeMatcher(baseRepo: string): IncludeMatcher | null {
    const matchers: IncludeMatcher[] = [];
    for (const { name, toMatcher } of INCLUDE_FILES) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(baseRepo, name), "utf8");
      } catch {
        continue;
      }
      const patterns = includeRuleLines(content);
      if (patterns.length > 0) matchers.push(toMatcher(patterns));
    }
    if (matchers.length === 0) return null;
    return (rel) => matchers.some((matches) => matches(rel));
  }

  /**
   * 递归列出 baseRepo 下的所有文件相对路径(用 / 分隔)。
   * 跳过 .git/ + node_modules/ + Cindy 当前/历史托管 worktree 子树, 防止扫超量。
   */
  function listAllFiles(baseRepo: string): string[] {
    const out: string[] = [];
    const SKIP_TOP = new Set([
      ".git",
      "node_modules",
      ...MANAGED_WORKTREE_DIR_NAMES,
    ]);
    function walk(absDir: string, relDir: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const ent of entries) {
        // 仅在顶层过滤 SKIP_TOP, 子目录里同名仍允许(罕见但合理)
        if (relDir === "" && SKIP_TOP.has(ent.name)) continue;
        const childRel = relDir ? `${relDir}/${ent.name}` : ent.name;
        const childAbs = path.join(absDir, ent.name);
        if (ent.isDirectory()) {
          walk(childAbs, childRel);
        } else if (ent.isFile() || ent.isSymbolicLink()) {
          out.push(childRel);
        }
      }
    }
    walk(baseRepo, "");
    return out;
  }

  /**
   * 用 git ls-files --error-unmatch 判断每个相对路径是否被 git tracked。
   * 一次批量调用比每条 spawn 一遍 git 快 O(N) 倍。
   *
   * 返回的 Set 元素是 baseRepo 相对路径(/ 分隔)。
   */
  async function getTrackedFiles(baseRepo: string): Promise<Set<string>> {
    try {
      const { stdout } = await gitExec(["ls-files"], baseRepo);
      const set = new Set<string>();
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed) set.add(trimmed);
      }
      return set;
    } catch {
      // 失败时给空集合, 让调用方按 "都不被 tracked" 处理(更安全的兜底)
      return new Set<string>();
    }
  }

  /**
   * 目标 worktree HEAD 树(= sourceBranch)里的文件。base 未跟踪、sourceBranch 已跟踪的
   * 同名文件不能用 base 的本地副本覆盖(与 WorktreeManager 的 listProtectedClaudeSiviPaths
   * 同一口径)。查询失败按空集处理(fail-open)。
   */
  async function getHeadTreeFiles(root: string): Promise<Set<string>> {
    try {
      const { stdout } = await gitExec(
        ["ls-tree", "-r", "-z", "--name-only", "HEAD"],
        root,
      );
      return new Set(stdout.split("\0").filter(Boolean));
    } catch {
      return new Set<string>();
    }
  }

  /**
   * 由受控路径集合得到冲突判定: rel 与任一受控路径相同、是其父级(受控文件或符号链接之下)、
   * 或是其祖先目录(受控内容需要这个目录)时, 在 rel 写入都会顶掉受控内容或与后台 checkout
   * 冲突。只看 Git 记录, 不依赖它是否已经落盘。
   */
  function trackedPathConflict(
    tracked: Iterable<string>,
  ): (rel: string) => boolean {
    const files = new Set(tracked);
    const dirs = new Set<string>();
    for (const file of files) {
      for (
        let end = file.lastIndexOf("/");
        end > 0;
        end = file.lastIndexOf("/", end - 1)
      ) {
        dirs.add(file.slice(0, end));
      }
    }
    return (rel) => {
      if (dirs.has(rel)) return true;
      for (let end = rel.length; end > 0; end = rel.lastIndexOf("/", end - 1)) {
        if (files.has(rel.slice(0, end))) return true;
      }
      return false;
    };
  }

  /**
   * 把 baseRepo 下匹配 patterns 且未被 git tracked 的文件拷贝到 destRoot 下相同相对路径。
   *
   * 已存在的 dest 文件会被覆盖(fs.copyFile 默认行为)。软链复制为软链本身。
   *
   * @param baseRepo  源 repo 根目录(绝对路径)
   * @param destRoot  目标 worktree 路径(绝对路径)
   * @param patterns  parseWorktreeIncludePatterns 的输出(`.xdtworktreeinclude` glob 语法)
   * @returns per-file 结果, 用于日志 / UI 展示
   */
  async function copyWorktreeIncludeFiles(
    baseRepo: string,
    destRoot: string,
    patterns: readonly string[],
    options: CopyWorktreeIncludeOptions = {},
  ): Promise<IncludeFileResult[]> {
    if (patterns.length === 0) return [];
    return copyMatchedFiles(baseRepo, destRoot, globMatcher(patterns), options);
  }

  /**
   * 写入 destAbs 时的实际落点是否仍在 destRoot 内: 取 destAbs 自身或最近一个已存在的
   * 父级, 解析全部符号链接后比较; 悬空链接或无法解析时按越界处理。
   */
  function landsInside(destRoot: string, destAbs: string): boolean {
    let probe = destAbs;
    for (;;) {
      try {
        fs.lstatSync(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) return false;
        probe = parent;
      }
    }
    try {
      const realRoot = fs.realpathSync(destRoot);
      const real = fs.realpathSync(probe);
      return real === realRoot || real.startsWith(realRoot + path.sep);
    } catch {
      return false;
    }
  }

  async function copyMatchedFiles(
    baseRepo: string,
    destRoot: string,
    matches: IncludeMatcher,
    options: CopyWorktreeIncludeOptions,
  ): Promise<IncludeFileResult[]> {
    const matched = listAllFiles(baseRepo).filter(matches);
    if (matched.length === 0) return [];

    const [trackedInBase, trackedInDestHead] = await Promise.all([
      getTrackedFiles(baseRepo),
      getHeadTreeFiles(destRoot),
    ]);
    const conflictsWithTracked = trackedPathConflict([
      ...trackedInBase,
      ...trackedInDestHead,
    ]);
    const results: IncludeFileResult[] = [];

    for (const rel of matched) {
      const srcAbs = path.join(baseRepo, rel);
      const destAbs = path.join(destRoot, rel);

      // 安全闸门: dest 必须仍在 destRoot 下(防 .. 越权 — 即使 rel 是 listAllFiles
      // 返回的"听话"路径, 也加这道防御性检查, 免得未来改实现意外丢)
      const normalizedDest = path.resolve(destAbs);
      if (!normalizedDest.startsWith(path.resolve(destRoot) + path.sep)) {
        results.push({ relpath: rel, status: "skipped-outside" });
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(srcAbs);
      } catch {
        results.push({ relpath: rel, status: "skipped-not-exist" });
        continue;
      }

      if (conflictsWithTracked(rel)) {
        results.push({ relpath: rel, status: "skipped-tracked" });
        continue;
      }

      // 词法检查看不到符号链接: 目标(或其父目录)若是指向外部的链接, 写入会落到 worktree 外。
      if (!landsInside(destRoot, destAbs)) {
        results.push({ relpath: rel, status: "skipped-outside" });
        continue;
      }

      try {
        if (options.overwriteExisting === false) {
          try {
            fs.lstatSync(destAbs);
            results.push({ relpath: rel, status: "skipped-existing" });
            continue;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        fs.mkdirSync(path.dirname(destAbs), { recursive: true });
        if (stat.isSymbolicLink()) {
          const link = fs.readlinkSync(srcAbs);
          // 已存在的目标先 unlink, fs.symlink 不会 overwrite
          try {
            fs.unlinkSync(destAbs);
          } catch {
            /* ignore */
          }
          fs.symlinkSync(link, destAbs);
          results.push({ relpath: rel, status: "copied-symlink" });
        } else if (stat.isFile()) {
          fs.copyFileSync(srcAbs, destAbs);
          results.push({ relpath: rel, status: "copied" });
        } else {
          // 目录或特殊文件, 跳过
          results.push({ relpath: rel, status: "skipped-not-exist" });
        }
      } catch (err) {
        results.push({
          relpath: rel,
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  async function listChangedWorktreeIncludeFiles(
    baseRepo: string,
    destRoot: string,
  ): Promise<ChangedIncludeFile[]> {
    const matches = readIncludeMatcher(baseRepo);
    if (!matches) return [];

    const [trackedInBase, trackedInDest] = await Promise.all([
      getTrackedFiles(baseRepo),
      getTrackedFiles(destRoot),
    ]);
    const conflictsWithTracked = trackedPathConflict([
      ...trackedInBase,
      ...trackedInDest,
    ]);
    const changed: ChangedIncludeFile[] = [];
    const destRootResolved = path.resolve(destRoot);
    const srcFiles = listAllFiles(baseRepo);

    for (const rel of srcFiles) {
      if (!matches(rel)) continue;
      // worktree 分支已跟踪的同名文件不是从 base 复制来的, 其改动由 git 自身的 dirty 检查负责。
      if (conflictsWithTracked(rel)) continue;

      const srcAbs = path.join(baseRepo, rel);
      const destAbs = path.join(destRoot, rel);
      const normalizedDest = path.resolve(destAbs);
      if (!normalizedDest.startsWith(destRootResolved + path.sep)) {
        changed.push({ relpath: rel, reason: "outside" });
        continue;
      }

      let srcStat: fs.Stats;
      let destStat: fs.Stats;
      try {
        srcStat = fs.lstatSync(srcAbs);
      } catch {
        continue;
      }
      try {
        destStat = fs.lstatSync(destAbs);
      } catch {
        changed.push({ relpath: rel, reason: "missing" });
        continue;
      }

      if (srcStat.isSymbolicLink()) {
        if (!destStat.isSymbolicLink()) {
          changed.push({ relpath: rel, reason: "type-mismatch" });
          continue;
        }
        if (fs.readlinkSync(srcAbs) !== fs.readlinkSync(destAbs)) {
          changed.push({ relpath: rel, reason: "symlink-differs" });
        }
        continue;
      }

      if (!srcStat.isFile()) continue;
      if (!destStat.isFile()) {
        changed.push({ relpath: rel, reason: "type-mismatch" });
        continue;
      }
      if (srcStat.size !== destStat.size) {
        changed.push({ relpath: rel, reason: "content-differs" });
        continue;
      }
      const srcContent = fs.readFileSync(srcAbs);
      const destContent = fs.readFileSync(destAbs);
      if (!srcContent.equals(destContent)) {
        changed.push({ relpath: rel, reason: "content-differs" });
      }
    }

    // dest-only 扫描(review 反馈):只存在于 worktree 的 include 匹配文件——典型是
    // base 侧 .env 已删、或 worktree 内新建的本地配置。这类文件通常 gitignored
    // (`stash push -u` 不含 ignored 文件),上面的 base 侧循环也看不到,不报的话
    // 删除 worktree 会静默丢失且恢复时无源可拷。
    const srcSet = new Set(srcFiles);
    for (const rel of listAllFiles(destRoot)) {
      if (srcSet.has(rel)) continue;
      if (!matches(rel)) continue;
      // base 与 worktree 可能位于不同分支；dest-only 文件是否已提交必须按
      // worktree 自己的 index 判断，不能复用 base checkout 的 tracked 集合。
      if (trackedInDest.has(rel)) continue;

      let destStat: fs.Stats;
      try {
        destStat = fs.lstatSync(path.join(destRoot, rel));
      } catch {
        continue;
      }
      if (!destStat.isFile() && !destStat.isSymbolicLink()) continue;
      changed.push({ relpath: rel, reason: "dest-only" });
    }

    return changed;
  }

  /**
   * 一站式: 读 .xdtworktreeinclude / .worktreeinclude → 解析 → 拷贝。都不存在则返回空。
   */
  async function applyWorktreeIncludeFile(
    baseRepo: string,
    destRoot: string,
    options: CopyWorktreeIncludeOptions = {},
  ): Promise<IncludeFileResult[]> {
    const matches = readIncludeMatcher(baseRepo);
    if (!matches) return [];
    return copyMatchedFiles(baseRepo, destRoot, matches, options);
  }

  // 仅供测试用
  const _internal = { globToRegex, listAllFiles, gitignoreMatcher };
  return {
    parseWorktreeIncludePatterns,
    copyWorktreeIncludeFiles,
    listChangedWorktreeIncludeFiles,
    applyWorktreeIncludeFile,
    _internal,
  };
}
