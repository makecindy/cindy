/**
 * subagent 定义发现 —— 扫出用户手写的 subagent 文件,读出它们各自声明的 model。
 *
 * 一次扫描服务两个用途:
 *   1. 「Subagent 模型」设置的**真默认语义**(见 subagent-model-default.ts):判断本会话里
 *      有没有 agent 自己声明了 model,据此决定要不要设 `CLAUDE_CODE_SUBAGENT_MODEL`;
 *   2. **诊断**:agent 指定的模型拼错 / 供应商未连接 / 用了会漂移的裸别名时,给用户可读的原因。
 *
 * ## 为什么要自己扫
 *
 * Claude Code 的 model 解析顺序是
 * `CLAUDE_CODE_SUBAGENT_MODEL` → 每次调用的 model 参数 → frontmatter → 主会话模型。
 * env 变量位于**最高**优先级,平台**没有**「最低优先级默认值」这个位置,也没有「只对某几个
 * agent 生效」的粒度(env 是进程级的)。所以想让「设置 = 默认值、frontmatter 能盖过它」,
 * 唯一可行的做法是:host 自己先看清有没有人声明 model,有人声明就整个会话不设那个 env。
 * 这就要求 host 先知道每个 agent 声明了什么 —— 即本模块。
 *
 * (曾试过「不设 env + 经 `options.agents` 给未声明者补默认值」,实测走不通:同名时文件定义
 * 胜出。判别实验与结论记在 subagent-model-default.ts 的模块头,改这块前先读。)
 *
 * ## 扫描范围与它的边界
 *
 * 覆盖用户**手写**的两个作用域(平台优先级 3 / 4):
 *   - 项目:从 workingDir 向上逐级找 `.claude/agents`(平台也是向上走查,近者优先);
 *   - 用户:`<CLAUDE_CONFIG_DIR>/agents`,缺省 `~/.claude/agents`。
 * 两者都递归子目录 —— 平台允许用 `agents/review/` 这类子目录归类,身份只认 frontmatter
 * 的 `name`,与路径无关。
 *
 * **必须传子进程 env**:`CLAUDE_CONFIG_DIR` 在 host boot 期就被 stripSensitiveAnthropicEnv
 * 从 `process.env` 清掉了,dev 多实例隔离是由 auth adapter 只往**子进程 env** 注入的
 * (apps/desktop/src/main/maker-host/auth-adapters.ts)。所以调用方要把最终交给 SDK 的那份
 * env 传进来,否则这里扫的是 `~/.claude/agents`,而 cc 读的是 `<userData>/claude-home/agents`
 * ——判定与实际不符,声明照旧被覆盖。目录解析要同时看递入 env 与 host env,原因见
 * {@link userAgentsDir}(SDK spawn 是两份 env 合并)。
 *
 * **刻意不覆盖** managed settings 与插件的 `agents/` 目录:那是组织与插件分发的内容,
 * 不是用户手写的,host 不该替它们改模型;这两类继续走 env 覆盖(与本改动前一致,不是回退)。
 *
 * ## 启动期 IO 预算
 *
 * 本扫描位于会话启动的关键路径上(env 要在 sdkQuery 之前定好),而 `.claude/agents` 的内容
 * 完全由仓库决定:生成出来的大目录、几 MB 的 md、软链环、挂死的网络盘都可能把新会话拖成
 * 「假死」。因此深度、目录数、单目录条目数、文件数与总耗时都有上限,任一超限即抛
 * {@link SubagentScanBudgetError},由调用方降级成「照旧设 env」——宁可默认值语义退回改动前,
 * 也不让会话卡在启动上。
 *
 * 两条原则贯穿这些上限:
 *   - **超限一律抛,绝不静默截断**。半份结果会被上层当成「扫完了,没人声明 model」,于是又把
 *     覆盖用的 env 设回去 —— 正是本 PR 要修的 bug 换个触发条件。
 *   - **单个文件不设大小上限**,改成只读开头的有界前缀。按大小跳过看着安全,实则会漏掉长
 *     prompt 的合法定义,同样退化成上一条那个 bug。
 */

