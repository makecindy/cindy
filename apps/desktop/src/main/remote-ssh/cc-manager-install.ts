/**
 * cc-manager silent install — Phase 4.x.
 *
 * Internal helper consumed by Phase 4.3 (cc-host) when a Claude Code remote
 * session needs the cc-manager daemon on a host. Not exposed via IPC: cc-manager
 * is an implementation detail of cc remote, not a user-visible agent kind.
 * That's why we don't extend `RemoteAgentKind` / `VALID_AGENT_KINDS` /
 * `SilentInstallStatusPushPayload` — those are the public IPC contract and
 * keeping them tight avoids ripple into the renderer toast state machine.
 *
 * Flow:
 *   1. Cache hit → return immediately.
 *   2. Probe Cindy-managed Claude Code runtime against the current pin.
 *      - Current → continue to cc-manager probe.
 *      - Missing / stale → run the full install pipeline.
 *   3. Probe remote for cc-mgr.mjs + bundled node.
 *      - Both present → cache + return.
 *      - Manager present + node missing → unrecoverable (someone wiped node);
 *        fall through to step 4.
 *      - Manager missing → step 4.
 *   4. Piggy-back `installRemoteAgent('claude-code')`
 *      which downloads the sandboxed node into `~/.xdt-server/<v>/node/`.
 *      It also installs the pinned `claude` shim under `node_modules/.bin/`.
 *   5. Upload cc-mgr.mjs bundle via `installCcManagerBundle` (SSH stdin pipe).
 *   6. Cache the host as ready.
 *
 * Concurrency: same-host concurrent installs deduplicated via in-flight Map,
 * matching the pattern in `ensureRemoteAgentInstalledOrInstall` (index.ts).
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

import {
  installRemoteAgent,
  installCcManagerBundle,
  probeCcManager,
  probeRemoteAgent,
  uninstallRemoteAgent,
  REMOTE_CC_MGR_BUNDLE_PATH,
  REMOTE_CC_MGR_PID_PATH,
  REMOTE_CC_MGR_SOCK_PATH,
  REMOTE_CLAUDE_SHIM_PATH,
  REMOTE_XDT_NODE_PATH,
  type RemoteHost,
} from '@cindy/maker-remote-ssh';
import { PROTOCOL_VERSION as CC_MGR_PROTOCOL_VERSION } from '@cindy/maker-cc-manager/protocol';

import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { broadcastSilentInstallStatus, broadcastCcMgrUpgradeAvailable } from './index.js';

const log = createLogger('remote-ssh/cc-manager-install');

const ccManagerInstalledCache = new Set<string>();
const inFlightCcManagerInstall = new Map<string, { promise: Promise<void>; withForceReinstall: boolean }>();
// Per-host cache of `claude` shim absolute path on remote — needed by SDK's
// `pathToClaudeCodeExecutable` option (SDK can't find native CLI binary on its
// own when bundled into cc-mgr.mjs: the optional-dep require.resolve gets
// frozen to desktop's build platform, fails on remote). Populated by piggy-back
// install of `claude-code` agentKind, or lazily via probeRemoteAgent on cache hit.
const claudeBinaryPathCache = new Map<string, string>();

/* ============================== Version mgmt ============================== */
// cc-mgr bundle version 是手动 bump 的常量 (CC_MGR_BUNDLE_VERSION in protocol.ts)。
// daemon 在 hello 握手里返回自己编译时的版本; desktop 跟自己 import 的版本比对。
// 不匹配 → upgrade。不随无关依赖 / esbuild 输出变化而触发无意义升级。

import { CC_MGR_BUNDLE_VERSION } from '@cindy/maker-cc-manager';

export function getLocalCcMgrBundleVersion(): string {
  return CC_MGR_BUNDLE_VERSION;
}

interface PendingCcMgrUpgrade {
  hostId: string;
  /** daemon-reported version (sha256:12) */
  currentVersion: string;
  /** desktop-packaged bundle version (the upgrade target) */
  availableVersion: string;
}

