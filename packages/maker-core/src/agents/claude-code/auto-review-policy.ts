/**
 * Claude Code 的 Auto-review adapter —— 把 CC 内置工具调用翻译成归一化 `ReviewableAction`,
 * 交给 harness 无关的 Cindy Auto-Review Core(`../shared/auto-review.ts`)裁决。
 *
 * 背景与判定档见 core 的文件头。Claude 侧特有的只是"工具名→动作"的映射:CC 的
 * `--permission-mode auto` 会绕过 Cindy 的 canUseTool(实机探针证实),故 auto 映射到 SDK
 * `default` 让 canUseTool 生效后,非 MCP 内置工具在此分类(见 claude-code/index.ts 的 dispatcher)。
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  reviewAction,
  isSensitiveCredentialPath,
  type ReviewableAction,
  type ReviewVerdict,
} from '../shared/auto-review.js';

export type BuiltinAutoReviewVerdict = ReviewVerdict;

export interface BuiltinAutoReviewContext {
  /** Claude 内置工具名(非 MCP;MCP 工具走 host 的 getMcpToolApprovalPolicy)。 */
  toolName: string;
  /** 工具入参(SDK 透传的原始对象)。 */
  input: unknown;
  /** 会话的工作区根:cwd + additionalDirectories,绝对路径。远端会话是远端路径(纯字符串判定)。 */
  workspaceRoots: string[];
  /** 会话所在平台(决定是否抹平 macOS firmlink /private)。缺省用本进程 process.platform;远端会话应传远端 OS。 */
  platform?: NodeJS.Platform;
}

/** 只读内省工具:纯读、无本地写、无命令执行、无外发。 */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'NotebookRead',
]);

/**
 * 无副作用的会话内状态/控制工具:TodoWrite 只改会话内 todo;BashOutput/KillShell 只读取/终止
 * 已存在(已被审过)的后台 shell;Task 派生 subagent,其内部工具调用会再次经 canUseTool 复检。
 */
const SAFE_STATEFUL_TOOLS: ReadonlySet<string> = new Set([
  'TodoWrite', 'BashOutput', 'KillShell', 'KillBash', 'Task',
]);

/** 会改文件、带结构化 path 参数、可精确判定工作区边界的工具。 */
const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
]);

/**
 * PowerShell 工具的 `command` 是**裸** PowerShell 语句(如 `Remove-Item -Recurse x`),
 * 而 core 的 `powerShellNeedsConsent` 判据要求命令以 `pwsh` / `powershell` 开头才认
 * (它服务的是 Bash 里写 `powershell -c "…"` 那种形态)。直接把裸语句当 exec 传下去,
 * POWERSHELL_DANGER_PATTERNS 一条都匹配不上 —— 红线形同虚设。
 *
 * 所以只做**一个二选一**的判断,绝不改写命令内容:
 *   - **已经是解释器调用** → **原样透传**。core 自己能从完整路径/引号/调用运算符里求出
 *     解释器身份(`executableName` 去目录去 `.exe`),不需要 adapter 帮忙搬位置。
 *   - **裸语句** → 整条包成 `pwsh -Command '<原文>'`,让同一份判据对「PowerShell 工具」
 *     和「Bash 调 powershell」两种入口给出一致结论。
 *
 * ---
 * **为什么不再对已是解释器调用的命令做任何归一(review 十轮的结论)。**
 *
 * 早先为了把更多形态拉进 argv 级红线,这里做过一串改写:补短名前缀、剥/归一调用运算符、
 * 把 `-Command` 载荷收成单 token、按外层分隔符切段、跳过反引号转义。每一次改写都在下一轮
 * 被证明制造了新的缺陷,且集中在同一处:
 *
 *   补前缀        → 完整路径被抹平,`C:\tmp\pwsh.exe` 复用可信路径的 allow
 *   剥运算符      → `& 'x.exe' …`(执行)与无运算符同串(不执行)折叠成一条身份
 *   `&{1,2}`     → `&&`(语法错误、不执行)与 `&`(执行)折叠
 *   载荷包引号    → 外层的 `Set-Content <系统路径>` 被藏进子进程载荷,并与真在子进程里的
 *                   写法折叠
 *   跳反引号转义  → 原始反引号仍被包进引号,与「反引号是字面字符」的写法反向折叠
 *
 * 根因不是某一处没写对,而是**在审查 adapter 里手写 PowerShell 解析器**:归一结果同时是
 * `reviewAutoAction` 的缓存身份(`claude-code/index.ts:2009` 用整个 request 的序列化做 key),
 * 所以任何"为了让判据看见而改写文本"的动作都在动权限身份 —— 少考虑一种语法就是一次
 * allow 复用。`AGENTS.md` 指向的 `git-workflow` 也写明这类通用能力不该在业务 PR 里手写试错。
 *
 * 改成原样透传后,这一整类问题在结构上不再存在:身份恒等于原文,不可能折叠;
 * 解析判断错了也无害 —— 只影响"透传还是包装",两条路 core 都会判,不会凭空放行。
 *
 * 实测代价(18 种形态对比,15 种判档不变):
 *   `. 'C:\…\pwsh.exe' -enc X`(空格点源)、`pwsh -Command iwr … \`| iex`(反引号管道)
 *   从必问回到灰区 —— core 看不到解释器/跨段,与 `Bash` 入口结论一致,缺口登记在 **#2563**;
 *   `&& pwsh -enc X` 反而从灰区变必问(透传后 core 的分段器把 `&&` 当分隔符)。
 * 落灰区不等于放行:审阅器面对不可读的 base64 倾向询问。
 */
function powerShellExecCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  return looksLikePowerShellInvocation(trimmed)
    ? trimmed
    : `pwsh -Command ${quoteAsSingleShellToken(trimmed)}`;
}

/**
 * 把任意命令文本包成**一个** token,供审查判据取整条载荷。
 *
 * 判据是"core 的 tokenizer 能不能把这一个 token 还原成原文"。它的两条相关行为决定了写法:
 *   1. 单引号内**一切原样**(连反斜杠都保留)—— Windows 路径需要这个;
 *   2. 引号外的 `\X` **连反斜杠一起保留**(为了 Windows 路径分隔符),所以 POSIX 的 `\'`
 *      转义还原不回一个裸单引号。
 *
 * 于是:**单引号包装,内层 `'` 转成 `'"'"'`**(闭单引号 → 双引号裹一个单引号 → 重开单引号,
 * 相邻片段被 tokenizer 拼回同一个 token)。这样内层的 `"`、`\`、空格全部逐字还原。
 *
 * 两条都是实测踩过的坑,不要再换回去:
 *   - 用 `'\''` 转义 → tokenizer 保留反斜杠,单引号写的路径还原成 `\'C:\…\'`,取不到写目标;
 *   - 改用双引号 + PowerShell 的重复引号规则(`"` → `""`)→ 单引号路径修好了,但**双引号**
 *     写的路径反而坏掉:`""` 在 POSIX 规则下是"闭引号紧接开引号"= 字符串拼接,于是
 *     `Set-Content "C:\Program Files\Windows Defender\x" owned` 的引号被吃掉、路径按空格
 *     拆成 `C:\Program` + `Files\Windows` + …,系统路径判据整条失效(codex 报,已实测)。
 *   两种引号都得能过,所以只能用 tokenizer 自己那套规则,不能用 PowerShell 的。
 *
 * 只服务静态审查、不用于真实执行;转义单射,所以包装对缓存身份无损:不同原文必得不同结果。
 */
