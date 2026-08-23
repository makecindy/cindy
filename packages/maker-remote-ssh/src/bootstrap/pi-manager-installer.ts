/**
 * pi-manager remote install — separate path from `installRemoteAgent` because
 * pi-manager isn't an npm package. It's a single esbuild-bundled .mjs file
 * (~27KB) that we ship to the remote via SSH.
 *
 * Install layout:
 *   ~/.xdt-server/v1/pi-manager/pi-manager.mjs   (the bundle)
 *
 * Node runtime: we REUSE the bundled node from `~/.xdt-server/v1/node/`
 * installed by the standard agent bootstrap (same as cc-manager).
 *
 * Structure mirrors cc-manager-installer.ts deliberately — the probe/upload
 * pattern is copied (not shared) to keep cc-manager's code byte-identical.
 */

import * as fs from 'node:fs/promises';
import type { RemoteHost } from '../RemoteHost.js';

/**
 * 凭证强脱敏(daemon log tail 回传用, 轮 40-w4-t4 CRITICAL):按常见凭证格式
 * 掩码, 防止 daemon log 中残留的 secret 经错误消息回传桌面。
 */
const CREDENTIAL_SCRUB_RE =
  /(?<![A-Za-z0-9])(sk-(?:ant|or|proj|admin|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|hf_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|LTAI[A-Za-z0-9]{16,}|A(?:KIA|SIA)[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|-----BEGIN OPENSSH PRIVATE KEY-----|[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})/g;

function redactSensitiveText(text: string): string {
  return text.replace(CREDENTIAL_SCRUB_RE, '[REDACTED]');
}

/** Quote a string for POSIX sh single-quoted form (private copy — cc-manager's is not exported). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface PiManagerProbeResult {
  /** bundled node is present + runnable. */
  nodeReady: boolean;
  /** pi-manager.mjs exists + `--version` returns valid JSON. */
  piManagerInstalled: boolean;
  /** Protocol version reported by the installed pi-manager. */
  piManagerProtocolVersion: number | null;
  /** Manager version (semver-like). */
  piManagerVersion: string | null;
  /** Absolute remote path of pi-manager.mjs. */
  piManagerBinaryPath: string;
  /** Absolute remote path of the manager socket. */
  piManagerSockPath: string;
  /** Bundled-node binary path (we depend on it). */
  nodeBinaryPath: string;
  /** Install root: $HOME/.xdt-server/<schema-version> resolved by remote bash. */
  installDir: string;
}

export type PiManagerInstallProgress =
  | { kind: 'probe' }
  | { kind: 'install-start' }
  | { kind: 'install-upload'; bytes: number }
  | { kind: 'install-done' }
  | { kind: 'ready' }
  // 轮 22(pi 独立化):bundled node 自动安装的进度行(与 silent-install 的
  // install-log 对齐, renderer 归入 install-log 阶段文案)。
  | { kind: 'install-log'; line: string }
  | { kind: 'error'; message: string };

export type PiManagerInstallEventCallback = (event: PiManagerInstallProgress) => void;

/**
 * Probe remote state: bundled node ready? pi-manager.mjs installed?
 *
 * Creates install dirs as needed (mkdir + chmod 700, 与 cc-manager probe 同款),
 * but does NOT upload/modify bundles. Caller decides whether to install.
 * (轮 6 LOW-2:注释与实现的 mkdir 副作用对齐。)
 */
export async function probePiManager(host: RemoteHost): Promise<PiManagerProbeResult> {
  const script = String.raw`#!/usr/bin/env bash
set -u
SERVER_VER="${'$'}{1:-v1}"
INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
NODE_BIN="$INSTALL_DIR/node/bin/node"
MGR_DIR="$INSTALL_DIR/pi-manager"
MGR_BIN="$MGR_DIR/pi-manager.mjs"
MGR_SOCK="$MGR_DIR/pi-manager.sock"

mkdir -p "$INSTALL_DIR" "$MGR_DIR" && chmod 700 "$INSTALL_DIR" "$MGR_DIR"
printf 'INSTALL_DIR %s\n' "$INSTALL_DIR"
printf 'NODE_BIN %s\n' "$NODE_BIN"
printf 'MGR_BIN %s\n' "$MGR_BIN"
printf 'MGR_SOCK %s\n' "$MGR_SOCK"

# Bundled node?
if [ -x "$NODE_BIN" ]; then
  V="$("$NODE_BIN" -p 'process.versions.node' 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'NODE_READY %s\n' "$V"; fi
else
  printf 'NODE_MISSING\n'
fi

# pi-manager?
if [ -f "$MGR_BIN" ]; then
  V="$("$NODE_BIN" "$MGR_BIN" --version 2>/dev/null || true)"
  if [ -n "$V" ]; then printf 'MGR_READY %s\n' "$V"; fi
else
  printf 'MGR_MISSING\n'
fi
exit 0
`;
  const result = await host.exec(
    `bash -l -s -- v1`,
    {
      input: script,
      timeoutMs: 15_000,
      label: 'pi-manager-probe',
    },
  );
  return parsePiManagerProbeOutput(result.stdout);
}

/**
 * Install (or update) pi-manager bundle on the remote. Uploads via SSH cat
 * with stdin pipe (no SFTP dependency).
 *
 * Caller must provide local absolute path to dist/pi-manager.mjs.
 * Idempotent — overwrites whatever is there. Sentinel is implicit
 * (pi-manager.mjs presence + --version success).
 */
export async function installPiManagerBundle(
  host: RemoteHost,
  opts: {
    piManagerBundlePath: string;
    onEvent?: PiManagerInstallEventCallback;
  },
): Promise<{ ready: boolean; error?: string; probe: PiManagerProbeResult }> {
  const onEvent = opts.onEvent ?? ((): void => undefined);
  onEvent({ kind: 'probe' });

  // Step 1: probe — make sure node is there. If not, abort (require bootstrap first).
  const probe1 = await probePiManager(host);
  if (!probe1.nodeReady) {
    const msg =
      'bundled node not installed on remote — run installRemoteAgent("claude-code" or "codex") first to bootstrap node';
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe1 };
  }

  // Step 2: upload pi-manager.mjs.
  onEvent({ kind: 'install-start' });
  const bytes = await fs.readFile(opts.piManagerBundlePath);
  onEvent({ kind: 'install-upload', bytes: bytes.length });
  try {
    await uploadBundle(host, bytes, probe1.piManagerBinaryPath);
  } catch (err) {
    const msg = `failed to upload pi-manager.mjs: ${(err as Error).message}`;
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe1 };
  }
  onEvent({ kind: 'install-done' });

  // Step 2.5: 校验上传字节数 —— 防 SSH 中断写半截 bundle(自审轮 4 M-4)。
  // 整段脚本 shellQuote 包裹(轮 6 MEDIUM-1):之前把 shellQuote 产物嵌进外层
  // 单引号字面量, 内层单引号会提前终止外层引号, 含空格路径被 word-split。
  const sizeScript = [
    'stat --format=%s',
    shellQuote(probe1.piManagerBinaryPath),
    '2>/dev/null || wc -c <',
    shellQuote(probe1.piManagerBinaryPath),
    '2>/dev/null',
  ].join(' ');
  const sizeResult = await host.exec(
    `bash -c ${shellQuote(sizeScript)}`,
    { timeoutMs: 10_000, label: 'pi-manager-upload-size-check' },
  );
  const remoteSize = parseInt(sizeResult.stdout.trim().split(/\s+/).pop() ?? '0', 10);
  if (remoteSize !== bytes.length) {
    const msg = `pi-manager upload size mismatch (expected ${bytes.length}, got ${remoteSize}) — likely truncated write`;
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe1 };
  }

  // Step 3: verify (re-probe).
  const probe2 = await probePiManager(host);
  if (!probe2.piManagerInstalled) {
    const msg = `pi-manager installed but --version probe failed (uploaded ${bytes.length} bytes; check node ${probe2.nodeBinaryPath})`;
    onEvent({ kind: 'error', message: msg });
    return { ready: false, error: msg, probe: probe2 };
  }

  onEvent({ kind: 'ready' });
  return { ready: true, probe: probe2 };
}

