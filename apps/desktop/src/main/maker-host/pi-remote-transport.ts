/**
 * SshPiTransport — pi `--mode rpc` JSONL over an SSH exec channel。
 *
 * 两种形态:
 *   - createSshPiTransport (direct):直接在远端跑 `pi --mode rpc`, 用
 *     `RemoteHost.execStream` 把那一对 stdin/stdout 拽回本地。断链即进程终止,
 *     重连 = 重新 exec + switch_session resume。
 *   - createSshPiDaemonTransport (daemon):远端 pi-manager 单例 daemon 持有 pi
 *     (unix socket bridge), SSH 断链后会话继续跑, 重连 attach(对齐 cc-mgr
 *     持久模型)。见 packages/maker-pi-manager。
 *
 * 协议层 (writeLine + onLine + onClose) 两种形态一致, PiRpcProcess 完全感知
 * 不到差异 (实测:pi 0.83.0 在非 pty ssh channel 上 JSONL framing 零污染,
 * 见 docs/research/pi-ssh-remote-feasibility.md §4)。
 *
 * env 注入:direct 远端 env 真值经 stdin env block 传递 (`KEY=value` 行 + 空行
 * 终止, wrapper 脚本 read + export 后 exec pi);daemon 经 RPC 参数 + env-file。
 * 两种都不进命令行 (`ps`/ssh audit log/错误消息都看不到)。
 *
 * Lifecycle (direct):
 *   - 构造即建 ssh channel, 后台探活;首个 writeLine 前先写 env block。
 *   - 任何阶段失败 → fire onClose(reason), 之后 writeLine 全 reject。
 *   - close() 关 ssh channel (kill 远端进程)。
 * Lifecycle (daemon):见 createSshPiDaemonTransport / killRemoteSession。
 */

import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

import type { RemoteHost, ExecStreamHandle } from '@cindy/maker-remote-ssh';
import { probeRemoteAgent, probePiManager } from '@cindy/maker-remote-ssh';

import { piManagerEnsure, piManagerKill } from './pi-manager-client.js';
import type {
  PiTransport,
  PiTransportCloseInfo,
  PiLineHandler,
  PiCloseHandler,
  PiRemoteFileOps,
} from '@cindy/maker-core';

interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export interface SshPiTransportOptions {
  /** Connected RemoteHost from maker-remote-ssh ConnectionPool。 */
  remoteHost: RemoteHost;
  /** 远端 pi 二进制绝对路径(probe 返回的 binaryPath)。 */
  binaryPath: string;
  /** pi 子命令参数(--mode rpc --session-dir ... 等)。 */
  args: string[];
  /** 远端工作目录。 */
  cwd: string;
  /** 注入远端的 env 真值(经 stdin env block, 不进命令行)。 */
  env: Record<string, string | undefined>;
  logger: Logger;
  /** ssh exec + 首个 stdout 字节的总等待预算。默认 15s。 */
  handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

// 轮 40-w4-t5 CRITICAL:key-aware 敏感字段名 —— 值形状正则覆盖不了 64-hex
// sessionToken / 自定义 MCP header 值, 字段名命中即整体替换。
const SENSITIVE_KEY_RE =
  /(^|[\s,{[])("?)([A-Za-z0-9_-]*)(token|secret|api[_-]?key|authorization|password|credential|CINDY_PI_MCP_BRIDGE|CINDY_PI_REMOTE_MCP_SECRET)([A-Za-z0-9_-]*)(\s*["]?\s*[:=]\s*)([^,\s}\]]+)/gi;

/** stderr 进桌面日志前的凭证脱敏(值形状 + key-aware 双保险)。
 *  轮 18-U4:导出供 pi-manager-client 复用(bridge stderr 进用户可见错误前脱敏)。
 *  轮 22-F3 MEDIUM:与 daemon 侧 scrubCredentialText(CREDENTIAL_SCRUB_RE)收敛
 *  同一套值形状覆盖 —— 补 xox(Slack)/LTAI(阿里云)/AKIA·ASIA(AWS)/PEM 私钥块,
 *  否则远端 stderr 吐这些形态时桌面红线漏脱敏。 */
