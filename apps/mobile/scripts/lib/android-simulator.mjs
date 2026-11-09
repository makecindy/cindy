import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
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
  readDir = readdirSync,
  requireTools = true,
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
    const platforms = win32Path.join(sdkRoot, 'platforms');
    const buildTools = win32Path.join(sdkRoot, 'build-tools');
    let hasBuildPackages = false;
    if (!requireTools && exists(platforms) && exists(buildTools)) {
      try {
        const platformPackages = readDir(platforms);
        const buildToolPackages = readDir(buildTools);
        hasBuildPackages = platformPackages.some((entry) => /^android-\d+$/.test(String(entry.name ?? entry)))
          && buildToolPackages.some((entry) => /^\d+\.\d+\.\d+$/.test(String(entry.name ?? entry)));
      } catch {
        hasBuildPackages = false;
      }
    }
    if (requireTools ? (exists(adb) && exists(emulator)) : hasBuildPackages) {
      return { sdkRoot, adb, emulator };
    }
  }

  throw new Error(
    requireTools
      ? '未找到完整 Android SDK。请设置 ANDROID_SDK_ROOT / ANDROID_HOME，或通过 Android Studio 安装 Platform Tools 与 Emulator。'
      : '未找到 Android SDK 目录。请设置有效的 ANDROID_SDK_ROOT / ANDROID_HOME，或通过 Android Studio 安装 SDK。',
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

/** Read-only diagnostics: an adb error must never look like an absent app/device. */
export function runAndroidProbe(adb, args, execFile = execFileSync) {
  try {
    const output = execFile(adb, args, {
      encoding: 'utf8', windowsHide: true, timeout: 15_000,
      stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
    });
    if (/^(?:Error:|cmd: Can't find service)/m.test(output)) throw new Error('adb service unavailable');
    return String(output).trim();
  } catch (error) {
    throw Object.assign(new Error('Android adb 检查失败；请检查目标模拟器与 adb 连接。'), {
      code: error.code === 'ETIMEDOUT' ? 'ANDROID_PROBE_TIMEOUT' : 'ANDROID_PROBE_FAILED',
    });
  }
}

export function inspectAndroidSimulator({ adb, serial, run = runAndroidProbe }) {
  const booted = parseAdbEmulatorSerials(run(adb, ['devices']));
  const candidates = serial ? booted.filter((device) => device === serial) : booted;
  const selected = candidates.length === 1 ? candidates[0] : null;
  const ready = selected && run(adb, ['-s', selected, 'shell', 'getprop', 'sys.boot_completed']) === '1';
  return {
    deviceSet: { name: 'android', path: null }, booted,
    targetBooted: ready ? [selected] : [], serial: selected,
    avd: ready ? parseEmulatorAvdName(run(adb, ['-s', selected, 'emu', 'avd', 'name'])) : null,
  };
}

export function inspectAndroidInstalledApp({ adb, serial, packageName, run = runAndroidProbe }) {
  if (!/^[A-Za-z][\w]*(?:\.[\w]+)+$/.test(packageName)) throw new Error('Android package name 无效');
  const target = ['-s', serial, 'shell'];
  // pm path exits 1 with empty output for an absent package. List first so that
  // path/read failures for an installed package remain diagnostic failures.
  const packages = run(adb, [...target, 'pm', 'list', 'packages', packageName]);
  const packageLines = packages.split(/\r?\n/).filter(Boolean);
  if (packageLines.some((line) => !/^package:[\w.]+$/.test(line))) {
    throw new Error('无法读取 Android 已安装包列表。');
  }
  if (!packageLines.includes(`package:${packageName}`)) return null;
  const paths = run(adb, [...target, 'pm', 'path', packageName]);
  const apk = paths.split(/\r?\n/).find((line) => /^package:\/.*\/base\.apk$/.test(line))?.slice(8);
  if (!apk) throw new Error('无法读取 Android base.apk 路径，不能判断原生兼容性。');
  const dump = run(adb, [...target, 'dumpsys', 'package', packageName]);
  const version = dump.match(/\bversionName=(\S+)/)?.[1];
  const buildNumber = dump.match(/\bversionCode=(\d+)/)?.[1];
  if (!version || !buildNumber) throw new Error('无法读取 Android 已安装版本。');
  return { apk, version, buildNumber, debuggable: /\b(?:pkgFlags|flags)=\[[^\]]*\bDEBUGGABLE\b/.test(dump) };
}

/** Expo Updates embeds the build hash at assets/fingerprint, also in debug APKs. */
export function readAndroidInstalledFingerprint({ adb, serial, apk, run = runAndroidProbe }) {
  // adb shell joins its arguments into a shell command, so quote the package-manager path.
  const quotedApk = `'${apk.replaceAll("'", "'\\''")}'`;
  const unzip = ['-s', serial, 'shell', 'unzip'];
  try {
    return run(adb, [...unzip, '-p', quotedApk, 'assets/fingerprint']);
  } catch (error) {
    if (error?.code !== 'ANDROID_PROBE_FAILED') throw error;
    // Some unzip implementations fail for an unmatched entry instead of
    // returning empty output. Only a successful APK listing proves absence;
    // a corrupt/unreadable archive or a failed listing must remain a failure.
    const entries = run(adb, [...unzip, '-l', quotedApk]).split(/\r?\n/)
      .map((line) => line.match(/^\s*\d+\s+\S+\s+\S+\s+(.+)$/)?.[1].trim()).filter(Boolean);
    if (entries.length > 0 && !entries.includes('assets/fingerprint')) return '';
    throw error;
  }
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