import type { Dirent, Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseFrontmatter } from '../shared/customization-scanner.js';

/** 扫描到的单个 subagent 定义。 */
export interface DiscoveredSubagent {
  /** frontmatter 的 `name` —— 身份来源,与 cc 一致(缺失的定义 cc 不加载,这里也不收)。 */
  name: string;
  /** 定义文件绝对路径。 */
  filePath: string;
  /** 作用域:项目(优先级更高)或用户。 */
  scope: 'project' | 'user';
  /**
   * 该 agent 自己声明的 model。
   * `undefined` = 没写 / 写了 `inherit`(平台语义等同没写)—— 这类才需要补默认值。
   */
  declaredModel?: string;
  /**
   * frontmatter 原始数据(诊断用;host 不改写它,也不重发定义)。
   *
   * **刻意不带正文**:host 只需要知道「声明了什么 model」,正文(subagent 的 system prompt)
   * 一个字都用不上。不留这个字段,读取就能只取文件开头的有界前缀 —— 一份 5 MB 的 md 也只花
   * 一次定长读,不必在「整份读进内存」和「按大小跳过」之间选(跳过会漏掉声明 → 又误判
   * 「没人声明 model」)。
   */
  frontmatter: Record<string, unknown>;
}

/**
 * 扫描触及预算上限 —— 调用方应据此降级(见模块头「启动期 IO 预算」),不要当作
 * 「没有人声明 model」。
 */
export class SubagentScanBudgetError extends Error {
  constructor(readonly budget: string) {
    super(`subagent definition scan exceeded budget: ${budget}`);
    this.name = 'SubagentScanBudgetError';
  }
}

/** 目录递归深度上限:防软链环 / 异常深目录。 */
const MAX_DEPTH = 8;
/** 遍历到的 .md 文件数上限。真实用法是个位数到几十;上百已属异常。 */
const MAX_FILES = 200;
/** 访问的目录数上限(深度管不住广度)。 */
const MAX_DIRS = 200;
/**
 * 单个目录的条目数上限。
 *
 * 为什么单独设这一道:`readdir` 会把整个目录**一次性物化成数组**,后面再排序 —— 生成出来的
 * 十万条目录能在计数预算生效前就吃掉内存,而同步排序还会**堵住事件循环**,连外层定时器都没
 * 机会触发。所以改用 `opendir` 流式读并在这里就地封顶:一超即抛,不物化、不排序。
 */
const MAX_DIR_ENTRIES = 500;
/**
 * 单个定义文件读取的前缀字节数。
 *
 * 我们只要 frontmatter,而它一定在文件开头。定长前缀让「几 MB 的 md」既不占内存也不会被
 * 整条跳过 —— 跳过等于漏掉一份可能声明了 model 的定义。
 */
const MAX_FRONTMATTER_BYTES = 32 * 1024;
/** 整趟扫描的墙钟上限 —— 兜住慢盘 / 网络盘 / 病态目录。 */
const MAX_ELAPSED_MS = 1_500;

/** 预算账本。任一维度超限立即抛,不做「静默截断」——截断会让判定悄悄失真。 */
class ScanBudget {
  private files = 0;
  private dirs = 0;
  constructor(private readonly startedAt: number, private readonly deadlineMs: number) {}

  countDir(): void {
    if (++this.dirs > MAX_DIRS) throw new SubagentScanBudgetError(`dirs>${MAX_DIRS}`);
    this.checkTime();
  }

  countFile(): void {
    if (++this.files > MAX_FILES) throw new SubagentScanBudgetError(`files>${MAX_FILES}`);
    this.checkTime();
  }

  checkTime(): void {
    if (Date.now() - this.startedAt > this.deadlineMs) {
      throw new SubagentScanBudgetError(`elapsed>${this.deadlineMs}ms`);
    }
  }
}