/**
 * Per-host pending-upgrade state. Set when silent-install probe detects a
 * version mismatch but skips auto-upgrade (because alive sessions would be
 * killed by daemon restart); cleared when user accepts upgrade via
 * `runCcMgrUpgrade` or explicitly dismisses (renderer `dismissPendingCcMgrUpgrade` IPC).
 *
 * Survives only desktop session lifetime — on restart, next silent-install
 * probe re-detects and re-broadcasts.
 */
const pendingUpgrade = new Map<string, PendingCcMgrUpgrade>();

/** Snapshot for `list-pending` IPC — renderer calls this on mount to sync state
 *  it might have missed before subscribing to the broadcast. */
export function listPendingCcMgrUpgrades(): PendingCcMgrUpgrade[] {
  return Array.from(pendingUpgrade.values());
}

export function getPendingCcMgrUpgrade(hostId: string): PendingCcMgrUpgrade | null {
  return pendingUpgrade.get(hostId) ?? null;
}

/**
 * User-explicit dismiss — clears pending state for this host. Banner won't
 * re-appear within this desktop session unless silent install runs again and
 * versions still don't match (e.g. user reconnects host, sends new message).
 */
export function dismissPendingCcMgrUpgrade(hostId: string): void {
  if (pendingUpgrade.delete(hostId)) {
    broadcastCcMgrUpgradeAvailable({ hostId, available: null });
  }
}

function setPending(p: PendingCcMgrUpgrade): void {
  const prev = pendingUpgrade.get(p.hostId);
  // Idempotent: skip broadcast if state unchanged (same currentVer + availableVer).
  // Otherwise overwrite (e.g. user reinstalled remote daemon at a different version).
  if (prev && prev.currentVersion === p.currentVersion && prev.availableVersion === p.availableVersion) {
    return;
  }
  pendingUpgrade.set(p.hostId, p);
  broadcastCcMgrUpgradeAvailable({
    hostId: p.hostId,
    available: {
      currentVersion: p.currentVersion,
      availableVersion: p.availableVersion,
    },
  });
}

function clearPending(hostId: string): void {
  if (pendingUpgrade.delete(hostId)) {
    broadcastCcMgrUpgradeAvailable({ hostId, available: null });
  }
}

/**
 * Locate the local `cc-mgr.mjs` bundle. Search order:
 *   1. Dev/source checkout: `<monorepo>/packages/maker-cc-manager/dist/cc-mgr.mjs`.
 *      Resolved from `app.getAppPath()` which in dev points at `apps/desktop`.
 *   2. Electron Forge packaged build with `extraResource`: under `process.resourcesPath`.
 *   3. Electron Forge packaged with asar.unpacked layout: alongside `app.asar`.
 *
 * Throws if none found — packaging config needs to ship the bundle. Bundle is
 * NOT in git (gitignore'd); produced + staged by
 * `apps/desktop/scripts/build-remote-bundles.mjs`, hooked at predev / prepackage
 * / prebuild in `package.json`, and explicitly called from `release-{win,mac}.mjs`
 * before `electron-forge make`. Dev path candidate #1 reads from the source
 * dist (rebuilt by the pre-hook); packaged paths #2/#3 read from staged copy.
 */
export function resolveCcManagerBundlePath(): string {
  const appPath = app.getAppPath();
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'maker-cc-manager', 'dist', 'cc-mgr.mjs'),
    path.join(process.resourcesPath ?? '', 'cc-manager', 'cc-mgr.mjs'),
    path.join(`${appPath}.unpacked`, 'packages', 'maker-cc-manager', 'dist', 'cc-mgr.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `cc-mgr.mjs bundle not found in any of: ${candidates.join(' | ')} — ` +
      'packaging needs to ship packages/maker-cc-manager/dist/cc-mgr.mjs as extraResource',
  );
}

/**
 * Optional companion proxy bundle. Phase 6 wires this in when host pref
 * `compatProxyMode='on'` (not yet implemented in Settings UI). Returns null
 * if the bundle isn't shipped.
 */
