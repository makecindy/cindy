/**
 * Installer — pushes bootstrap.sh down a remote's SSH channel to set up
 * an agent CLI under ~/.xdt-server/<schemaVer>/. The script ALWAYS uses
 * a sandboxed Node downloaded into ~/.xdt-server/<ver>/node/ — system
 * Node is never trusted (see bootstrap-script.ts header for rationale).
 *
 * Entry points:
 *   - probeRemoteAgent(host, kind): non-mutating; returns install state.
 *   - installRemoteAgent(host, kind, onEvent): full bootstrap; relays
 *     progress events to the caller (so the UI can show a live log).
 *
 * Implementation note: we don't `scp` the script — we `exec('bash -s -- ...')`
 * and write the script bytes into the channel's stdin. One round trip, no
 * temp file on the remote, works through ProxyJump. Same pattern VSCode
 * Remote-SSH uses for its server install.
 */

import type { RemoteHost } from '../RemoteHost.js';
import claudeLatest from '../../../../tools/claude/latest.json';
import codexLatest from '../../../../tools/codex/latest.json';
import piLatest from '../../../../tools/pi/latest.json';
import {
  BOOTSTRAP_SH,
  BUNDLED_NODE_VERSION,
  NODE_DIST_BASE_URL_DEFAULT,
  PROBE_BUNDLED_NODE_SH,
  REMOTE_SERVER_SCHEMA_VERSION,
} from './bootstrap-script.js';

export { REMOTE_SERVER_SCHEMA_VERSION };

export type RemoteAgentKind = 'claude-code' | 'codex' | 'pi';

export const PINNED_CLAUDE_CODE_VERSION = claudeLatest.version;
export const PINNED_CODEX_RELEASE_VERSION = codexLatest.version;
export const PINNED_PI_VERSION = piLatest.version;

export interface ProbeResult {
  agentKind: RemoteAgentKind;
  /** bundled Node is downloaded and runnable. */
  nodeReady: boolean;
  /** version reported by bundled `node -p 'process.versions.node'`. */
  nodeVersion: string | null;
  /** agent binary exists, runs, returned a `--version` string. */
  installed: boolean;
  installedVersion: string | null;
  installDir: string;
  binaryPath: string | null;
  /** Terminal-failure message if probe gave up. */
  error: string | null;
}

export interface InstallResult extends ProbeResult {
  /** true = bootstrap ran to completion (or sentinel was already valid). */
  ready: boolean;
}

export type InstallProgressEvent =
  | { kind: 'probe' }
  | { kind: 'install-dir'; path: string }
  | { kind: 'node-cached'; version: string }
  | { kind: 'node-install-start'; version: string }
  | { kind: 'node-download'; url: string }
  | { kind: 'node-extract'; basename: string }
  | { kind: 'node-install-done'; version: string }
  | { kind: 'already-installed'; version: string }
  | { kind: 'install-start'; pkg: string }
  | { kind: 'install-log'; line: string }
  | { kind: 'install-done' }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

// First-time install needs to download ~30 MB Node + run npm install of the
// agent CLI. On slow networks both stages combined can exceed a minute.
// 5-minute cap is generous but bounded.
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;

// ── pi 专用安装(CDN/GitHub release tar.gz 整包,不经 bundled Node/npm)─────────
//
// pi 是 bun 编译的单文件目录分发(二进制 + theme/ 等运行时资产),与 claude-code
// (npm install) / codex (install.sh standalone) 都不同。安装 = 下载官方 release
// tar.gz → SHA256 校验 → 解压到 $INSTALL_DIR/pi/ (tar 根即 pi/ 目录)。
// 远端 OS/arch 由脚本自探测,host 侧只传 4 个平台的期望 SHA256。

const PI_PROBE_SH = String.raw`#!/usr/bin/env bash
set -u
SERVER_VER="${'$'}{1:-}"
PI_VERSION="${'$'}{2:-}"
INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
BIN_PATH="$INSTALL_DIR/pi/pi"
printf 'INSTALL_DIR %s\n' "$INSTALL_DIR"
if [ -x "$BIN_PATH" ]; then
  V="$("$BIN_PATH" --version 2>/dev/null | head -1 || true)"
  # 取版本串末 token 精确比较(容忍 "pi 0.83.0" / "v0.83.0" 前缀, 拒绝
  # "10.83.0" 误匹配 "0.83.0" 的子串陷阱 —— R3 验证)。
  V_LAST="${'$'}{V##* }"
  [ "$V_LAST" = "$PI_VERSION" ] || [ "$V_LAST" = "v$PI_VERSION" ] && { printf 'READY %s\n' "$V"; exit 0; }
fi
printf 'NOT_INSTALLED\n'; exit 0
`;

