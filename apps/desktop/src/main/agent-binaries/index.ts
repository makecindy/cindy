/**
 * apps/desktop/src/main/agent-binaries/index.ts
 *
 * Agent 二进制下载/管理统一入口 —— 按 agentKind 分派,合并自原 vendor/{claude,codex}/binaryProvisioner.ts。
 * 2026-08 起 pi 也走本模块(整目录 tar.gz 分发,可选资产,失败由 pi-host 降级)。
 *
 * 公开 API (全部走 (kind, ...) 形态, 调用方不再分 claude/codex 各导一份):
 *   prepare(kind, opts?)             — splash 下载入口, 真做 dev fallback / OSS 下载 / SHA256 校验 / IPC 进度广播
 *   getCachedBinaryStatus(kind)      — 同步快查 (DropdownMenu 元 IPC 用), 不触发下载
 *   getReadyBinaryPath(kind)         — 读 prepare() 成功后写入的 cache 路径 (maker-host 构造期同步注入)
 *   peekNeedsDownload(kind)          — splash 顺序检查用
 *   getInstallState(kind)            — 详细安装状态
 *   broadcastResetForStep(kind, step, totalSteps) — splash 多步下载切换时归零进度条
 *   broadcastBinaryDownloadProgress  — splash 进度 IPC 推送 (本模块内部 + cleanup hook 外部用)
 *
 * 设计:
 *   - 配置表 (CONFIG): 按 kind 描述差异 (vendorKey/manifestField/installSubdir/binaryName/devBinDir/vendorTag),
 *     行为逻辑全部共享。新增 agent (e.g. gemini) 时, 一行加 CONFIG 即可。
 *   - 基础 BinaryProvisioner 实例懒加载 + 缓存 (createBinaryProvisioner 是工厂, 复用同一份 cached manifest)。
 *   - prepare(kind) 内部:
 *       dev: findDevBinary 短路, 缺失硬错 (开发者必须 git lfs pull / pnpm update:codex)
 *       Linux packaged: PC 已装 CLI / 旧缓存 / userData 私有安装优先; miss 后
 *         直接下载带上游 SHA-256 的官方 pin 资产（不依赖系统 npm/curl/tar）
 *       other prod: createBinaryProvisioner.prepare() + ProgressNormalizer 节流 + 'binary-download-progress' IPC 广播
 *     opts.broadcastProgress=false 时不接 IPC (lazy 调用路径, 当前 desktop 全是 splash 路径所以默认 true)。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

import { createBinaryProvisioner } from './factory.js';
import { findDevBinary } from './dev-fallback.js';
import {
  findCachedLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
} from './linux-runtime-fallback.js';
import { getPlatformKey } from '../manifestService.js';
import { ProgressNormalizer } from '../updateProgressNormalizer.js';
import type {
  BinaryProvisioner,
  BinaryDownloadProgressPayload,
  CachedBinaryStatus,
  PrepareOpts,
  PrepareResult,
  VendorKey,
  VendorRuntimeState,
} from './types.js';

// ── kind 配置表 ──────────────────────────────────────────────────────────────
//
// agent-binaries 的 kind 直接复用 maker-core AgentKind 字面量
// ('claude-code' | 'codex' | 'pi'), 跟 maker-core 保持同步; vendorKey 字段是给底层
// createBinaryProvisioner 用的内部 enum, 历史叫 'claude' / 'codex' (factory 内部
// 硬约定, 不改)。
//
// pi 与 cc/codex 的差异:
//   - artifactKind 'tar-gz-dir': pi 是整目录分发(主二进制 + theme/ 等运行时资产,
//     只装主二进制会在 RPC 启动期崩溃), CDN 资产是整包 tar.gz, 归档根即完整目录
//     (与 apps/pi-bin/<platform>/ 同布局)。
//   - optionalAsset: pi 是可选实验 agent。manifest 缺 pi 字段 / 下载失败都不阻塞
//     启动 —— check-environment 的 pi 段静默降级，本次不注册 pi。

export type AgentBinaryKind = 'claude-code' | 'codex' | 'pi';

interface AgentBinaryConfig {
  vendorKey: VendorKey;            // 底层 createBinaryProvisioner 接受的内部 key
  manifestField: string;           // CDN manifest 顶层字段
  installSubdir: string;           // userData/<installSubdir>/<version>/<binary>
  binaryName: string;              // 平台相关二进制名
  devBinDir: string;               // apps/<devBinDir>/<platform>/ (LFS bundle)
  vendorTag: VendorKey;            // 'binary-download-progress' IPC payload 的 vendor 字段
  artifactKind: 'gz' | 'tar-gz-dir'; // CDN 资产形态(单文件 gz / 整目录 tar.gz)
  optionalAsset?: boolean;         // true = manifest 缺字段不算"需要下载"(可选 vendor)
}

const CONFIG: Record<AgentBinaryKind, AgentBinaryConfig> = {
  'claude-code': {
    vendorKey: 'claude',
    manifestField: 'claudeCode',
    installSubdir: 'claude-code',
    binaryName: process.platform === 'win32' ? 'claude.exe' : 'claude',
    devBinDir: 'claude-code-bin',
    vendorTag: 'claude',
    artifactKind: 'gz',
  },
  codex: {
    vendorKey: 'codex',
    manifestField: 'codex',
    installSubdir: 'codex',
    binaryName: process.platform === 'win32' ? 'codex.exe' : 'codex',
    devBinDir: 'codex-bin',
    vendorTag: 'codex',
    artifactKind: 'gz',
  },
  pi: {
    vendorKey: 'pi',
    manifestField: 'pi',
    installSubdir: 'pi',
    binaryName: process.platform === 'win32' ? 'pi.exe' : 'pi',
    devBinDir: 'pi-bin',
    vendorTag: 'pi',
    artifactKind: 'tar-gz-dir',
    optionalAsset: true,
  },
};

// ── 懒加载的底层 provisioner 实例缓存 ─────────────────────────────────────────

const baseProvisioners = new Map<AgentBinaryKind, BinaryProvisioner>();

function getBase(kind: AgentBinaryKind): BinaryProvisioner {
  let base = baseProvisioners.get(kind);
  if (!base) {
    const cfg = CONFIG[kind];
    base = createBinaryProvisioner({
      vendorKey: cfg.vendorKey,
      manifestField: cfg.manifestField,
      installSubdir: cfg.installSubdir,
      artifact: { kind: cfg.artifactKind, binaryName: cfg.binaryName },
      optionalAsset: cfg.optionalAsset,
    });
    baseProvisioners.set(kind, base);
  }
  return base;
}

// ── prepare() 成功后回填的路径 cache ──────────────────────────────────────────
// maker-host getMaker() 在构造期同步读, 必须早于第一次 createSession。

const lastReadyPath = new Map<AgentBinaryKind, string>();

export function getReadyBinaryPath(kind: AgentBinaryKind): string | undefined {
  return lastReadyPath.get(kind);
}

/**
 * spawn/execFile 前的执行侧复核:candidate 必须与本模块此刻能解析出的受管二进制
 * 路径完全一致。二进制路径本就只该出自本模块,这里再挡一层意外来源作为防御纵深
 * (CodeQL js/command-line-injection)。
 */