/**
 * Uninstall pi-manager (rm pi-manager/ dir). Idempotent.
 * Note: does NOT kill a running daemon — caller should ensure daemon shutdown
 * (RPC pi/shutdown or process kill) before removing the bundle.
 * 路径来自 probe 的 installDir(不硬编码 v1 —— 自审轮 7 L-2)。
 */
export async function uninstallPiManager(host: RemoteHost): Promise<void> {
  const probe = await probePiManager(host);
  // 轮 11 HIGH-1:installDir 来自远端 probe 输出, 进 shell 必须 shellQuote ——
  // 之前嵌入外层单引号字面量, 含 " 的路径可破出引号执行任意命令。
  const script = `rm -rf ${shellQuote(`${probe.installDir}/pi-manager`)}`;
  await host.exec(
    `bash -c ${shellQuote(script)}`,
    { timeoutMs: 10_000, label: 'pi-manager-uninstall' },
  );
}

/**
 * Ensure the pi-manager daemon process is running. Idempotent — if the socket
 * exists and the pidfile points at a live `pi-manager.mjs daemon` process,
 * returns without spawning. Otherwise spawns detached via the bundle's
 * self-detach mode (`node pi-manager.mjs daemon --socket <sock> --detach
 * --log-file <log>`), which prints the grandchild PID to stdout.
 *
 * Caller must ensure the bundle is installed (probe/install first).
 *
 * 并发安全:per-host promise 去重 —— 并发调用 await 同一个 spawn(自审轮 4 H-2,
 * 否则双 spawn:后调用方 rm 掉前者的 socket, 前者成孤儿)。
 */
