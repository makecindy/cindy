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
 *       dev: findDevBinary 短路, 缺失硬错 (开发者必须 pnpm update:codex-package)
 *       Linux packaged: CDN manifest 段优先 (与 mac/win 同链, 国内可达); 资产缺失 /
 *         拉取 / 下载失败时静默回落 runtime fallback (PC 已装 CLI / 旧缓存 / userData
 *         私有安装 / 带上游 SHA-256 的官方 pin 资产, 不依赖系统 npm/curl/tar)
 *       other prod: createBinaryProvisioner.prepare() + ProgressNormalizer 节流 + 'binary-download-progress' IPC 广播
 *     opts.broadcastProgress=false 时不接 IPC (lazy 调用路径, 当前 desktop 全是 splash 路径所以默认 true)。
 */

import path from 'node:path';
import fs from 'node:fs';
import { app, BrowserWindow } from 'electron';

import { createBinaryProvisioner } from './factory.js';
import { probeBinaryVersion } from './binary-version-probe.js';
import { findDevBinary } from './dev-fallback.js';
import {
  findCachedLinuxRuntimeFallbackBinary,
  findUsableLinuxRuntimeFallbackBinary,
  prepareLinuxRuntimeFallback,
} from './linux-runtime-fallback.js';
import { getVendorAsset } from './manifest.js';
import {
  fetchManifest,
  getCachedManifest,
  getPlatformKey,
  type Manifest,
} from '../manifestService.js';
import { ProgressNormalizer } from '../updateProgressNormalizer.js';
import { createLogger } from '../logger.js';
import { consumeStartupBinaryUpdateMarker } from './startup-update.js';

let startupCheckForUpdates: boolean | undefined;

function resolveUpdateCheck(checkForUpdates?: boolean): boolean {
  startupCheckForUpdates ??= app.isPackaged
    && consumeStartupBinaryUpdateMarker(app.getPath('userData'), app.getVersion());
  return checkForUpdates ?? startupCheckForUpdates;
}

/**
 * CDN 腿预算上限(毫秒)。有进展的慢速下载给 3 分钟窗口(百 MB 级资产在慢网
 * 也能下完),无进展(stall)由 downloader 自带 connect 10s / idle 30s 兜底;
 * 共享 5 分钟启动预算给 fallback 留 1 分钟作最终判决。
 */
const LINUX_CDN_LEG_TIMEOUT_MS = 180_000;

/** 与 bootstrap-electron.ts 的 LINUX_AGENT_INSTALL_STARTUP_DEADLINE_MS 保持一致。 */
const LINUX_SHARED_STARTUP_DEADLINE_MS = 5 * 60_000;

/** 每个 CDN 腿开始前,共享 deadline 里必须给 fallback 预留的最小预算。 */
const LINUX_FALLBACK_RESERVE_MS = 60_000;

/** peek 的 manifest 探测超时(毫秒):离线首启时不能为「猜进度标签」白等 30s×2。 */
const LINUX_PEEK_MANIFEST_PROBE_TIMEOUT_MS = 3_000;

/**
 * peek 阶段跨 vendor 的单次 manifest 探测(single-flight,每轮 splash 一次)。
 * 两个 vendor 的 peek 串行调用共享同一探测(3s 短超时);prepare 开始时
 * 消费并清空——用户在同一进程内重试(新一轮 check-environment)会重新探测,
 * 不会因旧的失败 memo 把 vendor 排除出下载清单(进度标签与 prepare 行为
 * 对齐)。单轮离线成本上界 = 3s(两个 vendor 共享一次探测)。
 */
let peekManifestProbe: Promise<Manifest | null> | null = null;

/**
 * 本轮 peek 探测是否已失败(轮级信号,module 级)。探测失败(离线 / endpoint
 * 不可达)→ true:本轮的 prepare 跳过 CDN 腿,直接走 fallback——离线且本地
 * 已有 runtime 的首启不再为两个 vendor 白等 2×30s 的 manifest 拉取。
 * 下一轮 peek 成功会置回 false,CDN 腿自动恢复。
 */
