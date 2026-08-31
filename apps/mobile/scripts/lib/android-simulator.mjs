import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 as win32Path } from 'node:path';

export const DEFAULT_ANDROID_AVD = 'cindy-api36';
const DEFAULT_BOOT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * 提取 Windows Android 模拟器参数，避免把本地工具参数透传给 Expo。
 * Windows 默认启动模拟器；其它平台保持既有的 Metro-only 行为。
 */
export function extractAndroidSimulatorArgs(argv, platform = process.platform) {
  let avd = DEFAULT_ANDROID_AVD;
  let avdSpecified = false;
  let startEmulator = platform === 'win32';
  const passthrough = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-emulator') {
      startEmulator = false;
      continue;
    }
    if (arg === '--avd') {
      if (avdSpecified) throw new Error('--avd 只能传一次');
      avdSpecified = true;
      avd = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--avd=')) {
      if (avdSpecified) throw new Error('--avd 只能传一次');
      avdSpecified = true;
      avd = arg.slice('--avd='.length);
      continue;
    }
    passthrough.push(arg);
  }

  avd = avd?.trim();
  if (!avd) throw new Error('--avd 不能为空');
  return { avd, startEmulator, passthrough };
}

/** 从 Android SDK 环境变量或 Windows 标准安装目录解析 adb / emulator。 */
export function resolveAndroidSdkTools({
  env = process.env,
  platform = process.platform,
  exists = existsSync,
} = {}) {
  if (platform !== 'win32') return null;

  const candidates = [
    env.ANDROID_SDK_ROOT,
    env.ANDROID_HOME,
    env.LOCALAPPDATA ? win32Path.join(env.LOCALAPPDATA, 'Android', 'Sdk') : null,
  ].filter(Boolean);

  for (const sdkRoot of [...new Set(candidates)]) {
    const adb = win32Path.join(sdkRoot, 'platform-tools', 'adb.exe');
    const emulator = win32Path.join(sdkRoot, 'emulator', 'emulator.exe');
    if (exists(adb) && exists(emulator)) return { sdkRoot, adb, emulator };
  }

  throw new Error(
    '未找到完整 Android SDK。请设置 ANDROID_SDK_ROOT / ANDROID_HOME，或通过 Android Studio 安装 Platform Tools 与 Emulator。',
  );
}

export function parseAdbEmulatorSerials(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim().match(/^(emulator-\d+)\s+device(?:\s|$)/)?.[1])
    .filter(Boolean);
}

export function parseEmulatorAvdName(output) {
  return String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && line !== 'OK') ?? null;
}

function runText(execFile, command, args) {
  try {
    return execFile(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function findRunningAvd(adb, avd, execFile) {
  const devices = parseAdbEmulatorSerials(runText(execFile, adb, ['devices']));
  for (const serial of devices) {
    const runningAvd = parseEmulatorAvdName(
      runText(execFile, adb, ['-s', serial, 'emu', 'avd', 'name']),
    );
    if (runningAvd === avd) return serial;
  }
  return null;
}

function availableAvds(emulator, execFile) {
  return runText(execFile, emulator, ['-list-avds'])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保目标 AVD 已完成启动，并为当前 Metro 端口建立 adb reverse。
 * 模拟器进程与 Metro 解耦，关闭 Metro 不会连带关闭开发者正在使用的 AVD。
 */
export async function ensureWindowsAndroidEmulator({
  avd = DEFAULT_ANDROID_AVD,
  port,
  env = process.env,
  platform = process.platform,
  exists = existsSync,
  execFile = execFileSync,
  spawnProcess = spawn,
  wait = delay,
  now = Date.now,
  timeoutMs = DEFAULT_BOOT_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  log = console.log,
} = {}) {
  if (platform !== 'win32') return { action: 'skipped', serial: null };
  if (!Number.isInteger(port) || port <= 0) throw new Error(`无效 Metro 端口: ${port}`);

  const tools = resolveAndroidSdkTools({ env, platform, exists });
  let serial = findRunningAvd(tools.adb, avd, execFile);
  let action = 'reused';
  let launchError = null;

  if (!serial) {
    if (!availableAvds(tools.emulator, execFile).includes(avd)) {
      throw new Error(`未找到 Android AVD: ${avd}。请先在 Android Studio Device Manager 中创建它。`);
    }
    log(`› 正在启动 Android 模拟器 ${avd}…`);
    const emulatorChild = spawnProcess(tools.emulator, ['-avd', avd], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    emulatorChild.once('error', (error) => { launchError = error; });
    emulatorChild.unref();
    action = 'started';
  } else {
    log(`✓ 复用 Android 模拟器 ${avd} (${serial})`);
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (launchError) throw new Error(`无法启动 Android 模拟器 ${avd}: ${launchError.message}`);
    serial ??= findRunningAvd(tools.adb, avd, execFile);
    if (serial) {
      const bootCompleted = runText(
        execFile,
        tools.adb,
        ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
      ).trim();
      if (bootCompleted === '1') {
        execFile(
          tools.adb,
          ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`],
          { stdio: 'ignore', windowsHide: true },
        );
        log(`✓ Android 模拟器已就绪 (${serial})，Metro 端口 ${port} 已反向代理`);
        return { action, serial, avd, ...tools };
      }
    }
    await wait(pollIntervalMs);
  }

  throw new Error(`等待 Android 模拟器 ${avd} 启动超时 (${Math.round(timeoutMs / 1000)}s)`);
}
