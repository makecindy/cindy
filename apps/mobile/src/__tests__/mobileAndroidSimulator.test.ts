// @ts-nocheck —— 被测对象是 .mjs 开发工具模块，vitest 跑其纯函数与注入式流程。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ANDROID_AVD,
  ensureWindowsAndroidEmulator,
  extractAndroidSimulatorArgs,
  parseAdbEmulatorSerials,
  parseEmulatorAvdName,
  resolveAndroidSdkTools,
} from '../../scripts/lib/android-simulator.mjs';

describe('Windows Android 模拟器参数', () => {
  it('sim:start 使用跨平台 pnpm 调用器，不再直接 spawn pnpm', () => {
    const source = readFileSync(resolve(process.cwd(), 'scripts/sim-start.mjs'), 'utf8');
    expect(source).toContain('resolvePnpmInvocation(args');
    expect(source).toContain('usablePnpmExecPath(process.env.npm_execpath, existsSync)');
    expect(source).not.toContain("spawn('pnpm'");
  });

  it('Windows 默认启动 cindy-api36，且不把本地参数透传给 Expo', () => {
    expect(extractAndroidSimulatorArgs(['--avd', 'Pixel_API_36', '--port', '8082'], 'win32'))
      .toEqual({
        avd: 'Pixel_API_36',
        startEmulator: true,
        passthrough: ['--port', '8082'],
      });
    expect(extractAndroidSimulatorArgs(['--no-emulator', '--clear'], 'win32')).toEqual({
      avd: DEFAULT_ANDROID_AVD,
      startEmulator: false,
      passthrough: ['--clear'],
    });
  });

  it('非 Windows 平台保持 Metro-only 行为', () => {
    expect(extractAndroidSimulatorArgs([], 'darwin')).toEqual({
      avd: DEFAULT_ANDROID_AVD,
      startEmulator: false,
      passthrough: [],
    });
  });

  it('拒绝空 AVD 与重复参数', () => {
    expect(() => extractAndroidSimulatorArgs(['--avd='], 'win32')).toThrow(/不能为空/);
    expect(() => extractAndroidSimulatorArgs(['--avd=a', '--avd=b'], 'win32')).toThrow(/只能传一次/);
  });
});

describe('Android SDK 与 adb 输出解析', () => {
  it('依次尝试显式 SDK 与 Windows 标准目录', () => {
    const existing = new Set([
      'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
      'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe',
    ]);
    expect(resolveAndroidSdkTools({
      platform: 'win32',
      env: {
        ANDROID_SDK_ROOT: 'D:\\missing',
        LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local',
      },
      exists: (target) => existing.has(target),
    })).toEqual({
      sdkRoot: 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk',
      adb: 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\platform-tools\\adb.exe',
      emulator: 'C:\\Users\\dev\\AppData\\Local\\Android\\Sdk\\emulator\\emulator.exe',
    });
  });

  it('只接受在线 emulator，并去掉 avd name 的 OK 尾行', () => {
    expect(parseAdbEmulatorSerials([
      'List of devices attached',
      'emulator-5554 device product:sdk',
      'emulator-5556 offline',
      'R5CT device product:phone',
      '',
    ].join('\r\n'))).toEqual(['emulator-5554']);
    expect(parseEmulatorAvdName('cindy-api36\r\nOK\r\n')).toBe('cindy-api36');
  });
});

describe('Windows Android 模拟器启动流程', () => {
  const env = { ANDROID_SDK_ROOT: 'C:\\Android\\Sdk' };
  const adb = 'C:\\Android\\Sdk\\platform-tools\\adb.exe';
  const emulator = 'C:\\Android\\Sdk\\emulator\\emulator.exe';
  const exists = () => true;

  it('复用已启动 AVD，等待 boot_completed 后设置 adb reverse', async () => {
    const execFile = vi.fn((command, args) => {
      if (command === adb && args.join(' ') === 'devices') {
        return 'List of devices attached\nemulator-5554 device\n';
      }
      if (command === adb && args.includes('name')) return 'cindy-api36\nOK\n';
      if (command === adb && args.includes('sys.boot_completed')) return '1\n';
      return '';
    });

    await expect(ensureWindowsAndroidEmulator({
      avd: 'cindy-api36',
      port: 8081,
      platform: 'win32',
      env,
      exists,
      execFile,
      log: vi.fn(),
    })).resolves.toMatchObject({ action: 'reused', serial: 'emulator-5554' });
    expect(execFile).toHaveBeenCalledWith(
      adb,
      ['-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081'],
      { stdio: 'ignore', windowsHide: true },
    );
  });

  it('没有在线 AVD 时启动目标模拟器，再等待并设置端口', async () => {
    let devicesChecks = 0;
    let clock = 0;
    const execFile = vi.fn((command, args) => {
      if (command === emulator && args[0] === '-list-avds') return 'cindy-api36\n';
      if (command === adb && args.join(' ') === 'devices') {
        devicesChecks += 1;
        return devicesChecks >= 2
          ? 'List of devices attached\nemulator-5554 device\n'
          : 'List of devices attached\n';
      }
      if (command === adb && args.includes('name')) return 'cindy-api36\nOK\n';
      if (command === adb && args.includes('sys.boot_completed')) return '1\n';
      return '';
    });
    const child = { once: vi.fn(), unref: vi.fn() };
    const spawnProcess = vi.fn(() => child);

    await expect(ensureWindowsAndroidEmulator({
      avd: 'cindy-api36',
      port: 8081,
      platform: 'win32',
      env,
      exists,
      execFile,
      spawnProcess,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      log: vi.fn(),
    })).resolves.toMatchObject({ action: 'started', serial: 'emulator-5554' });
    expect(spawnProcess).toHaveBeenCalledWith(emulator, ['-avd', 'cindy-api36'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('目标 AVD 不存在时明确失败，不启动其它模拟器', async () => {
    const execFile = vi.fn((command, args) => {
      if (command === emulator && args[0] === '-list-avds') return 'other-avd\n';
      if (command === adb && args.join(' ') === 'devices') return 'List of devices attached\n';
      return '';
    });
    const spawnProcess = vi.fn();

    await expect(ensureWindowsAndroidEmulator({
      avd: 'cindy-api36',
      port: 8081,
      platform: 'win32',
      env,
      exists,
      execFile,
      spawnProcess,
      log: vi.fn(),
    })).rejects.toThrow(/未找到 Android AVD: cindy-api36/);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('目标 AVD 一直未完成启动时超时失败', async () => {
    let clock = 0;
    const execFile = vi.fn((command, args) => {
      if (command === adb && args.join(' ') === 'devices') {
        return 'List of devices attached\nemulator-5554 device\n';
      }
      if (command === adb && args.includes('name')) return 'cindy-api36\nOK\n';
      if (command === adb && args.includes('sys.boot_completed')) return '0\n';
      return '';
    });

    await expect(ensureWindowsAndroidEmulator({
      avd: 'cindy-api36',
      port: 8081,
      platform: 'win32',
      env,
      exists,
      execFile,
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      timeoutMs: 2_000,
      pollIntervalMs: 1_000,
      log: vi.fn(),
    })).rejects.toThrow(/启动超时 \(2s\)/);
  });
});