export function redactCredentialText(text: string): string {
  let out = text.replace(
    /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|LTAI[A-Za-z0-9]{16,}|A(?:KIA|SIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g,
    '[REDACTED]',
  );
  out = out.replace(SENSITIVE_KEY_RE, (_m, pre: string, quote: string, _k1: string, _k2: string, _k3: string, sep: string) =>
    `${pre}${quote}[REDACTED]${sep}[REDACTED]`);
  return out;
}
// 轮 40-w1 HIGH:SSH stdout JSONL 缓冲上限 —— 与本地 attachJsonlReader 的
// MAX_JSONL_BUFFER_CHARS(16MB)对齐, 防远端异常输出无换行流导致 OOM。
const SSH_JSONL_MAX_BUFFER_CHARS = 16 * 1024 * 1024;
// 轮 40-w4 MEDIUM-1:写队列(pendingWrites)硬上限 —— SSH channel 建立阶段
// (execStream 挂住/极慢)时每次 writeLine 都会 push 闭包, 无上限会无界增长
// 且 RPC 层 timeout 无法移除 transport 队列里的项。超限 = channel 卡住,
// 关闭 transport(走 onClose 重连), 而不是继续累积。正常流量(单个 RPC
// 请求, 偶发并发)远低于此。
const MAX_PENDING_WRITES = 256;

/**
 * Conservative POSIX single-quote escape(与 ssh-keys.ts / codex-remote-transport 同款)。
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** per-host 远端 pi 二进制路径 cache(probe 一次,后续命中)。 */
const remotePiBinaryPathCache = new Map<string, string>();

/**
 * 解析远端 pi 二进制绝对路径。probe(远端 `pi --version`)+ cache,首次 ~200ms。
 * 远端路径形如 `$HOME/.xdt-server/v1/pi/pi`(installer 解压布局)。
 * 未安装 → 抛错(会话 start 前置的 silent install 应已装好)。
 */
export async function resolveRemotePiBinaryPath(host: RemoteHost): Promise<string> {
  const hostId = host.id;
  const cached = remotePiBinaryPathCache.get(hostId);
  if (cached) return cached;
  const probe = await probeRemoteAgent(host, 'pi');
  if (!probe.binaryPath) {
    throw new Error(
      `pi not installed on remote host ${hostId} — run install (Settings → Remote → Pi) or wait for silent install`,
    );
  }
  remotePiBinaryPathCache.set(hostId, probe.binaryPath);
  return probe.binaryPath;
}

/**
 * 远端 pi agentHome 文件操作原语(host 侧 SSH 实现)。
 *
 * 所有路径都是远端机器上的绝对路径。文件内容经 SSH stdin 管道写(cat > 原子写 +
 * chmod,内容绝不进命令行 —— 与 cc-manager bundle 上传同模式),stat 走 bash 脚本,
 * 删走 rm。pi 进程在远端读这些文件,host 侧必须把写/读/删落到远端机器。
 */
export function createRemotePiFileOps(remoteHost: RemoteHost): PiRemoteFileOps {
  return {
    async mkdirp(dir: string): Promise<void> {
      // 轮 22 CRITICAL:远端 agentHome 是字面 $HOME/... —— 必须用**远端** HOME
      // 展开。bash 双引号只展开一次参数(值里的 $HOME 不再递归展开), 且
      // ${P/#$HOME/$HOME} 右侧在单引号内不展开 —— 本地 JS 插值会把 Windows
      // 本地 HOME 拼进去(建出 /c/Users/... 字面目录), 字面 \$HOME 又得不到
      // 远端值。
      // 轮 43 P1(codex-connector):eval "P=$P" 对路径内 shell 语法(如 $(...)/反引号)
      // 无防护, 会执行命令替换。改用 H=\$(printf ...) 取远端 HOME + 参数替换
      // ${P#\$HOME} 剥离前缀(无 eval, 无注入风险)。
      const script = `P=${shellQuote(dir)}; case "$P" in '$HOME'/*) H=$(printf '%s' "$HOME"); [ "\${P#\\\$HOME}" != "$P" ] && P="\${H}\${P#\\\$HOME}";; esac; mkdir -p "$P"`;
      const result = await remoteHost.exec(`bash -c ${shellQuote(script)}`, {
        timeoutMs: 15_000,
        label: 'pi-remote-mkdirp',
      });
      if (result.exitCode !== 0) {
        throw new Error(`remote mkdir failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 200)}`);
      }
    },

    async writeFile(file: string, content: string, mode?: number): Promise<void> {
      const script = [
        `REMOTE_PATH=${shellQuote(file)}`,
        // 轮 43 P1(codex-connector):eval 换 H=$(printf) + 参数替换, 无注入风险。
        `case "$REMOTE_PATH" in '$HOME'/*) H=$(printf '%s' "$HOME"); [ "\${REMOTE_PATH#\\\$HOME}" != "$REMOTE_PATH" ] && REMOTE_PATH="\${H}\${REMOTE_PATH#\\\$HOME}";; esac`,
        `mkdir -p "$(dirname "$REMOTE_PATH")"`,
        // 原子写:内容只经 stdin 进入,不进 argv(ps / ssh audit log / 错误消息都看不到)。
        // (umask 077 && cat >) 而非 cat > + chmod:后者在 chmod 执行前文件已按
        // 默认 umask(常见 022)创建,同机其他用户存在短暂读取窗口(R5 安全审计 H-1)。
        // umask 077 让文件从创建那一刻起就是 600。
        `(umask 077 && cat > "$REMOTE_PATH")`,
        mode !== undefined ? `chmod ${mode.toString(8)} "$REMOTE_PATH"` : '',
      ].join('\n');
      const result = await remoteHost.exec(`bash -c ${shellQuote(script)}`, {
        input: content,
        timeoutMs: 30_000,
        label: 'pi-remote-write-file',
      });
      if (result.exitCode !== 0) {
        throw new Error(`remote write failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 200)}`);
      }
    },

    async stat(file: string): Promise<{ isFile: boolean } | null> {
      // 轮 43 P1(codex-connector):eval 换 H=$(printf) + 参数替换, 无注入风险。
      const script = `
P=${shellQuote(file)}
case "$P" in '$HOME'/*) H=$(printf '%s' "$HOME"); [ "\${P#\\\$HOME}" != "$P" ] && P="\${H}\${P#\\\$HOME}";; esac
if [ -f "$P" ]; then
  printf 'FILE\\n'
elif [ -e "$P" ]; then
  printf 'DIR\\n'
else
  printf 'MISSING\\n'
fi
`;
      const result = await remoteHost.exec(`bash -c ${shellQuote(script)}`, {
        timeoutMs: 10_000,
        label: 'pi-remote-stat',
      });
      const kind = result.stdout.trim().split(/\r?\n/).pop() ?? 'MISSING';
      if (kind === 'FILE') return { isFile: true };
      if (kind === 'DIR') return { isFile: false };
      return null;
    },

    async rm(fileOrDir: string, opts?: { recursive?: boolean }): Promise<void> {
      const flag = opts?.recursive === true ? ' -rf' : ' -f';
      // 轮 43 P1(codex-connector):eval 换 H=$(printf) + 参数替换, 无注入风险。
      const script = `P=${shellQuote(fileOrDir)}; case "$P" in '$HOME'/*) H=$(printf '%s' "$HOME"); [ "\${P#\\\$HOME}" != "$P" ] && P="\${H}\${P#\\\$HOME}";; esac; rm${flag} "$P"`;
      const result = await remoteHost.exec(`bash -c ${shellQuote(script)}`, {
        timeoutMs: 10_000,
        label: 'pi-remote-rm',
      });
      if (result.exitCode !== 0) {
        // rm -f 对不存在路径不报错;这里只对真正异常(权限等)抛。
        const msg = result.stderr.trim().slice(0, 200);
        if (msg) throw new Error(`remote rm failed (exit ${result.exitCode}): ${msg}`);
      }
    },

    async listDir(dir: string): Promise<string[]> {
      // 轮 43 P1(codex-connector):eval 换 H=$(printf) + 参数替换, 无注入风险。
      const script = `P=${shellQuote(dir)}; case "$P" in '$HOME'/*) H=$(printf '%s' "$HOME"); [ "\${P#\\\$HOME}" != "$P" ] && P="\${H}\${P#\\\$HOME}";; esac; ls -1 "$P" 2>/dev/null || true`;
      const result = await remoteHost.exec(`bash -c ${shellQuote(script)}`, {
        timeoutMs: 10_000,
        label: 'pi-remote-listdir',
      });
      if (result.exitCode !== 0) return [];
      return result.stdout
        .trim()
        .split(/\r?\n/)
        .filter((s) => s.length > 0 && s !== '.');
    },
  };
}

/**
 * createSshPiTransport — 直连模式:远端直接 spawn `pi --mode rpc`,ssh exec 桥 stdio。
 * 断链即进程终止(无 daemon 持久),重连 = 重新 spawn + switch_session resume。
 */
export function createSshPiTransport(opts: SshPiTransportOptions): PiTransport {
  return createSshPiChannelTransport(
    opts,
    (o) => {
      // wrapper:stdin 前段 = env block(read 到空行 break + export), 之后 exec pi ——
      // exec 替换 bash 进程后, 剩余 stdin 直接流入 pi(JSONL 命令)。
      // 注意:不能 `export "$LINE"` —— 双引号展开后 bash 会把展开结果重新当赋值
      // 语句解析, `K=$(cmd)` 文本会被执行命令替换(R5 安全审计 H-1)。改为参数展开
      // 先拆 KEY/VALUE, 再 `export "$KEY"="$VALUE"` —— 已展开的字符串不再递归解析,
      // 值里的 `$()` / 反引号只是普通文本。KEY 再做一次白名单校验(host 侧
      // serializeEnvBlock 已验, 这里是纵深防御)。
      const args = o.args.map(shellQuote).join(' ');
      const script = `
        while IFS= read -r LINE; do
          [ -z "$LINE" ] && break
          KEY=${'${LINE%%=*}'}
          case "$KEY" in
            [A-Za-z_][A-Za-z0-9_]*) VAL=${'${LINE#*=}'}; export "$KEY"="$VAL" ;;
          esac
        done
        cd ${shellQuote(o.cwd)} || exit 1
        exec ${shellQuote(o.binaryPath)} ${args}
      `.trim();
      return `bash -c ${shellQuote(script)}`;
    },
    (o) => ({
      // 直连模式:env block 走 stdin(与首个命令同一批次)。
      envViaStdin: o.env,
      envViaFile: undefined,
      daemonSessionId: undefined,
    }),
  );
}

/**
 * pi-manager 路径:确保单例 daemon 持有 pi(RPC ensure, 条件 restart 语义),
 * 返回 bridge 命令(session socket 桥回 ssh channel)。
 *
 * env 经 RPC 参数传递(不进命令行), daemon 内部写 per-session env-file(0600)。
 */
async function buildPiManagerDaemonCmd(
  opts: SshPiTransportOptions,
  chanOpts: SshPiChannelOptions,
  logger: Logger,
): Promise<string> {
  const sessionId = chanOpts.daemonSessionId!;
  // env 校验(R6 M-7):KEY 白名单 + 值拒换行/NUL(轮 18-U1:拒 \0 与 daemon 侧
  // session-registry 的 /[\r\n\0]/ 对齐 —— 否则 NUL 经 RPC 到 daemon 后
  // env-file 无法保真, 且与 direct 路径同款 fail-closed)。daemon 侧也校验,
  // 这里快速失败。
  const envEntries = Object.entries(chanOpts.envViaFile ?? {}).filter(([, v]) => v !== undefined);
  const env: Record<string, string> = {};
  for (const [k, v] of envEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n\0]/.test(v!)) {
      throw new Error(`pi-manager: unsafe env entry ${JSON.stringify(k)} — key must be [A-Za-z_][A-Za-z0-9_]*, value must not contain newlines or NUL`);
    }
    env[k] = v!;
  }
  // envHash:与 daemon 写入 env-file 的内容逐字节一致(KEY=VALUE 行 join \n)。
  const envHash = createHash('sha256')
    .update(Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n'))
    .digest('hex');
  // 轮 22-Z2 CRITICAL:piCmd 由 daemon 侧 `bash -c <cmd>` 执行 —— cmd 内
  // 单引号会冻住字面 $HOME(cwd/binaryPath 可能来自 probe 的字面 $HOME/...),
  // 导致 cd/exec 找不到路径 → pi 秒退(LAZY_CREATE_FAILED 同源)。
  // 双引号包住路径:bash -c 收到 cmd 后 $HOME 活动展开, macOS 用户名空格由
  // 双引号容纳。args 仍用 shellQuote(参数无 $HOME, 且可能含特殊字符)。
  // 注入防护:双引号内非 $HOME 的 $ 与反引号会展开 —— 拒绝($HOME 前缀是
  // probe 白名单形态, 展开后即远端绝对路径, 允许)。路径来自用户选择/固定
  // 模板, 正常只含 $HOME 前缀或绝对路径; 其它 $ 形态 fail-closed。
  const unsafeDollar = (s: string): boolean => {
    const rest = s.startsWith('$HOME/') ? s.slice('$HOME/'.length) : s;
    return /[\$`"]/.test(rest);
  };
  if (unsafeDollar(opts.cwd) || unsafeDollar(opts.binaryPath)) {
    throw new Error('pi-manager: unsafe cwd or binaryPath (contains $, backtick, or double-quote)');
  }
  // 轮 42 P1(codex-connector):args 里可能含 `$HOME/...` 字面值(如
  // --session-dir 与 plan-mode --extension 路径, 远端 agentHome 以 $HOME 前缀
  // 表达)。shellQuote 单引号会冻结 $HOME → pi 收到字面路径, 在 cwd 下建字面
  // $HOME 目录、扩展扫描不到。与 cwd/binaryPath 同款处理: `$HOME/` 前缀值用
  // **双引号**(bash -c 收到后活动展开), 其余仍 shellQuote。注入防护与
  // unsafeDollar 同口径: 去掉 $HOME/ 前缀后不得含 $ / 反引号 / 双引号。
  const quotePiArg = (arg: string): string => {
    if (!arg.startsWith('$HOME/')) return shellQuote(arg);
    const rest = arg.slice('$HOME/'.length);
    if (/[\$`"]/.test(rest)) {
      throw new Error('pi-manager: unsafe arg value (contains $, backtick, or double-quote after $HOME/)');
    }
    return `"${arg}"`;
  };
  const piCmd = [
    `cd "${opts.cwd}" || exit 1`,
    `exec "${opts.binaryPath}" ${opts.args.map(quotePiArg).join(' ')}`,
  ].join('\n');
  // 轮 42 P1(codex-connector):envHash 必须覆盖**完整启动身份** —— 旧版只 hash
  // env-file 内容, 但现存子进程的启动身份还依赖 cmd/args(如 BYOM baseUrl /
  // wire protocol 变化会改 models.json 内容 → 经 CINDY_PI_MANAGED_RG_PATH 等
  // env 之外的路由体现; gateway endpoint 变更同理)。env 相同但 cmd/args 变时
  // 纯 attach 会让旧 pi 继续用启动时加载的旧配置。hash 加入 piCmd 与 cwd。
  const launchHash = createHash('sha256')
    .update(envHash)
    .update('\n')
    .update(piCmd)
    .update('\n')
    .update(opts.cwd)
    .digest('hex');
  const ensured = await piManagerEnsure(opts.remoteHost, logger, {
    sessionId,
    cmd: piCmd,
    env,
    envHash: launchHash,
    restart: true,
  });
  // 轮 15 缺口 5:isReattach 留日志 —— 诊断断链重连是「会话继续」(消息历史
  // 完整)还是「全新 spawn」(历史可能丢)的关键线索。
  logger.debug('pi session ensured', {
    hostId: opts.remoteHost.id,
    sessionId,
    isReattach: ensured.isReattach,
  });
  // bridge session socket 到 ssh channel。sockPath 是展开后的绝对路径
  // (probe 返回 installDir 已展开 $HOME), 无需 bash -c wrapper 展开。
  // node/pi-manager 二进制路径用带缓存的 resolve(ensurePiManagerInstalled
  // 已 probe 过, 这里不重复 SSH 往返 —— 退役审轮 2 H-1)。
  const { nodeBinaryPath, piManagerBinaryPath } = await resolvePiManagerBinaryPaths(opts.remoteHost, logger);
  // 轮 22-Z2 CRITICAL(远端实测确认):bridgeScript 必须是 bash -c 的**单个 argv**
  // (直接拼会被远端 shell 拆词)。方案:内层路径用**双引号**(bash -c 收到脚本
  // 后 $HOME 活动展开, macOS 用户名空格由双引号容纳), 外层**整体 shellQuote**
  // 单引号包成单个 argv(外层 shell 不展开, bash -c 收到的是去掉引号的内容,
  // 其中双引号内 $HOME 正常展开)。node/pi-manager 路径是 probe 返回的字面
  // $HOME/...(白名单无注入), sockPath 来自 daemon 返回(绝对)。
  const bridgeScript = [
    `"${nodeBinaryPath}" "${piManagerBinaryPath}" bridge --socket "${ensured.sockPath}"`,
  ].join(' ');
  return `bash -c ${shellQuote(bridgeScript)}`;
}