/**
 * 给整趟扫描套一个**真**超时。
 *
 * 为什么计数式的 checkTime() 不够:它只在两次 await 之间执行。落在网络盘 / 已失联的挂载点上
 * 的 `readdir` / `stat` / `readFile` 可以一直挂着不返回,此时代码根本走不到下一次检查 ——
 * 会话启动就跟着无限期卡住。所以必须让**等待方**自己放弃,而不是指望被等的操作回来。
 *
 * 放弃后底层 fs 操作仍会挂在 libuv 线程池里(没有取消语义),但我们不再等它:定时器一到就以
 * {@link SubagentScanBudgetError} 拒绝,调用方走既有的降级路径。定时器 unref,不拖住进程退出。
 */
async function withDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SubagentScanBudgetError(`deadline>${deadlineMs}ms`)),
          deadlineMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * cc 子进程实际会读的 `<config dir>/agents`。
 *
 * 必须按 **SDK spawn 的合并语义**来解:SDK 起 CLI 时用的是
 * `{ ...process.env, ...userEnv }`,所以子进程看到的 `CLAUDE_CONFIG_DIR` 是
 * 「host 递入的那份」优先、其次才是「host 自己 process.env 上的」。
 *
 * 两者都要看,漏一个就会扫错目录:
 *   - 只看 `process.env`:dev 多实例的重定向只存在于递入的 env 里(desktop boot 已把该键
 *     从 process.env 剥掉),会漏掉;
 *   - 只看递入的 env:没调过 stripSensitiveAnthropicEnv 的 host(CLI host、单测)其
 *     `process.env.CLAUDE_CONFIG_DIR` 照样会被 SDK 合并进子进程 —— 我们的字典副本里没有它
 *     (cleanProcessEnv 剥了),但 cc 读的就是它。
 *
 * 都没有则回落 `~/.claude` —— 与 cc 在子进程里自己的解析一致(local spawn 同一个用户)。
 */
function userAgentsDir(childEnv: NodeJS.ProcessEnv, hostEnv: NodeJS.ProcessEnv): string {
  const configDir = childEnv.CLAUDE_CONFIG_DIR?.trim() || hostEnv.CLAUDE_CONFIG_DIR?.trim();
  const base = configDir && configDir.length > 0 ? configDir : path.join(os.homedir(), '.claude');
  return path.join(base, 'agents');
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 流式读一个目录的条目,条目数超 {@link MAX_DIR_ENTRIES} 立即抛。
 *
 * 打不开的目录(权限 / 竞态删除)当作空目录,只跳过它自己;但**条目过多要抛** —— 那种情况下
 * 结果不可信,静默截断会让上层以为「扫完了,没人声明 model」。
 * 每读一条都过一次时间预算:opendir 的异步迭代天然会让出事件循环,外层定时器也就有机会触发。
 */
async function readDirEntriesBounded(dir: string, budget: ScanBudget): Promise<Dirent[]> {
  let handle: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    handle = await fs.opendir(dir);
  } catch {
    return [];
  }
  const entries: Dirent[] = [];
  // for-await 在 break / throw 时会自动关闭目录句柄。
  for await (const ent of handle) {
    if (entries.length >= MAX_DIR_ENTRIES) {
      throw new SubagentScanBudgetError(`dirEntries>${MAX_DIR_ENTRIES}`);
    }
    entries.push(ent);
    budget.checkTime();
  }
  return entries;
}

type EntryKind = 'directory' | 'file' | 'other';

/**
 * 把目录条目按跟随软链后的目标分类。
 *
 * `statEntry` 可注入是为了让 Windows 在未开启 Developer Mode、无法创建文件软链时，
 * 仍能真实覆盖 Dirent 的软链分支；目录 junction 则继续走端到端测试。
 */