let skipCdnUntilNextProbeSuccess = false;

/** 本轮(最新一次)首个 peek 探测的发起点:prepare 开始时会消费进
 *  per-signal 记录并清零,下一轮 peek 未探测(命中缓存)时自然为 0。 */
let lastPeekProbeStartMs = 0;

function probeManifestForPeek(): Promise<Manifest | null> {
  if (peekManifestProbe) return peekManifestProbe;
  // 新一轮的首个探测:记录轮次起点(共享 deadline 从 bootstrap 创建 signal
  // 起就在流逝,peek 起点比 prepare 起点更接近 signal 创建时刻)。
  lastPeekProbeStartMs = Date.now();
  const probe = fetchManifest(LINUX_PEEK_MANIFEST_PROBE_TIMEOUT_MS).then(
    (manifest) => {
      skipCdnUntilNextProbeSuccess = manifest === null;
      return manifest;
    },
    () => {
      skipCdnUntilNextProbeSuccess = true;
      return null;
    },
  );
  peekManifestProbe = probe;
  return probe;
}

/** 新一轮 check-environment 开始时清空 peek 探测 memo(peek 先于 prepare)。 */
function resetPeekManifestProbe(): void {
  peekManifestProbe = null;
}

/**
 * 共享 signal → 该轮首个 prepare 的启动时刻。WeakMap 以 signal 对象为键:
 * bootstrap 每次 check-environment 新建一个 AbortSignal.timeout,新一轮自然
 * 拿到新键、老键随 signal 回收——无跨轮状态泄漏,也无需显式 reset。
 */
const linuxRoundStartBySignal = new WeakMap<object, number>();

/**
 * 计算本 vendor 的 CDN 腿预算:min(180s 上限, 共享 deadline 剩余 − 1 分钟
 * fallback 预留)。前一 vendor 的慢 fallback 已消耗共享预算时,本 vendor 的
 * CDN 腿相应缩短;剩余不足预留时返回 0(调用方跳过 CDN 腿,把剩余时间全部
 * 留给 fallback 作最终判决)。
 */
function linuxCdnBudgetForSignal(sharedSignal: AbortSignal | undefined): number {
  if (!sharedSignal) return LINUX_CDN_LEG_TIMEOUT_MS;
  const now = Date.now();
  let roundStart = linuxRoundStartBySignal.get(sharedSignal);
  if (roundStart === undefined) {
    // 轮次起点由 prepare 在入口消费本轮 peek 探测起点写入;直接 prepare
    // (无 peek)或入口未写入时退回 now。
    roundStart = now;
    linuxRoundStartBySignal.set(sharedSignal, roundStart);
  }
  const elapsedMs = now - roundStart;
  const remainingMs = LINUX_SHARED_STARTUP_DEADLINE_MS - elapsedMs;
  if (remainingMs <= LINUX_FALLBACK_RESERVE_MS) return 0;
  return Math.min(LINUX_CDN_LEG_TIMEOUT_MS, remainingMs - LINUX_FALLBACK_RESERVE_MS);
}

const log = createLogger('agent-binaries');

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
// 目录分发运行时:
//   - codex-package:完整目录包含 bin/codex、code-mode host、rg 与 resources；生产入口
//     与 dev 一致指向 bin/codex，CDN 资产读取 manifest.codexPackage。
//   - pi:完整目录包含主二进制与 theme/ 等运行时资产；同时它是可选实验 agent，
//     manifest 缺 pi 字段 / 下载失败都不阻塞启动。

export type AgentBinaryKind = 'claude-code' | 'codex' | 'pi';