export function resolveProxyBundlePath(): string | null {
  const appPath = app.getAppPath();
  // candidate #2 路径跟 forge.config.ts 的 extraResource 一一对应:
  // 'resources/anthropic-compat-proxy' → packaged 后落在 process.resourcesPath/
  // anthropic-compat-proxy/。先前用过 cc-manager/ 共享目录是历史遗留, 现在 cc-mgr
  // 跟 proxy 各占独立 extraResource 目录, 路径与目录名 1:1, 易读且未来加新 bundle
  // 自然扩展。详见 scripts/build-remote-bundles.mjs。
  const candidates = [
    path.join(appPath, '..', '..', 'packages', 'anthropic-compat-proxy', 'dist', 'proxy.mjs'),
    path.join(process.resourcesPath ?? '', 'anthropic-compat-proxy', 'proxy.mjs'),
    path.join(`${appPath}.unpacked`, 'packages', 'anthropic-compat-proxy', 'dist', 'proxy.mjs'),
  ];
  for (const candidate of candidates) {
    try {
      const st = fs.statSync(candidate);
      if (st.isFile() && st.size > 0) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Ensure cc-manager is installed on the given remote host. Idempotent:
 * cache hit returns ~0ms; cold path runs probe + (conditional) node install +
 * bundle upload.
 *
 * `installProxyOnDemand` (default false) installs the anthropic-compat-proxy
 * companion at the same time. Caller decides based on host's `compatProxyMode`
 * pref (Phase 6 — not yet read by this function).
 *
 * Caller must have already brought the host to `ready` status
 * (e.g. via `ensureRemoteHostReady`); we don't auto-connect here.
 */
export async function ensureCcManagerInstalledOrInstall(opts: {
  host: RemoteHost;
  installProxyOnDemand?: boolean;
  /**
   * Force the full install pipeline to run (re-upload bundle, re-probe binary
   * path) regardless of probe / cache state. Used by `runCcMgrUpgrade` after
   * kill-daemon to GUARANTEE the bundle on disk is the desktop-packaged
   * version. Without this flag the fast path would short-circuit on
   * `ccManagerInstalled=true` and the old bundle would stay on disk.
   */
  forceReinstall?: boolean;
}): Promise<void> {
  const { host, installProxyOnDemand = false, forceReinstall = false } = opts;
  const hostId = host.id;

  // In-memory cache hit: 上次 install 成功过, fast path return。但 cache 只代表
  // "这个 desktop 进程在此次启动后曾经装过" — 文件可能被外部 rm / 磁盘 cleanup /
  // 用户手动操作弄没了, in-memory cache 无法感知。**必须 stat 远端 bundle 真存在**
  // 再 return; 否则会让 ensureDaemonRunning 走 spawn 时 `node cc-mgr.mjs` 报
  // Cannot find module → sock 永远不出现 → 10s timeout, 用户看到 "daemon did
  // not become ready" 但完全不知道是 bundle 缺失。
  //
  // stat 是单个 ssh exec `[ -f bundle ] && [ -x node ]`, 几十 ms, 比 probeCcManager 的完整
  // bash script (含 node spawn 验证 cc-mgr.mjs --version) 轻得多, 但能覆盖
  // "缺失" 这个最常见的 cache-stale 场景。stat 失败 → 清 cache 走完整 install
  // pipeline (包含上传新 bundle), 自动恢复。
  if (!forceReinstall && ccManagerInstalledCache.has(hostId)) {
    try {
      const r = await host.exec(
        // 全部双引号 wrap: $HOME 含空格 (macOS 用户合法的 "/Users/Foo Bar/") 时
        // 不 quote `[ -f $HOME/.../cc-mgr.mjs ]` 会被 bash word-split 成多 arg, test
        // 报 "too many arguments" 失败, fast path 误判 MISSING 触发不必要 reinstall。
        `bash -c '[ -f "${REMOTE_CC_MGR_BUNDLE_PATH}" ] && [ -x "${REMOTE_XDT_NODE_PATH}" ] && [ -e "${REMOTE_CLAUDE_SHIM_PATH}" ] && echo OK || echo MISSING'`,
        { timeoutMs: 3000, label: 'cc-mgr-bundle-stat' },
      );
      if (r.stdout.includes('OK')) return;
      log.info('cc-mgr install: cached "installed" but bundle/node/claude shim missing on remote, reinstalling', {
        hostId,
      });
      ccManagerInstalledCache.delete(hostId);
      claudeBinaryPathCache.delete(hostId);
    } catch (err) {
      log.warn('cc-mgr install: bundle stat failed (will fall through to full install)', {
        hostId,
        error: err instanceof Error ? err.message : String(err),
      });
      ccManagerInstalledCache.delete(hostId);
      claudeBinaryPathCache.delete(hostId);
    }
  }

  if (host.getStatus() !== 'ready') {
    throwIpcError('SSH_NOT_CONNECTED', `ssh host ${hostId} not connected`);
  }

  // cc-manager 的存在性和版本只证明 daemon bundle 可用，不证明它将启动的
  // Claude Code binary 符合当前 Desktop pin。应用升级后 in-memory cache 为空，
  // cold path 必须先做 agent probe；旧 runtime 直接跳过下面的 cc-manager fast
  // path，进入统一 install pipeline 自动升级 binary。
  let claudeRuntimeReady = forceReinstall;
  if (!forceReinstall) {
    try {
      const agentProbe = await probeRemoteAgent(host, 'claude-code');
      claudeRuntimeReady = agentProbe.installed;
      if (agentProbe.installed && agentProbe.binaryPath) {
        claudeBinaryPathCache.set(hostId, agentProbe.binaryPath);
      } else {
        log.info('cc-mgr install: Claude Code runtime missing or stale, installing current pin', {
          hostId,
          installedVersion: agentProbe.installedVersion,
        });
      }
    } catch (err) {
      claudeRuntimeReady = false;
      log.warn('cc-mgr install: Claude Code version probe failed (will attempt install)', {
        hostId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fast path: probe + cache if both bundle and node already there. Also
  // compare bundle version — mismatch surfaces an UpgradeBanner via push, but
  // does NOT force-restart the daemon here (would kill any alive sessions
  // mid-turn). User accepts upgrade explicitly via the banner's button →
  // `runCcMgrUpgrade` calls back with forceReinstall=true to skip this path.
  if (!forceReinstall && claudeRuntimeReady) {
    try {
      const probe = await probeCcManager(host);
      if (probe.ccManagerInstalled && probe.nodeReady) {
        // 校验 claude shim 也在 (跟 cache-hit fast path 对称): probeCcManager 自己
        // 不查 shim, 但 SDK 启动需要 pathToClaudeCodeExecutable 指 shim, 没装
        // claude-code agent 时 cc-mgr 跑起来但 SDK call 失败。把缺 shim 当成
        // "需要完整 install" 兜底到下面的 install pipeline (会自动装 claude shim)。
        const shimCheck = await host.exec(
          `bash -c '[ -e "${REMOTE_CLAUDE_SHIM_PATH}" ] && echo OK || echo MISSING'`,
          { timeoutMs: 3_000, label: 'cc-mgr-shim-check' },
        );
        if (!shimCheck.stdout.includes('OK')) {
          log.info('cc-mgr probe ok but claude shim missing, falling through to install', { hostId });
        } else {
          const localVer = getLocalCcMgrBundleVersion();
          const remoteVer = probe.ccManagerVersion ?? 'unknown';
          const remoteProtocol = probe.ccManagerProtocolVersion;
          // 协议层不兼容 → 必须强制 reinstall (不能只 record pending), 否则后续
          // `protocol/hello` 直接失败 daemon 起不来; 这里既然 cold path 路过, 借
          // 机替换 bundle, 避开后续 send 撞 hello 失败的 user-visible error。
          //
          // **关键**: 仅 fall through 到 install pipeline 只 upload 新 bundle, 旧
          // daemon (sock/pid 持有的旧进程) 仍在跑; 紧接的 ensureDaemonRunning 探
          // 活会看见 sock + pid alive 直接复用旧 daemon, 后续 hello 继续失败。必须
          // 先 pkill 旧 daemon + 清 sock/pid (等价 runCcMgrUpgrade step 1), 让 install
          // 完成后 ensureDaemonRunning 重新 spawn 加载新 bundle 的 daemon。
          // 协议不兼容时 attach 已不可用, kill alive sessions 是必要代价。
          if (remoteProtocol !== null && remoteProtocol !== CC_MGR_PROTOCOL_VERSION) {
            log.warn('cc-mgr protocol version incompatible — killing old daemon + forcing reinstall', {
              hostId,
              remoteProtocol,
              clientProtocol: CC_MGR_PROTOCOL_VERSION,
              remoteVer,
              localVer,
            });
            // round-17 fix #3 (P1): pkill 之前先用旧 protocol 跟老 daemon 对话,
            // jsonl-as-truth: protocol-kill 不再需要 legacy drain — SDK 的 jsonl
            // 在磁盘上不受 pkill 影响,desktop 重连后走 session/readJsonl 从磁盘恢复。
            await host.exec(
              // $HOME 含空格也安全; 多目标 `rm -f` 用 -- 防止路径以 - 开头被当 flag。
              `PID="$(cat "${REMOTE_CC_MGR_PID_PATH}" 2>/dev/null || true)"; ` +
                `if [ -n "$PID" ] && ps -p "$PID" -o command= 2>/dev/null | grep -qF "cc-mgr.mjs"; then kill "$PID" 2>/dev/null || true; fi; ` +
                `rm -f -- "${REMOTE_CC_MGR_SOCK_PATH}" "${REMOTE_CC_MGR_PID_PATH}"`,
              { timeoutMs: 5_000, label: 'cc-mgr-protocol-kill' },
            ).catch((err) => {
              log.warn('cc-mgr protocol-kill step failed (continuing to install)', {
                hostId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
            // fall through to install pipeline below
          } else if (localVer !== 'unknown' && remoteVer !== localVer) {
            // 协议同, 仅 bundle 版本 (hash) 差。两种情况:
            //  (a) daemon 正在跑 (sock 存在 + pid 活) → 不打扰 alive session,
            //      record pending, UpgradeBanner 引导用户主动选时机升级
            //  (b) daemon 没在跑 (磁盘上只有旧 bundle, 没活进程) → 直接 fall
            //      through 走 install pipeline, 静默升 disk bundle 到最新; 下次
            //      ensureDaemonRunning spawn 自然加载新 bundle, 没有 alive session
            //      要保护
            // round-9 加 (b) 分支: 避免"磁盘旧 bundle + 用户没看到 banner →
            // ensureDaemonRunning 用旧 bundle 起 daemon, fixes 永远不生效"。
            // round-16 fix #3 (P2): 不能只 kill -0, stale pidfile 的 PID 被别的
            // 进程 reuse 时 kill -0 也 ALIVE; 跟 ensureDaemonRunning probe
            // (cc-manager-client.ts:107) 同款 `ps -p PID -o command=` + grep
            // cc-mgr.mjs cmdline 才能确认这真是我们的 daemon。否则把别人家的
            // node / python / 等进程当 alive daemon, silent disk 升级跳过, 用户
            // banner 一直挂但点不动 (force-upgrade 也会以为 daemon 在跑试图
            // pkill 但其实没 cc-mgr 进程)。
            const daemonAliveCheck = await host.exec(
              `bash -c 'PID="$(cat "${REMOTE_CC_MGR_PID_PATH}" 2>/dev/null || true)"; ` +
                `CMD="$(ps -p "$PID" -o command= 2>/dev/null || true)"; ` +
                `if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && ` +
                `printf "%s" "$CMD" | grep -F "cc-mgr.mjs" >/dev/null; ` +
                `then echo ALIVE; else echo DEAD; fi'`,
              { timeoutMs: 3_000, label: 'cc-mgr-daemon-alive-check' },
            ).catch((err) => {
              log.warn('cc-mgr daemon-alive check failed (treating as alive to be safe)', {
                hostId,
                error: err instanceof Error ? err.message : String(err),
              });
              return { stdout: 'ALIVE', stderr: '', exitCode: 0 } as const;
            });
            const daemonAlive = daemonAliveCheck.stdout.includes('ALIVE');
            if (daemonAlive) {
              log.info('cc-mgr version mismatch + daemon alive — upgrade available (banner)', {
                hostId,
                remoteVer,
                localVer,
              });
              setPending({ hostId, currentVersion: remoteVer, availableVersion: localVer });
              ccManagerInstalledCache.add(hostId);
              return;
            }
            log.info('cc-mgr version mismatch + no live daemon — silently upgrading disk bundle', {
              hostId,
              remoteVer,
              localVer,
            });
            // fall through to install pipeline below
          } else {
            // Versions match (or local hash unknown) — make sure any stale pending
            // state from a previous probe is cleared so the banner disappears.
            clearPending(hostId);
            ccManagerInstalledCache.add(hostId);
            return;
          }
        }
      }
    } catch (err) {
      log.warn('cc-mgr probe failed (will attempt install)', {
        hostId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Concurrency dedup: force reinstall must not reuse a non-force in-flight
  // install, otherwise UpgradeBanner can finish without uploading the new
  // bundle. Wait for the non-force run to settle, then start/dedup a force run.
  while (true) {
    const existing = inFlightCcManagerInstall.get(hostId);
    if (!existing) break;
    if (forceReinstall && !existing.withForceReinstall) {
      try {
        await existing.promise;
      } catch (err) {
        log.warn('cc-mgr install: waited for non-force in-flight install before force reinstall', {
          hostId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    return existing.promise;
  }

  const promise = (async (): Promise<void> => {
    log.info('cc-mgr install: starting', { hostId, installProxyOnDemand });
    // Toast 'started' — 让 renderer 立刻显示 "正在准备远端..." 而不是静默等
    // 10-20s。toast 切阶段文案靠后续 progress event 的 eventKind。
    broadcastSilentInstallStatus({ hostId, agentKind: 'claude-code', phase: 'started' });

    try {
      // Step 1: ensure bundled node + claude-code shim. Piggy-back on
      // installRemoteAgent('claude-code') — it npm-installs @anthropic-ai/claude-code
      // into the shared install dir, which also drags down the platform-matching
      // `@anthropic-ai/claude-cli-<plat>-<arch>` optional dep (the actual native
      // binary). cc-mgr daemon needs the binary path to pass into SDK's
      // `pathToClaudeCodeExecutable`, so we always run the installer (idempotent —
      // it's a fast probe + no-op when already installed) and capture the binaryPath.
      const probe = await probeCcManager(host);
      if (!probe.nodeReady) {
        // round-15 fix #4 (P2): bundled node 缺失时单纯调 installRemoteAgent 不够 —
        // 它先看 sentinel + claude shim 能不能跑 (verify_binary),如果系统 PATH
        // 上的 node 还能跑 JS shim,bootstrap-script.ts:284 直接 exit 0,**bundled
        // node 不会被装回来**。后续 installCcManagerBundle 的 probe 要 bundled
        // node 跑 cc-mgr.mjs,失败报"bundled node not installed",cc-manager 永远
        // self-heal 不了。
        //
        // 修法:先 uninstallRemoteAgent 删 sentinel,强制 installRemoteAgent 走
        // 完整 install path → ensure_node 看 NODE_DIR 不在就重下 + 解压。
        // uninstall 不删 node_modules / NODE_DIR,只删 sentinel,代价小;真的有
        // 系统 node 能跑 shim 的情况下,bootstrap-script 重跑会重建 sentinel 而
        // 不会丢 npm install 进度。
        log.info('cc-mgr install: bundled node missing, invalidating sentinel + bootstrapping', { hostId });
        await uninstallRemoteAgent(host, 'claude-code').catch((err) => {
          log.warn('cc-mgr install: sentinel invalidate failed (continuing)', {
            hostId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      const nodeInstall = await installRemoteAgent(host, 'claude-code', (e) => {
        // install-log 的 e.line 是 bootstrap-script 的 INSTALL_LOG emit 内容
        // (包括 verify-fail 诊断 / npm output 等), kind 不够定位问题, 把 line 也打。
        // 其它 kind (probe / install-dir / node-* / install-start / install-done /
        // ready / error) 没 line 字段, 只打 kind 就够。
        if (e.kind === 'install-log') {
          log.debug('cc-mgr install: node bootstrap event', { hostId, kind: e.kind, line: e.line });
        } else if (e.kind === 'error') {
          log.warn('cc-mgr install: node bootstrap event', { hostId, kind: e.kind, message: e.message });
        } else {
          log.debug('cc-mgr install: node bootstrap event', { hostId, kind: e.kind });
        }
        // Forward node-install / npm 阶段 event 给 toast (kind 跟 toast 端 schema
        // 对得上, "node-download" / "install-start" 等切文案)。
        broadcastSilentInstallStatus({
          hostId,
          agentKind: 'claude-code',
          phase: 'progress',
          eventKind: e.kind,
        });
      });
      if (!nodeInstall.ready) {
        throw new Error(`bundled node install failed: ${nodeInstall.error ?? 'unknown error'}`);
      }
      if (nodeInstall.binaryPath) {
        claudeBinaryPathCache.set(hostId, nodeInstall.binaryPath);
      }

      // Step 2: upload cc-mgr.mjs bundle. Re-resolve in case dev/packaged layout
      // differs at runtime (this throws with a clear message if bundle missing).
      const ccBundlePath = resolveCcManagerBundlePath();
      const proxyBundlePath = installProxyOnDemand ? resolveProxyBundlePath() : null;
      if (installProxyOnDemand && proxyBundlePath === null) {
        log.warn('cc-mgr install: proxy bundle not found despite installProxyOnDemand=true; skipping proxy', { hostId });
      }
      const result = await installCcManagerBundle(host, {
        ccManagerBundlePath: ccBundlePath,
        ...(proxyBundlePath ? { proxyBundlePath } : {}),
        onEvent: (e) => {
          log.debug('cc-mgr install: bundle event', { hostId, event: e });
          // cc-mgr bundle 阶段 event.kind (probe / install-start / install-upload /
          // install-done / ready / error) 跟 toast schema 的 eventKind union 不重叠,
          // 不带 eventKind 让 toast 保持上一次文案 (用户已经看到 "正在装 ..."), phase
          // 仍是 progress 表示还在做事; renderer 状态机据此延续 toast 不让它消失。
          broadcastSilentInstallStatus({
            hostId,
            agentKind: 'claude-code',
            phase: 'progress',
          });
        },
      });
      if (!result.ready) {
        throw new Error(`cc-mgr install failed: ${result.error ?? 'unknown error'}`);
      }

      ccManagerInstalledCache.add(hostId);
      // round-15 fix #6 (P2): full reinstall path 也要清 pendingUpgrades。否则
      // 之前因 hash-mismatch + alive-daemon 留下的 banner 会一直挂着, 用户点了
      // 等于 force-upgrade 一个其实已经是最新版的 daemon (无谓 kill + restart)。
      // 配对 setPending 在 fast-path daemonAlive 分支记 pending, 这里 silent
      // reinstall (daemon 死了被识别后 fall through) 走完磁盘 bundle 已是最新,
      // pending 状态应当随之 clear。
      clearPending(hostId);
      broadcastSilentInstallStatus({ hostId, agentKind: 'claude-code', phase: 'done' });
      log.info('cc-mgr install: done', {
        hostId,
        managerVersion: result.probe.ccManagerVersion,
        protocolVersion: result.probe.ccManagerProtocolVersion,
        proxyInstalled: result.probe.proxyInstalled,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcastSilentInstallStatus({
        hostId,
        agentKind: 'claude-code',
        phase: 'failed',
        message: msg,
      });
      throw err;
    }
  })();

  inFlightCcManagerInstall.set(hostId, { promise, withForceReinstall: forceReinstall });
  try {
    await promise;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('cc-mgr install: failed', { hostId, error: msg });
    // Preserve coded IpcError when present; wrap raw errors.
    if (err instanceof Error && (err as { code?: string }).code) throw err;
    throwIpcError('SSH_INSTALL_FAILED', msg);
  } finally {
    if (inFlightCcManagerInstall.get(hostId)?.promise === promise) {
      inFlightCcManagerInstall.delete(hostId);
    }
  }
}


/**
 * Cleanup hook — called from `REMOVE` IPC and `disposeRemoteSshPool` so a
 * subsequently re-added host with the same id doesn't hit a stale cache.
 */
export function clearCcManagerInstallCache(hostId?: string): void {
  if (hostId) {
    ccManagerInstalledCache.delete(hostId);
    claudeBinaryPathCache.delete(hostId);
    dismissPendingCcMgrUpgrade(hostId);
  } else {
    ccManagerInstalledCache.clear();
    claudeBinaryPathCache.clear();
    for (const id of pendingUpgrade.keys()) {
      broadcastCcMgrUpgradeAvailable({ hostId: id, available: null });
    }
    pendingUpgrade.clear();
  }
}

/**
 * Resolve the absolute path of the `claude` shim on a remote host. SDK needs
 * this via `pathToClaudeCodeExecutable` because its bundled-into-cc-mgr.mjs
 * optional-dep resolver fails on remote.
 *
 * Cache hit → instant. Cache miss → one `probeRemoteAgent('claude-code')` SSH
 * round-trip (~200ms) to read INSTALL_DIR from the bootstrap probe. Throws if
 * claude-code isn't installed (caller should have called
 * `ensureCcManagerInstalledOrInstall` first, which always piggy-back installs it).
 */
export async function getRemoteClaudeBinaryPath(host: RemoteHost): Promise<string> {
  const hostId = host.id;
  const cached = claudeBinaryPathCache.get(hostId);
  if (cached) return cached;
  const probe = await probeRemoteAgent(host, 'claude-code');
  if (!probe.binaryPath) {
    throw new Error(
      `claude-code not installed on remote host ${hostId} — cc-mgr install pipeline should have ` +
        'piggy-backed it; check silent install logs',
    );
  }
  claudeBinaryPathCache.set(hostId, probe.binaryPath);
  return probe.binaryPath;
}

/**
 * Force upgrade — kill the running daemon (any in-flight turn on this host
 * dies), wipe in-memory caches so re-install runs the full pipeline (re-upload
 * bundle), then re-run `ensureCcManagerInstalledOrInstall` which spawns a new
 * daemon on next `ensureDaemonRunning`. Pending banner state is cleared at
 * the end.
 *
 * Triggered by user click on `UpgradeBanner` → `cc-mgr:force-upgrade` IPC.
 * Re-uses the silent-install toast pipeline (via the wrapped ensureCc call) so
 * the UX is consistent with first-time install — user sees "正在准备 / 正在装"
 * toasts during the ~5-15s upgrade window.
 *
 * Caller is responsible for surfacing errors back to renderer; we throw on
 * any failure (e.g. SSH dropped, bundle re-upload failed).
 */
export async function runCcMgrUpgrade(host: RemoteHost): Promise<void> {
  const hostId = host.id;
  log.info('cc-mgr force upgrade: starting', { hostId });

  // Step 1: kill existing daemon via pidfile (cmdline-verified) + clean sock/pid.
  await host.exec(
    `PID="$(cat "${REMOTE_CC_MGR_PID_PATH}" 2>/dev/null || true)"; ` +
      `if [ -n "$PID" ] && ps -p "$PID" -o command= 2>/dev/null | grep -qF "cc-mgr.mjs"; then kill "$PID" 2>/dev/null || true; fi; ` +
      `rm -f -- "${REMOTE_CC_MGR_SOCK_PATH}" "${REMOTE_CC_MGR_PID_PATH}"`,
    { timeoutMs: 5_000, label: 'cc-mgr-upgrade-kill' },
  ).catch((err) => {
    // pkill may fail if daemon was already dead, that's fine — keep going.
    log.warn('cc-mgr upgrade: kill step failed (continuing)', {
      hostId,
      error: String(err instanceof Error ? err.message : err),
    });
  });

  // Step 2: invalidate in-memory caches so ensureCcManagerInstalledOrInstall
  // doesn't short-circuit (cache hit) or treat bundle as up-to-date.
  ccManagerInstalledCache.delete(hostId);
  claudeBinaryPathCache.delete(hostId);

  // Step 3: re-run full install pipeline with forceReinstall=true. Without
  // the flag, ensureCc's fast path probe would see "ccManagerInstalled=true"
  // (bundle file still on disk) and short-circuit — only re-flagging the
  // pending state, NEVER actually re-uploading the new bundle. force flag
  // skips the fast path and goes straight to the install branch (bundled
  // node install + bundle upload + bin path probe).
  await ensureCcManagerInstalledOrInstall({ host, forceReinstall: true });

  // Step 4: clear pending banner state (broadcasts available=null so UI
  // banner self-hides). ensureCcMgr ran a fresh probe with new bundle, so
  // hashes now match and the banner has no reason to be up.
  clearPending(hostId);
  log.info('cc-mgr force upgrade: done', { hostId });
}
