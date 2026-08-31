/**
 * Review 新鲜度的 submodule 感知身份读取(#2463)。
 *
 * gitlink 是目录,文件指纹器只接受普通文件,所以 submodule 被刻意排除在
 * `workspacePathsWithoutContent` 之外(见 reviewEvidence.ts 的注释)——代价
 * 是「dirty submodule 内部的一份改动换成另一份」时,porcelain 的 `S` 布尔位、
 * 空 patch 元数据与父仓工作树指纹全部不变,两道 freshness gate 都会放行。
 *
 * 这里为每个纳入 Review 的 submodule 读取一份**身份 manifest**:
 *
 *  - 父仓侧:index 里的 gitlink 记录(mode 160000 + oid)与 HEAD tree 里的
 *    gitlink oid —— 绑定「父仓认为子仓应当在哪个 commit」;
 *  - 已初始化子仓:当前 checkout 的 HEAD oid —— 绑定「子仓实际在哪」;
 *  - dirty 子仓:进入子仓读取 —— staged 侧绑定 index 的 (path, mode, stage,
 *    oid)(复用 #2460 的 indexIdentityReader),modified/untracked 工作树侧对
 *    **具体普通文件**做有界内容哈希(复用 capped 指纹器的边界、敏感路径过滤
 *    与稳定性重读);
 *  - 嵌套 submodule 以相同规则递归,深度封顶,超限 fail closed;
 *  - manifest 无法完整读取(git 失败、条目形态超出表达能力)时抛错 fail
 *    closed,与其他 Git 证据读取失败同语义。
 *
 * 只保存 `git submodule status` 一类的 commit oid + dirty 布尔是不够的:子仓
 * HEAD 不变、dirty 文件内容从 A 换成 B 时两者完全相同 —— 必须绑定 dirty
 * tracked/untracked 文件的实际身份,这正是本文件与 #2460 机制共用的原因。
 */

import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

import { runGit } from '../git-review/gitRunner.js';
import { isPathInside } from '../git-review/fsPathGuard.js';
import {
  readStagedIndexIdentity,
  splitIntoBatches,
  type IndexIdentityBatchLimits,
} from '../git-review/indexIdentityReader.js';
import { fingerprintReviewCappedWorkspaceFiles } from './reviewCappedWorkspaceFingerprint.js';

/** 嵌套 submodule 的递归深度封顶;超过按无法完整表达处理(fail closed)。 */
const MAX_SUBMODULE_RECURSION_DEPTH = 5;
/** 单个子仓 dirty 条目上限;超过按无法完整表达处理(fail closed)。 */
const MAX_SUBMODULE_DIRTY_ENTRIES = 10_000;
/**
 * 整次 manifest 构建(全部子仓 + 嵌套递归)**共享**的内容哈希预算。上限与
 * capped 指纹器单次调用相同,但这里跨子仓累计扣减 —— 否则 N 个大型 dirty
 * 子仓各自重置 512MB 额度,快照总读取量没有上限。耗尽 fail closed。
 */
const MAX_MANIFEST_CONTENT_BYTES = 512 * 1024 * 1024;
const MAX_MANIFEST_CONTENT_PATHS = 10_000;

interface ManifestContentBudget {
  remainingBytes: number;
  remainingPaths: number;
}

/**
 * 所有 manifest 条目(子仓自身、staged 身份记录、dirty 工作树文件)共同消耗
 * 全局路径预算 —— 只对工作树文件扣减时,N 个子仓仍可各自产生上限条 staged
 * 记录或继续横向展开子仓,总量不受控。耗尽 fail closed。
 */
function consumePathBudget(budget: ManifestContentBudget, count: number): void {
  budget.remainingPaths -= count;
  if (budget.remainingPaths < 0) {
    throw new ReviewSubmoduleIdentityError(
      `Review submodule manifest exceeds the shared content-path budget of ${MAX_MANIFEST_CONTENT_PATHS}`,
    );
  }
}

export class ReviewSubmoduleIdentityError extends Error {}