const piManagerEnsureInFlight = new Map<string, Promise<void>>();

export function ensurePiManagerDaemon(
  host: RemoteHost,
  opts?: { protocolVersion?: number; probe?: PiManagerProbeResult },
): Promise<void> {
  const key = `${host.id}`;
  const inFlight = piManagerEnsureInFlight.get(key);
  if (inFlight) {
    return inFlight;
  }
  const promise = ensurePiManagerDaemonInner(host, opts)
    .finally(() => piManagerEnsureInFlight.delete(key));
  piManagerEnsureInFlight.set(key, promise);
  return promise;
}

/** @internal test helper: reset per-host dedup map between test cases. */
export function resetPiManagerEnsureInFlight(): void {
  piManagerEnsureInFlight.clear();
}

async function ensurePiManagerDaemonInner(
  host: RemoteHost,
  opts?: { protocolVersion?: number; probe?: PiManagerProbeResult },
): Promise<void> {
  // 轮 22-G5 MEDIUM:调用方(ensurePiManagerInstalledInner)刚 probe 过可复用 ——
  // 避免每次会话启动 2-3 次完整 probe(node spawn + --version, 多会话叠加)。
  const probe = opts?.probe ?? (await probePiManager(host));
  if (!probe.nodeReady) {
    throw new Error('bundled node not installed on remote — run installRemoteAgent("claude-code" or "codex") first');
  }
  if (!probe.piManagerInstalled) {
    throw new Error('pi-manager bundle not installed on remote — installPiManagerBundle first');
  }

  // Fast path: socket exists + pidfile points at a live daemon process +
  // socket actually accepts a connection(自审轮 4 M-1 —— 文件存在但事件循环
  // 卡死的 daemon 会误判 ALIVE, 客户端连上后超时)。
  // 注意:连接测试不能用 shell 重定向(cat > "$MGR_SOCK" 对 unix socket 的
  // open() 返回 ENXIO, 永远失败 —— 深度自审轮 5 发现的真实 bug)。
  // 用 bundled node 内联脚本 net.connect 做真正的 connect 语义。
  // 轮 40-w4-t3 HIGH(升级残留自愈):「磁盘 bundle 已升级但运行中 daemon 仍是
  // 旧协议」时, probe(读磁盘 --version)会误判已最新, 这里只验 socket 可连
  // 会误判 ALIVE, 之后 RPC hello 必失败且无自愈。传 protocolVersion 时,
  // 连接后发一次 protocol/hello 校验运行中 daemon 的协议版本 —— 不匹配
  // 判定 DEAD → spawn 新 daemon(磁盘已是新 bundle), 覆盖升级/回滚残留。
  const expectedProtocol = opts?.protocolVersion;
  // 简单 connect test:只验 socket 可连 —— 不用 protocol/hello 校验。
  // 原因:node inline script 内的 `"\\n"` 经 template literal + shellQuote
  // 两层转义后, 传到 node -e 的不是 0x0A 换行符而是字面 \n(两个字符),
  // daemon 的 NDJSON codec 收不到合法分界 → 永不解析 → 超时 exit 1 →
  // 误判 DEAD → kill 活 daemon(协同委托双会话并发 kill+respawn 循环的根因)。
  // protocol 版本校验改由下方 RPC hello 单独做(复用 RpcClient, 无转义问题)。
  const checkScript = [
    `MGR_SOCK=${shellQuote(probe.piManagerSockPath)}`,
    `PID_FILE=${shellQuote(`${probe.installDir}/pi-manager/pi-manager.pid`)}`,
    `NODE_BIN=${shellQuote(probe.nodeBinaryPath)}`,
    `if [ -S "$MGR_SOCK" ]; then`,
    `  if [ -f "$PID_FILE" ]; then`,
    `    PID=$(cat "$PID_FILE" 2>/dev/null || true)`,
    `    case "$PID" in`,
    `      *[!0-9]*|'') PID_OK=0 ;;`,
    `      *) if kill -0 "$PID" 2>/dev/null && (ps -p "$PID" -o command= 2>/dev/null | grep -F -- "pi-manager.mjs" | grep -F -- "--socket $MGR_SOCK"); then PID_OK=1; else PID_OK=0; fi ;;`,
    `    esac`,
    `  else`,
    `    PID_OK=1`,
    `  fi`,
    `  if [ "$PID_OK" = "1" ]; then`,
    `    if "$NODE_BIN" -e 'require("net").createConnection(process.argv[1]).on("connect",()=>process.exit(0)).on("error",()=>process.exit(1)).setTimeout(3000,()=>process.exit(1))' "$MGR_SOCK" >/dev/null 2>&1; then`,
    `      echo ALIVE; exit 0;`,
    `    fi`,
    `  fi`,
    `fi`,
    `echo DEAD`,
  ].join('\n');
  const checkResult = await host.exec(`bash -c ${shellQuote(checkScript)}`, {
    timeoutMs: 10_000,
    label: 'pi-manager-daemon-check',
  });
  if (checkResult.exitCode === 0 && checkResult.stdout.trim().includes('ALIVE')) {
    // connect test 通过, 若传了 protocolVersion 则额外校验 daemon 运行期协议版本。
    // 用 String.fromCharCode(10) 代替 "\n" 避 template literal + shellQuote 双重
    // 转义——`\\n` 经两层后变成字面 \n(两个字符)而非 0x0A, daemon 永不解析 造成
    // 误判 DEAD → kill 活 daemon(协同委托双会话并发 kill+respawn 循环的根因)。
    if (expectedProtocol !== undefined) {
      const protoCheckScript = [
        `MGR_SOCK=${shellQuote(probe.piManagerSockPath)}`,
        `NODE_BIN=${shellQuote(probe.nodeBinaryPath)}`,
        `EXPECTED=${shellQuote(String(expectedProtocol))}`,
        `"$NODE_BIN" -e 'const n=require("net"),s=n.createConnection(process.argv[1]),e=Number(process.argv[2]),nl=String.fromCharCode(10);let b="";const t=setTimeout(()=>{s.destroy();process.exit(1)},3000);s.on("error",()=>{clearTimeout(t);process.exit(1)});s.on("connect",()=>s.write(JSON.stringify({type:"request",id:1,method:"protocol/hello",params:{protocolVersion:e}})+nl));s.on("data",c=>{b+=c.toString();const i=b.indexOf(nl);if(i>=0){clearTimeout(t);try{const r=JSON.parse(b.slice(0,i));if(r.type==="response"&&r.result&&r.result.protocolVersion===e){s.destroy();process.exit(0)}}catch(_){}s.destroy();process.exit(1)}})' "$MGR_SOCK" "$EXPECTED" >/dev/null 2>&1`,
        `if [ $? -eq 0 ]; then echo PROTOCOL_OK; else echo PROTOCOL_MISMATCH; fi`,
      ].join('\n');
      const protoResult = await host.exec(`bash -c ${shellQuote(protoCheckScript)}`, {
        timeoutMs: 10_000,
        label: 'pi-manager-protocol-check',
      });
      if (protoResult.exitCode === 0 && protoResult.stdout.trim().includes('PROTOCOL_OK')) return;
      // 协议不匹配 → 不 return, 继续走下方 kill+respawn。
    } else {
      return;
    }
  }

  // Spawn detached. `node pi-manager.mjs daemon --socket <sock> --detach
  // --log-file <log>` re-spawns itself as a detached grandchild and prints PID.
  const spawnScript = [
    `MGR_SOCK=${shellQuote(probe.piManagerSockPath)}`,
    `LOG=${shellQuote(`${probe.installDir}/pi-manager/pi-manager.log`)}`,
    `PID_FILE=${shellQuote(`${probe.installDir}/pi-manager/pi-manager.pid`)}`,
    `mkdir -p "$(dirname "$MGR_SOCK")" && chmod 700 "$(dirname "$MGR_SOCK")"`,
    // 轮 42 P1(codex-connector):DEAD 判定(旧协议/连不上)的旧 daemon 必须
    // **先 kill 再 spawn** —— 只 rm socket/pidfile 不终止进程, 旧 daemon 仍
    // 绑着 socket、持有 pi 子进程与凭证 env, 与新 daemon 争同一状态目录。
    // 按 pidfile kill + **socket 身份校验**: stale pidfile 的 PID 可能被系统
    // 复用成**另一个** pi-manager.mjs daemon(不同 install root / 不同 host),
    // 只 grep 进程名会误杀别的活 daemon、打断它的活跃 Pi 会话。必须同时匹配
    // 本 install 的 `--socket <MGR_SOCK>` 命令行(与 386 行 orphan 清理同口径)
    // 才确认是本 install 的旧 daemon, 才杀。
    `if [ -f "$PID_FILE" ]; then`,
    `  PID=$(cat "$PID_FILE" 2>/dev/null || true)`,
    `  case "$PID" in`,
    `    *[!0-9]*|'') ;;`,
    `    *) if kill -0 "$PID" 2>/dev/null && (ps -p "$PID" -o command= 2>/dev/null | grep -F -- "pi-manager.mjs" | grep -F -- "--socket $MGR_SOCK"); then`,
    `         kill "$PID" >/dev/null 2>&1 || true`,
    `         for i in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.1; done`,
    `         if kill -0 "$PID" 2>/dev/null; then`,
    `           kill -9 "$PID" >/dev/null 2>&1 || true`,
    // 轮 42 P1(codex-connector):SIGKILL 后必须确认 PID 真死才允许 respawn ——
    // wedged(D 状态)进程连 SIGKILL 都杀不死, 会在新 daemon 起后继续持有 pi
    // 子进程与凭证 env, 两个 manager 争同一状态目录。确认不到死(fail-closed)
    // 就抛错退出, 让调用方重试/人工介入, 不冒险 spawn 第二个。
    `           for i in $(seq 1 25); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done`,
    `           if kill -0 "$PID" 2>/dev/null; then echo "ERROR: old pi-manager daemon (PID $PID) survived SIGKILL — refusing to respawn" >&2; exit 8; fi`,
    `         fi`,
    `       fi ;;`,
    `  esac`,
    `fi`,
    // 轮 42 P1(codex-connector):**socket 存在但无 pidfile**(daemon 断链后残留 /
    // spawn 中断)时, pidfile kill 分支跳过, 直接 unlink 活 socket 会双 spawn。
    // 按 cmdline 特征扫本 install 的 daemon(socket 独有路径), kill + 确认退出;
    // 未死 fail-closed 不 unlink。与下方 timeout 清理的 orphan 逻辑同款。
    `if [ -S "$MGR_SOCK" ]; then`,
    `  ORPHAN_LEFT=0`,
    `  for ORPHAN in $(ps -axo pid=,command= | grep -F -- "pi-manager.mjs daemon --socket $MGR_SOCK" | awk '{print $1}'); do`,
    `    kill "$ORPHAN" >/dev/null 2>&1 || true`,
    `    for i in $(seq 1 15); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.2; done`,
    `    if kill -0 "$ORPHAN" 2>/dev/null; then`,
    `      kill -9 "$ORPHAN" >/dev/null 2>&1 || true`,
    `      for i in $(seq 1 25); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.2; done`,
    `      if kill -0 "$ORPHAN" 2>/dev/null; then echo "ERROR: socket daemon (PID $ORPHAN) survived SIGKILL — refusing to respawn" >&2; exit 8; fi`,
    `    fi`,
    `  done`,
    `fi`,
    `rm -f "$MGR_SOCK" "$PID_FILE"`,
    // 轮 40-w2 LOW:node/pi-manager 路径也走 shellQuote(与 socket/log/pid 一致)——
    // 双引号只防空格, 路径含双引号/反引号/$() 会破坏 shell 结构。
    `PID=$(${shellQuote(probe.nodeBinaryPath)} ${shellQuote(probe.piManagerBinaryPath)} daemon --socket "$MGR_SOCK" --detach --log-file "$LOG")`,
    `if [ -n "$PID" ]; then echo "$PID" > "$PID_FILE"; echo STARTED; else echo FAILED; exit 1; fi`,
  ].join('\n');
  // 轮 22(对齐 cc-manager-client ensureDaemonRunning):spawn 的 SSH 断链/超时
  // 不算 daemon 启动失败 —— daemon --detach 后父 node 已 exit, channel 可能
  // 提前关闭。catch 后继续等 sock(daemon 可能已起);真正失败(exit≠0)由下方
  // 判定 throw。对齐 cc-mgr 的「SSH timeout 继续 sock-wait」降级。
  let spawnResult: Awaited<ReturnType<RemoteHost['exec']>> | undefined;
  try {
    spawnResult = await host.exec(`bash -c ${shellQuote(spawnScript)}`, {
      timeoutMs: 20_000,
      label: 'pi-manager-daemon-spawn',
    });
  } catch {
    // daemon 可能已 detached(父进程 exit 导致 channel 关闭)—— 继续等 sock。
  }
  if (spawnResult && (spawnResult.exitCode !== 0 || !spawnResult.stdout.trim().includes('STARTED'))) {
    throw new Error(
      `pi-manager daemon spawn failed: ${spawnResult.stderr.trim().slice(0, 300) || spawnResult.stdout.trim().slice(0, 300)}`,
    );
  }

  // Wait for socket to appear (grandchild boot may take a moment).
  const waitScript = [
    `MGR_SOCK=${shellQuote(probe.piManagerSockPath)}`,
    `for i in $(seq 1 50); do`,
    `  [ -S "$MGR_SOCK" ] && { echo READY; exit 0; }`,
    `  sleep 0.2`,
    `done`,
    `echo TIMEOUT; exit 1`,
  ].join('\n');
  const waitResult = await host.exec(`bash -c ${shellQuote(waitScript)}`, {
    timeoutMs: 15_000,
    label: 'pi-manager-daemon-wait',
  });
  if (waitResult.exitCode !== 0 || !waitResult.stdout.trim().includes('READY')) {
    // 轮 21-W3 HIGH:超时/失败时已 spawn 的 daemon 进程可能仍在(启动慢/半挂),
    // 直接抛错会让调用方重试时双 spawn, 且旧进程残留占 socket。先按
    // killRemotePiManagerDaemon 同等语义收尾(SIGTERM→SIGKILL 升级 + 清 pid/socket),
    // 再抛错 —— 幂等(进程已死则 rm 空跑)。
    const cleanupScript = [
      `PID_FILE=${shellQuote(`${probe.installDir}/pi-manager/pi-manager.pid`)}`,
      `MGR_SOCK=${shellQuote(probe.piManagerSockPath)}`,
      `if [ -f "$PID_FILE" ]; then`,
      `  PID=$(cat "$PID_FILE" 2>/dev/null || true)`,
      `  case "$PID" in`,
      `    *[!0-9]*|'') ;;`,
      // 轮 42 P1(codex-connector):与 spawn 前 kill 同款 socket 身份校验 ——
      // 超时路径的 stale pidfile PID 可能已被系统复用成**别的** pi-manager
      // daemon(不同 install root), 只 kill -0 会误杀无关进程/别的 host 的
      // daemon。必须匹配本 install 的 `--socket $MGR_SOCK` 才确认是我们
      // spawn 的旧 daemon, 才杀。
      `    *) if kill -0 "$PID" 2>/dev/null && (ps -p "$PID" -o command= 2>/dev/null | grep -F -- "pi-manager.mjs" | grep -F -- "--socket $MGR_SOCK"); then`,
      `         kill "$PID" >/dev/null 2>&1 || true`,
      `         for i in $(seq 1 15); do`,
      `           kill -0 "$PID" 2>/dev/null || break`,
      `           sleep 0.2`,
      `         done`,
      `         if kill -0 "$PID" 2>/dev/null; then`,
      `           kill -9 "$PID" >/dev/null 2>&1 || true`,
      `           for i in $(seq 1 25); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done`,
      // 轮 42 P1(codex-connector):kill 后必须确认进程真死才 unlink —— wedged
      // 幸存 daemon 会继续持有 pi 子进程与凭证 env, 此时删 pidfile/socket 让
      // 下次 ensure 误判无 daemon → 双 spawn 争同一状态目录。未确认死 →
      // **不 unlink**(保持 pidfile/socket 原位, 下次 ensure 的 fast-path 会
      // 重试 kill/判定), fail-closed。
      `           if kill -0 "$PID" 2>/dev/null; then echo "WARN: pi-manager daemon (PID $PID) survived SIGKILL — keeping state for next ensure" >&2; exit 8; fi`,
      `         fi`,
      `       fi ;;`,
      `  esac`,
      `fi`,
      // 轮 22-Z3 MEDIUM:spawn exec 断链时 pidfile 可能未落盘(wrapper 写入被
      // channel 关闭打断), detached daemon 已成 orphan —— 按 cmdline 特征
      // 回收:ps 全量 + grep -F 精确匹配「daemon --socket <sock>」(固定字符串
      // 防正则特殊字符), 命中则 kill + 等退出。无匹配(无 orphan)空跑幂等。
      // 防误杀:pattern 含完整 sockPath(本 host 独有), 只命中我们的 daemon。
      // 轮 42 P2(codex-connector):daemon 是 Node argv spawn(`--socket` 后裸
      // 路径), ps 显示 `--socket /path` **不带引号** —— shellQuote 加单引号
      // 会让 pattern 匹配不到真 orphan(慢启动的孤儿漏回收, 与下次 retry 的
      // daemon/socket 竞态)。用裸路径(grep -F 固定串, 空格字符照常匹配)。
      // 轮 42 P1(codex-connector):kill 后必须**确认进程退出**才允许 unlink ——
      // 还在关停/存活 SIGTERM 的 orphan 若没死透, 删状态文件让下次 ensure 双
      // spawn; 未确认死 → fail-closed 不 unlink(状态保留, 下次 ensure 重试)。
      // 注意: 管道 while 里的赋值发生在**子 shell**, 外层读不到(轮 42 P1 两连)——
      // 改用 for 循环 + 命令替换(同一 shell, 变量共享)。存活标志置位后跳过
      // unlink 并整体退出。
      `ORPHAN_LEFT=0`,
      // 轮 43 P2(codex-connector):grep 行自身也含匹配串, bash -c 脚本同样,
      // 会误杀自己的 shell。加 grep -v grep 排除 grep 进程, $$ 排本 shell。
      `for ORPHAN in $(ps -axo pid=,command= | grep -F -- "pi-manager.mjs daemon --socket ${probe.piManagerSockPath}" | grep -v -F "grep" | awk '{print $1}'); do`,
      `  [ "$ORPHAN" = "$$" ] && continue`,
      `  kill "$ORPHAN" >/dev/null 2>&1 || true`,
      `  for i in $(seq 1 15); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.2; done`,
      `  if kill -0 "$ORPHAN" 2>/dev/null; then`,
      `    kill -9 "$ORPHAN" >/dev/null 2>&1 || true`,
      `    for i in $(seq 1 25); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.2; done`,
      `    if kill -0 "$ORPHAN" 2>/dev/null; then echo "WARN: orphan pi-manager (PID $ORPHAN) survived SIGKILL — keeping state" >&2; ORPHAN_LEFT=1; fi`,
      `  fi`,
      `done`,
      `if [ "$ORPHAN_LEFT" = "1" ]; then exit 8; fi`,
      `rm -f "$PID_FILE" "$MGR_SOCK"`,
      `echo CLEANED`,
    ].join('\n');
    try {
      await host.exec(`bash -c ${shellQuote(cleanupScript)}`, {
        timeoutMs: 10_000,
        label: 'pi-manager-daemon-cleanup',
      });
    } catch (err) {
      // 清理失败不阻断抛错(调用方重试会走 check → DEAD → 重新 spawn)。
    }
    throw new Error(`pi-manager daemon did not become ready; log tail: ${await tailDaemonLog(host, probe)}`);
  }
}