export async function classifySubagentEntry(
  ent: Pick<Dirent, 'isDirectory' | 'isFile' | 'isSymbolicLink'>,
  fullPath: string,
  statEntry: (entryPath: string) => Promise<Pick<Stats, 'isDirectory' | 'isFile'>> = (entryPath) =>
    fs.stat(entryPath),
): Promise<EntryKind | undefined> {
  let isDir = ent.isDirectory();
  let isFile = ent.isFile();
  if (ent.isSymbolicLink()) {
    // follow: stat 走目标。悬空 / 无权限的链直接跳过这一条。
    try {
      const st = await statEntry(fullPath);
      isDir = st.isDirectory();
      isFile = st.isFile();
    } catch {
      return undefined;
    }
  }
  if (isDir) return 'directory';
  if (isFile) return 'file';
  return 'other';
}

/**
 * 递归收集目录下的 .md 文件。单个坏目录只跳过它自己,不影响其余扫描;超预算则整趟抛出。
 *
 * **软链必须跟随**:`readdir(withFileTypes)` 给软链的 Dirent 既不是 file 也不是 dir,
 * 只看 isFile()/isDirectory() 会把它整条漏掉。本仓在建 worktree 时是**刻意**保留
 * `.claude/agents` 里的软链的(WorktreeManager.copyDirIfExists 用 `dereference: false`,
 * 因为有人就是这么复用定义的)—— 漏掉一个软链定义,就等于误判「没人声明 model」,
 * 于是又把覆盖用的 env 设回去,正是本次要修的 bug。所以对软链补一次 follow-stat。
 *
 * 跟随软链就要防环:用 realpath 记账,同一真实目录只进一次(深度上限管不住 A→B→A)。
 *
 * **用 opendir 而不是 readdir**:readdir 会把整个目录一次性物化成数组,一个生成出来的十万
 * 条目录在任何计数预算生效**之前**就吃掉内存,随后的同步排序还会堵住事件循环 —— 那期间连外层
 * 定时器都触发不了。opendir 流式读能在超过 {@link MAX_DIR_ENTRIES} 时立刻抛出,不物化、不排序。
 */
async function collectMarkdownFiles(
  dir: string,
  budget: ScanBudget,
  visitedDirs: Set<string>,
  depth = 0,
): Promise<string[]> {
  // 深度上限也是预算的一部分,超了同样**抛**而不是返回空:深层目录里若有声明了 model 的定义,
  // 静默截断会让上层判成「没人声明」→ 又把覆盖用的 env 设回去(本 PR 要修的 bug)。
  if (depth > MAX_DEPTH) throw new SubagentScanBudgetError(`depth>${MAX_DEPTH}`);
  // 软链环兜底:按真实路径去重。realpath 失败(悬空链)就跳过这个目录。
  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return [];
  }
  if (visitedDirs.has(real)) return [];
  visitedDirs.add(real);
  budget.countDir();
  const entries = await readDirEntriesBounded(dir, budget);
  const files: string[] = [];
  // 名字排序保证同一目录下的遍历顺序稳定(平台对同目录同名的取舍是文件系统序,
  // 我们至少让自己的结果可复现)。条目数已封顶,这次排序的规模是有界的。
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const ent of sorted) {
    // 隐藏条目与 .bak.N 备份跳过 —— 与本仓既有的 customization-scanner(同名过滤,
    // agents/shared/customization-scanner.ts)保持**同一份有效定义集**。
    // 这条的风险方向和其它几条相反:多认一份 cc 根本不加载的 `.reviewer.md` 备份,会让我们
    // 以为「有人声明了 model」从而删掉 env —— 用户配的默认值对真正的 agent 反而失效了。
    if (ent.name.startsWith('.') || /\.bak\.\d+$/.test(ent.name)) continue;
    const full = path.join(dir, ent.name);
    const kind = await classifySubagentEntry(ent, full);
    if (kind === undefined) continue;
    if (kind === 'directory') {
      files.push(...(await collectMarkdownFiles(full, budget, visitedDirs, depth + 1)));
      // 扩展名大小写不敏感:`reviewer.MD` 在大小写保留的文件系统上照样是一份定义,
      // 本仓既有的 customization-scanner 也是 `toLowerCase().endsWith('.md')`。
      // 大小写敏感地漏掉一份声明了 model 的定义 = 又把覆盖用的 env 设回去。
    } else if (kind === 'file' && ent.name.toLowerCase().endsWith('.md')) {
      budget.countFile();
      files.push(full);
    }
  }
  return files;
}