const PI_INSTALL_SH = String.raw`#!/usr/bin/env bash
set -u
SERVER_VER="${'$'}{1:-}"
PI_VERSION="${'$'}{2:-}"
SHA_DARWIN_ARM64="${'$'}{3:-}"
SHA_DARWIN_X64="${'$'}{4:-}"
SHA_LINUX_ARM64="${'$'}{5:-}"
SHA_LINUX_X64="${'$'}{6:-}"
INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
BIN_PATH="$INSTALL_DIR/pi/pi"
printf 'INSTALL_DIR %s\n' "$INSTALL_DIR"
# 幂等:已装且版本匹配 → READY。取末 token 精确比较(容忍前缀, 拒绝子串误判 —— R3)。
if [ -x "$BIN_PATH" ]; then
  V="$("$BIN_PATH" --version 2>/dev/null | head -1 || true)"
  V_LAST="${'$'}{V##* }"
  [ "$V_LAST" = "$PI_VERSION" ] || [ "$V_LAST" = "v$PI_VERSION" ] && { printf 'READY %s\n' "$V"; exit 0; }
fi
# 探测远端 OS/arch → 选对应资产的 SHA256
case "$(uname -s)" in
  Darwin) OS_TAG="darwin" ;;
  Linux)  OS_TAG="linux"  ;;
  *)      printf 'ERROR unsupported OS: %s\n' "$(uname -s)"; exit 6 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH_TAG="arm64" ;;
  x86_64|amd64)  ARCH_TAG="x64"   ;;
  *)             printf 'ERROR unsupported arch: %s\n' "$(uname -m)"; exit 6 ;;
esac
case "$OS_TAG-$ARCH_TAG" in
  darwin-arm64) SHA="$SHA_DARWIN_ARM64" ;;
  darwin-x64)   SHA="$SHA_DARWIN_X64"   ;;
  linux-arm64)  SHA="$SHA_LINUX_ARM64"  ;;
  linux-x64)    SHA="$SHA_LINUX_X64"    ;;
  *)            printf 'ERROR no asset for %s-%s\n' "$OS_TAG" "$ARCH_TAG"; exit 6 ;;
esac
URL="https://github.com/earendil-works/pi/releases/download/v${'$'}{PI_VERSION}/pi-${'$'}{OS_TAG}-${'$'}{ARCH_TAG}.tar.gz"
printf 'INSTALL_START pi\n'
TMP="$INSTALL_DIR/pi-dl-$$"
rm -rf "$TMP"; mkdir -p "$TMP"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP/pi.tgz" "$URL" || { printf 'ERROR download failed\n'; rm -rf "$TMP"; exit 7; }
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP/pi.tgz" "$URL" || { printf 'ERROR download failed\n'; rm -rf "$TMP"; exit 7; }
else
  printf 'ERROR neither curl nor wget found\n'; rm -rf "$TMP"; exit 7
fi
# SHA256 校验(shasum=macOS / sha256sum=Linux coreutils)
if command -v shasum >/dev/null 2>&1; then
  ( cd "$TMP" && echo "$SHA  pi.tgz" | shasum -a 256 -c - >/dev/null ) || { printf 'ERROR sha256 mismatch\n'; rm -rf "$TMP"; exit 7; }
elif command -v sha256sum >/dev/null 2>&1; then
  ( cd "$TMP" && echo "$SHA  pi.tgz" | sha256sum -c - >/dev/null ) || { printf 'ERROR sha256 mismatch\n'; rm -rf "$TMP"; exit 7; }
else
  printf 'ERROR no sha256 tool\n'; rm -rf "$TMP"; exit 7
fi
printf 'INSTALL_LOG sha256 ok\n'
# 解包:先解到临时目录,成功后再原子替换 —— 解压失败(磁盘满/权限)不会毁掉
# 旧 pi 二进制(R2 安装 B5)。tar 根即 pi/ 目录。
rm -rf "$TMP/extract"
mkdir -p "$TMP/extract"
tar xzf "$TMP/pi.tgz" -C "$TMP/extract" || { printf 'ERROR extract failed\n'; rm -rf "$TMP"; exit 7; }
# 原子换位(轮 42 P1 codex-connector):先删旧再 mv 会在 mv 失败时把正在用的
# 旧版删掉, 远端 Pi 会话全挂。旧目录先改名保留(同 FS 瞬时), 新目录就位
# 失败则回滚 —— 任何一步失败旧版都完好。
if [ -d "$INSTALL_DIR/pi" ]; then
  mv "$INSTALL_DIR/pi" "$INSTALL_DIR/pi.old-$$" || { printf 'ERROR backup failed\n'; rm -rf "$TMP"; exit 7; }
fi
mv "$TMP/extract/pi" "$INSTALL_DIR/pi" || { printf 'ERROR move failed\n'; rm -rf "$TMP"; [ -d "$INSTALL_DIR/pi.old-$$" ] && mv "$INSTALL_DIR/pi.old-$$" "$INSTALL_DIR/pi"; exit 7; }
rm -rf "$INSTALL_DIR/pi.old-$$"
rm -rf "$TMP"
chmod +x "$INSTALL_DIR/pi/pi"
touch "$INSTALL_DIR/.installed-pi"
V="$("$INSTALL_DIR/pi/pi" --version 2>/dev/null | head -1 || true)"
printf 'INSTALL_DONE\n'
printf 'READY %s\n' "$V"
exit 0
`;