/** pi-manager 二进制路径(带 per-host cache, 避免每次 bridge 都重复 probe)。 */
const piManagerPathsCache = new Map<string, { nodeBinaryPath: string; piManagerBinaryPath: string }>();

/**
 * 清除某 host 的远端路径 cache(轮 40-w4-t4 MEDIUM):host remove/disconnect/
 * update 后同名 host 重建会串到旧远端路径 —— 必须显式失效。
 */
export function invalidateRemotePiPathCaches(hostId: string): void {
  remotePiBinaryPathCache.delete(hostId);
  piManagerPathsCache.delete(hostId);
}

async function resolvePiManagerBinaryPaths(
  remoteHost: RemoteHost,
  logger: Logger,
): Promise<{ nodeBinaryPath: string; piManagerBinaryPath: string }> {
  const cached = piManagerPathsCache.get(remoteHost.id);
  if (cached) return cached;
  const probe = await probePiManager(remoteHost);
  const paths = { nodeBinaryPath: probe.nodeBinaryPath, piManagerBinaryPath: probe.piManagerBinaryPath };
  piManagerPathsCache.set(remoteHost.id, paths);
  return paths;
}

/**
 * createSshPiDaemonTransport — daemon 持久模式:远端 pi-manager 持有 pi
 * 进程(setsid 常驻, stdin/stdout 桥 unix socket), 本地 `daemon proxy --sock` 桥
 * socket 字节流。SSH 断链后 pi 会话继续跑, 重连后重新 proxy 即 attach(对齐
 * codex app-server daemon / cc-mgr 持久模型)。
 *
 * env 注入:env 经 env-file(daemon spawn pi 时读一次, 断开重连不再重传);env 真值
 * 只在远端 env-file 里(spawn 时注入), 不进命令行。
 */