/**
 * 从 workingDir 向上逐级收集 `.claude/agents` 目录(近者在前)。
 * 平台对嵌套项目目录的规则是「离 workingDir 最近的同名定义生效」,顺序与此一致。
 *
 * **先 realpath 再向上走**:workingDir 本身可能是个软链(指向仓库的某个子目录)。子进程的
 * cwd 会被解析成物理路径,cc 于是能看到 `<真实仓库>/.claude/agents`;而按软链的字面父目录
 * 往上走查会走到完全另一支,漏掉那份定义 → 又误判「没人声明 model」。realpath 失败(不存在
 * 等)时回落字面路径,不因此放弃整个项目作用域。
 */
async function projectAgentsDirs(workingDir: string): Promise<string[]> {
  if (!workingDir || !path.isAbsolute(workingDir)) return [];
  const dirs: string[] = [];
  let cur = workingDir;
  try {
    cur = await fs.realpath(workingDir);
  } catch {
    /* 保持字面路径 */
  }
  for (;;) {
    const candidate = path.join(cur, '.claude', 'agents');
    if (await isDirectory(candidate)) dirs.push(candidate);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs;
}

/**
 * model id 的长度上限。真实 id 最长也就几十个字符;frontmatter 却能塞进整个前缀(32 KiB)。
 * 不封顶的话,这个串会一路流到诊断打分(suggestModelIds 逐词干比对整份可用清单)与日志里 ——
 * 前者是**同步**计算且发生在扫描 deadline 之外,拦不住,只能从源头限长。
 */
const MAX_DECLARED_MODEL_CHARS = 256;

function normalizeDeclaredModel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // cc 对 model **会** trim,且把空白与 `inherit` 都当作「没指定」,继续沿解析链向下。
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.toLowerCase() === 'inherit') return undefined;
  return trimmed.length > MAX_DECLARED_MODEL_CHARS
    ? trimmed.slice(0, MAX_DECLARED_MODEL_CHARS)
    : trimmed;
}

/**
 * 读文件开头的有界前缀 —— frontmatter 一定在这里,正文我们不需要(见 DiscoveredSubagent)。
 *
 * 这样「几 MB 的 md」既不占内存,也**不会被整条跳过**:按大小跳过看着安全,实则会漏掉一份
 * 可能声明了 model 的合法定义(长 system prompt 的 agent 完全正常),于是又误判「没人声明」
 * 并把覆盖用的 env 设回去 —— 正是本 PR 要修的 bug。
 *
 * 返回 null = 读不到(不存在 / 无权限),这一条不算。
 */