/** 单个 submodule 的身份 manifest(JSON 可序列化,字段序即声明序,确定性)。 */
export interface ReviewSubmoduleIdentity {
  path: string;
  /**
   * 父仓 index 里的 gitlink 记录(`<mode> <stage> <oid>`);unmerged 时
   * stage 1/2/3 全部并入并稳定排序、逗号连接,缺席记 'absent'。
   */
  indexRecord: string;
  /** 父仓 HEAD tree 里的 gitlink oid,缺席(如新增未提交)记 'absent'。 */
  headRecord: string;
  /** 子仓状态:未初始化 / HEAD oid;unborn HEAD 记 'unborn'。 */
  subHead: string;
  /** 子仓 dirty staged 侧的 index 身份记录(#2460 同格式);clean 为空数组。 */
  stagedIdentity: string[];
  /**
   * 子仓 porcelain status 原始记录(`XY path`,稳定排序)。intent-to-add
   * (` A`)与 reset 后的 untracked(`??`)字节相同、内容指纹相同,staged 侧
   * 也都为空 —— 只有状态码能区分这两种(以及其它同字节的)内层形态,不绑
   * 会让不同状态映射到同一 manifest(Codex review #2515)。
   */
  statusRecords: string[];
  /** 子仓 dirty 工作树普通文件的有界内容指纹;无 dirty 工作树文件为 null。 */
  dirtyContentFingerprint: string | null;
  /** dirty 的嵌套 submodule,按相同规则递归。 */
  nested: ReviewSubmoduleIdentity[];
}

export interface ReviewSubmoduleIdentityResult {
  identities: ReviewSubmoduleIdentity[];
  /** 是否发生过内层文件内容哈希 —— 调用方据此启用快照稳定性重读窗口。 */
  hashedContent: boolean;
}

function literalPathspec(gitPath: string): string {
  return `:(top,literal)${gitPath}`;
}

/** realpath(符号链接归一)——toplevel 归属比较必须在同一坐标系里做。 */
async function fsRealpath(p: string): Promise<string> {
  return fsPromises.realpath(p);
}

/** 父仓 index / HEAD tree 里该路径的 gitlink 记录。 */
async function readParentRecords(
  repoRoot: string,
  subPath: string,
): Promise<{ indexRecord: string; headRecord: string }> {
  const { stdout: stageOut } = await runGit(
    ['ls-files', '--stage', '-z', '--', literalPathspec(subPath)],
    { cwd: repoRoot, maxStdoutBytes: 1024 * 1024 },
  );
  // unmerged gitlink 在 index 里是 stage 1/2/3 三条记录,全部并入身份并稳定
  // 排序 —— 只留最后一条会让「替换较早 stage 的 OID」逃过新鲜度检查(与
  // readStagedIndexIdentity 的多 stage 表达同一裁决)。
  const indexRows: string[] = [];
  for (const record of stageOut.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(tab + 1) !== subPath) continue;
    const [mode, oid, stage] = record.slice(0, tab).trim().split(/\s+/);
    if (mode && oid && stage) indexRows.push(`${mode} ${stage} ${oid}`);
  }
  const indexRecord = indexRows.length > 0 ? indexRows.sort().join(',') : 'absent';

  const { stdout: treeOut } = await runGit(
    // 字面 pathspec:子仓名以 pathspec magic 开头(如合法目录名 ':(exclude)')
    // 时,裸路径会以 128 失败中止 Review(Codex review #2515;同函数的
    // ls-files 调用已是 literal)。
    ['ls-tree', '-z', 'HEAD', '--', literalPathspec(subPath)],
    { cwd: repoRoot, maxStdoutBytes: 1024 * 1024, allowedExitCodes: [0, 128] },
  );
  // exit 128 = unborn HEAD 等;当作 tree 无记录处理(absent 本身就是身份)。
  let headRecord = 'absent';
  for (const record of treeOut.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab < 0 || record.slice(tab + 1) !== subPath) continue;
    const [mode, type, oid] = record.slice(0, tab).trim().split(/\s+/);
    if (mode && type && oid) headRecord = `${mode} ${type} ${oid}`;
  }
  return { indexRecord, headRecord };
}

/** 子仓 porcelain v1 条目(--no-renames,单路径记录)。 */
interface SubStatusEntry {
  staged: boolean;
  worktree: boolean;
  untracked: boolean;
  /** porcelain v1 原始 XY 两字符状态码。 */
  xy: string;
  path: string;
}

