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
import {
  BOOTSTRAP_SH,
  BUNDLED_NODE_VERSION,
  NODE_DIST_BASE_URL_DEFAULT,
  PROBE_BUNDLED_NODE_SH,
  REMOTE_SERVER_SCHEMA_VERSION,
} from './bootstrap-script.js';

export { REMOTE_SERVER_SCHEMA_VERSION };

export type RemoteAgentKind = 'claude-code' | 'codex';

export const PINNED_CLAUDE_CODE_VERSION = claudeLatest.version;
export const PINNED_CODEX_RELEASE_VERSION = codexLatest.version;

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

/**
 * Inspect what's currently installed on the remote without making changes.
 * Reports bundled Node state + agent install state. Read-only: never
 * downloads Node, never runs npm install.
 */
export async function probeRemoteAgent(
  host: RemoteHost,
  agentKind: RemoteAgentKind,
): Promise<ProbeResult> {
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
  await host.exec(
    `rm -f "$HOME/.xdt-server/${REMOTE_SERVER_SCHEMA_VERSION}/.installed-${agentKind}"`,
    { timeoutMs: 10_000, label: 'uninstall' },
  );
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
  return kind === 'codex' ? 'codex' : 'claude';
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