interface AgentBinaryConfig {
  vendorKey: VendorKey;            // 底层 createBinaryProvisioner 接受的内部 key
  manifestField: string;           // CDN manifest 顶层字段
  installSubdir: string;           // userData/<installSubdir>/<version>/<binary>
  binaryName: string;              // 平台相关二进制名
  devBinDir: string;               // apps/<devBinDir>/<platform>/
  devBinaryName?: string;          // dev 可覆盖入口相对路径；prod 仍使用 binaryName
  vendorTag: VendorKey;            // 'binary-download-progress' IPC payload 的 vendor 字段
  artifactKind: 'gz' | 'tar-gz-dir'; // CDN 资产形态(单文件 gz / 整目录 tar.gz)
  optionalAsset?: boolean;         // true = manifest 缺字段不算"需要下载"(可选 vendor)
  preserveLocalVersion?: boolean;  // true = 本地真实版本 >= manifest 时保留，禁止降级
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
    preserveLocalVersion: true,
  },
  codex: {
    vendorKey: 'codex',
    manifestField: 'codexPackage',
    installSubdir: 'codex-package',
    binaryName: path.join('bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    devBinDir: 'codex-package-bin',
    devBinaryName: path.join('bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    vendorTag: 'codex',
    artifactKind: 'tar-gz-dir',
    preserveLocalVersion: true,
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
    preserveLocalVersion: true,
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
      localVersionResolver: cfg.preserveLocalVersion ? probeBinaryVersion : undefined,
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

  // dev:优先查仓库本地 runtime(apps/<devBinDir>/<platform>/<devBinaryName>)。
  if (!app.isPackaged) {
    const devPath = findDevBinary({
      vendorBinDir: cfg.devBinDir,
      binaryName: cfg.devBinaryName ?? cfg.binaryName,
    });
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
    const devPath = findDevBinary({
      vendorBinDir: cfg.devBinDir,
      binaryName: cfg.devBinaryName ?? cfg.binaryName,
    });
    if (devPath) {
      console.log(`[agent-binaries/${kind}] dev fallback hit: ${devPath}`);
      console.warn(`[agent-binaries/${kind}] dev fallback: SHA256 check SKIPPED — for development only`);
      lastReadyPath.set(kind, devPath);
      return { ready: true, path: devPath, downloaded: false };
    }
    return { ready: false, error: `${kind} dev binary not found for ${getPlatformKey()}`, downloaded: false };
  }

  opts = { ...opts, checkForUpdates: resolveUpdateCheck(opts.checkForUpdates) };

  // ── packaged Linux: CDN manifest 段优先,失败静默回落 runtime fallback ─────
  // 2026-08 起 Linux 与 mac/win 同链:scripts 侧发版把 claude/codex 资产上传
  // 区域 CDN 并写进 manifest 段(国内可达)。CDN 链失败(manifest 无段——旧
  // canary / 首发渠道、拉取失败、下载失败)是预期内的降级第一环,不向 splash
  // 广播 failed,静默落到 runtime fallback(私有安装 / 旧缓存 / 系统 CLI /
  // 官方下载)——fallback 才是最终判决。
  // pi 例外:没有官方 CLI fallback 链,Linux 也走下方通用 manifest 路径
  // (manifest 缺 pi 字段 → asset_missing 快速失败,由调用方降级)。
  if (process.platform === 'linux' && app.isPackaged && kind !== 'pi') {
    if (opts.checkForUpdates === false && !getCachedManifest()) await probeManifestForPeek();
    // 本轮轮次起点:优先消费本轮 peek 探测的发起点(含 Phase 0 探测耗时,
    // 比 prepare 起点更接近 signal 创建时刻);本轮 peek 命中缓存未探测时
    // lastPeekProbeStartMs 为 0,退回 now。消费后清零,防跨轮残留
    // (下一轮 peek 未探测时,预算不能拿上一轮的旧起点计算)。
    if (opts.signal && !linuxRoundStartBySignal.has(opts.signal)) {
      linuxRoundStartBySignal.set(opts.signal, lastPeekProbeStartMs > 0 ? lastPeekProbeStartMs : Date.now());
    }
    lastPeekProbeStartMs = 0;
    // 新一轮 check-environment 开始(Phase 0 peek 已全部完成):清空 peek
    // 探测 memo,下一轮重试的 peek 会重新探测 manifest。
    resetPeekManifestProbe();
    // 本轮 peek 探测失败(离线 / endpoint 不可达)→ 跳过 CDN 腿,直接
    // fallback:离线且本地已有 runtime 的首启不再为两个 vendor 白等
    // 2×30s 的 manifest 拉取。下一轮 peek 成功自动恢复 CDN 腿。
    // 例外:peek 与 prepare 之间缓存里已出现 manifest(并发启动 updater
    // 可能已拉取并缓存)→ 清标记走 CDN,CDN 资产可用时不该被旧标记跳过。
    if (getCachedManifest()) skipCdnUntilNextProbeSuccess = false;
    const cdnSkipped = skipCdnUntilNextProbeSuccess;
    if (opts.checkForUpdates === false) {
      const hasLocalCdnRuntime = getCachedManifest() && !await getBase(kind).peekNeedsDownload(opts);
      if (!hasLocalCdnRuntime) {
        const localPath = await findUsableLinuxRuntimeFallbackBinary(kind, opts.signal);
        if (localPath) {
          lastReadyPath.set(kind, localPath);
          return { ready: true, path: localPath, downloaded: false };
        }
      }
    }
    // CDN 腿的信号与预算在 prepareViaCdn 内构造(预算从传输真正开始计起,
    // 排队等待不计入,见该函数注释)。CDN 链任何异常(含磁盘错误级)都是降级
    // 第一环的信号:吞掉走 fallback,绝不让 CDN 尝试本身变成 splash 失败原因。
    let cdnResult: PrepareResult = { ready: false, error: 'cdn_skipped_probe_failed', downloaded: false };
    if (!cdnSkipped) {
      try {
        cdnResult = await prepareViaCdn(kind, opts, {
          broadcastProgress,
          broadcastFailure: false,
          linuxCdnBudget: true,
        });
      } catch (err) {
        log.warn(`CDN chain failed, falling back to linux runtime fallback: ${String((err as Error)?.message ?? err)}`);
        cdnResult = { ready: false, error: 'cdn_chain_error', downloaded: false };
      }
    }
    if (cdnResult.ready) return cdnResult;

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

  return prepareViaCdn(kind, opts, { broadcastProgress, broadcastFailure, linuxCdnBudget: false });
}

/**
 * 通用 CDN 供给链(与 mac/win 同链):读 manifest 段 → 下载 → SHA-256 校验。
 * Linux 上也作为首选链调用;失败由调用方决定是否回落 runtime fallback。
 * broadcastFailure 允许调用方关掉失败广播(降级链的第一环不该让 splash
 * 短暂闪烁失败态)。linuxCdnBudget 只在 packaged Linux 分支传 true——
 * mac/win 没有 runtime fallback,不能让 180s 惰性预算中止它们的传输。
 */
async function prepareViaCdn(
  kind: AgentBinaryKind,
  opts: PrepareOpts,
  {
    broadcastProgress,
    broadcastFailure,
    linuxCdnBudget,
  }: {
    broadcastProgress: boolean;
    broadcastFailure: boolean;
    linuxCdnBudget: boolean;
  },
): Promise<PrepareResult> {
  const cfg = CONFIG[kind];
  const { step, totalSteps } = opts;
  const base = getBase(kind);

  // ── 不广播 IPC 路径 (lazy 调用, 当前 desktop 不走) ────────────────────────
  if (!broadcastProgress) {
    const result = await base.prepare({ signal: opts.signal, checkForUpdates: opts.checkForUpdates });
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

  // CDN 腿预算(仅 packaged Linux)从「传输真正开始」计起,排队等待不计入:
  // 单槽 FIFO 下载器可能被启动期 app 更新(.deb,百 MB 级)占住,若预算从信号
  // 创建起算,排队期间预算就在流逝,排到队首时可能已耗尽 → 没试 CDN 就被迫
  // 回落官方源。factory 只在传输层首个 progress 事件才发 'downloading',
  // 用它作为预算计时起点。mac/win 不启用(没有 runtime fallback,不能让
  // 预算中止它们的传输)。
  // 入口早退:此刻共享 deadline 剩余已不足预留 → 跳过 CDN 腿,把剩余时间
  // 全部留给 fallback 作最终判决(不能先空跑一段 CDN 再把它烧掉)。
  if (linuxCdnBudget && linuxCdnBudgetForSignal(opts.signal) <= 0) {
    return { ready: false, error: 'cdn_budget_exhausted', downloaded: false };
  }
  const cdnBudget = linuxCdnBudget ? new AbortController() : null;
  let budgetTimer: ReturnType<typeof setTimeout> | null = null;
  const startCdnBudget = (): void => {
    if (!cdnBudget || budgetTimer) return;
    // 传输真正开始的时刻重新按共享 deadline 剩余计算:manifest 拉取与
    // FIFO 排队期间共享 deadline 已在流逝,入口时的预算值已陈旧,固定值
    // 会让 CDN 吃掉本应留给 fallback 的预留。剩余不足预留 → 立即中止。
    const budgetMs = linuxCdnBudgetForSignal(opts.signal);
    if (budgetMs <= 0) {
      cdnBudget.abort();
      return;
    }
    budgetTimer = setTimeout(() => cdnBudget.abort(), budgetMs);
  };
  // 共享启动 deadline(opts.signal)与 CDN 预算(Linux only)任一触发即中止:
  // 共享 deadline 保证整段启动仍严格受 5 分钟预算约束;CDN 预算保证单段
  // CDN 传输不吞掉全部共享预算(每段开始前重新计算,始终预留 1 分钟)。
  const effectiveSignal = cdnBudget
    ? opts.signal
      ? AbortSignal.any([opts.signal, cdnBudget.signal])
      : cdnBudget.signal
    : opts.signal;

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

  try {
    const result = await base.prepare({
      signal: effectiveSignal,
      checkForUpdates: opts.checkForUpdates,
      onProgress: (p: VendorRuntimeState) => {
        if (p.status === 'downloading') {
          didDownload = true;
          startCdnBudget();
        }
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
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer);
  }
}

// ── splash 顺序检查 helpers ──────────────────────────────────────────────────

export async function peekNeedsDownload(
  kind: AgentBinaryKind,
  opts: Pick<PrepareOpts, 'checkForUpdates'> = {},
): Promise<boolean> {
  // dev 模式永不下载 (findDevBinary 命中 / 缺失都不走 OSS)
  if (!app.isPackaged) return false;
  opts = { ...opts, checkForUpdates: resolveUpdateCheck(opts.checkForUpdates) };
  // Linux(cc/codex):manifest 有段 → 走通用 CDN peek(与 mac/win 同口径);
  // 无段(旧 canary / 首发渠道)→ 只看私有 fallback 是否已就位(fs 快查)。
  // peek 时 manifest 未缓存则做一次跨 vendor 的短超时探测(3s,single-flight +
  // 失败负缓存),与 prepare 判据对齐又不拖慢离线首启:两个 vendor 的 peek
  // 串行调用共享同一探测,offline 首启只损失 3s 而非 2×30s。
  // PATH 与版本探测统一留给可取消的 async prepare。
  // pi 各平台统一走 manifest peek(可选资产:manifest 缺字段 → false)。
  if (process.platform === 'linux' && kind !== 'pi') {
    let manifest = getCachedManifest();
    if (manifest) {
      // 缓存里已有 manifest(如并发启动 updater 已拉取并缓存):探测失败
      // 标记立即作废——CDN 资产已可用,不能让 prepare 因旧标记跳过 CDN 腿。
      skipCdnUntilNextProbeSuccess = false;
    } else {
      manifest = await probeManifestForPeek();
    }
    if (manifest && getVendorAsset(manifest, CONFIG[kind].manifestField)) {
      const needsDownload = await getBase(kind).peekNeedsDownload(opts);
      if (!needsDownload || opts.checkForUpdates) return needsDownload;
    }
    if (opts.checkForUpdates === false) return await findUsableLinuxRuntimeFallbackBinary(kind) === null;
    return findCachedLinuxRuntimeFallbackBinary(kind) === null;
  }
  return getBase(kind).peekNeedsDownload(opts);
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