async function readSubStatus(subRoot: string): Promise<SubStatusEntry[]> {
  const { stdout } = await runGit(
    // --ignore-submodules=none 显式覆盖仓库配置:.gitmodules / 本地配置里的
    // submodule.<name>.ignore=all/dirty 会让 status 省略脏的嵌套子仓,内层
    // 内容替换不进 nested manifest,旧结论照样通过新鲜度门(Codex review
    // #2515,已实仓验证 ignore=all 会移除 dirty child)。
    ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'],
    { cwd: subRoot, maxStdoutBytes: 16 * 1024 * 1024 },
  );
  const entries: SubStatusEntry[] = [];
  for (const record of stdout.split('\0')) {
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const entryPath = record.slice(3);
    if (!entryPath) continue;
    if (x === '?' && y === '?') {
      entries.push({ staged: false, worktree: true, untracked: true, xy: '??', path: entryPath });
      continue;
    }
    entries.push({
      staged: x !== ' ' && x !== '?',
      worktree: y !== ' ',
      untracked: false,
      xy: `${x}${y}`,
      path: entryPath,
    });
  }
  if (entries.length > MAX_SUBMODULE_DIRTY_ENTRIES) {
    throw new ReviewSubmoduleIdentityError(
      `Review cannot bind a submodule with more than ${MAX_SUBMODULE_DIRTY_ENTRIES} dirty entries`,
    );
  }
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 子仓 index 里 mode 160000 的路径集合(区分嵌套 submodule 与普通文件)。
 * pathspec 与 indexIdentityReader 同规则分批(Windows ~32K 命令行上限),
 * 批间合并集合,语义与单次调用一致。
 */
async function readGitlinkPaths(
  subRoot: string,
  candidates: readonly string[],
  batch?: IndexIdentityBatchLimits,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const gitlinks = new Set<string>();
  for (const group of splitIntoBatches(candidates, batch)) {
    const { stdout } = await runGit(
      ['ls-files', '--stage', '-z', '--', ...group.map(literalPathspec)],
      { cwd: subRoot, maxStdoutBytes: Math.max(1024 * 1024, group.length * 512) },
    );
    for (const record of stdout.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const mode = record.slice(0, tab).trim().split(/\s+/)[0];
      if (mode === '160000') gitlinks.add(record.slice(tab + 1));
    }
    // HEAD tree 也要查(Codex review #2515):git rm --cached 从 index 删除
    // gitlink 但保留 checkout 时,status 是 D + ?? 目录 —— 只查 index 会把
    // 保留目录当普通 worktree 路径喂给文件指纹器直接抛错。HEAD 里是 gitlink
    // 的路径同样按嵌套子仓处理(indexRecord 记 absent,身份仍完整绑定)。
    // unborn HEAD 等按 exit 128 视作无记录。
    const { stdout: treeOut } = await runGit(
      ['ls-tree', '-z', 'HEAD', '--', ...group.map(literalPathspec)],
      {
        cwd: subRoot,
        maxStdoutBytes: Math.max(1024 * 1024, group.length * 512),
        allowedExitCodes: [0, 128],
      },
    );
    for (const record of treeOut.split('\0')) {
      if (!record) continue;
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const mode = record.slice(0, tab).trim().split(/\s+/)[0];
      if (mode === '160000') gitlinks.add(record.slice(tab + 1));
    }
  }
  return gitlinks;
}

/** 未跟踪目录条目(如内嵌仓库)带尾斜杠;与 gitlink 路径比较前归一。 */
function stripTrailingSlash(p: string): string {
  return p.endsWith('/') ? p.slice(0, -1) : p;
}

async function readOneSubmoduleIdentity(
  repoRoot: string,
  subPath: string,
  depth: number,
  budget: ManifestContentBudget,
  batch?: IndexIdentityBatchLimits,
): Promise<{ identity: ReviewSubmoduleIdentity; hashedContent: boolean }> {
  if (depth > MAX_SUBMODULE_RECURSION_DEPTH) {
    throw new ReviewSubmoduleIdentityError(
      `Review cannot bind submodules nested deeper than ${MAX_SUBMODULE_RECURSION_DEPTH} levels`,
    );
  }
  // 子仓条目自身也计入全局路径预算:横向展开的子仓数量同样必须受控。
  consumePathBudget(budget, 1);
  const { indexRecord, headRecord } = await readParentRecords(repoRoot, subPath);
  const subRoot = path.join(repoRoot, ...subPath.split('/'));

  // 已初始化判定:目录里能解析出 git toplevel **且 toplevel 就是子仓目录
  // 本身**。只测 rev-parse 成功是不够的 —— deinit 后留下的空目录仍在父仓
  // 工作树里,rev-parse 会静默落到父仓,把父仓 HEAD 错当子仓身份。
  const uninitialized = {
    identity: {
      path: subPath,
      indexRecord,
      headRecord,
      subHead: 'uninitialized',
      stagedIdentity: [],
      statusRecords: [],
      dirtyContentFingerprint: null,
      nested: [],
    },
    hashedContent: false,
  };
  let subHead: string;
  // 「未初始化」只有两种合法形态:工作树目录整个缺席(gitlink 在、目录被清),
  // 或 deinit 后留下的空目录(rev-parse 静默落到父仓 → toplevel 归属不是子仓
  // 自身)。除这两种外的任何读取失败(权限、git 异常、realpath 失败)都必须
  // 向上抛 fail closed —— 把读取错误降级成稳定的 'uninitialized' 身份,会让
  // 不同的内层内容映射到同一 manifest,新鲜度门形同虚设。
  let subEntry;
  try {
    subEntry = await fsPromises.lstat(subRoot);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return uninitialized;
    throw new ReviewSubmoduleIdentityError(
      `Review cannot stat submodule worktree ${subPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!subEntry.isDirectory()) {
    // gitlink 被普通文件 / 符号链接替换(typechange):porcelain 的 sub 字段仍
    // 标 S,statusReader 把它当 submodule 路由到这里;把 rev-parse 的 cwd 指到
    // 普通文件只会 ENOTDIR。普通文件的新鲜度真身是那份文件字节 —— 交给
    // capped 指纹器绑定内容(同一套路径守卫、敏感过滤与共享预算);symlink
    // 替换与内层 dirty symlink 同语义按链接文本绑定 —— gitlink 换成悬空或
    // 指向仓库外的链接是 Git 可表达的合法 typechange,按目标解析会中止整个
    // 快照(Codex review)。
    consumePathBudget(budget, 1);
    const typechangeFingerprint = await fingerprintReviewCappedWorkspaceFiles(
      repoRoot,
      [subPath],
      { byteBudget: budget, symlinkMode: 'link-text' },
    );
    return {
      identity: {
        path: subPath,
        indexRecord,
        headRecord,
        subHead: 'typechange',
        stagedIdentity: [],
        statusRecords: [],
        dirtyContentFingerprint: typechangeFingerprint,
        nested: [],
      },
      hashedContent: true,
    };
  }
  const { stdout: toplevelOut } = await runGit(['rev-parse', '--show-toplevel'], {
    cwd: subRoot,
    maxStdoutBytes: 4096,
  });
  const [toplevelReal, subRootReal] = await Promise.all([
    // 只剥 git 追加的行终止符,不 trim:目录名允许以空格/制表符结尾(macOS
    // 文件系统与 git 均合法),trim 会把路径本身裁掉导致 realpath 查错路径
    // (Codex review #2515)。\r 按平台区分:Windows 文件名不可能含 \r,行尾
    // \r\n 整体是终止符;POSIX 上 git 只追加 \n,\n 前的 \r 是目录名自身的
    // 字节,必须保留(Codex review 第二轮)。
    fsRealpath(toplevelOut.replace(process.platform === 'win32' ? /\r?\n$/ : /\n$/, '')),
    fsRealpath(subRoot),
  ]);
  // 边界校验:祖先目录被替换成指向父仓外的 symlink 时,lstat/realpath 会
  // 跟随中间链接把 subRoot 解析到仓外 —— 那里的 checkout 有自己的 toplevel,
  // 仅比对「toplevel === 自身」拦不住。解析结果必须仍在父仓 realpath 边界
  // 内,否则 fail closed,不读取仓外 status 与字节(Codex review)。
  const repoRootReal = await fsRealpath(repoRoot);
  if (!isPathInside(repoRootReal, subRootReal)) {
    throw new ReviewSubmoduleIdentityError(
      `Review cannot bind submodule ${subPath}: worktree resolves outside its parent repository`,
    );
  }
  if (toplevelReal !== subRootReal) {
    // toplevel 归属不是子仓自身 = 没有独立 git 身份。只有**空目录**是合法的
    // deinit 形态可以稳定归入 'uninitialized';非空普通目录(.git 被移除、
    // 内容被任意文件替换)必须 fail closed —— 目录里的字节没有任何身份来源,
    // 归入固定的 'uninitialized' 会让不同内容映射到同一 manifest,旧结论
    // 照样通过新鲜度门(Codex review #2515)。
    const entries = await fsPromises.readdir(subRoot);
    if (entries.length === 0) return uninitialized;
    throw new ReviewSubmoduleIdentityError(
      `Review cannot bind submodule ${subPath}: worktree directory has no git identity but is not empty`,
    );
  }
  // --verify --quiet 让「HEAD 不是合法 ref(已初始化的空仓)」确定性地表现为
  // exit 1 + 空输出;超时、进程启动失败等其余错误仍由 runGit 抛出 fail
  // closed —— 无条件 catch 会把读取失败伪装成稳定的 'unborn' 身份。
  {
    const { stdout } = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: subRoot,
      maxStdoutBytes: 1024,
      allowedExitCodes: [0, 1],
    });
    subHead = stdout.trim() || 'unborn';
  }

  const entries = await readSubStatus(subRoot);
  // untracked 条目也参与 gitlink 判定(尾斜杠归一):index 已删但 checkout
  // 保留的嵌套仓在 status 里正是 ?? 目录形态。
  const gitlinkPaths = await readGitlinkPaths(
    subRoot,
    [...new Set(entries.map((entry) => stripTrailingSlash(entry.path)))],
    batch,
  );

  const stagedPaths = entries
    .filter((entry) => entry.staged && !gitlinkPaths.has(stripTrailingSlash(entry.path)))
    .map((entry) => entry.path);
  const worktreePaths = entries
    .filter((entry) => entry.worktree && !gitlinkPaths.has(stripTrailingSlash(entry.path)))
    .map((entry) => entry.path);
  const nestedPaths = [...new Set(
    entries
      .filter((entry) => gitlinkPaths.has(stripTrailingSlash(entry.path)))
      .map((entry) => stripTrailingSlash(entry.path)),
  )];

  // staged 身份记录同样消耗全局路径预算(每条 staged 路径一条记录)。
  consumePathBudget(budget, stagedPaths.length);
  const stagedIdentity = await readStagedIndexIdentity(subRoot, stagedPaths, batch);
  // 工作树 dirty 普通文件走 capped 指纹器:同一套路径守卫、敏感路径过滤、
  // 字节上限与「哈希期间文件变了就抛 ChangedError」的稳定性语义。目录形态
  // (如 untracked 的内嵌仓库)会被它拒绝 —— 即 fail closed,不静默跳过。
  let dirtyContentFingerprint: string | null = null;
  let hashedContent = false;
  if (worktreePaths.length > 0) {
    // 字节与路径预算都从整次构建的共享额度里扣,不按子仓重置。
    consumePathBudget(budget, worktreePaths.length);
    dirtyContentFingerprint = await fingerprintReviewCappedWorkspaceFiles(subRoot, worktreePaths, {
      byteBudget: budget,
      // symlink 绑定链接文本(Git 对 symlink 记录的内容就是文本):子仓里指向
      // 子仓外(如 ../shared 解析进父仓)或悬空的链接是合法 Git 改动,按目标
      // 解析会把整个快照 fail closed 中止;链接文本变化照样改变 manifest,
      // 且完全不读取目标字节(Codex review)。
      symlinkMode: 'link-text',
    });
    hashedContent = true;
  }

  const nested: ReviewSubmoduleIdentity[] = [];
  for (const nestedPath of nestedPaths) {
    const child = await readOneSubmoduleIdentity(subRoot, nestedPath, depth + 1, budget, batch);
    nested.push(child.identity);
    hashedContent = hashedContent || child.hashedContent;
  }

  return {
    identity: {
      path: subPath,
      indexRecord,
      headRecord,
      subHead,
      stagedIdentity,
      // 原始状态码逐条并入 manifest:同字节的状态迁移(如 intent-to-add
      // `git reset` 后变 untracked)不改变 stagedIdentity 与内容指纹,只有
      // 这里能把它们区分开。
      statusRecords: entries.map((entry) => `${entry.xy} ${entry.path}`).sort(),
      dirtyContentFingerprint,
      nested,
    },
    hashedContent,
  };
}

/**
 * 读取一组 submodule 路径的身份 manifest,按路径稳定排序返回。
 *
 * 任何一步 git 读取失败都向上抛(fail closed);调用方把返回的 manifest 并入
 * workspace fingerprint,`hashedContent` 为真时启用快照稳定性重读窗口。
 */
export async function readReviewSubmoduleIdentity(
  repoRoot: string,
  rawPaths: readonly string[],
  limits?: { maxContentBytes?: number; maxContentPaths?: number; batch?: IndexIdentityBatchLimits },
): Promise<ReviewSubmoduleIdentityResult> {
  // 不做字符过滤:pathspec 经 argv 传递、输出全部走 -z(NUL 分隔、无引号
  // 转义),含 \n / \r 的合法 submodule 路径同样必须绑定身份 —— 静默丢弃
  // 就是绕过口(与 indexIdentityReader 同一裁决)。
  const paths = [...new Set(rawPaths)]
    .filter((p) => p.length > 0)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const budget: ManifestContentBudget = {
    remainingBytes: limits?.maxContentBytes ?? MAX_MANIFEST_CONTENT_BYTES,
    remainingPaths: limits?.maxContentPaths ?? MAX_MANIFEST_CONTENT_PATHS,
  };
  const identities: ReviewSubmoduleIdentity[] = [];
  let hashedContent = false;
  for (const subPath of paths) {
    const one = await readOneSubmoduleIdentity(repoRoot, subPath, 1, budget, limits?.batch);
    identities.push(one.identity);
    hashedContent = hashedContent || one.hashedContent;
  }
  return { identities, hashedContent };
}