/** 轮 24-I4 MEDIUM:导出供 desktop 侧 bridge/RPC 失败路径复用 —— 运行期
 *  daemon 崩溃/报错时把 daemon log tail 带回用户可见错误, 不用手动 SSH。 */
export async function tailDaemonLog(host: RemoteHost, probe: PiManagerProbeResult): Promise<string> {
  // 轮 11 HIGH-2:installDir 来自 probe 输出, 进 shell 必须 shellQuote(同 HIGH-1)。
  // 轮 40-w4-t4 CRITICAL:log 可能含凭证(历史版本 corrupt line 原文 / daemon
  // stderr 泄漏)—— tail 回传桌面是凭证泄漏的最后一段, 必须二次强脱敏。
  const script = `tail -10 ${shellQuote(`${probe.installDir}/pi-manager/pi-manager.log`)} 2>/dev/null || true`;
  const result = await host.exec(`bash -c ${shellQuote(script)}`, {
    timeoutMs: 10_000,
    label: 'pi-manager-daemon-log',
  });
  return redactSensitiveText(result.stdout.trim()).slice(0, 300);
}

/* ============================== private ============================== */

async function uploadBundle(host: RemoteHost, bytes: Buffer, remotePath: string): Promise<void> {
  // 轮 40-w2 MEDIUM-1:不用共享 buildUploadScript 的 `cat > target` 直写 ——
  // SSH 中断/磁盘满时会把旧 bundle 截断破坏(旧 daemon 已被 kill, 远端进入
  // 无可用 manager 状态)。改为同目录临时文件 + 字节数校验 + mv 原子替换:
  // 只有完整写入的临时文件才替换正式路径, 失败删临时文件, 旧 bundle 保留。
  const script = [
    `REMOTE_PATH=${shellQuote(remotePath)}`,
    `case "$REMOTE_PATH" in`,
    `  '$HOME'/*) REMOTE_PATH="$HOME/\${REMOTE_PATH#\\$HOME/}" ;;`,
    `esac`,
    `TMP_PATH="$REMOTE_PATH.tmp.$$"`,
    `trap 'rm -f "$TMP_PATH"' EXIT`,
    `mkdir -p "$(dirname "$REMOTE_PATH")"`,
    `umask 077`,
    `cat > "$TMP_PATH"`,
    `EXPECTED=${bytes.length}`,
    // 轮 22(实测 LAZY_CREATE_FAILED):wc -c 输出在部分系统(BSD/macOS/GNU
    // 对齐)带前导/尾随空白 —— 两侧都 trim 再比, 否则相等也判 mismatch。
    `ACTUAL=$(wc -c < "$TMP_PATH" 2>/dev/null | tr -d '[:space:]' || echo 0)`,
    `[ "$ACTUAL" = "$EXPECTED" ] || { echo "size mismatch: expected $EXPECTED got $ACTUAL" >&2; exit 1; }`,
    `chmod 644 "$TMP_PATH"`,
    `mv -f "$TMP_PATH" "$REMOTE_PATH"`,
    `trap - EXIT`,
  ].join('\n');
  const result = await host.exec(`bash -c ${shellQuote(script)}`, {
    input: bytes,
    timeoutMs: 60_000,
    label: 'pi-manager-upload',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `remote bash exit=${result.exitCode}: ${result.stderr.trim().slice(0, 200) || '(no stderr)'}`,
    );
  }
}

