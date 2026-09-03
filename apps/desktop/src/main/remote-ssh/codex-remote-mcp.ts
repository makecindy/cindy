/**
 * codex-remote-mcp — 让远端常驻 codex daemon 用上本机 in-process MCP
 * (cindy_orca / orca_worker_bridge 等),经 SSH remote-forward 直连本机
 * HTTP bridge (codexHttpBridge)。
 *
 * 链路:
 *   远端 daemon → http://127.0.0.1:<remotePort>/mcp/<server>  (sshd 监听)
 *     → SSH remote-forward (`ssh -R`)
 *     → 本机 127.0.0.1:<bridgePort>  (codexHttpBridge, Bearer 鉴权)
 *
 * 稳定性设计(daemon 常驻,不能每次 app 重启都要求它重配):
 *   - remotePort per-host 持久化 (<userData>/remote-mcp-forwards.json) 并作为
 *     preferred 传入 RemoteHost.ensureRemoteForward (#715):端口被占时由
 *     RemoteHost 顺延探测,重绑到新端口时持久化新值并靠 config 漂移检测自愈;
 *   - bearer 用 persistent token (safeStorage, 见 mcp-integrations/
 *     remoteMcpBridgeToken.ts),daemon env 在 bootstrap 时注入后不失效;
 *   - 远端 config.toml 漂移检测:内容一致不重写、不重启 daemon;
 *     漂移 (首次 / 端口换 / server 列表变) 才写入并经幂等 bootstrap 重启 daemon。
 *
 * 安全:
 *   - sshd 只监听远端 127.0.0.1 (不暴露到远端网络);token 防远端本机的
 *     无意/低端伪造请求,远端主机自身安全由其自身负责;
 *   - token 只经 exec stdin 的 KEY=value 块传给 bootstrap (secrets only
 *     live in stdin: argv 与远端 `ps` 不可见, cmd 不进日志, 见
 *     RemoteHost.exec 的 label 约定),不落远端文件。
 */

import { app } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RemoteHost } from '@cindy/maker-remote-ssh';

import { createLogger } from '../logger.js';
import {
  REMOTE_ALLOWED_SERVER_NAMES,
  REMOTE_COLLAB_SERVER_NAMES,
  computeRemoteMcpFingerprint,
  selectRemoteInjectableServerNames,
} from '../mcp-integrations/codexHttpBridge.js';
import { getRemoteMcpBridgeToken } from '../mcp-integrations/remoteMcpBridgeToken.js';

const log = createLogger('codex-remote-mcp');

const TOKEN_ENV = 'LIZI_MCP_TOKEN';
// 远端注入白名单的唯一真源在 codexHttpBridge.ts (bridge 鉴权层按
// REMOTE_ALLOWED_SERVER_NAMES = 协同 + cindy_memory scope persistent token)。
// 这里取协同别名保持本文件既有引用点不变;cindy_memory 独立走 Maker Memory
// 全局开关 (daemon config 是 per-host 共享的, 没有 per-session 粒度)。
const CODEX_REMOTE_MCP_SERVER_NAMES = REMOTE_COLLAB_SERVER_NAMES;
const MANAGED_BEGIN = '# >>> cindy-remote-mcp (managed, do not edit) >>>';
const MANAGED_END = '# <<< cindy-remote-mcp <<<';
/**
 * 受管段内 token 指纹注释行前缀 (见 renderManagedMcpBlock)。merge 的残留
 * 判定必须认识它, 否则该行被当成用户内容剥出受管段, 幂等漂移检测失效。
 */
const TOKEN_FINGERPRINT_PREFIX = '# cindy-token-fingerprint:';
/** per-host 远端首选端口:无持久化记录时的起始值 (实际绑定由 RemoteHost 探测顺延)。 */
const DEFAULT_REMOTE_PORT_START = 47921;
/** 与 codex-remote-transport.ts 的 installRoot 默认值一致。 */
const DEFAULT_INSTALL_ROOT = '$HOME/.xdt-server/v1';

/** 远端 MCP 注入所需的 bridge 信息(由调用方确保 bridge 已启动后提供)。 */
export interface RemoteMcpBridgeEndpoint {
  port: number;
  /** bridge 上实际挂出的 server 名 (如 cindy_orca / orca_worker_bridge)。 */
  serverNames: string[];
  /**
   * bridge 实例代际 id (CodexHttpBridge.instanceId)。bridge 重建后旧实例
   * 签发的 mcp-session-id 全部失效,但常驻 daemon 无感知 — 代际进漂移
   * 指纹, 让重建也触发 re-bootstrap (codex-connector P2)。
   */
  bridgeInstanceId: string;
}

export interface EnsureRemoteCodexMcpResult {
  ok: boolean;
  /** 失败原因 (bridge-unavailable / token-unavailable / forward-failed / ...)。 */
  reason?: string;
  daemonRebootstrapped?: boolean;
}

export interface StripRemoteCodexMcpConfigResult {
  daemonRebootstrapped: boolean;
}

// ── per-host 固定 remotePort 与已生效指纹持久化 ─────────────────────────────

type PortPrefs = Record<string, { remotePort: number; appliedFingerprint?: string; bridgeLocalPort?: number }>;

function portPrefsPath(): string {
  return path.join(app.getPath('userData'), 'remote-mcp-forwards.json');
}

let portPrefsCache: PortPrefs | null = null;

