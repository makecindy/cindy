/**
 * gpuRenderingPolicy — macOS Electron 42 GPU 渲染保护与软件渲染回退策略。
 *
 * 背景:
 * - Electron 42 / Chromium 146 在 macOS 上默认启用 Skia Graphite (Dawn/Metal)。
 *   在透明 BrowserWindow + vibrancy + backdrop-filter + 休眠唤醒/多屏切换场景下，
 *   Skia Graphite 易触发 GPU 合成花屏/黑屏或 GPU 进程反复崩溃。
 * - 默认在 macOS 禁用 SkiaGraphite（回退至成熟的 Skia Ganesh Metal 后端），除非
 *   通过 `XDT_ENABLE_SKIA_GRAPHITE=1` 显式开启。
 * - 若运行期间 GPU 进程在短时间内连续异常崩溃（默认 2 分钟内 ≥3 次），自动落盘
 *   `<userData>/gpu-rendering-policy.json` 标记，下次启动时启用软件渲染回退
 *   （`app.disableHardwareAcceleration()` + 关闭透明窗/vibrancy/CSS backdrop-filter）。
 *   自动触发的回退会绑定 `appVersion`，应用升级到新版本后自动重置以重试硬件加速；
 *   用户显式设置 `reason: 'user'` 或 `XDT_DISABLE_HARDWARE_ACCELERATION=1/0` 始终优先。
 */

import fs from 'node:fs';
import path from 'node:path';

export const GPU_RENDERING_POLICY_FILE = 'gpu-rendering-policy.json';
export const GPU_CRASH_LOOP_THRESHOLD = 3;
export const GPU_CRASH_LOOP_WINDOW_MS = 120_000;

export type GpuFallbackReason = 'env' | 'user' | 'gpu-crash-loop';

export interface PersistedGpuRenderingPolicy {
  version: 1;
  disableHardwareAcceleration: boolean;
  reason: 'user' | 'gpu-crash-loop';
  appVersion?: string;
  crashCount?: number;
  updatedAt: string;
}

export interface GpuPolicyCommandLine {
  hasSwitch?(name: string): boolean;
  getSwitchValue?(name: string): string;
  appendSwitch(name: string, value?: string): void;
}

export interface ConfigureGpuRenderingPolicyOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  commandLine: GpuPolicyCommandLine;
  disableHardwareAcceleration: () => void;
  userDataDir?: string;
  appVersion?: string;
}

export interface GpuRenderingPolicyResult {
  hardwareAccelerationDisabled: boolean;
  fallbackReason: GpuFallbackReason | null;
  skiaGraphiteDisabled: boolean;
}

let activeHardwareAccelerationDisabled = false;
let activeFallbackReason: GpuFallbackReason | null = null;
let activeSkiaGraphiteDisabled = false;

export function isHardwareAccelerationDisabled(): boolean {
  return activeHardwareAccelerationDisabled;
}

export function getActiveGpuRenderingPolicy(): GpuRenderingPolicyResult {
  return {
    hardwareAccelerationDisabled: activeHardwareAccelerationDisabled,
    fallbackReason: activeFallbackReason,
    skiaGraphiteDisabled: activeSkiaGraphiteDisabled,
  };
}

export function resetActiveGpuRenderingPolicyForTest(): void {
  activeHardwareAccelerationDisabled = false;
  activeFallbackReason = null;
  activeSkiaGraphiteDisabled = false;
}