/**
 * Parse probe stdout. Format:
 *   INSTALL_DIR /home/x/.xdt-server/v1
 *   NODE_BIN /home/x/.xdt-server/v1/node/bin/node
 *   MGR_BIN /home/x/.xdt-server/v1/pi-manager/pi-manager.mjs
 *   MGR_SOCK /home/x/.xdt-server/v1/pi-manager/pi-manager.sock
 *   NODE_READY 22.13.0
 *   MGR_READY {"managerVersion":"0.1.0","protocolVersion":1}
 */
export function parsePiManagerProbeOutput(stdout: string): PiManagerProbeResult {
  const lines = stdout.split(/\r?\n/);
  const get = (prefix: string): string | null => {
    for (const line of lines) {
      if (line.startsWith(prefix + ' ')) {
        return line.slice(prefix.length + 1).trim();
      }
      if (line === prefix) return '';
    }
    return null;
  };

  const installDir = get('INSTALL_DIR') ?? '$HOME/.xdt-server/v1';
  const nodeBinaryPath = get('NODE_BIN') ?? `${installDir}/node/bin/node`;
  const piManagerBinaryPath = get('MGR_BIN') ?? `${installDir}/pi-manager/pi-manager.mjs`;
  const piManagerSockPath = get('MGR_SOCK') ?? `${installDir}/pi-manager/pi-manager.sock`;

  const nodeReady = get('NODE_READY') !== null;
  const mgrReadyRaw = get('MGR_READY');

  let piManagerProtocolVersion: number | null = null;
  let piManagerVersion: string | null = null;
  let piManagerInstalled = false;
  if (mgrReadyRaw) {
    try {
      const j = JSON.parse(mgrReadyRaw) as { managerVersion?: string; protocolVersion?: number };
      piManagerVersion = j.managerVersion ?? null;
      piManagerProtocolVersion = typeof j.protocolVersion === 'number' ? j.protocolVersion : null;
      piManagerInstalled = piManagerProtocolVersion !== null;
    } catch {
      piManagerInstalled = false;
    }
  }

  return {
    nodeReady,
    piManagerInstalled,
    piManagerProtocolVersion,
    piManagerVersion,
    piManagerBinaryPath,
    piManagerSockPath,
    nodeBinaryPath,
    installDir,
  };
}