function readPortPrefs(): PortPrefs {
  if (portPrefsCache) return portPrefsCache;
  const file = portPrefsPath();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
      const out: PortPrefs = {};
      if (raw && typeof raw === 'object') {
        for (const [hostId, v] of Object.entries(raw as Record<string, unknown>)) {
          const port = (v as { remotePort?: unknown })?.remotePort;
          if (typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536) {
            out[hostId] = { remotePort: port };
            const fp = (v as { appliedFingerprint?: unknown })?.appliedFingerprint;
            if (typeof fp === 'string' && fp.length > 0) {
              out[hostId].appliedFingerprint = fp;
            }
            const blp = (v as { bridgeLocalPort?: unknown })?.bridgeLocalPort;
            if (typeof blp === 'number' && Number.isInteger(blp) && blp > 0 && blp < 65536) {
              out[hostId].bridgeLocalPort = blp;
            }
          }
        }
      }
      portPrefsCache = out;
      return out;
    }
  } catch (err) {
    log.warn('remote-mcp-forwards.json read failed → falling back to empty', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  portPrefsCache = {};
  return portPrefsCache;
}

function writePortPrefs(next: PortPrefs): void {
  const file = portPrefsPath();
  const tmp = `${file}.tmp`;
  // userData 在真实 app 里由 electron 保证存在; 测试 stub 只拼路径不建
  // 目录, 全新环境直接 writeFileSync 会 ENOENT (CI 回归: 目录依赖测试
  // 执行顺序)。recursive mkdir 对已有目录是 no-op。
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
  portPrefsCache = next;
}

function writeHostRemotePort(hostId: string, remotePort: number): void {
  writePortPrefs({ ...readPortPrefs(), [hostId]: { ...readPortPrefs()[hostId], remotePort } });
}

/** 记录本机 bridge 当前本地端口:bridge 重建换端口时识别并拆除旧 forward。 */
function writeHostBridgeLocalPort(hostId: string, bridgeLocalPort: number): void {
  const current = readPortPrefs()[hostId];
  if (!current) return;
  writePortPrefs({ ...readPortPrefs(), [hostId]: { ...current, bridgeLocalPort } });
}

/**
 * bootstrap 确认成功后落「已生效指纹」。这是 daemon env 与 config 一致性
 * 的唯一持久事实:config 已写入 (changed=false) 但 bootstrap 失败/中断 +
 * app 重启的组合下,进程内 pending 标记会丢,而本记录不会 — 下次 ensure
 * 比较「应有指纹 ≠ 已生效指纹」仍会强制 bootstrap,daemon 不会永远持旧
 * env 401 (Greptile P1: 重启丢失令牌更新状态)。
 */
function writeHostAppliedFingerprint(hostId: string, fingerprint: string): void {
  const current = readPortPrefs()[hostId];
  if (!current) return; // 无端口记录 = 未曾注入, 不写孤儿行
  writePortPrefs({ ...readPortPrefs(), [hostId]: { ...current, appliedFingerprint: fingerprint } });
}

/** 清理路径 (白名单为空) bootstrap 后调用:daemon env 已清, 摘除生效记录。 */
function clearHostAppliedFingerprint(hostId: string): void {
  const current = readPortPrefs()[hostId];
  if (!current?.appliedFingerprint) return;
  const next = { ...readPortPrefs() };
  delete next[hostId].appliedFingerprint;
  writePortPrefs(next);
}

/** host 被删时清理端口记录 (registerRemoteSshIpc 的 remove 路径调用)。 */
export function removeRemoteMcpForwardPref(hostId: string): void {
  const current = readPortPrefs();
  if (!(hostId in current)) return;
  const next = { ...current };
  delete next[hostId];
  writePortPrefs(next);
}

/**
 * Endpoint fields changed while the stable SSH alias stayed the same.
 * Keep the alias's preferred remote port, but discard facts that only apply to
 * the old machine/connection. The next ensure must rebuild the forward and
 * bootstrap the new endpoint instead of trusting the old applied fingerprint.
 */
export function invalidateRemoteCodexMcpEndpointState(hostId: string): void {
  const current = readPortPrefs()[hostId];
  if (!current || (!current.appliedFingerprint && !current.bridgeLocalPort)) return;
  writePortPrefs({
    ...readPortPrefs(),
    [hostId]: { remotePort: current.remotePort },
  });
}

// ── 远端 config.toml 管理段 (纯函数, 便于单测) ──────────────────────────────

/** 生成我们管理的 mcp_servers 配置块 (带 begin/end 标记)。 */
export function renderManagedMcpBlock(opts: {
  remotePort: number;
  serverNames: string[];
  /**
   * 当前 bridge token 的指纹 (sha256 前 12 hex, 非 token 本身)。写进受管段
   * 让 token 轮换 (账号切换清空重生成) 也构成 config 漂移 — 否则 daemon
   * env 里的旧 token 不失效, config 无漂移不重启, 远端请求全部 401。
   */
  tokenFingerprint: string;
}): string {
  const lines: string[] = [MANAGED_BEGIN, `${TOKEN_FINGERPRINT_PREFIX} ${opts.tokenFingerprint}`];
  for (const name of opts.serverNames) {
    lines.push(
      `[mcp_servers.${name}]`,
      `url = "http://127.0.0.1:${opts.remotePort}/mcp/${name}"`,
      `bearer_token_env_var = "${TOKEN_ENV}"`,
      'startup_timeout_sec = 600',
      'tool_timeout_sec = 600',
      '',
    );
  }
  lines.push(MANAGED_END);
  return lines.join('\n');
}

/**
 * 解析一行为 TOML table header 的 dotted key 分段; 非 header 行返回 null。
 * 覆盖尾注释 (`[a.b] # note`)、array-of-tables (`[[a.b]]`) 与引号 key
 * (`[mcp_servers."name"]`) — 只做强直判定 (inner 不含 `]` 的形态),
 * 多行字符串内容里以 `[` 开头但不符合 header 形态的行不会被误判成边界。
 */
function parseTableHeaderKey(line: string): string[] | null {
  const m = /^(\[+)([^\]]*?)(\]+)(?:\s*#.*)?$/.exec(line);
  if (!m) return null;
  const inner = m[2].trim();
  if (!inner) return null;
  return inner
    .split('.')
    .map((seg) => seg.trim().replace(/^(['"]?)(.*)\1$/, '$2').trim());
}

/**
 * 判断一行 (trim 后) 是否为指定 server 的用户级 mcp_servers table header
 * (含 `[mcp_servers.<name>.*]` 子表、引号 key 与 array-of-tables 形态)。
 */
function userMcpServerHeader(line: string, serverNames: string[]): string | null {
  const segments = parseTableHeaderKey(line);
  if (!segments || segments[0] !== 'mcp_servers' || segments.length < 2) return null;
  const name = segments[1];
  return serverNames.includes(name) ? name : null;
}

/**
 * managed 段残留内容的行形态:orphan begin (有 begin 无 end, 通常是写文件
 * 半途中断) 的自愈只剥这一段连续形态, 遇到任何不属于它的行 (用户配置)
 * 即停 — 不会像"剥到 EOF"那样误删用户配置。
 */
function isManagedResidueLine(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  if (t.startsWith(TOKEN_FINGERPRINT_PREFIX)) return true;
  const header = parseTableHeaderKey(t);
  if (header && header[0] === 'mcp_servers') return true;
  return /^(url|bearer_token_env_var|startup_timeout_sec|tool_timeout_sec)\s*=/.test(t);
}

/**
 * 把管理段 merge 进现有 config.toml 内容。逐行处理:
 *   - marker 行级精确匹配 (trim 后整行相等):子串匹配会把用户注释里提到
 *     marker 文本的内容误判成管理段起点;
 *   - managed 段原位剥除后在文末重建 (TOML 与顺序无关, 幂等收敛);
 *     orphan begin (缺 end) 只剥连续的 managed 残留形态行, 不波及用户配置;
 *   - managed 段之外用户手写的同名 `[mcp_servers.<name>]` table 一并剥离
 *     (重复 table 是非法 TOML, codex 会直接起不来), 由 managed 段接管,
 *     名字经 strippedUserServers 返回给调用方记 warn;
 *   - table 边界按 header 形态判定 (parseTableHeaderKey), 多行字符串内容里
 *     以 `[` 开头但形态不符的行不会提前结束剥离 (残留风险: 内容行恰好是
 *     合法 header 形态时仍会误判 — 已知局限, codex config 场景可接受)。
 * 返回 { next, changed } — 内容一致时 changed=false, 调用方据此跳过写文件
 * 与 daemon 重启。
 */
export function mergeManagedMcpBlock(
  existing: string,
  block: string,
  opts?: { serverNames?: string[] },
): { next: string; changed: boolean; strippedUserServers: string[] } {
  const serverNames = opts?.serverNames ?? [];
  const stripped = new Set<string>();
  const kept: string[] = [];
  let inManaged = false;
  let inUserBlock = false;
  for (const line of existing.split('\n')) {
    const t = line.trim();
    if (t === MANAGED_BEGIN) {
      inManaged = true;
      continue;
    }
    if (t === MANAGED_END) {
      inManaged = false;
      continue;
    }
    if (inManaged) {
      if (isManagedResidueLine(line)) continue;
      // orphan begin: 用户内容开始, 退出 managed 状态并保留该行。
      inManaged = false;
    }
    const hit = userMcpServerHeader(t, serverNames);
    if (hit) {
      stripped.add(hit);
      inUserBlock = true;
      continue;
    }
    if (inUserBlock) {
      // table 延伸到下一个任何 header 形态行 (table / array-of-tables) 为止。
      if (parseTableHeaderKey(t)) {
        inUserBlock = false;
      } else {
        continue;
      }
    }
    kept.push(line);
  }
  const trimmed = kept.join('\n').replace(/\s+$/, '');
  // block='' (清理路径, 见 doEnsure 空白名单分支):只剥除受管段, 不重建。
  const next =
    block === ''
      ? trimmed.length > 0
        ? `${trimmed}\n`
        : ''
      : trimmed.length > 0
        ? `${trimmed}\n\n${block}\n`
        : `${block}\n`;
  return { next, changed: next !== existing, strippedUserServers: [...stripped] };
}

// ── 远端命令 (与 codex-remote-transport.ts 的 codexCmd wrapper 同布局) ────────

function shellQuoteSh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function codexHomePrefix(installRoot: string): string {
  return [
    `INSTALL_ROOT="${installRoot}"`,
    'export CODEX_HOME="$INSTALL_ROOT/codex-home"',
  ].join('; ');
}

function codexDaemonCmd(subArgs: string[], opts?: { envFromStdin?: boolean }): string {
  const lines = [
    codexHomePrefix(DEFAULT_INSTALL_ROOT),
    'CODEX="$CODEX_HOME/packages/standalone/current/codex"',
    'if [ ! -x "$CODEX" ]; then exit 127; fi',
    // proxy env marker 存在则 source (与 codex-remote-transport.ts 的 codexCmd
    // wrapper 同语义):daemon 的两条启动路径 (transport bootstrap / 本模块
    // MCP bootstrap) 必须产出一致的 env — 本路径不 source 的话, MCP 注入 /
    // token 轮换 / 代际漂移触发的重启会让 daemon 丢 proxy env, 而远端
    // marker 内容未变, proxy reconcile 走 fast path 不再重启, 远端流量
    // 永久旁路用户 proxy (codex-connector R18 P1)。
    'if [ -f "$INSTALL_ROOT/agent-proxy.env" ]; then . "$INSTALL_ROOT/agent-proxy.env"; fi',
    // secret 不进 argv (远端 `ps` 可见):经 stdin 的 KEY=value 块传入, 空行
    // 终止, 与 remote-ssh/index.ts oneShotCommand 的 stdin 协议一致。
    ...(opts?.envFromStdin
      ? ['while IFS= read -r LINE; do [ -z "$LINE" ] && break; export "$LINE"; done']
      : []),
    `exec "$CODEX" ${subArgs.map(shellQuoteSh).join(' ')}`,
  ].join('\n');
  return `bash -c ${shellQuoteSh(lines)}`;
}

function readConfigCmd(): string {
  // 只有「文件不存在」按空 config 处理;存在但读失败 (权限 / 瞬时 IO)
  // 必须 exit 非 0 让 readRemoteConfig 抛错 — 否则空 stdout 被当成缺席,
  // 后续 merge/write 会把用户已有 config (含 MCP/provider 配置与 secret)
  // 整个替换成只剩受管段 (codex-connector R24 P2, 数据丢失类)。
  return `bash -c ${shellQuoteSh(
    `${codexHomePrefix(DEFAULT_INSTALL_ROOT)}; ` +
      `if [ -f "$CODEX_HOME/config.toml" ]; then cat "$CODEX_HOME/config.toml"; fi`,
  )}`;
}

function writeConfigCmd(): string {
  // 原子写:先 decode 到 tmp 再 mv 就位。直接 `> config.toml` 时, decode
  // 失败或 SSH 中断会把用户配置截断成空/半截 — 这里编辑的是真实远端
  // config.toml, 错误路径不得破坏现有内容 (tmp 残留无害, 下次覆盖)。
  // base64 内容经 stdin 传入, 不进 argv:用户 config.toml 可能已含 secret
  // (其他 MCP server 的 bearer / provider token), argv 在远端 `ps` / audit
  // log 可见 — 与 bootstrap token 的 "secrets only live in stdin" 同约束
  // (review: PR #778 codex-connector R17 P1)。
  // umask 077:同一份 secret 内容也不得被远端其他本地用户读到 — 默认 022
  // 下 tmp / config 与新建 $CODEX_HOME 都是世界可读的 (codex-connector
  // R20 P2;与 ssh-keys.ts 的 0o700 私钥目录同语义)。
  return `bash -c ${shellQuoteSh(
    `umask 077; ${codexHomePrefix(DEFAULT_INSTALL_ROOT)}; mkdir -p "$CODEX_HOME" && ` +
      `base64 -d > "$CODEX_HOME/config.toml.tmp" && ` +
      `mv "$CODEX_HOME/config.toml.tmp" "$CODEX_HOME/config.toml"`,
  )}`;
}

async function readRemoteConfig(host: RemoteHost): Promise<string> {
  const result = await host.exec(readConfigCmd(), { timeoutMs: 15_000, label: 'read codex config.toml' });
  if (result.exitCode !== 0) {
    throw new Error(`read remote config.toml failed: ${result.stderr.trim().slice(0, 200)}`);
  }
  return result.stdout;
}

async function writeRemoteConfig(host: RemoteHost, content: string): Promise<void> {
  const b64 = Buffer.from(content, 'utf-8').toString('base64');
  const result = await host.exec(writeConfigCmd(), {
    timeoutMs: 15_000,
    label: 'write codex config.toml',
    // base64 单行无空白, stdin 写完即 EOF, base64 -d 读到 EOF 解码 (与
    // bootstrapDaemon 的 stdin 协议同通道, cmd 不进日志见 exec label 约定)。
    input: `${b64}\n`,
  });
  if (result.exitCode !== 0) {
    throw new Error(`write remote config.toml failed: ${result.stderr.trim().slice(0, 200)}`);
  }
}

/** daemon 是否在跑 (version 探活, 与 transport 的 discoverSocketPath 同语义)。 */
async function isDaemonRunning(host: RemoteHost): Promise<boolean> {
  const result = await host.exec(codexDaemonCmd(['app-server', 'daemon', 'version']), {
    timeoutMs: 10_000,
    label: 'codex-daemon-version',
  });
  return result.exitCode === 0;
}

/**
 * 幂等 bootstrap (不存在则创建 settings + 启动, 已存在则重写 settings +
 * 重启 daemon)。token 只经 stdin 的 KEY=value 块注入 daemon env —— argv 与
 * 远端 `ps` 可见的命令行都不含 secret (与 oneShotCommand 的 "secrets only
 * live in stdin" 一致), cmd 不进日志 (RemoteHost.exec 的 label 约定),
 * 不落远端文件。
 */
async function bootstrapDaemon(host: RemoteHost, token: string): Promise<void> {
  const result = await host.exec(
    codexDaemonCmd(['app-server', 'daemon', 'bootstrap', '--remote-control'], {
      envFromStdin: true,
    }),
    {
      timeoutMs: 30_000,
      label: 'codex-daemon-bootstrap',
      // KEY=value 行 + 空行终止符 (wrapper 的 read 循环消费; token 是 hex,
      // 无换行/空格, 单行安全)。read 循环后 stdin 即 EOF, daemon 不读 stdin。
      input: `${TOKEN_ENV}=${token}\n\n`,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(`daemon bootstrap exit=${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`);
  }
}

// ── per-host 固定 remotePort:持久化值优先, 被占则由 RemoteHost 顺延探测 ──────

async function ensureRemotePort(host: RemoteHost, localBridgePort: number): Promise<number> {
  const prefs = readPortPrefs()[host.id];
  const preferred = prefs?.remotePort;
  // bridge 重建换本地端口:旧 localPort 的 forward 在 RemoteHost 上仍 armed
  // (ensureRemoteForward 按 localHost:localPort 幂等, 不主动拆) — 不拆每次
  // 重建多吃一个远端端口, 最终填满扫描窗口 (codex-connector R19 P2)。
  const staleBridgeLocalPort = prefs?.bridgeLocalPort;
  if (staleBridgeLocalPort !== undefined && staleBridgeLocalPort !== localBridgePort) {
    try {
      await host.closeRemoteForward('127.0.0.1', staleBridgeLocalPort);
      log.info('stale remote MCP forward closed after bridge port change', {
        host: host.id,
        staleLocalPort: staleBridgeLocalPort,
        localPort: localBridgePort,
      });
    } catch (err) {
      log.warn('close stale remote MCP forward failed (continuing)', {
        host: host.id,
        staleLocalPort: staleBridgeLocalPort,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // 端口分配下推给 RemoteHost.ensureRemoteForward (#715):先试上次实际绑定
  // 的端口,再按首选基数顺延探测;断线重连自动 re-arm,重绑到新端口时经
  // onRearmed 通知。连接代际竞争 (bind 期间 SSH 换代) 由 RemoteHost 内部
  // 的 stale-arm 重试处理,不在候选间漂移。
  const fwd = await host.ensureRemoteForward({
    localHost: '127.0.0.1',
    localPort: localBridgePort,
    preferredRemotePort: preferred ?? DEFAULT_REMOTE_PORT_START,
    onRearmed: (remotePort) => {
      // 重连后隧道口被重绑到新端口:持久化新值。旧 daemon config 仍指向旧
      // 端口,下一次 ensure 的漂移检测会重写 config 并重启 daemon 自愈。
      writeHostRemotePort(host.id, remotePort);
      log.info('remote MCP forward port re-armed to new port after reconnect', {
        host: host.id,
        remotePort,
      });
      rearmedHook?.(host.id, remotePort);
    },
  });
  if (fwd.remotePort !== preferred) {
    // 换了端口:持久化新值。旧 daemon config 指向旧端口,但接下来的
    // config 漂移检测会重写并重启 daemon,自洽恢复。
    writeHostRemotePort(host.id, fwd.remotePort);
    log.info('remote MCP forward port (re)assigned', { host: host.id, remotePort: fwd.remotePort });
  }
  if (staleBridgeLocalPort !== localBridgePort) {
    writeHostBridgeLocalPort(host.id, localBridgePort);
  }
  return fwd.remotePort;
}

/**
 * forward 端口重绑 (onRearmed) 时的宿主钩子:maker-host 注入,用于让该
 * host 上活跃 remote CC query 的 fresh 状态失效并重建 (旧 query 的
 * mcpServers URL 还指旧端口, codex-connector R19 P2)。remote-ssh 不反向
 * 依赖 maker-host, 经本钩子解耦。
 */
let rearmedHook: ((hostId: string, remotePort: number) => void) | null = null;

export function setRemoteMcpForwardRearmedHook(fn: (hostId: string, remotePort: number) => void): void {
  rearmedHook = fn;
}

/**
 * 清理路径 (serverNames 空) 拆除本 host 的 MCP forward 并摘除
 * bridgeLocalPort 记录:collab 禁用 / token 失效后远端不再需要到本机
 * bridge 的隧道, 残留 forward 是无谓的远端端口占用 (R20 P2 同源)。
 * close 失败不阻断清理 (记录照摘, 服务端残留随连接死亡消失)。
 */
async function releaseRemoteMcpForwardIfAny(host: RemoteHost): Promise<void> {
  const stale = readPortPrefs()[host.id]?.bridgeLocalPort;
  if (stale === undefined) return;
  try {
    await host.closeRemoteForward('127.0.0.1', stale);
    log.info('remote MCP forward released on cleanup path', { host: host.id, staleLocalPort: stale });
  } catch (err) {
    log.warn('release remote MCP forward failed (continuing cleanup)', {
      host: host.id,
      staleLocalPort: stale,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const current = readPortPrefs()[host.id];
  if (!current?.bridgeLocalPort) return;
  const next = { ...readPortPrefs() };
  delete next[host.id].bridgeLocalPort;
  writePortPrefs(next);
}

// ── per-host 串行锁与共用 forward 入口 ───────────────────────────────────────

/**
 * per-host 串行链:同一 host 的 forward 端口分配 / config.toml 读写 / daemon
 * bootstrap 必须串行——并发时两个 ensure 会互相交错 arm 与 config 写入,
 * 把 config 写成已失效的端口。codex daemon ensure 与 cc per-query forward
 * ensure 共用同一把锁。
 * 链上每个环节都吞掉异常(锁永不死锁),Map 每 host 常驻一条,量可忽略。
 */
const hostSerialChain = new Map<string, Promise<void>>();

function withHostSerial<T>(hostId: string, fn: () => Promise<T>): Promise<T> {
  const prev = hostSerialChain.get(hostId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  hostSerialChain.set(
    hostId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/**
 * 确保 host 上有指向本机 MCP bridge 的 remote-forward,返回远端监听端口。
 * per-host 固定端口(持久化),cc 与 codex 的远端 session 共用同一条 forward。
 * 锁内执行,与 daemon ensure 串行。
 */
export function ensureRemoteMcpForward(
  host: RemoteHost,
  localBridgePort: number,
): Promise<number> {
  return withHostSerial(host.id, () => ensureRemotePort(host, localBridgePort));
}

// ── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * bridge shutdown 时的立即清理 (无 bridge 变体, codex-connector R21 P1):
 * 插件 / 全局设置变更触发 shutdownCodexEnvironment 后, 远端 daemon config
 * 仍指向已停 bridge — 立刻剥受管段 + 清 daemon env, 让「指向死 bridge 的
 * 404 / connection-refused MCP」当场降级为「无 MCP」;lazy 重建后恢复遍历
 * (remote-codex-mcp-recovery) 会按常规漂移路径重新注入。
 *
 * live turn 时整体跳过:旧 config 在 turn 中仍可用 (daemon 内存态),
 * turn-done 的 ensure 会兜底。失败只记 warn 不抛 (shutdown 路径不因此被
 * 阻断)。与 ensure 共用 per-host 串行锁。
 */
export function stripRemoteCodexMcpConfig(
  host: RemoteHost,
  deps?: { hasLiveTurnOnHost?: (hostId: string) => boolean },
): Promise<StripRemoteCodexMcpConfigResult> {
  return withHostSerial(host.id, () => doStripRemoteCodexMcpConfig(host, deps));
}

/**
 * stripRemoteCodexMcpConfig 的无锁核心 — 供已持有 per-host 串行锁的
 * ensure 路径直调 (R27 P2:bridge 不可用的 cleanup-only 分支;锁内再入
 * withHostSerial 会自死锁)。
 */
async function doStripRemoteCodexMcpConfig(
  host: RemoteHost,
  deps?: { hasLiveTurnOnHost?: (hostId: string) => boolean },
): Promise<StripRemoteCodexMcpConfigResult> {
  {
    try {
      if (deps?.hasLiveTurnOnHost?.(host.id)) return { daemonRebootstrapped: false };
      const existing = await readRemoteConfig(host);
      const { next, changed } = mergeManagedMcpBlock(existing, '', { serverNames: [] });
      if (changed) {
        await writeRemoteConfig(host, next);
        log.info('remote codex config.toml managed block stripped on bridge shutdown', {
          host: host.id,
        });
      }
      const applied = readPortPrefs()[host.id]?.appliedFingerprint;
      const daemonRunning = await isDaemonRunning(host);
      if (daemonRunning && (changed || applied)) {
        await bootstrapDaemon(host, '');
        log.info('remote codex daemon rebootstrapped with empty MCP env on bridge shutdown', {
          host: host.id,
        });
        clearHostAppliedFingerprint(host.id);
        await releaseRemoteMcpForwardIfAny(host);
        return { daemonRebootstrapped: true };
      }
      if (changed || applied) clearHostAppliedFingerprint(host.id);
      await releaseRemoteMcpForwardIfAny(host);
      return { daemonRebootstrapped: false };
    } catch (err) {
      log.warn('strip remote codex MCP config on bridge shutdown failed', {
        host: host.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return { daemonRebootstrapped: false };
    }
  }
}

/**
 * live send 前的轻量 MCP 漂移判定 (纯本地, 零远程 RTT):「应有状态」与
 * appliedFingerprint 不一致 ⇒ 需要一次完整 ensure。成分:
 *   - collab 关闭 / token 缺失:applied 存在 = 待清理;
 *   - bridge 不在 (shutdown 后):返回 true — ensure 会触发 lazy 重建并按
 *     collab/token 现状重注入或清理;
 *   - bridge 在:全成分 (token|instanceId|remotePort|servers) 与 applied 比对。
 * stripRemoteCodexMcpConfig 后 applied 被摘除 ⇒ collab 开时恒 true
 * (codex-connector R23 P1:strip 后 idle-live 的 send 必须 send 前恢复)。
 * servers 成分用白名单全集 — collab 开启时 provider 恒注册
 * (keepOrcaProviderStable), 与 ensure 内 filter 结果一致。
 */
export function hasPendingRemoteMcpDrift(
  hostId: string,
  opts: {
    collabEnabled: boolean;
    /**
     * Maker Memory 全局开关 (manager.isEnabled)。开着时 desired server 列表
     * 含 cindy_memory — 与 ensure 内的注入集合同源, 开关翻转构成漂移。
     */
    makerMemoryEnabled: boolean;
    token: string | null;
    bridgeInstanceId: string | null;
  },
): boolean {
  const applied = readPortPrefs()[hostId]?.appliedFingerprint ?? null;
  if ((!opts.collabEnabled && !opts.makerMemoryEnabled) || !opts.token) {
    // 清理语义:applied 存在 = 待清理 (strip / 清理路径未跑过)。
    return applied !== null;
  }
  if (!opts.bridgeInstanceId) {
    return true;
  }
  const remotePort = readPortPrefs()[hostId]?.remotePort ?? DEFAULT_REMOTE_PORT_START;
  // desired 集合与 ensure 的注入集合靠 selectRemoteInjectableServerNames 构造
  // 同源;available 传白名单全集 = 「provider 恒注册」假设 (keepOrcaProviderStable,
  // memory 侧由调用方按活跃 bridge 快照预钳制)。
  const desired = computeRemoteMcpFingerprint({
    token: opts.token,
    bridgeInstanceId: opts.bridgeInstanceId,
    remotePort,
    serverNames: selectRemoteInjectableServerNames([...REMOTE_ALLOWED_SERVER_NAMES], {
      collabEnabled: opts.collabEnabled,
      memoryEnabled: opts.makerMemoryEnabled,
    }),
  });
  return desired !== applied;
}

/**
 * 确保远端 codex daemon 能用上本机 MCP bridge。幂等,挂在 remote codex
 * session 的 start/resume 前置 (ensureRemoteReadyForSessionStart)。
 * 整个 ensure 在 per-host 串行锁内执行 (见 withHostSerial)。
 *
 * best-effort 之外的失败语义:bridge/token 不可用 → { ok:false } 并记 warn,
 * 调用方放行 session (远端无 MCP 也能跑, 与现状一致);forward/config/daemon
 * 操作抛错同样折叠为 { ok:false } — 不让 MCP 注入阻塞 session 建立。
 */
export function ensureRemoteCodexMcpBridge(
  host: RemoteHost,
  deps: {
    ensureBridgeStarted: () => Promise<RemoteMcpBridgeEndpoint | null>;
    /**
     * 同 host 是否有 live turn (远端 daemon 正在跑 query)。config 漂移需要
     * 重启 daemon 才能生效,而重启会断 live turn — 有 live turn 时本次
     * 跳过 config 写入与重启 (config 保持旧值, 下次 ensure 仍会检测到
     * 漂移并重试), 降级为远端无 MCP。未注入时按无 live turn 处理。
     */
    hasLiveTurnOnHost?: (hostId: string) => boolean;
    /**
     * Collab 全局开关 (plugin registry Tier 4, 不依赖 workingDir)。缺省视为
     * 开启。provider 层为工具面稳定在禁用时仍注册 cindy_orca
     * (keepOrcaProviderStable), bridge 名单不反映开关 — 远端注入必须以本
     * 闸门为准: 禁用时按清理路径剥受管段 (codex-connector R20 P2)。
     */
    isCollabEnabled?: () => boolean;
    /**
     * Maker Memory 全局开关 (manager.isEnabled)。开着时把 cindy_memory 一并
     * 写进远端 daemon config (daemon 是 per-host 共享的, 无 per-session
     * 粒度; per-session prompt 注入仍由 maker-core 按 session flag 决定,
     * withStore 在 manager 禁用时返回 MAKER_MEMORY_NOT_READY 兜底)。缺省
     * 视为关闭 — 未接线的调用方不改变既有行为。
     */
    isMakerMemoryEnabled?: () => boolean;
  },
): Promise<EnsureRemoteCodexMcpResult> {
  return withHostSerial(host.id, () => doEnsureRemoteCodexMcpBridge(host, deps));
}

async function doEnsureRemoteCodexMcpBridge(
  host: RemoteHost,
  deps: {
    ensureBridgeStarted: () => Promise<RemoteMcpBridgeEndpoint | null>;
    hasLiveTurnOnHost?: (hostId: string) => boolean;
    /**
     * Collab 全局开关 (plugin registry Tier 4, 不依赖 workingDir)。缺省视为
     * 开启。provider 层为工具面稳定在禁用时仍注册 cindy_orca
     * (keepOrcaProviderStable), bridge 名单不反映开关 — 远端注入必须以本
     * 闸门为准: 禁用时按清理路径剥受管段 (codex-connector R20 P2)。
     */
    isCollabEnabled?: () => boolean;
    /** 见 ensureRemoteCodexMcpBridge.deps.isMakerMemoryEnabled。 */
    isMakerMemoryEnabled?: () => boolean;
  },
): Promise<EnsureRemoteCodexMcpResult> {
  try {
    let daemonRebootstrapped = false;
    const bridge = await deps.ensureBridgeStarted();
    if (!bridge) {
      // bridge 起不来时清理场景 (collab 全局禁用 / token 失效 / 曾注入过)
      // 不需要 bridge — 剥 config / 清 env 都是纯远端操作。直接走 strip
      // (R21 的无 bridge 变体), 否则 bridge 停机期间旧 config/env 残留,
      // 远端持续暴露死 MCP (codex-connector R27 P2)。从未注入过且无清理
      // 对象的维持 bridge-unavailable 早退。
      const applied = readPortPrefs()[host.id]?.appliedFingerprint;
      const collabEnabled = deps.isCollabEnabled?.() ?? true;
      const memoryEnabled = deps.isMakerMemoryEnabled?.() ?? false;
      const token = getRemoteMcpBridgeToken();
      if (applied || (!collabEnabled && !memoryEnabled) || !token) {
        log.warn('bridge unavailable — running cleanup-only strip on remote host', {
          host: host.id,
          hadAppliedFingerprint: Boolean(applied),
          collabEnabled,
          memoryEnabled,
          hasToken: Boolean(token),
        });
        // 已在 per-host 串行锁内 (ensure 持锁), 直调无锁核心 (R27 P2 自死锁修正)。
        const stripResult = await doStripRemoteCodexMcpConfig(host, { hasLiveTurnOnHost: deps.hasLiveTurnOnHost });
        return { ok: true, daemonRebootstrapped: stripResult.daemonRebootstrapped };
      }
      log.warn('remote MCP injection skipped: http bridge unavailable', { host: host.id });
      return { ok: false, reason: 'bridge-unavailable' };
    }
    // 只注入白名单 server (协同 + 开着 Maker Memory 时的 cindy_memory):
    // bridge 上还挂着其他 in-process provider (cindy_ssh 等), 全量写进远端
    // daemon config 会让远端 session 获得本机 MCP 能力, 越出边界。合成规则
    // 唯一真源在 selectRemoteInjectableServerNames (codexHttpBridge.ts, 与
    // cc 侧 / drift 判定共用)。
    const token = getRemoteMcpBridgeToken();
    const collabEnabled = deps.isCollabEnabled?.() ?? true;
    let serverNames = selectRemoteInjectableServerNames(bridge.serverNames, {
      collabEnabled,
      memoryEnabled: deps.isMakerMemoryEnabled?.() ?? false,
    });
    if (
      !collabEnabled &&
      serverNames.length === 0 &&
      bridge.serverNames.some((n) => CODEX_REMOTE_MCP_SERVER_NAMES.has(n))
    ) {
      // collab 全局禁用 (且 memory 也没开):bridge 名单不反映开关
      // (keepOrcaProviderStable) — 按清理路径剥受管段, 远端从「工具可见但
      // 调用必败」降级为不暴露 (codex-connector R20 P2)。
      log.info('collab globally disabled — cleaning remote managed block', { host: host.id });
    }
    if (serverNames.length > 0 && !token) {
      // token 不可用但本 host 之前注入过 (appliedFingerprint 在):旧 config
      // 与 daemon env 会让远端继续暴露 cindy_orca / orca_worker_bridge 而
      // 每次调用 401 — 比「降级无 MCP」更糟。按清理路径剥受管段 + 清 env
      // (codex-connector R19 P2);token 恢复后下次 ensure 自然重新注入。
      // 之前没注入过则维持早退 (无清理对象)。
      if (!readPortPrefs()[host.id]?.appliedFingerprint) {
        log.warn('remote MCP injection skipped: persistent token unavailable (safeStorage?)', {
          host: host.id,
        });
        return { ok: false, reason: 'token-unavailable' };
      }
      log.warn('remote MCP token lost after prior injection — cleaning remote managed block', {
        host: host.id,
      });
      serverNames = [];
    }
    // 清理路径 (白名单为空, collab 被禁用等) 不强求 token:剥除受管段不需要
    // 指纹, bootstrap 传空 token — daemon 不再持有有效 token 正是清理目标。
    const effectiveToken = token ?? '';

    // 只有确实要下发 server 时才 arm forward:清理路径 (serverNames 空)
    // 剥 config / 清 env 都不经隧道 — forward 被拒或扫描窗口耗尽不该
    // 阻断清理, 否则旧受管段与 daemon env 残留成「持续暴露死 MCP」
    // (codex-connector R20 P2)。拆除旧 forward 则推迟到清理真正生效
    // (bootstrap) 时:live turn 期间 defer 不拆 — daemon 内存里的旧
    // config 还指着这个端口, 早拆会让进行中的协同调用 connection
    // refused, 与「不打断 live turn」自相矛盾 (codex-connector R21 P2)。
    const remotePort = serverNames.length > 0 ? await ensureRemotePort(host, bridge.port) : 0;

    // token 与 bridge 代际一起进指纹:token 轮换 (账号切换) 与 bridge 重建
    // (旧 mcp-session-id 全失效, codex-connector P2) 都构成 config 漂移,
    // 走既有路径重启 daemon 拿到新 env / 新连接。
    const tokenFingerprint = createHash('sha256')
      .update(`${effectiveToken}|${bridge.bridgeInstanceId}`, 'utf8')
      .digest('hex')
      .slice(0, 12);
    const existing = await readRemoteConfig(host);
    // serverNames 为空时 block='':merge 只剥不建 — 清掉上一次注入留下的
    // 受管段 (不能早退, 否则 daemon 永远持旧 token env 与死配置,
    // codex-connector P2);本来就没注入过 → changed=false → no-op。
    const block = serverNames.length > 0
      ? renderManagedMcpBlock({
          remotePort,
          serverNames,
          tokenFingerprint,
        })
      : '';
    const { next, changed, strippedUserServers } = mergeManagedMcpBlock(existing, block, {
      serverNames,
    });
    if (strippedUserServers.length > 0) {
      log.warn('user-defined mcp_servers blocks taken over by managed block', {
        host: host.id,
        servers: strippedUserServers,
      });
    }
    if (changed) {
      await writeRemoteConfig(host, next);
      log.info('remote codex config.toml mcp_servers updated', {
        host: host.id,
        remotePort,
        servers: serverNames,
      });
    }

    // 「daemon env 是否已生效」的唯一持久事实:应有指纹 (清理路径为 null —
    // 目标是 daemon 不持 token) vs bootstrap 确认时落盘的已生效指纹。
    // 不一致 ⇒ 必须 (重) bootstrap;bootstrap 失败/中断 + app 重启后它依然
    // 成立, 自愈不依赖任何进程内存态 (Greptile P1: 重启丢失令牌更新状态)。
    // 指纹成分 = token|bridge 代际|remotePort|server 列表:后两者不进
    // config 的指纹注释行 (那里的职责是触发 config 重写), 但同样是「必须
    // 重启 daemon 才生效」的成分 — 端口重绑 / server 列表变化 + bootstrap
    // 失败时缺了它们 driftUnapplied 会漏判, daemon 永远拿着旧 URL /
    // server 列表 (codex-connector R19 P1)。changed 仍是并列独立触发。
    const desiredFingerprint = serverNames.length > 0
      ? computeRemoteMcpFingerprint({
          token: effectiveToken,
          bridgeInstanceId: bridge.bridgeInstanceId,
          remotePort,
          serverNames,
        })
      : null;
    const appliedFingerprint = readPortPrefs()[host.id]?.appliedFingerprint ?? null;
    const driftUnapplied = desiredFingerprint !== appliedFingerprint;
    const needApply = changed || driftUnapplied;

    const daemonRunning = await isDaemonRunning(host);
    if (needApply && deps.hasLiveTurnOnHost?.(host.id)) {
      // bootstrap 重启会断 live turn:config 已就绪 (changed 时已写入, daemon
      // 运行中不读 config), 本次只推迟重启 — driftUnapplied 是持久事实,
      // turn 结束后的 ensure (turn-done 挂钩 / 下次 session start) 必然补刀,
      // 宽限期内 daemon 持旧 env (协同降级) 但 turn 本身不被打断。
      log.warn('remote MCP daemon bootstrap deferred: live turn in progress on host', {
        host: host.id,
      });
      return { ok: true, daemonRebootstrapped: false };
    }
    if (!daemonRunning || needApply) {
      await bootstrapDaemon(host, effectiveToken);
      daemonRebootstrapped = true;
      // 防御:bootstrap 若覆盖了 config.toml (managed_install 行为未文档化),
      // 管理段丢失时补写一次并再次 bootstrap。最多两轮,避免无限循环。
      // 仅注入路径 (serverNames 非空):清理路径本来就要管理段不存在,
      // 不得把它当"丢失"补写回去。
      const after = await readRemoteConfig(host);
      if (serverNames.length > 0 && !after.includes(MANAGED_BEGIN)) {
        log.warn('managed mcp block lost after bootstrap — rewriting once', { host: host.id });
        await writeRemoteConfig(host, next);
        await bootstrapDaemon(host, effectiveToken);
        daemonRebootstrapped = true;
      }
      // bootstrap 确认完成才落已生效指纹;失败/中断不落 → 下次 ensure
      // driftUnapplied 仍成立, 强制重试 (跨 app 重启同样成立)。
      if (desiredFingerprint) writeHostAppliedFingerprint(host.id, desiredFingerprint);
      else clearHostAppliedFingerprint(host.id);
      if (serverNames.length === 0) {
        // 清理真正生效 (daemon 已持空 env 重启) 才拆 MCP forward — 见
        // ensureRemotePort 调用点注释 (R21 P2: live turn defer 期间不拆)。
        await releaseRemoteMcpForwardIfAny(host);
      }
      log.info('remote codex daemon (re)bootstrapped with MCP bridge env', {
        host: host.id,
        daemonWasRunning: daemonRunning,
        configChanged: changed,
      });
    }
    return { ok: true, daemonRebootstrapped };
  } catch (err) {
    log.error('ensureRemoteCodexMcpBridge failed', {
      host: host.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: (err as Error).message };
  }
}