function quoteAsSingleShellToken(text: string): string {
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

/**
 * 命令**是否已经是** PowerShell 解释器调用 —— 只读判断,不改写、不重排。
 *
 * 覆盖:短名 / 带 `.exe` / 完整路径 / 带引号路径(含 PowerShell 重复引号转义)/
 * 前置调用运算符(`&` 调用、`.` 点源,与目标之间空白可选)。
 *
 * 判错的两个方向都不会放宽判档:
 *   - 误判成解释器 → 原样透传,core 按原文判(与 `Bash` 入口同口径);
 *   - 误判成裸语句 → 整条包进 `-Command` 载荷,文本型红线照样扫得到,通常更严。
 * 这正是不再做归一后换来的性质:解析不完备不再等于安全缺口。
 */
function looksLikePowerShellInvocation(command: string): boolean {
  // `&` 调用 / `&&` 链式 / `.` 点源都可能把解释器带在后面;`.` 必须紧跟空白或引号,
  // 否则 `.\script.ps1` / `./script.ps1` 是相对路径调用、开头的 `.` 不是运算符。
  //
  // 这里连 `&&` 一起认,与「归一时期」的口径相反 —— 那时必须排除 `&&`,因为把它改写成 `&`
  // 会让「语法错误、不执行」与「真执行」折叠成同一条缓存身份(codex 报)。现在只做识别、
  // 不改写内容,身份恒等于原文,`&&…` 与 `&…` 天然是两条不同身份,约束不再需要。
  // 同一段正则用于改写时危险、只用于识别时无害 —— 这就是不再归一换来的结构性收益。
  const withoutOperator = command.replace(/^(?:&{1,2}|\.(?=[\s'"]))\s*/, '');
  const target = leadingShellToken(withoutOperator);
  return target !== null && isPowerShellExecutable(target.value);
}

/**
 * 取开头的一个 token(支持单/双引号包裹的带空格路径),返回其**值**与在原串中占的长度。
 *
 * 引号内按 **PowerShell 转义**扫描:PowerShell 用「重复引号」表示字面引号,
 * `'C:\O''Brien\pwsh.exe'` 是一个 token、值为 `C:\O'Brien\pwsh.exe`。按首个匹配字符收尾
 * 会把它截成 `C:\O` —— 解释器认不出来,整条被包成 `-Command` 载荷,argv 级的
 * `-EncodedCommand` 红线随之失效(codex 报)。
 *
 * `length` 覆盖原文里的完整 token(含重复引号),调用方据此原样保留路径写法。
 */
function leadingShellToken(text: string): { value: string; length: number } | null {
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < text.length; i++) {
      if (text[i] !== quote) continue;
      if (text[i + 1] === quote) { i++; continue; } // 重复引号 = 字面引号,不收尾
      return { value: text.slice(1, i).replaceAll(quote + quote, quote), length: i + 1 };
    }
    return null; // 引号未闭合 → 不当作解释器调用,交给外层包装
  }
  const match = /^\S+/.exec(text);
  return match ? { value: match[0], length: match[0].length } : null;
}

/**
 * token 是否为 PowerShell 解释器。与 core 的 `executableName` 同口径:去目录、去 `.exe`、
 * 大小写无关。只做判断,**不用于改写** —— 改写会抹掉路径,而路径是缓存身份的一部分。
 */
function isPowerShellExecutable(token: string): boolean {
  const base = token.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.exe$/i, '').toLowerCase();
  return stem === 'pwsh' || stem === 'powershell';
}

function extractFilePath(toolName: string, input: unknown): string | undefined {
  const obj = input as Record<string, unknown> | null;
  if (!obj) return undefined;
  const key = toolName === 'NotebookEdit' ? 'notebook_path' : 'file_path';
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function extractCommand(input: unknown): string {
  const c = (input as { command?: unknown } | null)?.command;
  return typeof c === 'string' ? c : '';
}

/**
 * 读工具的路径字段(Read=file_path、NotebookRead=notebook_path、Grep/Glob/LS=path),交 core 判凭证。
 * 命中凭证位置(如 ~/.ssh、/Users/x/.aws)才升级——读内容(Read/Grep)与列目录(LS/Glob)都算侦察面;
 * 路径缺失(如 `Glob {pattern}` 无 path)返回 undefined,按普通只读放行。
 */
function extractReadPath(toolName: string, input: unknown): string | undefined {
  const obj = input as Record<string, unknown> | null;
  if (!obj) return undefined;
  const primaryKey = toolName === 'Read' ? 'file_path' : toolName === 'NotebookRead' ? 'notebook_path' : 'path';
  const candidates: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.length > 0) candidates.push(v);
  };
  push(obj[primaryKey]);
  // 文件选择器也可能直指凭证文件:Grep 的 glob(`{path:'/Users/me', glob:'**/.aws/credentials'}` 会读出内容)、
  // Glob 的 pattern(其本身就是路径选择器)。任一命中凭证就用它升级;Grep 的 pattern 是搜索正则、非路径,不纳入。
  if (toolName === 'Grep') push(obj.glob);
  if (toolName === 'Glob') push(obj.pattern);
  return candidates.find((c) => isSensitiveCredentialPath(c)) ?? candidates[0];
}

function extractNetworkTarget(toolName: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const obj = input as Record<string, unknown>;
  const key = toolName === 'WebFetch' ? 'url' : 'query';
  const value = obj[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Auto-review 下对一个**内置工具调用**给出审查档位。仅在权限档为 `auto` 时调用
 * (见 claude-code/index.ts 的 canUseTool dispatcher)。纯映射,判定逻辑全在 core。
 */
export function classifyBuiltinToolForAutoReview(
  ctx: BuiltinAutoReviewContext,
): BuiltinAutoReviewVerdict {
  const action = normalizeBuiltinToolForAutoReview(ctx.toolName, ctx.input);
  const opts = ctx.platform ? { platform: ctx.platform } : undefined;
  return reviewAction(action, ctx.workspaceRoots, opts);
}

/** 把 Claude 内置工具翻译成共享动作；判定与 AI fallback 都复用这一份归一化结果。 */
export function normalizeBuiltinToolForAutoReview(
  toolName: string,
  input: unknown,
): ReviewableAction {
  if (READ_ONLY_TOOLS.has(toolName)) {
    // Read/NotebookRead 读单个具名文件(scope='file');Grep/Glob/LS 是目录级递归读(scope='tree'),
    // 根在工作区外时能遍历进区外凭证子路径 → 由 core 按边界升级(见 reviewAction 的 read 分支)。
    const scope: 'file' | 'tree' = toolName === 'Read' || toolName === 'NotebookRead' ? 'file' : 'tree';
    return { kind: 'read', path: extractReadPath(toolName, input), scope };
  }
  if (SAFE_STATEFUL_TOOLS.has(toolName)) return { kind: 'session-state' };
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return { kind: 'file-write', path: extractFilePath(toolName, input) };
  }
  // Bash / PowerShell 都是「跑一段命令文本」,判据完全相同 —— 归一到 exec 让
  // classifyShellCommand 的红线(含 POWERSHELL_DANGER_PATTERNS)真正生效。
  // 漏掉 PowerShell 的后果不是「少审一个工具」而是**静默拒绝**:它会落到下面
  // 的兜底 other,而无 description 的 other 在 missingReviewEvidence 处直接
  // block、连模型都不问 —— Windows 用户在 Auto 档下用 PowerShell 是坏的。
  if (toolName === 'Bash') {
    return { kind: 'exec', command: extractCommand(input) };
  }
  if (toolName === 'PowerShell') {
    return { kind: 'exec', command: powerShellExecCommand(extractCommand(input)) };
  }
  // WebFetch/WebSearch:把 URL/搜索词送往外部(exfil 面)→ 升级。
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    return {
      kind: 'network',
      operation: toolName,
      target: extractNetworkTarget(toolName, input),
    };
  }
  // 未知 / 其它一切工具 → 升级给审阅器裁决。
  //
  // **必须带 description**:裸 `{ kind: 'other' }` 会在 missingReviewEvidence
  // (shared/auto-review-decision.ts)被判为「证据不足」→ 在调模型**之前**直接
  // block。那不是「fail-closed 升级」而是静默拒绝:用户既看不到卡也没有理由,
  // 而 SDK 每加一个内置工具就会复发一次(实测 PowerShell 已中)。
  return {
    kind: 'other',
    description: describeUnknownTool(toolName, input),
    // 形状+指纹能分缓存桶,但不能让审阅器区分工作区/系统路径或测试/生产目标。
    // 未映射工具在有显式归类之前必须用户确认,不能 allow(codex 报)。
    requireConsent: true,
  };
}

/**
 * 未映射工具的审查证据。三个约束同时成立,少一个就会出问题:
 *
 * 1. **非空** —— 否则 missingReviewEvidence 在调模型前直接 block(静默拒绝)。
 * 2. **不泄漏入参内容** —— description 会进 reviewer prompt,入参可能是文件正文、
 *    凭证或用户数据。所以只带**键名**与值的**形状**,绝不带值本身。
 * 3. **逐调用可区分** —— reviewAutoAction 的缓存键是整个 request 的序列化
 *    (claude-code/index.ts:2009)。只带工具名会让同一工具的所有调用共享一个键,
 *    于是「先一次无害调用拿到 allow、后续任意参数复用该 allow」(codex 报)。
 *    带上入参指纹让不同参数各自成键。
 *
 * 形状与指纹**不是**安全证据:审阅器看不见路径是工作区还是系统目录。未映射
 * 工具另标 `requireConsent`,确定性必问,不把 allow 交给审阅器。
 */
function describeUnknownTool(toolName: string, input: unknown): string {
  const shape = describeInputShape(input);
  return `Claude Code built-in tool "${toolName}" (not individually classified by Cindy). `
    + `Arguments withheld; structure only: ${shape}`;
}

/** 入参的键名与值形状(不含值本身),外加一个内容指纹用于逐调用分桶。 */
function describeInputShape(input: unknown): string {
  if (input === null || input === undefined) return 'none';
  if (typeof input !== 'object' || Array.isArray(input)) {
    return `${Array.isArray(input) ? 'array' : typeof input}#${contentFingerprint(input)}`;
  }
  const entries = Object.entries(input as Record<string, unknown>)
    .map(([key, value]) => `${key}:${valueShape(value)}`)
    .sort();
  const shape = entries.length > 0 ? `{${entries.join(', ')}}` : '{}';
  return `${shape}#${contentFingerprint(input)}`;
}

/** 值的形状:类型 + 规模。字符串只报长度,不报内容。 */
function valueShape(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  switch (typeof value) {
    case 'string': return `string(${value.length})`;
    case 'object': return `object(${Object.keys(value as object).length})`;
    default: return typeof value;
  }
}

/**
 * 内容指纹:让「同一工具、不同入参」落到不同缓存键。
 *
 * **必须抗碰撞** —— 这不是分桶提示,而是权限决定的调用身份:`reviewAutoAction` 的缓存键
 * 是整个 request 的序列化,指纹相同即两次调用共享同一条裁决结论。此前用 32 位 FNV-1a,
 * codex 给出并已实测复现的碰撞样本:
 *
 *     {"target":"/tmp/safe__","nonce":"DXELUy3B"}   → 2b-81a56911
 *     {"target":"/etc/passwd","nonce":"9A9Bi4ie"}   → 2b-81a56911   ← 同长度、同形状
 *
 * 前者拿到 `allow` 后,后者命中同一缓存键、不再经审阅器。故改用 SHA-256 截断 128 位。
 *
 * 入参先做**键序规范化**再摘要:`{a,b}` 与 `{b,a}` 语义相同,不规范化会因键序不同各建
 * 一条缓存 —— 那是白掏审阅费用(不是安全问题,但同轮重复调用会重复付费)。
 * 摘要单向,从指纹拿不回原文。
 */
function contentFingerprint(value: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(canonicalize(value, new Set())) ?? String(value);
  } catch {
    // BigInt、抛异常的 toJSON 等仍可能失败:退化成类型标记,仍比完全无区分好。
    return 'unserializable';
  }
  return createHash('sha256')
    .update(FINGERPRINT_SALT)
    .update(serialized, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

/**
 * 指纹盐:进程内随机、永不外传。
 *
 * 没有盐时,低熵入参的摘要是可穷举的 —— 审阅器拿到「键名 + 类型 + 长度 + 摘要」后,
 * 对候选值(如常见的 11 字符路径)逐个求摘要就能反推出原值,等于绕过「不发送入参内容」
 * 这条承诺(codex 报)。加盐后摘要在进程外没有意义。
 *
 * 代价为零:指纹只需要在**同一进程内**稳定 —— 它服务的 `autoReviewDecisionCache` 是
 * `new Map`(claude-code/index.ts:1965),会话内的内存缓存,本来就不跨进程存活;
 * `description` 也只进审阅器 prompt,不落盘、不进持久批准记忆。
 */
const FINGERPRINT_SALT = randomBytes(16);

/**
 * 递归按键名排序,让语义相同的入参得到同一份序列化。
 * `seen` 只用于识别**真环**(进入时加、离开时删),不把 DAG 里重复引用的同一对象误判成环。
 */
function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  const obj = value as object;
  if (seen.has(obj)) return '[circular]';
  seen.add(obj);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    // **必须 Object.create(null)**:`JSON.parse('{"__proto__":"x"}')` 产生的是 own 属性,
    // 但往普通 `{}` 上 `out['__proto__'] = …` 会触发原型 setter 而**不建立 own 属性** ——
    // 该字段被静默丢掉,`{"__proto__":"/tmp/safe__"}` 与 `{"__proto__":"/etc/passwd"}`
    // 都序列化成 `{}`(形状也相同)→ 指纹碰撞 → 前者的 allow 被后者复用(codex 报,已实测)。
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key], seen);
    }
    return out;
  } finally {
    seen.delete(obj);
  }
}