export function createSshPiDaemonTransport(opts: SshPiTransportOptions & {
  /** daemon 会话 id(远端 ensure 的 session key;host 传 maker sessionId)。 */
  daemonSessionId?: string;
}): PiTransport {
  // daemon 模式必须有唯一 sessionId(env-file / pidfile / socket 文件名都拼它)。
  // 缺失(匿名会话)→ 回退直连模式,避免多个匿名会话共享同一 daemon 进程
  // (共享 stdin/stdout + 关一个杀全部 —— R2 生命周期 B1)。
  if (!opts.daemonSessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(opts.daemonSessionId)) {
    if (opts.daemonSessionId) {
      // 显式传入但含非法字符(路径遍历面)或超长(MAX_PATH):拒绝而非静默降级。
      throw new Error(
        `pi daemon: unsafe daemonSessionId ${JSON.stringify(opts.daemonSessionId)} — only [A-Za-z0-9_-]{1,128} allowed`,
      );
    }
    // 匿名会话缺 daemonSessionId → 回退直连。不静默:留日志便于诊断
    // (R5 配置审计 M-4 —— 会话未持久化、断链即终止)。
    opts.logger.warn('pi daemon: no daemonSessionId for this session — falling back to direct transport (no persistence)');
    return createSshPiTransport(opts);
  }
  return createSshPiChannelTransport(
    opts,
    (o) => {
      // 直连 wrapper 不用于 daemon 模式;daemon ensure 的 --cmd 由这里构造。
      throw new Error('unreachable');
    },
    (o) => ({
      envViaStdin: undefined,
      envViaFile: o.env,
      daemonSessionId: opts.daemonSessionId,
    }),
  );
}