/**
 * Inspect what's currently installed on the remote without making changes.
 * Reports bundled Node state + agent install state. Read-only: never
 * downloads Node, never runs npm install.
 */
export async function probeRemoteAgent(
  host: RemoteHost,
  agentKind: RemoteAgentKind,
): Promise<ProbeResult> {
  if (agentKind === 'pi') return probeRemotePi(host);
  const probeScript = String.raw`#!/usr/bin/env bash
set -u
AGENT_KIND="${'$'}{1:-}"
SERVER_VER="${'$'}{2:-v1}"
CLAUDE_RELEASE="${'$'}{3:-}"
case "$AGENT_KIND" in
  claude-code) BIN_NAME="claude" ;;
  codex)       BIN_NAME="codex"  ;;
  *) printf 'ERROR unknown agent kind\n'; exit 10 ;;
esac
INSTALL_DIR="$HOME/.xdt-server/$SERVER_VER"
NODE_DIR="$INSTALL_DIR/node"
NODE_BIN="$NODE_DIR/bin/node"
SENTINEL="$INSTALL_DIR/.installed-$AGENT_KIND"
# codex: standalone install via install.sh -> isolated CODEX_HOME (binary at
#        $CODEX_HOME/packages/standalone/current/codex). claude-code: npm install
#        -> node_modules/.bin/claude. Stay in sync with bootstrap-script.ts.
if [ "$AGENT_KIND" = "codex" ]; then
  BIN_PATH="$INSTALL_DIR/codex-home/packages/standalone/current/codex"
else
  BIN_PATH="$INSTALL_DIR/node_modules/.bin/$BIN_NAME"
fi
printf 'INSTALL_DIR %s\n' "$INSTALL_DIR"
${PROBE_BUNDLED_NODE_SH}
# PATH-prepend bundled node so the agent shim's \`env node\` resolves to it
# when we run --version. If bundled node is missing, the version check will
# silently fail and we'll report NOT_INSTALLED, which is the right outcome.
export PATH="$NODE_DIR/bin:$PATH"
if [ -f "$SENTINEL" ] && { [ -x "$BIN_PATH" ] || [ -f "$BIN_PATH" ]; }; then
  V="$("$BIN_PATH" --version 2>/dev/null | head -1 || true)"
  if [ -n "$V" ]; then
    if [ "$AGENT_KIND" != "claude-code" ] || [ "${'$'}{V%% *}" = "$CLAUDE_RELEASE" ]; then
      printf 'READY %s\n' "$V"
      exit 0
    fi
  fi
fi
printf 'NOT_INSTALLED\n'; exit 0
`;

  // `bash -l` so login profile (~/.bash_profile / ~/.profile) gets sourced.
  // Mostly defensive — bundled Node design means we don't actually depend on
  // the user's profile setting PATH. Kept for parity with install command.
  const args = [
    agentKind,
    REMOTE_SERVER_SCHEMA_VERSION,
    PINNED_CLAUDE_CODE_VERSION,
  ].map(shellQuoteArg).join(' ');
  const result = await host.exec(`bash -l -s -- ${args}`, {
    input: probeScript,
    timeoutMs: PROBE_TIMEOUT_MS,
  });

  const state = blankState(agentKind);
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    parseProbeLine(line, state, agentKind);
  }
  if (result.exitCode !== 0 && !state.error) {
    state.error = result.stderr.trim() || `probe exited ${result.exitCode}`;
  }
  return state;
}