export function isVettedAgentBinaryPath(kind: AgentBinaryKind, candidate: string): boolean {
  if (!candidate) return false;
  const status = getCachedBinaryStatus(kind);
  return status.binaryReady === true && status.binaryPath === candidate;
}

// ── splash 进度 IPC 广播 ─────────────────────────────────────────────────────

export function broadcastBinaryDownloadProgress(data: BinaryDownloadProgressPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('binary-download-progress', data);
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── 同步快查 (不触发下载) ────────────────────────────────────────────────────

export function getCachedBinaryStatus(kind: AgentBinaryKind): CachedBinaryStatus {
  const cfg = CONFIG[kind];
  const cachedReadyPath = lastReadyPath.get(kind);
  if (cachedReadyPath) {
    try {
      fs.accessSync(cachedReadyPath, fs.constants.X_OK);
      return { binaryReady: true, binaryPath: cachedReadyPath };
    } catch {
      lastReadyPath.delete(kind);
    }
  }

  // dev: 优先查 LFS bundle (apps/<devBinDir>/<platform>/<binary>)
  if (!app.isPackaged) {
    const devPath = findDevBinary({ vendorBinDir: cfg.devBinDir, binaryName: cfg.binaryName });
    if (devPath) return { binaryReady: true, binaryPath: devPath };
  }

  // packaged Linux 同步快查只看已知私有路径；不能在 renderer-facing 路径
  // 里执行 CLI --version 或 PATH shell lookup。系统 CLI 由 async prepare 发现。
  // pi 不走 Linux runtime fallback(那条链是 cc/codex 官方 CLI 专用),Linux 上的
  // pi 与其它平台一致:只使用 manifest 管理的 CDN 资产。
  if (kind !== 'pi') {
    const linuxFallbackPath = findCachedLinuxRuntimeFallbackBinary(kind);
    if (linuxFallbackPath) return { binaryReady: true, binaryPath: linuxFallbackPath };
  }

  // prod / dev fallback miss: 扫 userData/<installSubdir>/<version>/<binary> + .verified
  try {
    const installRoot = path.join(app.getPath('userData'), cfg.installSubdir);
    const versions = fs
      .readdirSync(installRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const v of versions) {
      const p = path.join(installRoot, v, cfg.binaryName);
      const verified = path.join(installRoot, v, '.verified');
      if (fs.existsSync(p) && fs.existsSync(verified)) {
        return { binaryReady: true, binaryPath: p };
      }
    }
  } catch {
    // fs 错 (目录不存在等) → 降级 false
  }

  return { binaryReady: false };
}

// ── 主入口: prepare ──────────────────────────────────────────────────────────

export async function prepare(
  kind: AgentBinaryKind,
  opts: PrepareOpts = {},
): Promise<PrepareResult> {
  const cfg = CONFIG[kind];
  const { step, totalSteps, broadcastProgress = true, broadcastFailure = true } = opts;

  // ── dev mode 短路 (与老 vendor/{claude,codex}/binaryProvisioner.ts 等价) ──
  if (!app.isPackaged) {
    const devPath = findDevBinary({ vendorBinDir: cfg.devBinDir, binaryName: cfg.binaryName });
    if (devPath) {
      console.log(`[agent-binaries/${kind}] dev fallback hit: ${devPath}`);
      console.warn(`[agent-binaries/${kind}] dev fallback: SHA256 check SKIPPED — for development only`);
      lastReadyPath.set(kind, devPath);
      return { ready: true, path: devPath, downloaded: false };
    }
    return { ready: false, error: `${kind} dev binary not found for ${getPlatformKey()}`, downloaded: false };
  }

  // ── packaged Linux runtime: 私有安装 / 旧缓存 / PC 已装 / 官方下载 ───────
  // Linux release manifest 明确不发布 Claude/Codex 资产。这里直接走 runtime
  // fallback，不能先调 base.prepare()/manifest：离线首装会让 peek + prepare
  // 重复等待 CDN 超时，fallback 尚未开始 splash 就已经卡住。
  // pi 例外:没有官方 CLI fallback 链,Linux 也走下方通用 manifest 路径
  // (manifest 缺 pi 字段 → asset_missing 快速失败,由调用方降级)。
  if (process.platform === 'linux' && app.isPackaged && kind !== 'pi') {
    if (broadcastProgress) {
      broadcastBinaryDownloadProgress({
        progress: 0,
        step,
        totalSteps,
        vendor: cfg.vendorTag,
      });
    }
    try {
      const fallback = await prepareLinuxRuntimeFallback(kind, {
        signal: opts.signal,
        onProgress: broadcastProgress
          ? (event) => {
              broadcastBinaryDownloadProgress({
                progress: Math.max(0, Math.min(100, event.percent ?? 0)),
                speed: event.speedBps > 0 ? `${formatBytes(event.speedBps)}/s` : undefined,
                downloaded: event.loaded > 0 ? formatBytes(event.loaded) : undefined,
                total: event.total && event.total > 0 ? formatBytes(event.total) : undefined,
                step,
                totalSteps,
                vendor: cfg.vendorTag,
              });
            }
          : undefined,
      });
      if (fallback.ready) {
        if (broadcastProgress && fallback.installed) {
          broadcastBinaryDownloadProgress({
            progress: 100,
            step,
            totalSteps,
            vendor: cfg.vendorTag,
          });
        }
        lastReadyPath.set(kind, fallback.binaryPath);
        return {
          ready: true,
          path: fallback.binaryPath,
          downloaded: fallback.installed,
        };
      }
      return { ready: false, error: fallback.error ?? 'unknown', downloaded: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (broadcastProgress && broadcastFailure) {
        broadcastBinaryDownloadProgress({
          progress: 0,
          failed: true,
          error: message,
          step,
          totalSteps,
          vendor: cfg.vendorTag,
        });
      }
      return { ready: false, error: message, downloaded: false };
    }
  }

  const base = getBase(kind);

  // ── 不广播 IPC 路径 (lazy 调用, 当前 desktop 不走) ────────────────────────
  if (!broadcastProgress) {
    const result = await base.prepare({ signal: opts.signal });
    if (result.ready) {
      lastReadyPath.set(kind, result.binaryPath);
      return { ready: true, path: result.binaryPath };
    }
    return { ready: false, error: result.error ?? 'unknown' };
  }

  // ── splash 路径: ProgressNormalizer 节流 + IPC 广播 ───────────────────────
  let lastReceived = 0;
  let lastTotal = 0;
  let lastSpeed: string | undefined;
  let didDownload = false;

  const normalizer = new ProgressNormalizer({
    onIpc: (progress) => {
      broadcastBinaryDownloadProgress({
        progress,
        speed: lastSpeed,
        downloaded: lastReceived > 0 ? formatBytes(lastReceived) : undefined,
        total: lastTotal > 0 ? formatBytes(lastTotal) : undefined,
        step,
        totalSteps,
        vendor: cfg.vendorTag,
      });
    },
  });

  const result = await base.prepare({
    signal: opts.signal,
    onProgress: (p: VendorRuntimeState) => {
      if (p.status === 'downloading') didDownload = true;
      if (p.downloadProgress) {
        lastReceived = p.downloadProgress.received;
        lastTotal = p.downloadProgress.total;
        lastSpeed = p.downloadProgress.speedBps > 0
          ? `${formatBytes(p.downloadProgress.speedBps)}/s`
          : undefined;
        normalizer.handle({
          loaded: lastReceived,
          total: lastTotal > 0 ? lastTotal : null,
          percent: lastTotal > 0 ? (lastReceived / lastTotal) * 100 : null,
          speedBps: p.downloadProgress.speedBps,
        });
      }
      // 初始 0% 广播 (首次进入 downloading 状态时, lastReceived 还是 0)
      if (p.status === 'downloading' && lastReceived === 0) {
        broadcastBinaryDownloadProgress({
          progress: 0,
          total: lastTotal > 0 ? formatBytes(lastTotal) : undefined,
          step,
          totalSteps,
          vendor: cfg.vendorTag,
        });
      }
    },
  });

  if (result.ready) {
    if (didDownload) {
      normalizer.flush();
      broadcastBinaryDownloadProgress({
        progress: 100,
        downloaded: lastReceived > 0 ? formatBytes(lastReceived) : undefined,
        total: lastTotal > 0 ? formatBytes(lastTotal) : undefined,
        step,
        totalSteps,
        vendor: cfg.vendorTag,
      });
    }
    lastReadyPath.set(kind, result.binaryPath);
    return { ready: true, path: result.binaryPath, downloaded: didDownload };
  }

  if (broadcastFailure) {
    broadcastBinaryDownloadProgress({
      progress: normalizer.getCurrent(),
      failed: true,
      error: result.error ?? 'unknown',
      step,
      totalSteps,
      vendor: cfg.vendorTag,
    });
  }
  return { ready: false, error: result.error ?? 'unknown', downloaded: didDownload };
}

// ── splash 顺序检查 helpers ──────────────────────────────────────────────────

export async function peekNeedsDownload(kind: AgentBinaryKind): Promise<boolean> {
  // dev 模式永不下载 (findDevBinary 命中 / 缺失都不走 OSS)
  if (!app.isPackaged) return false;
  // Linux release 不发布 cc/codex manifest 资产。peek 只做已知私有路径的 fs 快查，
  // PATH 与版本探测统一留给可取消的 async prepare，避免 splash 前同步阻塞。
  // pi 各平台统一走 manifest peek(可选资产:manifest 缺字段 → false)。
  if (process.platform === 'linux' && kind !== 'pi') {
    return findCachedLinuxRuntimeFallbackBinary(kind) === null;
  }
  return getBase(kind).peekNeedsDownload();
}

export async function getInstallState(kind: AgentBinaryKind): Promise<VendorRuntimeState> {
  return getBase(kind).getState();
}

/**
 * splash 顺序下载切换到下一段前调用: 直接广播一个 reset payload, splash 收到
 * reset=true 立即把进度条 set 到 0% (无 transition 动画)。
 * step/totalSteps 由调用方按"本次需要下载的 vendor 序列"给出(2 段或 3 段)。
 */
export function broadcastResetForStep(
  kind: AgentBinaryKind,
  step: 1 | 2 | 3,
  totalSteps: 2 | 3,
): void {
  broadcastBinaryDownloadProgress({
    progress: 0,
    step,
    totalSteps,
    reset: true,
    vendor: CONFIG[kind].vendorTag,
  });
}

// ── 兼容: 给老 vendor/claude/runtime.ts 用的 BinaryProvisioner 实例 ──────────
// 等飞书 bot 切 maker.* 后, runtime.ts 退役, 这个 export 一起删。

export function getBaseProvisioner(kind: AgentBinaryKind): BinaryProvisioner {
  return getBase(kind);
}

// re-export type for convenience
export type { BinaryProvisioner, BinaryDownloadProgressPayload, CachedBinaryStatus, PrepareOpts, PrepareResult };