interface SshPiChannelOptions {
  /** stdin env block(直连模式;首条命令前写入)。 */
  envViaStdin: Record<string, string | undefined> | undefined;
  /** env-file 内容(daemon 模式;ensure 时写入远端文件)。 */
  envViaFile: Record<string, string | undefined> | undefined;
  /** daemon 会话 id(daemon 模式;ensure 的 session key)。 */
  daemonSessionId: string | undefined;
}

/**
 * 共享的 ssh channel 桥实现。两种模式差异只在「远端怎么跑 pi」:
 *   - 直连:execStream 跑 wrapper(bash env block + exec pi)
 *   - daemon:execStream 跑 `daemon proxy --sock <path>`(桥已持有 pi 的 socket)
 */
function createSshPiChannelTransport(
  opts: SshPiTransportOptions,
  buildDirectCmd: (o: SshPiTransportOptions) => string,
  buildChannelOpts: (o: SshPiTransportOptions) => SshPiChannelOptions,
): PiTransport {
  const logger = opts.logger.child('pi-ssh-transport');
  const handshakeTimeoutMs = opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  let channel: ExecStreamHandle | null = null;
  let closed = false;
  let handshakeTimer: NodeJS.Timeout | null = null;
  /** 直连模式的 env block 是否已写入 channel(写前不得 drain RPC 命令)。 */
  let envWritten = false;

  const lineHandlers = new Set<PiLineHandler>();
  const closeHandlers = new Set<PiCloseHandler>();
  const stderrHandlers = new Set<(line: string) => void>();
  const pendingWrites: Array<{ line: string; resolve: () => void; reject: (err: Error) => void }> = [];
  /** stdout 行切分缓冲(ssh channel 文本块可能跨行/半行)。 */
  let stdoutBuffer = '';
  // 轮 8 发现 5:ExecStreamHandle.onStdout 用 chunk.toString('utf8') 逐块解码,
  // 跨 chunk 的多字节 UTF-8 字符会被切成 U+FFFD。改用 onStdoutBytes +
  // StringDecoder(与 attachJsonlReader 同款), 保证 JSONL 帧内中文/emoji 不损坏。
  const stdoutDecoder = new StringDecoder('utf8');

  /** stdout 尾部 flush(幂等):channel 关闭/主动 close 前把 stdoutBuffer 里
   *  残留的未换行尾帧(pi 崩溃前输出半行 / 最后一行无 \n)吐给 lineHandlers,
   *  decoder.end() 同时吐出跨 chunk 滞留的半字节序列。轮 8 发现 2(HIGH) 补的
   *  flush 只挂在 ch.onClose 里, fireClose 先置 closed 会把它挡掉 —— 任何
   *  close 路径(自然关闭/队列溢出/缓冲超限/error)都先执行一次(轮 20-V3 MEDIUM)。 */
  let flushedTail = false;
  const flushStdoutTail = (): void => {
    if (flushedTail) return;
    flushedTail = true;
    const tail = stdoutBuffer + stdoutDecoder.end();
    stdoutBuffer = '';
    if (tail.trim().length > 0) {
      fireLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail);
    }
  };

  const fireClose = (info: PiTransportCloseInfo): void => {
    if (closed) return;
    closed = true;
    flushStdoutTail();
    if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
    clearBackpressureTimer();
    drainListenerAttached = false;
    const err = new Error(`pi ssh transport closed: ${info.reason}`);
    for (const w of pendingWrites.splice(0)) w.reject(err);
    try { channel?.kill(); } catch { /* best-effort */ }
    channel = null;
    for (const handler of closeHandlers) {
      try { handler(info); } catch { /* handler should not throw */ }
    }
  };

  const fireLine = (line: string): void => {
    for (const handler of lineHandlers) handler(line);
  };

  const fireStderr = (line: string): void => {
    for (const handler of stderrHandlers) handler(line);
  };

  /** 轮 23-H4 HIGH:背压感知的写入 —— channel.write 返回 false(ssh2 缓冲满)
   *  时**不 resolve**, 等 channel drain 再写下一条; 带背压超时(防 drain 永不
   *  触发挂死)fireClose。写入抛错 reject 该条。 */
  let backpressureTimer: NodeJS.Timeout | null = null;
  let drainListenerAttached = false;
  // 轮 42 P2(codex-connector):背压等待标志 —— write 返回 false 时置位, drain
  // 触发前**不重入 drainPending**。否则新的 writeLine() 或 stdout chunk 在
  // drain 前再调 drainPending, 会重写 pendingWrites[0](同一帧), 慢 SSH 背压
  // 下重复 RPC 帧(重放 prompt/控制响应, 破坏请求顺序)。
  let waitingDrain = false;
  const clearBackpressureTimer = (): void => {
    if (backpressureTimer) { clearTimeout(backpressureTimer); backpressureTimer = null; }
  };
  const drainPending = (): void => {
    // 背压等待中: 等 drain 回调继续, 不重入(防止重写当前帧)。
    if (waitingDrain) return;
    // 一次只写一条:write 返回 false → 等 drain 再继续(背压闭环)。
    const next = pendingWrites[0];
    if (!next) return;
    if (!channel || closed) return;
    let ok = false;
    try {
      ok = channel.write(next.line + '\n');
    } catch (err) {
      pendingWrites.shift();
      next.reject(err instanceof Error ? err : new Error(String(err)));
      drainPending();
      return;
    }
    if (ok) {
      pendingWrites.shift();
      next.resolve();
      drainPending(); // 继续下一条
      return;
    }
    // 缓冲满:等 drain(带超时 —— 慢链路卡死时 fireClose 走重连)。
    waitingDrain = true;
    if (backpressureTimer) clearTimeout(backpressureTimer);
    backpressureTimer = setTimeout(() => {
      backpressureTimer = null;
      waitingDrain = false;
      fireClose({
        code: null,
        signal: null,
        reason: 'pi ssh write backpressure timeout (channel stuck?)',
      });
    }, 30_000);
    backpressureTimer.unref?.();
    // onDrain 只注册一次(避免每次背压累积 listener); drain 后清除标志,
    // 下一次背压重新注册。
    if (!drainListenerAttached) {
      drainListenerAttached = true;
      channel.onDrain(() => {
        drainListenerAttached = false;
        waitingDrain = false;
        clearBackpressureTimer();
        drainPending();
      });
    }
  };

  const writeLine = (line: string): Promise<void> => {
    if (closed) return Promise.reject(new Error('pi ssh transport already closed'));
    // 轮 40-w4 MEDIUM-1:队列溢出 = channel 卡住(建立阶段挂死或消费不及),
    // 关闭 transport 让上层走 onClose 重连 —— 比无界增长(闭包/内存)和
    // 卡住恢复后批量 drain 已超时旧请求都好。
    if (pendingWrites.length >= MAX_PENDING_WRITES) {
      fireClose({
        code: null,
        signal: null,
        reason: `pi ssh write queue overflow (${MAX_PENDING_WRITES} pending — channel stuck?)`,
      });
      return Promise.reject(new Error('pi ssh transport write queue overflow'));
    }
    return new Promise<void>((resolve, reject) => {
      pendingWrites.push({ line, resolve, reject });
      // channel 就绪 + env 已写才真正 drain(R2 传输 Bug4/5:未就绪时 reject 会让
      // 慢 SSH 下首条 get_state 失败;env 未写时先 drain 会让 RPC 命令被 wrapper
      // 当 KEY=VALUE 消费)。就绪则由 channel 建立后的 drainPending() 触发。
      if (channel && envWritten) drainPending();
    });
  };

  void (async () => {
    try {
      const chanOpts = buildChannelOpts(opts);
      let cmd: string;
      if (chanOpts.daemonSessionId) {
        // daemon 模式:pi-manager(TS 单例 daemon + NDJSON RPC)是唯一形态。
        // 失败传播异常 → 外部 catch 触发 fireClose(无回退路径)。
        cmd = await buildPiManagerDaemonCmd(opts, chanOpts, logger);
      } else {
        cmd = buildDirectCmd(opts);
      }

      // 轮 40-w4-t6 HIGH:execStream 可能晚于 handshake timeout/close() 返回 ——
      // 不能在已 closed 的 transport 上继续注册 handler/写 env/发命令。晚到
      // channel 必须立即 kill(否则远端进程/channel 成孤儿累积)。
      const lateChannel = await opts.remoteHost.execStream(cmd, { timeoutMs: handshakeTimeoutMs });
      if (closed) {
        try { lateChannel.kill(); } catch { /* best-effort */ }
        return;
      }
      channel = lateChannel;
      const ch = channel;
      // 直连模式:channel 建立后**先写** env block,再 drain 排队的 RPC 命令
      // (R2 传输 Bug5:命令先于 env 到达会被 wrapper 当 KEY=VALUE 消费丢失)。
      if (!chanOpts.daemonSessionId && chanOpts.envViaStdin) {
        // 轮 8 发现 10:直连模式 env 校验与 daemon 模式对齐 —— 值含 \n 会被
        // wrapper 的 read -r 按行拆开, 后续形如 FOO=bar 的行可能被 case 命中
        // 额外 export(注入面)。wrapper 有 KEY case 白名单兜底, 这里纵深防御
        // 快速失败。
        const envEntries = Object.entries(chanOpts.envViaStdin).filter(([, v]) => v !== undefined);
        for (const [k, v] of envEntries) {
          // 轮 18-U1 MEDIUM:拒 \0 与 daemon 路径对齐(session-registry 同款
          // /[\r\n\0]/) —— wrapper 的 read -r 无法保真 NUL 字节, 会截断/腐化
          // env block, 实际环境与调用方输入不一致(direct 路径缺同等 fail-closed)。
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || /[\r\n\0]/.test(v!)) {
            fireClose({
              code: null,
              signal: null,
              reason: `unsafe env entry ${JSON.stringify(k)} — key must be [A-Za-z_][A-Za-z0-9_]*, value must not contain newlines or NUL`,
            });
            ch.kill();
            return;
          }
        }
        const envLines = envEntries.map(([k, v]) => `${k}=${v}`);
        ch.write(envLines.join('\n') + '\n\n');
      }
      ch.onStdoutBytes((chunk: Buffer) => {
        if (closed) return;
        if (handshakeTimer) { clearTimeout(handshakeTimer); handshakeTimer = null; }
        stdoutBuffer += stdoutDecoder.write(chunk);
        // 轮 40-w1 HIGH:SSH stdout 缓冲无 OOM 上限(本地 attachJsonlReader 有
        // 16MB guard, 双实现契约不一致)。远端路径更不可信 —— 超限丢弃缓冲并
        // 关闭(继续解析已无意义, 且防 OOM)。
        if (stdoutBuffer.length > SSH_JSONL_MAX_BUFFER_CHARS) {
          logger.warn('pi ssh stdout buffer exceeded limit — closing transport', {
            hostId: opts.remoteHost.id,
            bytes: stdoutBuffer.length,
          });
          stdoutBuffer = '';
          fireClose({ code: null, signal: null, reason: 'pi ssh stdout buffer overflow (no newline in stream)' });
          return;
        }
        while (true) {
          const newlineIndex = stdoutBuffer.indexOf('\n');
          if (newlineIndex === -1) break;
          let line = stdoutBuffer.slice(0, newlineIndex);
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.trim().length === 0) continue;
          fireLine(line);
        }
        drainPending();
      });
      envWritten = true;
      drainPending();
      ch.onStderr((s) => {
        const trimmed = s.trim();
        if (trimmed) {
          // 轮 40-w4-t5 CRITICAL:direct fallback 的 stderr 绕过 daemon 侧 scrub,
          // 进桌面日志前 key-aware 脱敏(env 凭证/64-hex sessionToken)。
          const redacted = redactCredentialText(trimmed);
          logger.warn('pi ssh stderr', { line: redacted.slice(0, 500) });
          fireStderr(redacted);
        }
      });
      ch.onClose((info) => {
        // 尾部 flush 统一由 fireClose 里的 flushStdoutTail 执行(幂等)——
        // 这里不再自己 flush:fireClose 可能已被其它路径(队列溢出/缓冲超限/
        // error)先触发, 由 flushStdoutTail 保证任何 close 路径都收尾帧。
        if (!closed) {
          const reason = info.signal
            ? `ssh channel closed (signal=${info.signal})`
            : `ssh channel closed (exit code=${info.code ?? 'null'})`;
          const signal = (info.signal ?? null) as NodeJS.Signals | null;
          fireClose({ code: info.code ?? null, signal, reason });
        }
      });
      ch.onError((err) => {
        // err 不一定是 Error 实例(轮 8 发现 6):裸字符串/非对象时 message 为
        // undefined, 用 String() 兜底。
        const msg = err instanceof Error ? err.message : String(err);
        fireClose({ code: null, signal: null, reason: `ssh channel error: ${msg}` });
      });

    } catch (err) {
      // err 不一定是 Error 实例(依赖可能 throw 字符串), 用 String() 兜底避免
      // "(err as Error).message" 产出 "undefined"(R7 审计 M-2)。
      // 轮 40-w4-t16 HIGH(日志盲区):失败分支必须留结构化日志 —— 否则现场
      // 无法区分 buildCmd/execStream/env/首字节超时, 连不上被折叠成黑盒。
      logger.error('pi ssh transport setup failed', {
        hostId: opts.remoteHost.id,
        stage: 'setup',
        channelEstablished: channel !== null,
        pendingWrites: pendingWrites.length,
        error: err instanceof Error ? err.message : String(err),
      });
      fireClose({
        code: null,
        signal: null,
        reason: `execStream failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
  })();

  // 轮 40-w4-t3 CRITICAL:handshake timeout 必须覆盖完整 setup 生命周期
  // (buildCmd → execStream → env block → 首个 stdout 字节)。旧实现只在
  // channel !== null 时 fireClose —— execStream 卡住(SSH client.exec callback
  // 永不返回)时 channel 恒为 null, timer 静默结束且 transport 永久半连接,
  // 上层 RPC timeout 无法触发 onClose 重连语义。
  //
  // 语义变化:从「channel 建立后未收到字节才超时」改为「从构造起 X ms 内未
  // 完成 setup + 首个字节就超时」。两种意图统一由这一个 timer 承担 ——
  // channel 建立前的 execStream 等待也计入预算, 慢 SSH 首连 15s 内正常完成
  // 不受影响(首个字节到达时 clearTimeout)。仍保留「有排队写入才 fireClose」
  // 的 R2 传输 Bug6 语义:只有正在等响应的 transport 才需要超时收口, 空闲
  // transport(无 pendingWrites)不误杀。
  handshakeTimer = setTimeout(() => {
    if (closed) return;
    if (pendingWrites.length === 0) {
      // 没有在等写入(空闲 transport)—— 保持打开, 由后续写入触发新的
      // handshake 计时。不 fireClose(R2 传输 Bug6 语义)。
      handshakeTimer = null;
      return;
    }
    const reason = `ssh handshake timeout after ${handshakeTimeoutMs}ms (channel established: ${channel !== null})`;
    // 轮 40-w4-t16 HIGH(日志盲区):timeout 分支留诊断上下文(阶段/hostId)。
    logger.error('pi ssh handshake timeout', {
      hostId: opts.remoteHost.id,
      stage: 'handshake',
      timeoutMs: handshakeTimeoutMs,
      channelEstablished: channel !== null,
      pendingWrites: pendingWrites.length,
    });
    // 迟到 channel 也一并 kill —— 防止 execStream 在超时后终于返回一个
    // 半建立 channel, 挂起远端进程/占住连接。
    try { channel?.kill(); } catch { /* best-effort */ }
    fireClose({ code: null, signal: null, reason });
  }, handshakeTimeoutMs);
  handshakeTimer.unref?.();

  return {
    writeLine,

    onLine(handler: PiLineHandler): () => void {
      lineHandlers.add(handler);
      return () => { lineHandlers.delete(handler); };
    },

    // 显式类型标注(轮 8 发现 4):与 PiTransport 接口契约对齐, 防重构引入
    // 类型漂移(对比 codex-remote-transport 的 StderrHandler 标注)。
    onStderr(handler: (line: string) => void): () => void {
      stderrHandlers.add(handler);
      return () => { stderrHandlers.delete(handler); };
    },

    onClose(handler: PiCloseHandler): () => void {
      closeHandlers.add(handler);
      return () => { closeHandlers.delete(handler); };
    },

    async close(reason = 'pi ssh transport close()'): Promise<void> {
      if (closed) return;
      fireClose({ code: null, signal: null, reason });
    },

    get pid(): undefined {
      return undefined;
    },

    isClosed(): boolean {
      return closed;
    },

    // 远端实际使用的 pi 二进制路径(plan-mode 扩展 / subagent 都用它,不能是本地路径)。
    get remoteBinaryPath(): string {
      return opts.binaryPath;
    },

    // daemon 模式:用户主动 close 会话时杀掉远端 daemon 持有的 pi(对齐 CC/Codex
    // daemon 生命周期)。直连模式不设(断链即进程随 channel 死)。
    async killRemoteSession(): Promise<void> {
      const chanOpts = buildChannelOpts(opts);
      if (!chanOpts.daemonSessionId) return;
      await killRemotePiManagerSession(
        opts.remoteHost,
        chanOpts.daemonSessionId,
        logger,
      );
    },
  };
}

/** pi-manager 会话 kill(host 主动关会话时调用,杀远端 pi 进程;幂等)。 */
export async function killRemotePiManagerSession(
  remoteHost: RemoteHost,
  sessionId: string,
  logger?: Logger,
): Promise<void> {
  // 与 createSshPiDaemonTransport 同款白名单(session 进 RPC 与远端路径拼接)。
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    throw new Error(`pi daemon: unsafe sessionId ${JSON.stringify(sessionId)} — only [A-Za-z0-9_-]{1,128} allowed`);
  }
  // pi-manager RPC kill;失败传播(残留由 daemon 空闲超时兜底)。
  // 轮 25 CRITICAL:SESSION_NOT_FOUND 视为幂等成功 —— rehydrate/resume 时 DB 里
  // 的 sdkSessionId 可能对应已 teardown/重启清掉的远端 session, 没有可杀的东西
  // = 目标态已达成, 不该上浮成 REHYDRATE_FAILED 卡死恢复路径。
  try {
    await piManagerKill(remoteHost, logger ?? remoteHostLogger, sessionId);
  } catch (err) {
    if ((err as { code?: string })?.code === 'SESSION_NOT_FOUND') {
      logger?.debug?.('pi killRemoteSession: session already gone (idempotent success)', { sessionId });
      return;
    }
    throw err;
  }
}

/** 轻量 logger 适配(pi-manager-client 需要)。 */
const remoteHostLogger: Logger = {
  debug: () => undefined,
  // info 用 console.log(轮 8 发现 9):info 是正常运维信息, 混入 stderr 会污染
  // 错误流; warn/error 保持 stderr。
  info: (msg, ctx) => console.log('[pi-ssh]', msg, ctx ?? ''),
  warn: (msg, ctx) => console.error('[pi-ssh][warn]', msg, ctx ?? ''),
  error: (msg, ctx) => console.error('[pi-ssh][error]', msg, ctx ?? ''),
  child: () => remoteHostLogger,
};