/**
 * Run the full bootstrap on the remote. Streams progress events so the
 * UI can render a live log. Idempotent — if both bundled Node and the
 * agent are already installed and runnable, it short-circuits to READY.
 */
export async function installRemoteAgent(
  host: RemoteHost,
  agentKind: RemoteAgentKind,
  onEvent: (event: InstallProgressEvent) => void = () => {},
): Promise<InstallResult> {
  if (agentKind === 'pi') return installRemotePi(host, onEvent);
  const state = blankState(agentKind);
  onEvent({ kind: 'probe' });

  const args = [
    agentKind,
    REMOTE_SERVER_SCHEMA_VERSION,
    BUNDLED_NODE_VERSION,
    NODE_DIST_BASE_URL_DEFAULT,
    PINNED_CODEX_RELEASE_VERSION,
    PINNED_CLAUDE_CODE_VERSION,
  ].map(shellQuoteArg).join(' ');

  const result = await host.exec(`bash -l -s -- ${args}`, {
    input: BOOTSTRAP_SH,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });

  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const event = parseInstallLine(line, state, agentKind);
    if (event) onEvent(event);
  }

  const ready = result.exitCode === 0 && state.installed;
  if (!ready && !state.error) {
    state.error = result.stderr.trim() || `install exited ${result.exitCode}`;
    onEvent({ kind: 'error', message: state.error });
  }
  return { ...state, ready };
}

/**
 * Remove the agent's sentinel for this schema version. Leaves the agent's
 * `node_modules/` and the shared bundled Node alone — flipping the sentinel
 * back triggers a quick re-verify on the next probe. To fully reclaim disk,
 * users can `rm -rf ~/.xdt-server/v1` manually.
 */