async function readFilePrefix(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buf = Buffer.allocUnsafe(MAX_FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_FRONTMATTER_BYTES, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** frontmatter 起始分隔符(允许 BOM 与前导空行,与 gray-matter 的宽容度对齐)。 */
const FRONTMATTER_OPEN = /^\uFEFF?\s*---\r?\n/;

async function readSubagentFile(
  filePath: string,
  scope: DiscoveredSubagent['scope'],
): Promise<DiscoveredSubagent | null> {
  const raw = await readFilePrefix(filePath);
  if (raw === null) return null;
  // 前缀里没读到 frontmatter 的**收尾**分隔符,但开头确实有起始分隔符 → 这份 frontmatter
  // 大到超出前缀,解析结果不可信。此时**抛**而不是跳过:跳过会让上层以为「没人声明 model」。
  if (FRONTMATTER_OPEN.test(raw) && !/\n---\s*(\r?\n|$)/.test(raw.replace(FRONTMATTER_OPEN, '\n'))) {
    throw new SubagentScanBudgetError(`frontmatter>${MAX_FRONTMATTER_BYTES}B`);
  }
  const parsed = parseFrontmatter(raw);
  if (parsed.parseError || !parsed.frontmatter) return null;
  const fm = parsed.frontmatter;
  // gray-matter 对「没有 frontmatter 的普通 md」返回空对象 —— 那不是 subagent 定义
  // (放在 agents 目录里的说明文件、笔记等)。空 frontmatter 一律跳过,否则会被当成
  // 一个匿名 agent 重发出去。
  if (Object.keys(fm).length === 0) return null;
  // 严格对齐 cc 的加载条件:`name` 与 `description` 都必须是非空字符串,缺任一 cc 就把整份
  // 定义**丢弃**(反编译自 bundled cli.js 的 agent 文件加载函数:
  //   `if (!name || typeof name !== 'string') return null;`
  //   `if (!description || typeof description !== 'string') { warn(...); return null; }`
  // 身份取 `frontmatter.name`;函数里的 basename(file,'.md') 只用于 memory 前缀与 filename
  // 字段,**不是** name 的回退)。
  //
  // 这里两个方向都会出错,所以必须照抄平台规则而不是往任一边偏:
  //   - 漏认一份 cc 会加载的定义 → 误判「没人声明 model」→ 又把覆盖用的 env 设回去;
  //   - 多认一份 cc 不加载的定义(例如只写了 model 没写 name 的草稿)→ 误判「有人声明」→
  //     删掉 env → 用户配的默认值对**所有**真实 agent 和内置 agent 静默失效。
  //
  // ⚠️ 三个字段的谓词**不对称**,必须逐个照抄,不能一刀切:
  //   - `name` / `description`:`!value || typeof value !== 'string'` —— 只排除空串,
  //     **不 trim**。所以 `description: "  "` 在 cc 眼里是合法的、会被加载;我们若额外 trim
  //     就比 cc 更严 → 漏认一份 cc 真会加载的定义 → 又把覆盖用的 env 设回去。
  //   - `model`:cc 自己会 `trim()` 并把空白与 `inherit` 视作未指定(见 normalizeDeclaredModel)。
  const name = typeof fm.name === 'string' && fm.name.length > 0 ? fm.name : '';
  const hasDescription = typeof fm.description === 'string' && fm.description.length > 0;
  if (name.length === 0 || !hasDescription) return null;
  return {
    name,
    filePath,
    scope,
    declaredModel: normalizeDeclaredModel(fm.model),
    frontmatter: fm,
  };
}

export interface DiscoverSubagentsOptions {
  workingDir: string;
  /**
   * **递给 SDK 的那份子进程 env**(`options.env`),用于取 `CLAUDE_CONFIG_DIR`。
   *
   * 刻意设成**必填**:dev 多实例的配置目录重定向只存在于这份 env 里(host boot 期已把该键
   * 从 `process.env` 剥掉),缺了它就会静默扫错目录。让类型强制调用方交出这份 env,
   * 比留个默认值再靠注释提醒可靠。解析规则见 {@link userAgentsDir}。
   */
  env: NodeJS.ProcessEnv;
  /** host 自己的 env;缺省 `process.env`。SDK spawn 会把它合并进子进程,故一并参与解析。 */
  hostEnv?: NodeJS.ProcessEnv;
  /** 整趟扫描的墙钟上限;缺省 {@link MAX_ELAPSED_MS}。测试注入小值验证超时分支。 */
  deadlineMs?: number;
  /** 测试注入起始时刻(避免依赖真实时钟)。 */
  now?: () => number;
}

/**
 * 扫出当前会话可见的用户手写 subagent 定义,按平台优先级去重(项目近者 > 项目远者 > 用户)。
 *
 * 单个文件/目录的 IO 异常都被吞成「这条不算」——本扫描只服务默认值与诊断,不能让它拖垮
 * 会话启动。但**预算超限会抛** {@link SubagentScanBudgetError}:那种情况下结果已不可信,
 * 必须由调用方显式降级,不能伪装成「扫完了,没人声明」。
 *
 * 超时有两道:计数式的 `budget.checkTime()`(便宜,覆盖「很多个都不慢」的累积)+ 外层
 * {@link withDeadline} 的真定时器(覆盖「某一个 fs 调用永远不返回」)。缺了后者,挂死的网络盘
 * 能让会话启动无限期卡住 —— 计数检查根本没机会执行。
 */
export async function discoverSubagentDefinitions(
  opts: DiscoverSubagentsOptions,
): Promise<DiscoveredSubagent[]> {
  const deadlineMs = opts.deadlineMs ?? MAX_ELAPSED_MS;
  return await withDeadline(scanSubagentDefinitions(opts, deadlineMs), deadlineMs);
}

async function scanSubagentDefinitions(
  opts: DiscoverSubagentsOptions,
  deadlineMs: number,
): Promise<DiscoveredSubagent[]> {
  const budget = new ScanBudget((opts.now ?? Date.now)(), deadlineMs);
  const visitedDirs = new Set<string>();
  const scoped: Array<{ dir: string; scope: DiscoveredSubagent['scope'] }> = [
    // 顺序 = 跨作用域优先级从高到低(项目近者 > 项目远者 > 用户)。
    ...(await projectAgentsDirs(opts.workingDir)).map((dir) => ({ dir, scope: 'project' as const })),
    { dir: userAgentsDir(opts.env, opts.hostEnv ?? process.env), scope: 'user' as const },
  ];

  // 同名去重。分两种情况,因为「平台会选哪一个」的可知性完全不同:
  //
  // 1. **来自不同扫描根**(项目近者 / 项目远者 / 用户):优先级是平台文档确定的,近者、项目优先。
  //    `scoped` 已按该优先级排好,所以先到者胜、后来者一律不动。
  //    注意不能用 `scope` 字段判断这件事 —— 它只有 'project' / 'user' 两个值,嵌套项目的
  //    「近」与「远」两个根都是 'project',拿它当同源判据会把确定的优先级也一起打翻。
  // 2. **来自同一个扫描根**(比如 `agents/x.md` 与 `agents/review/x.md`):cc 在这个根里按文件
  //    系统枚举顺序任选其一 —— 那个顺序我们复现不了(ext4 与 APFS 不同,也不等于我们的名字
  //    排序)。与其赌顺序,不如让判定**与顺序无关**:声明了 model 的那个胜出。这样无论文件系统
  //    怎么枚举,结论都一样。
  //
  // 第 2 种的残留代价诚实说明:若 cc 实际加载的是没写 model 的那份,我们会多算一次「有人声明」
  // → 默认值不生效。选这个方向是因为本 PR 的不变量是「用户显式写下的 model 不被静默覆盖」,
  // 而同一个根里重名本身是配置错误(cc 自己也只是任选其一)。
  const byName = new Map<string, { def: DiscoveredSubagent; rootIndex: number }>();
  for (const [rootIndex, { dir, scope }] of scoped.entries()) {
    if (!(await isDirectory(dir))) continue;
    for (const filePath of await collectMarkdownFiles(dir, budget, visitedDirs)) {
      budget.checkTime();
      const found = await readSubagentFile(filePath, scope);
      if (!found) continue;
      const existing = byName.get(found.name);
      if (!existing) {
        byName.set(found.name, { def: found, rootIndex });
        continue;
      }
      // 不同扫描根 → 已存在的那个优先级更高,不动(情况 1)。
      if (existing.rootIndex !== rootIndex) continue;
      // 同一个扫描根 → 声明了 model 的胜出(情况 2)。
      if (existing.def.declaredModel === undefined && found.declaredModel !== undefined) {
        byName.set(found.name, { def: found, rootIndex });
      }
    }
  }
  return [...byName.values()].map((e) => e.def);
}