function splitFeatureList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function readPersistedGpuRenderingPolicy(
  userDataDir: string | undefined,
): PersistedGpuRenderingPolicy | null {
  if (!userDataDir) return null;
  const filePath = path.join(userDataDir, GPU_RENDERING_POLICY_FILE);
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) return null;
    if (typeof parsed.disableHardwareAcceleration !== 'boolean') return null;
    const reason = parsed.reason === 'user' || parsed.reason === 'gpu-crash-loop' ? parsed.reason : null;
    if (!reason) return null;
    return {
      version: 1,
      disableHardwareAcceleration: parsed.disableHardwareAcceleration,
      reason,
      ...(typeof parsed.appVersion === 'string' ? { appVersion: parsed.appVersion } : {}),
      ...(typeof parsed.crashCount === 'number' && Number.isFinite(parsed.crashCount)
        ? { crashCount: parsed.crashCount }
        : {}),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export function recordGpuCrashLoopFallback(options: {
  userDataDir: string;
  appVersion: string;
  crashCount: number;
  now?: Date;
}): boolean {
  const existing = readPersistedGpuRenderingPolicy(options.userDataDir);
  if (existing?.reason === 'user') {
    // 尊重用户显式覆盖，不被自动崩溃标记改写。
    return false;
  }
  const filePath = path.join(options.userDataDir, GPU_RENDERING_POLICY_FILE);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const payload: PersistedGpuRenderingPolicy = {
    version: 1,
    disableHardwareAcceleration: true,
    reason: 'gpu-crash-loop',
    appVersion: options.appVersion,
    crashCount: options.crashCount,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
  try {
    fs.mkdirSync(options.userDataDir, { recursive: true });
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* ignore cleanup error */
    }
    return false;
  }
}

/**
 * 必须在 app.whenReady() 之前调用：决定是否禁用硬件加速及是否在 macOS 禁用 SkiaGraphite。
 */
export function configureGpuRenderingPolicy(
  options: ConfigureGpuRenderingPolicyOptions,
): GpuRenderingPolicyResult {
  const { platform, env, commandLine, disableHardwareAcceleration, userDataDir, appVersion } =
    options;

  let hardwareAccelerationDisabled = false;
  let fallbackReason: GpuFallbackReason | null = null;

  const envDisableHw = env.XDT_DISABLE_HARDWARE_ACCELERATION?.trim();
  if (envDisableHw === '1') {
    hardwareAccelerationDisabled = true;
    fallbackReason = 'env';
  } else if (envDisableHw !== '0') {
    const persisted = readPersistedGpuRenderingPolicy(userDataDir);
    if (persisted?.disableHardwareAcceleration) {
      if (persisted.reason === 'user') {
        hardwareAccelerationDisabled = true;
        fallbackReason = 'user';
      } else if (
        persisted.reason === 'gpu-crash-loop' &&
        (!appVersion || !persisted.appVersion || persisted.appVersion === appVersion)
      ) {
        hardwareAccelerationDisabled = true;
        fallbackReason = 'gpu-crash-loop';
      }
    }
  }

  if (hardwareAccelerationDisabled) {
    disableHardwareAcceleration();
  }

  let skiaGraphiteDisabled = false;
  if (platform === 'darwin' && !hardwareAccelerationDisabled && env.XDT_ENABLE_SKIA_GRAPHITE !== '1') {
    const enabledFeatures = splitFeatureList(commandLine.getSwitchValue?.('enable-features'));
    const disabledFeatures = splitFeatureList(commandLine.getSwitchValue?.('disable-features'));
    if (!enabledFeatures.includes('SkiaGraphite')) {
      if (!disabledFeatures.includes('SkiaGraphite')) {
        disabledFeatures.push('SkiaGraphite');
        commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
      }
      skiaGraphiteDisabled = true;
    }
  }

  activeHardwareAccelerationDisabled = hardwareAccelerationDisabled;
  activeFallbackReason = fallbackReason;
  activeSkiaGraphiteDisabled = skiaGraphiteDisabled;

  return {
    hardwareAccelerationDisabled,
    fallbackReason,
    skiaGraphiteDisabled,
  };
}

export interface GpuCrashRecordResult {
  crashCount: number;
  thresholdReached: boolean;
}

/**
 * 滑动窗口 GPU 异常退出计数器：仅统计非 clean-exit / non-killed 的 GPU 子进程崩溃。
 */
export function createGpuCrashTracker(options?: {
  threshold?: number;
  windowMs?: number;
}) {
  const threshold = options?.threshold ?? GPU_CRASH_LOOP_THRESHOLD;
  const windowMs = options?.windowMs ?? GPU_CRASH_LOOP_WINDOW_MS;
  const timestamps: number[] = [];
  let tripped = false;

  return {
    record(nowMs = Date.now()): GpuCrashRecordResult {
      const cutoff = nowMs - windowMs;
      while (timestamps.length > 0 && timestamps[0]! < cutoff) {
        timestamps.shift();
      }
      timestamps.push(nowMs);
      const justTripped = !tripped && timestamps.length >= threshold;
      if (justTripped) tripped = true;
      return {
        crashCount: timestamps.length,
        thresholdReached: justTripped,
      };
    },
    isTripped(): boolean {
      return tripped;
    },
    reset(): void {
      timestamps.length = 0;
      tripped = false;
    },
  };
}