export async function uninstallRemoteAgent(
  host: RemoteHost,
  agentKind: RemoteAgentKind,
): Promise<void> {
  // 拼远端命令前把 agentKind 收窄回字面量白名单;"$HOME/..." 需远端展开,
  // 不能整体单引号(CodeQL js/shell-command-constructed-from-input)。
  const kind: RemoteAgentKind = agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : 'claude-code';
  // pi 是整包目录分发(非 npm/standalone),卸载 = 删整个 pi/ 目录 + sentinel。
  // 连带删 pi-manager 目录 + pi-oneshot(one-shot 测试目录)。
  // 旧 host 的 pi-daemon 目录(python daemon 时代残留, 含旧 env-file 凭证)也
  // 一并删除 —— python daemon 已退役, 目录惰性无进程读取, uninstall 清干净
  // (退役审轮 8 LOW-2 补充, 轮 10 H-1 注释与代码对齐)。
  if (agentKind === 'pi') {
    const instDir = `"$HOME/.xdt-server/${REMOTE_SERVER_SCHEMA_VERSION}"`;
    // 先杀运行中的 daemon + pi 进程, 再删文件 —— 顺序不能反:
    // daemon 进程内存态仍持有 API key(删文件不会清进程内存), 且持有已删
    // inode 的 pi 二进制(可经 /proc/<pid>/exe 恢复)。
    // kill 失败不阻断 uninstall(rm 继续, 残留由 daemon 空闲超时兜底回收)。
    const killDaemons = [
      // pi-manager daemon kill:按 pidfile 精确定位, 不用 pkill -f
      // (会误杀含 pi-manager.mjs 字符串的无关进程 —— 自审轮 5 M-3)。
      // daemon 的 SIGTERM handler 会 shutdownAll + 清理 env-file/socket。
      // kill 前验证进程身份(kill -0 + ps 确认是 pi-manager.mjs)—— 防 pidfile
      // 陈旧 + PID 被系统进程重用时误杀(深挖轮 5 M-3)。
      `if [ -f ${instDir}/pi-manager/pi-manager.pid ]; then`,
      `  PID=$(cat ${instDir}/pi-manager/pi-manager.pid 2>/dev/null || true)`,
      `  case "$PID" in`,
      `    *[!0-9]*|'') ;;`,
      // 轮 42 P2(codex-connector):pidfile 陈旧 + PID 被复用成**别的** install
      // root 的 pi-manager daemon 时, 只匹配进程名会误杀别的 manager 及其
      // 活跃 Pi 会话。与 pi-manager-installer 的 kill 同口径: 同时匹配本
      // install 的 `--socket <instDir>/pi-manager/pi-manager.sock` 才确认是
      // 本 install 的 daemon 才杀。
      `    *) if kill -0 "$PID" 2>/dev/null && (ps -p "$PID" -o command= 2>/dev/null | grep -F -- "pi-manager.mjs" | grep -F -- "--socket ${instDir}/pi-manager/pi-manager.sock" || (grep -aq pi-manager.mjs /proc/$PID/cmdline 2>/dev/null && grep -aq -- "--socket ${instDir}/pi-manager/pi-manager.sock" /proc/$PID/cmdline 2>/dev/null)); then`,
      `         kill "$PID" >/dev/null 2>&1 || true`,
      `         # 等 daemon 退出(最多 3s) —— daemon 的 shutdownAll 要杀所有 pi 子进程`,
      `         # + 清理 env-file/socket 后再 exit; 不等的话 rm -rf 会和 shutdown 竞态`,
      `         # (轮 10 M-1, 对齐 killRemotePiManagerDaemon 的等待循环)。`,
      `         # 轮 18-T4 CONFIRMED:循环里用 break 而非 exit —— 原 exit 0 会`,
      `         # 直接退出整个 bash 脚本, daemon 正常退出时 rm -rf 被跳过, 卸载`,
      `         # 提前成功但目录/凭证文件全残留。`,
      `         for i in $(seq 1 15); do`,
      `           kill -0 "$PID" 2>/dev/null || break`,
      `           sleep 0.2`,
      `         done`,
      `         # 3s 内未退出 → 补 SIGKILL(对齐 killRemotePiManagerDaemon 升级序列),`,
      `         # 再等 2s; 仍存活(D 状态)记 stderr 警告 —— 不阻断 rm(与「kill 失败`,
      `         # 不阻断 uninstall, 残留由空闲超时兜底」语义一致, 文件删除不影响`,
      `         # 进程内存中的凭证, 下次 ensure 会按版本/存活检测重建)。`,
      `         if kill -0 "$PID" 2>/dev/null; then`,
      `           kill -9 "$PID" >/dev/null 2>&1 || true`,
      `           for i in $(seq 1 10); do`,
      `             kill -0 "$PID" 2>/dev/null || break`,
      `             sleep 0.2`,
      `           done`,
      `           if kill -0 "$PID" 2>/dev/null; then echo "WARN: pi-manager daemon (PID $PID) still alive after SIGKILL — leftover process holds credentials" >&2; fi`,
      `         fi`,
      `       fi ;;`,
      `  esac`,
      `fi`,
      // 轮 42 P1(codex-connector):socket 存在但无 pidfile(SSH detach 打断 pidfile
      // 创建)的存活 daemon 也要杀 —— 否则 uninstall 跳过 kill, rm 掉 pi-manager/
      // 后旧 daemon 带着 pi 子进程与凭证 env 在 unlinked socket 后继续跑。
      // 按 cmdline 扫本 install 的 daemon(socket 独有路径) + 确认退出。
      `if [ -S ${instDir}/pi-manager/pi-manager.sock ]; then`,
      // 与 ensure 侧 orphan sweep 同口径:grep / 本 bash -c 命令行也含匹配串,
      // 不排除会误杀卸载脚本自己, 随后 rm -rf 仍继续, 未扫到的 daemon 带着凭证残留。
      `  for ORPHAN in $(ps -axo pid=,command= | grep -F -- "pi-manager.mjs daemon --socket ${instDir}/pi-manager/pi-manager.sock" | grep -v -F "grep" | awk '{print $1}'); do`,
      `    [ "$ORPHAN" = "$$" ] && continue`,
      `    kill "$ORPHAN" >/dev/null 2>&1 || true`,
      `    for i in $(seq 1 15); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.2; done`,
      `    if kill -0 "$ORPHAN" 2>/dev/null; then`,
      `      kill -9 "$ORPHAN" >/dev/null 2>&1 || true`,
      `      for i in $(seq 1 10); do kill -0 "$ORPHAN" 2>/dev/null || break; sleep 0.2; done`,
      `      if kill -0 "$ORPHAN" 2>/dev/null; then echo "WARN: socket daemon (PID $ORPHAN) survived SIGKILL — leftover process holds credentials" >&2; fi`,
      `    fi`,
      `  done`,
      `fi`,
    ].join('\n');
    await host.exec(`bash -c ${shellQuoteArg(killDaemons)}`, {
      timeoutMs: 20_000,
      label: 'uninstall-pi-kill-daemons',
    });
    await host.exec(
      // 连带删旧 host 残留的 pi-daemon 目录(python daemon 时代, 含旧 env-file
      // 凭证 —— 退役审轮 8 LOW-2:虽惰性, 但 uninstall 该清干净)。
      `rm -rf ${instDir}/pi ${instDir}/pi-manager ${instDir}/pi-daemon ${instDir}/../pi-oneshot && rm -f ${instDir}/.installed-pi`,
      { timeoutMs: 10_000, label: 'uninstall-pi' },
    );
    return;
  }
  await host.exec(
    `rm -f "$HOME/.xdt-server/${REMOTE_SERVER_SCHEMA_VERSION}/.installed-${kind}"`,
    { timeoutMs: 10_000, label: 'uninstall' },
  );
}

/**
 * pi 专用 probe:检查 $INSTALL_DIR/pi/pi 存在且版本匹配 pin。
 */
async function probeRemotePi(host: RemoteHost): Promise<ProbeResult> {
  const state = blankState('pi');
  const args = [
    REMOTE_SERVER_SCHEMA_VERSION,
    PINNED_PI_VERSION,
  ].map(shellQuoteArg).join(' ');
  const result = await host.exec(`bash -l -s -- ${args}`, {
    input: PI_PROBE_SH,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    parseProbeLine(line, state, 'pi');
  }
  if (result.exitCode !== 0 && !state.error) {
    state.error = result.stderr.trim() || `probe exited ${result.exitCode}`;
  }
  return state;
}

/**
 * pi 专用安装:下载官方 release tar.gz(SHA256 校验)→ 解压到 $INSTALL_DIR/pi/。
 */
async function installRemotePi(
  host: RemoteHost,
  onEvent: (event: InstallProgressEvent) => void = () => {},
): Promise<InstallResult> {
  const state = blankState('pi');
  onEvent({ kind: 'probe' });

  const args = [
    REMOTE_SERVER_SCHEMA_VERSION,
    PINNED_PI_VERSION,
    // 4 个 POSIX 平台的期望 SHA256(远端脚本自探测 OS/arch 选择)。
    piRuntimeAssetSha256('darwin-arm64'),
    piRuntimeAssetSha256('darwin-x64'),
    piRuntimeAssetSha256('linux-arm64'),
    piRuntimeAssetSha256('linux-x64'),
  ].map(shellQuoteArg).join(' ');

  const result = await host.exec(`bash -l -s -- ${args}`, {
    input: PI_INSTALL_SH,
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const event = parseInstallLine(line, state, 'pi');
    if (event) onEvent(event);
  }

  const ready = result.exitCode === 0 && state.installed;
  if (!ready && !state.error) {
    state.error = result.stderr.trim() || `install exited ${result.exitCode}`;
    onEvent({ kind: 'error', message: state.error });
  }
  return { ...state, ready };
}

/**
 * 取 pi runtime 资产在 host 侧 pin 的 SHA256(tools/pi/latest.json runtimeAssets)。
 * 只含 POSIX 平台 —— 远端 SSH 主机一律 POSIX(maker-remote-ssh 不支持 Windows 远端)。
 */
function piRuntimeAssetSha256(key: string): string {
  const asset = (piLatest as {
    runtimeAssets?: Record<string, { sha256?: string }>;
  }).runtimeAssets?.[key];
  const sha = asset?.sha256;
  if (!sha) throw new Error(`tools/pi/latest.json missing sha256 for runtime asset "${key}"`);
  return sha;
}

// ── Codex credential sync ────────────────────────────────────────────────

export interface CodexAuthState {
  /**
   * Remote `~/.codex/auth.json` exists. When true, callers SHOULD confirm
   * before overwriting — user may have an active interactive login on the
   * remote that the sync would clobber.
   */
  remoteExists: boolean;
  /** mtime ISO string for surfacing "last logged in N days ago" in the warning. */
  remoteMtime: string | null;
}

/**
 * Read-only check of remote `~/.codex/auth.json`. Returns exists + mtime
 * so the UI can build a meaningful "this will overwrite a login from X"
 * warning. Never reads / leaks the file contents.
 */
export async function checkRemoteCodexAuth(host: RemoteHost): Promise<CodexAuthState> {
  // Check the ISOLATED CODEX_HOME path under our xdt-server tree, NOT the
  // user's system $HOME/.codex/. Philosophy: xdt-maker owns its own codex
  // namespace + never touches the user's. The bootstrap-script.ts mirrors
  // ~/.codex/auth.json into here on first install (cp -n), so existing
  // logged-in users get a seamless start; thereafter the two are independent.
  //
  // POSIX `stat -f` (BSD/macOS) vs `stat -c` (GNU/Linux) — try both, take
  // whichever returns a usable number. Output is epoch seconds.
  const script = String.raw`#!/usr/bin/env bash
set -u
F="$HOME/.xdt-server/v1/codex-home/auth.json"
if [ ! -f "$F" ]; then
  printf 'NOT_EXISTS\n'
  exit 0
fi
M=$(stat -f '%m' "$F" 2>/dev/null || stat -c '%Y' "$F" 2>/dev/null || echo '')
printf 'EXISTS %s\n' "$M"
`;
  const result = await host.exec('bash -l -s', {
    input: script,
    timeoutMs: 10_000,
    label: 'check codex auth',
  });
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? '';
  if (line === 'NOT_EXISTS') return { remoteExists: false, remoteMtime: null };
  if (line.startsWith('EXISTS ')) {
    const epoch = parseInt(line.slice('EXISTS '.length).trim(), 10);
    const mtime = Number.isFinite(epoch) && epoch > 0
      ? new Date(epoch * 1000).toISOString()
      : null;
    return { remoteExists: true, remoteMtime: mtime };
  }
  // Unexpected output — treat as exists=false but log via caller.
  return { remoteExists: false, remoteMtime: null };
}

/**
 * Push `authJsonContent` to the remote's ISOLATED CODEX_HOME auth.json
 * (`$HOME/.xdt-server/v1/codex-home/auth.json`), NOT the user's system
 * `$HOME/.codex/auth.json`. Same philosophy as checkRemoteCodexAuth above:
 * xdt-maker owns its own codex namespace + never touches the user's.
 *
 * Dir created with `0700`, file with `0600` (matches what Codex CLI does on
 * first login). Caller MUST have confirmed the overwrite with the user when
 * `checkRemoteCodexAuth().remoteExists` is true — this function will
 * clobber without asking.
 *
 * Implementation: piped via stdin to a heredoc-free `cat > file` wrapper so
 * the file contents NEVER appear on the command line (which would show up
 * in remote `ps`, ssh audit logs, and our own timeout messages).
 */
export async function pushRemoteCodexAuth(
  host: RemoteHost,
  authJsonContent: string,
): Promise<void> {
  if (!authJsonContent.trim()) {
    throw new Error('refusing to push empty auth.json content');
  }
  const script = String.raw`#!/usr/bin/env bash
set -eu
DIR="$HOME/.xdt-server/v1/codex-home"
F="$DIR/auth.json"
mkdir -p "$DIR"
chmod 700 "$DIR" 2>/dev/null || true
# Atomic write via tmp + rename — never have a half-written auth.json on disk.
TMP="$F.xdt-tmp-$$"
cat > "$TMP"
chmod 600 "$TMP"
mv "$TMP" "$F"
printf 'OK\n'
`;
  // Stdin: <wrapper script>\n<auth.json content>?  NO — bash reads the script
  // from stdin first via `bash -s`, but the `cat > TMP` inside ALSO reads
  // stdin. Solution: use `bash -c <script>` (script is the arg, not stdin)
  // so stdin is purely the auth.json bytes for `cat`.
  const result = await host.exec(`bash -c ${shellQuoteArg(script)}`, {
    input: authJsonContent,
    timeoutMs: 15_000,
    label: 'push codex auth',
  });
  if (result.exitCode !== 0) {
    throw new Error(`remote write failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
  }
  if (!result.stdout.includes('OK')) {
    throw new Error(`remote write completed without OK marker: ${result.stdout.trim()}`);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function blankState(agentKind: RemoteAgentKind): ProbeResult {
  return {
    agentKind,
    nodeReady: false,
    nodeVersion: null,
    installed: false,
    installedVersion: null,
    installDir: '',
    binaryPath: null,
    error: null,
  };
}

function shellQuoteArg(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function binaryName(kind: RemoteAgentKind): string {
  if (kind === 'codex') return 'codex';
  if (kind === 'pi') return 'pi';
  return 'claude';
}

/**
 * 跟 bootstrap-script.ts / installer.ts probe shell (line 97-101) 的 BIN_PATH
 * 分支保持一致:
 *   - codex 用 install.sh 装成 standalone, 二进制落在 CODEX_HOME 下
 *     ($INSTALL_DIR/codex-home/packages/standalone/current/codex)
 *   - claude-code 走 npm install, 在 $INSTALL_DIR/node_modules/.bin/claude
 * 任一端改路径都要同步 — 否则 RUN_AGENT_ONE_SHOT 等消费 binaryPath 的链路会
 * 执行不存在的路径, 已安装的 agent 也会跑不起来。
 */
function binaryPathFor(kind: RemoteAgentKind, installDir: string): string {
  if (kind === 'codex') {
    return `${installDir}/codex-home/packages/standalone/current/codex`;
  }
  if (kind === 'pi') {
    return `${installDir}/pi/pi`;
  }
  return `${installDir}/node_modules/.bin/${binaryName(kind)}`;
}

// ── line parsers ──────────────────────────────────────────────────────────

function parseProbeLine(line: string, state: ProbeResult, kind: RemoteAgentKind): void {
  if (line.startsWith('INSTALL_DIR ')) {
    state.installDir = line.slice('INSTALL_DIR '.length).trim();
    state.binaryPath = binaryPathFor(kind, state.installDir);
  } else if (line.startsWith('NODE_CACHED ')) {
    state.nodeReady = true;
    state.nodeVersion = line.slice('NODE_CACHED '.length).trim();
  } else if (line.startsWith('NODE_MISSING')) {
    state.nodeReady = false;
  } else if (line.startsWith('READY ')) {
    state.installed = true;
    state.installedVersion = line.slice('READY '.length).trim();
  } else if (line.startsWith('NOT_INSTALLED')) {
    state.installed = false;
  } else if (line.startsWith('ERROR ')) {
    state.error = line.slice('ERROR '.length).trim();
  }
}

function parseInstallLine(
  line: string,
  state: ProbeResult,
  kind: RemoteAgentKind,
): InstallProgressEvent | null {
  if (line === 'PROBE_START') return { kind: 'probe' };

  if (line.startsWith('INSTALL_DIR ')) {
    const path = line.slice('INSTALL_DIR '.length).trim();
    state.installDir = path;
    state.binaryPath = binaryPathFor(kind, path);
    return { kind: 'install-dir', path };
  }

  if (line.startsWith('NODE_CACHED ')) {
    const version = line.slice('NODE_CACHED '.length).trim();
    state.nodeReady = true;
    state.nodeVersion = version;
    return { kind: 'node-cached', version };
  }
  if (line.startsWith('NODE_INSTALL_START ')) {
    return { kind: 'node-install-start', version: line.slice('NODE_INSTALL_START '.length).trim() };
  }
  if (line.startsWith('NODE_DOWNLOAD ')) {
    return { kind: 'node-download', url: line.slice('NODE_DOWNLOAD '.length).trim() };
  }
  if (line.startsWith('NODE_EXTRACT ')) {
    return { kind: 'node-extract', basename: line.slice('NODE_EXTRACT '.length).trim() };
  }
  if (line.startsWith('NODE_INSTALL_DONE ')) {
    const version = line.slice('NODE_INSTALL_DONE '.length).trim();
    state.nodeReady = true;
    state.nodeVersion = version;
    return { kind: 'node-install-done', version };
  }

  if (line.startsWith('ALREADY_INSTALLED ')) {
    const version = line.slice('ALREADY_INSTALLED '.length).trim();
    state.installed = true;
    state.installedVersion = version;
    return { kind: 'already-installed', version };
  }
  if (line.startsWith('INSTALL_START ')) {
    return { kind: 'install-start', pkg: line.slice('INSTALL_START '.length).trim() };
  }
  if (line.startsWith('INSTALL_LOG ')) {
    return { kind: 'install-log', line: line.slice('INSTALL_LOG '.length) };
  }
  if (line === 'INSTALL_DONE') {
    return { kind: 'install-done' };
  }
  if (line.startsWith('READY ')) {
    const version = line.slice('READY '.length).trim();
    state.installed = true;
    state.installedVersion = version;
    return { kind: 'ready', version };
  }
  if (line.startsWith('ERROR ')) {
    const message = line.slice('ERROR '.length).trim();
    state.error = message;
    return { kind: 'error', message };
  }
  return null;
}
