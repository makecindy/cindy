import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { existsSyncMock, outboundFetchMock, spawnMock, execFileMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  outboundFetchMock: vi.fn(),
  spawnMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  execFile: execFileMock,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: existsSyncMock,
  };
});

vi.mock('node:net', () => {
  const { EventEmitter } = require('node:events');
  return {
    default: {
      Socket: class MockSocket extends EventEmitter {
        connect() {
          // Simulate "port not in use" — no pre-existing server
          process.nextTick(() => this.emit('error', new Error('ECONNREFUSED')));
          return this;
        }
        destroy() {}
      },
    },
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'temp' ? '/tmp' : '/Users/tester')),
    getAppPath: vi.fn(() => '/repo/apps/desktop'),
  },
}));

vi.mock('../../maker-host/outbound-fetch.js', () => ({
  outboundFetch: (...args: unknown[]) => outboundFetchMock(...args),
}));

import {
  callAndroidDriverTool,
  clearAndroidStateSnapshotsForTest,
  disposeAndroidAdb,
  getAndroidMcpDeps,
  prepareAndroidAdb,
  setAndroidAutomationSettingsReaderForTest,
  setAndroidPlatformToolsDownloadTimeoutForTest,
  setServerPreExistedForTest,
} from '../android.js';

interface MockSpawnOptions {
  stdout?: Buffer | string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  hang?: boolean;
}

function mockAdbSpawn(options: MockSpawnOptions) {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    queueMicrotask(() => {
      if (options.hang) return;
      if (options.error) {
        child.emit('error', options.error);
        return;
      }
      if (options.stdout) {
        child.stdout.emit('data', Buffer.isBuffer(options.stdout) ? options.stdout : Buffer.from(options.stdout));
      }
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
      child.emit('close', options.exitCode ?? 0, null);
    });

    return child;
  });
}

function mockAdbSpawnByArgs(
  handlers: Record<string, MockSpawnOptions | MockSpawnOptions[]>,
) {
  spawnMock.mockImplementation((command: string, args: string[]) => {
    const normalizedCommand = command === 'adb.exe' ? 'adb' : slashPath(command);
    const key = `${normalizedCommand} ${args.join(' ')}`;
    const handler = handlers[key];
    const options = Array.isArray(handler) ? handler.shift() : handler;
    if (!options) {
      throw new Error(`unexpected adb spawn: ${key}`);
    }
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();

    queueMicrotask(() => {
      if (options.hang) return;
      if (options.error) {
        child.emit('error', options.error);
        return;
      }
      if (options.stdout) {
        child.stdout.emit('data', Buffer.isBuffer(options.stdout) ? options.stdout : Buffer.from(options.stdout));
      }
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
      child.emit('close', options.exitCode ?? 0, null);
    });

    return child;
  });
}

function sampleUiDump() {
  return `UI hierchary dumped to: /dev/tty
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.android.settings" clickable="false" enabled="true" bounds="[0,0][1080,2400]" />
  <node index="1" text="Network &amp; internet" resource-id="android:id/title" class="android.widget.TextView" package="com.android.settings" clickable="true" enabled="true" bounds="[10,100][1070,220]" />
  <node index="2" text="Display" resource-id="android:id/display" class="android.widget.TextView" package="com.android.settings" clickable="true" enabled="true" bounds="[10,240][1070,360]"></node>
</hierarchy>`;
}

function alternateUiDump() {
  return `UI hierchary dumped to: /dev/tty
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="Different" resource-id="android:id/alt" class="android.widget.TextView" package="com.android.settings" clickable="true" enabled="true" bounds="[20,400][220,520]" />
</hierarchy>`;
}

function slashPath(value: unknown): string {
  return String(value).replace(/\\/g, '/');
}

function pngWithSize(width: number, height: number): Buffer {
  const png = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = 6;
  return png;
}

describe('android mcp integration', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    existsSyncMock.mockReset();
    outboundFetchMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    clearAndroidStateSnapshotsForTest();
    setAndroidAutomationSettingsReaderForTest(null);
    delete process.env.XDT_ANDROID_ADB_PATH;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('parses adb status and devices', async () => {
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });

    await expect(callAndroidDriverTool('status', {})).resolves.toMatchObject({
      ok: true,
      data: {
        adb_available: true,
        version: 'Android Debug Bridge version 1.0.41',
        devices: [
          {
            device_serial: 'emulator-5554',
            state: 'device',
            product: 'sdk_gphone64_arm64',
            model: 'Pixel_8',
            device: 'emu',
            transport_id: '1',
          },
        ],
        default_device_serial: 'emulator-5554',
        issue: null,
      },
    });
  });

  it('waits for a cold adb daemon and retries devices once after the initial timeout', async () => {
    vi.useFakeTimers();
    mockAdbSpawnByArgs({
      'adb devices -l': [
        { hang: true },
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
      ],
      'adb start-server': {
        stderr: '* daemon not running; starting now at tcp:5037\n* daemon started successfully\n',
      },
    });

    const resultPromise = callAndroidDriverTool('list_devices', {});
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      data: [{ device_serial: 'emulator-5554', state: 'device' }],
    });
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['devices', '-l'],
      ['start-server'],
      ['devices', '-l'],
    ]);
  });

  it('keeps polling during the cold-start window after a transient protocol reset', async () => {
    vi.useFakeTimers();
    mockAdbSpawnByArgs({
      'adb devices -l': [
        { hang: true },
        {
          stderr: "error: protocol fault (couldn't read status): Connection reset by peer\n",
          exitCode: 1,
        },
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
      ],
      'adb start-server': {
        stderr: '* daemon not running; starting now at tcp:5037\n* daemon started successfully\n',
      },
    });

    const resultPromise = callAndroidDriverTool('list_devices', {});
    await vi.advanceTimersByTimeAsync(3_250);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      data: [{ device_serial: 'emulator-5554', state: 'device' }],
    });
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['devices', '-l'],
      ['start-server'],
      ['devices', '-l'],
      ['devices', '-l'],
    ]);
  });

  it('retries start-server after a transient protocol reset', async () => {
    vi.useFakeTimers();
    mockAdbSpawnByArgs({
      'adb devices -l': [
        { hang: true },
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
      ],
      'adb start-server': [
        {
          stderr: "error: protocol fault (couldn't read status): Connection reset by peer\n",
          exitCode: 1,
        },
        {
          stderr: '* daemon not running; starting now at tcp:5037\n* daemon started successfully\n',
        },
      ],
    });

    const resultPromise = callAndroidDriverTool('list_devices', {});
    await vi.advanceTimersByTimeAsync(3_250);

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      data: [{ device_serial: 'emulator-5554', state: 'device' }],
    });
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['devices', '-l'],
      ['start-server'],
      ['start-server'],
      ['devices', '-l'],
    ]);
  });

  it('shares one cold-start recovery across concurrent device queries', async () => {
    vi.useFakeTimers();
    mockAdbSpawnByArgs({
      'adb devices -l': [
        { hang: true },
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
      ],
      'adb start-server': {
        stderr: '* daemon not running; starting now at tcp:5037\n* daemon started successfully\n',
      },
    });

    const first = callAndroidDriverTool('list_devices', {});
    const second = callAndroidDriverTool('list_devices', {});
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({
        ok: true,
        data: [expect.objectContaining({ device_serial: 'emulator-5554' })],
      }),
      expect.objectContaining({
        ok: true,
        data: [expect.objectContaining({ device_serial: 'emulator-5554' })],
      }),
    ]);
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['devices', '-l'],
      ['start-server'],
      ['devices', '-l'],
    ]);
  });

  it('does not treat a strict adb version probe timeout as a cold daemon', async () => {
    vi.useFakeTimers();
    setAndroidAutomationSettingsReaderForTest(() => ({
      defaultDeviceSerial: null,
      adbPathOverride: '/custom/platform-tools/adb',
    }));
    mockAdbSpawnByArgs({
      '/custom/platform-tools/adb version': { hang: true },
    });

    const resultPromise = callAndroidDriverTool('list_devices', {});
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      errorCode: 'ANDROID_DRIVER_ERROR',
      message: 'adb version timed out after 3000ms',
    });
    expect(spawnMock.mock.calls.map((call) => [slashPath(call[0]), call[1]])).toEqual([
      ['/custom/platform-tools/adb', ['version']],
    ]);
  });

  it('returns ADB_NOT_FOUND when adb cannot be spawned', async () => {
    mockAdbSpawn({ error: Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }) });

    await expect(callAndroidDriverTool('status', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'ADB_NOT_FOUND',
    });
  });

  it('falls back to adb.exe on Windows PATH before bare adb', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    try {
      await expect(callAndroidDriverTool('status', {})).resolves.toMatchObject({
        ok: true,
        data: {
          adb_path: 'adb.exe',
        },
      });
      expect(spawnMock.mock.calls[0]?.[0]).toBe('adb.exe');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('prefers the bundled Windows adb before SDK and PATH fallbacks', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe'
    ));
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/repo/apps/android-platform-tools-bin/win32-x64/adb.exe');
      expect(slashPath(spawnMock.mock.calls[0]?.[0]))
        .toBe('/repo/apps/android-platform-tools-bin/win32-x64/adb.exe');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('kill-servers the bundled adb on quit cleanup after it was used', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe'
    ));
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    try {
      await callAndroidDriverTool('status', {});
      const callsBefore = spawnMock.mock.calls.length;

      spawnMock.mockImplementation(() => ({ unref: vi.fn() }));
      disposeAndroidAdb();

      expect(spawnMock.mock.calls.length).toBe(callsBefore + 1);
      const [command, args, options] = spawnMock.mock.calls[callsBefore]!;
      expect(slashPath(command)).toBe('/repo/apps/android-platform-tools-bin/win32-x64/adb.exe');
      expect(args).toEqual(['kill-server']);
      expect(options).toMatchObject({ detached: true, stdio: 'ignore' });

      // 幂等:第二次 dispose 不再 spawn。
      disposeAndroidAdb();
      expect(spawnMock.mock.calls.length).toBe(callsBefore + 1);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('does not kill-server on quit when adb came from the user PATH', async () => {
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    await callAndroidDriverTool('status', {});
    const callsBefore = spawnMock.mock.calls.length;
    disposeAndroidAdb();
    expect(spawnMock.mock.calls.length).toBe(callsBefore);
  });

  it('does not kill-server on quit when a server pre-existed before our usage', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe'
    ));
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    // Simulate: server was already on 5037 before we used adb
    setServerPreExistedForTest(true);

    try {
      await callAndroidDriverTool('status', {});
      const callsBefore = spawnMock.mock.calls.length;

      spawnMock.mockImplementation(() => ({ unref: vi.fn() }));
      disposeAndroidAdb();

      // Should NOT have spawned kill-server since server pre-existed
      expect(spawnMock.mock.calls.length).toBe(callsBefore);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('prefers packaged bundled Windows adb from resources before prepared and PATH fallbacks', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/packed/resources',
    });
    existsSyncMock.mockImplementation((candidate: string) => {
      const normalized = slashPath(candidate);
      return normalized === '/packed/resources/tools/android-platform-tools/win32-x64/adb.exe'
        || normalized === '/Users/tester/android-platform-tools/win32-x64/platform-tools/adb.exe';
    });
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/packed/resources/tools/android-platform-tools/win32-x64/adb.exe');
      expect(slashPath(spawnMock.mock.calls[0]?.[0]))
        .toBe('/packed/resources/tools/android-platform-tools/win32-x64/adb.exe');
    } finally {
      platformSpy.mockRestore();
      if (originalResourcesPath) {
        Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
      } else {
        // Electron 类型把 resourcesPath 声明为必选,交叉类型无法把它变回可选;
        // 断言成独立对象类型才能让 delete 通过 TS2790 检查。
        delete (process as { resourcesPath?: string }).resourcesPath;
      }
    }
  });

  it('uses platform adb executable names for packaged bundled adb candidates', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const archSpy = vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', {
      configurable: true,
      value: '/packed/resources',
    });
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/packed/resources/tools/android-platform-tools/darwin-arm64/adb'
    ));
    mockAdbSpawnByArgs({
      '/packed/resources/tools/android-platform-tools/darwin-arm64/adb version': {
        stdout: 'Android Debug Bridge version 1.0.41\n',
      },
      '/packed/resources/tools/android-platform-tools/darwin-arm64/adb devices -l': {
        stdout: 'List of devices attached\n',
      },
    });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/packed/resources/tools/android-platform-tools/darwin-arm64/adb');
      expect(slashPath(spawnMock.mock.calls[0]?.[0]))
        .toBe('/packed/resources/tools/android-platform-tools/darwin-arm64/adb');
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
      if (originalResourcesPath) {
        Object.defineProperty(process, 'resourcesPath', originalResourcesPath);
      } else {
        // Electron 类型把 resourcesPath 声明为必选,交叉类型无法把它变回可选;
        // 断言成独立对象类型才能让 delete 通过 TS2790 检查。
        delete (process as { resourcesPath?: string }).resourcesPath;
      }
    }
  });

  it('falls back from an unusable bundled adb to the SDK adb candidate', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    existsSyncMock.mockImplementation((candidate: string) => {
      const normalized = slashPath(candidate);
      return normalized === '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe'
        || normalized === '/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe';
    });
    mockAdbSpawnByArgs({
      '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe version': {
        stderr: 'bad adb binary',
        exitCode: 1,
      },
      '/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe version': {
        stdout: 'Android Debug Bridge version 1.0.41\n',
      },
      '/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe devices -l': {
        stdout: 'List of devices attached\n',
      },
    });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe');
      expect(slashPath(spawnMock.mock.calls[0]?.[0]))
        .toBe('/repo/apps/android-platform-tools-bin/win32-x64/adb.exe');
      expect(slashPath(spawnMock.mock.calls[1]?.[0]))
        .toBe('/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe');
      expect(slashPath(spawnMock.mock.calls[2]?.[0]))
        .toBe('/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('reports and reuses PATH adb after skipping an unusable bundled candidate', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe'
    ));
    mockAdbSpawnByArgs({
      '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe version': {
        stderr: 'bad adb binary',
        exitCode: 1,
      },
      'adb version': { stdout: 'Android Debug Bridge version 1.0.41\n' },
      'adb devices -l': { stdout: 'List of devices attached\n' },
    });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && (result.data as { adb_path: string }).adb_path).toBe('adb.exe');
      expect(spawnMock.mock.calls.map((call) => slashPath(call[0]))).toEqual([
        '/repo/apps/android-platform-tools-bin/win32-x64/adb.exe',
        'adb.exe',
        'adb.exe',
      ]);
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('falls back from an unusable absolute PATH adb candidate to the next PATH adb', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const archSpy = vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
    existsSyncMock.mockImplementation((candidate: string) => {
      const normalized = slashPath(candidate);
      return normalized === '/opt/homebrew/bin/adb'
        || normalized === '/usr/local/bin/adb';
    });
    mockAdbSpawnByArgs({
      '/opt/homebrew/bin/adb version': {
        stderr: 'homebrew adb is quarantined',
        exitCode: 1,
      },
      '/usr/local/bin/adb version': {
        stdout: 'Android Debug Bridge version 1.0.41\n',
      },
      '/usr/local/bin/adb devices -l': {
        stdout: 'List of devices attached\n',
      },
    });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/usr/local/bin/adb');
      expect(spawnMock.mock.calls.map((call) => slashPath(call[0]))).toEqual([
        '/opt/homebrew/bin/adb',
        '/usr/local/bin/adb',
        '/usr/local/bin/adb',
      ]);
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it('does not fall back when a strict custom adb path is unusable', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    setAndroidAutomationSettingsReaderForTest(() => ({
      defaultDeviceSerial: null,
      adbPathOverride: '/custom/platform-tools/adb.exe',
    }));
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/custom/platform-tools/adb.exe'
        || slashPath(candidate) === '/Users/tester/AppData/Local/Android/Sdk/platform-tools/adb.exe'
    ));
    mockAdbSpawnByArgs({
      '/custom/platform-tools/adb.exe version': {
        stderr: 'custom adb is blocked',
        exitCode: 1,
      },
    });

    try {
      await expect(callAndroidDriverTool('status', {})).resolves.toMatchObject({
        ok: false,
        errorCode: 'ADB_NOT_FOUND',
      });
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(slashPath(spawnMock.mock.calls[0]?.[0])).toBe('/custom/platform-tools/adb.exe');
    } finally {
      platformSpy.mockRestore();
    }
  });

  it('uses XDT_ANDROID_ADB_PATH as an explicit override', async () => {
    process.env.XDT_ANDROID_ADB_PATH = '/custom/platform-tools/adb.exe';
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/custom/platform-tools/adb.exe'
    ));
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/custom/platform-tools/adb.exe');
      expect(slashPath(spawnMock.mock.calls[0]?.[0])).toBe('/custom/platform-tools/adb.exe');
    } finally {
      platformSpy.mockRestore();
      delete process.env.XDT_ANDROID_ADB_PATH;
    }
  });

  it('times out stalled platform-tools downloads during adb preparation', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const archSpy = vi.spyOn(process, 'arch', 'get').mockReturnValue('x64');
    setAndroidPlatformToolsDownloadTimeoutForTest(1);
    mockAdbSpawn({ error: Object.assign(new Error('spawn adb ENOENT'), { code: 'ENOENT' }) });
    outboundFetchMock.mockImplementation((_url: string, init?: { signal?: AbortSignal }) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('download aborted'), { name: 'AbortError' }));
        }, { once: true });
      })
    ));

    try {
      const result = await prepareAndroidAdb();
      expect(result).toMatchObject({
        supported: true,
        ready: false,
        platform: 'linux-x64',
        source: 'prepared',
      });
      expect(slashPath(result.path)).toBe('/Users/tester/android-platform-tools/linux-x64/platform-tools/adb');
      expect(result.error).toContain('Android platform-tools download timed out after 1ms');
      expect(outboundFetchMock).toHaveBeenCalledWith(
        'https://dl.google.com/android/repository/platform-tools-latest-linux.zip',
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      platformSpy.mockRestore();
      archSpy.mockRestore();
    }
  });

  it('captures screenshot and image payload for get_device_state', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
      },
      'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
      'adb -s emulator-5554 shell wm density': { stdout: 'Physical density: 440\n' },
      'adb -s emulator-5554 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n',
      },
      'adb -s emulator-5554 exec-out screencap -p': { stdout: png },
      'adb -s emulator-5554 exec-out uiautomator dump /dev/tty': { stdout: sampleUiDump() },
    });

    const result = await callAndroidDriverTool('get_device_state', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      device_serial: 'emulator-5554',
      screen: { width: 1080, height: 2400, density: 440 },
      current_app: {
        package: 'com.android.settings',
        activity: 'com.android.settings.Settings',
      },
    });
    expect((result.data as { screenshot_base64: string }).screenshot_base64).toBe(png.toString('base64'));
    expect((result.data as { nodes: Array<{ text?: string }> }).nodes[0]?.text).toBe('Network & internet');
  });

  it('fails oversized binary screenshot payloads instead of returning truncated images', async () => {
    const oversizedPng = Buffer.concat([
      pngWithSize(1080, 2400),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ]);
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
      },
      'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
      'adb -s emulator-5554 shell wm density': { stdout: 'Physical density: 440\n' },
      'adb -s emulator-5554 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n',
      },
      'adb -s emulator-5554 exec-out screencap -p': { stdout: oversizedPng },
    });

    await expect(callAndroidDriverTool('get_device_state', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'SCREENSHOT_FAILED',
    });
  });

  it('preserves screenshots when uiautomator dump exits non-zero', async () => {
    const png = pngWithSize(1080, 2400);
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
      },
      'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
      'adb -s emulator-5554 shell wm density': { stdout: 'Physical density: 440\n' },
      'adb -s emulator-5554 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n',
      },
      'adb -s emulator-5554 exec-out screencap -p': { stdout: png },
      'adb -s emulator-5554 exec-out uiautomator dump /dev/tty': {
        stderr: 'UI hierarchy dump failed',
        exitCode: 1,
      },
    });

    const result = await callAndroidDriverTool('get_device_state', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      device_serial: 'emulator-5554',
      screen: { width: 1080, height: 2400, density: 440 },
      nodes: [],
      ui_dump_error: 'UI hierarchy dump failed',
    });
    expect((result.data as { screenshot_base64: string }).screenshot_base64).toBe(png.toString('base64'));
  });

  it('prefers the saved custom adb path before environment and automatic candidates', async () => {
    process.env.XDT_ANDROID_ADB_PATH = '/env/platform-tools/adb';
    setAndroidAutomationSettingsReaderForTest(() => ({
      defaultDeviceSerial: null,
      adbPathOverride: '/settings/platform-tools/adb',
    }));
    existsSyncMock.mockImplementation((candidate: string) => (
      slashPath(candidate) === '/settings/platform-tools/adb'
    ));
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({ stdout: 'List of devices attached\n' });

    try {
      const result = await callAndroidDriverTool('status', {});
      expect(result).toMatchObject({ ok: true });
      expect(result.ok && slashPath((result.data as { adb_path: string }).adb_path))
        .toBe('/settings/platform-tools/adb');
      expect(slashPath(spawnMock.mock.calls[0]?.[0])).toBe('/settings/platform-tools/adb');
    } finally {
      delete process.env.XDT_ANDROID_ADB_PATH;
    }
  });

  it('falls back to dumpsys activity when window focus omits the current app', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
9fc52f30 device product:dada model:24129PN74C device:dada transport_id:2
`,
      },
      'adb -s 9fc52f30 shell wm size': { stdout: 'Physical size: 1200x2670\n' },
      'adb -s 9fc52f30 shell wm density': { stdout: 'Physical density: 520\n' },
      'adb -s 9fc52f30 shell dumpsys window windows': {
        stdout: 'mTopFocusedDisplayId=0\n',
      },
      'adb -s 9fc52f30 shell dumpsys activity activities': {
        stdout: 'topResumedActivity=ActivityRecord{abc u0 com.miui.home/.launcher.Launcher t1}\n',
      },
      'adb -s 9fc52f30 exec-out screencap -p': { stdout: png },
      'adb -s 9fc52f30 exec-out uiautomator dump /dev/tty': { stdout: sampleUiDump() },
    });

    const result = await callAndroidDriverTool('get_device_state', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      device_serial: '9fc52f30',
      current_app: {
        package: 'com.miui.home',
        activity: '.launcher.Launcher',
      },
    });
  });

  it('uses screenshot dimensions as the coordinate screen for landscape apps', async () => {
    const png = pngWithSize(2670, 1200);
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
9fc52f30 device product:dada model:24129PN74C device:dada transport_id:2
`,
      },
      'adb -s 9fc52f30 shell wm size': { stdout: 'Physical size: 1200x2670\n' },
      'adb -s 9fc52f30 shell wm density': { stdout: 'Physical density: 520\n' },
      'adb -s 9fc52f30 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.example.unitygame/com.example.input.UnityPlayerActivity}\n',
      },
      'adb -s 9fc52f30 exec-out screencap -p': { stdout: png },
      'adb -s 9fc52f30 exec-out uiautomator dump /dev/tty': {
        stdout: `UI hierchary dumped to: /dev/tty
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.example.unitygame" clickable="false" enabled="true" bounds="[0,0][2670,1200]" />
</hierarchy>`,
      },
    });

    const result = await callAndroidDriverTool('get_device_state', {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      screen: { width: 2670, height: 1200, density: 520 },
      current_app: {
        package: 'com.example.unitygame',
        activity: 'com.example.input.UnityPlayerActivity',
      },
    });
  });

  it('validates swipe coordinates against the latest screenshot coordinate screen', async () => {
    const png = pngWithSize(2670, 1200);
    mockAdbSpawnByArgs({
      'adb devices -l': [
        {
          stdout: `List of devices attached
9fc52f30 device product:dada model:24129PN74C device:dada transport_id:2
`,
        },
        {
          stdout: `List of devices attached
9fc52f30 device product:dada model:24129PN74C device:dada transport_id:2
`,
        },
      ],
      'adb -s 9fc52f30 shell wm size': { stdout: 'Physical size: 1200x2670\n' },
      'adb -s 9fc52f30 shell wm density': { stdout: 'Physical density: 520\n' },
      'adb -s 9fc52f30 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.example.unitygame/com.example.input.UnityPlayerActivity}\n',
      },
      'adb -s 9fc52f30 exec-out screencap -p': { stdout: png },
      'adb -s 9fc52f30 exec-out uiautomator dump /dev/tty': {
        stdout: `UI hierchary dumped to: /dev/tty
<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="1">
  <node index="0" text="" resource-id="android:id/content" class="android.widget.FrameLayout" package="com.example.unitygame" clickable="false" enabled="true" bounds="[0,0][2670,1200]" />
</hierarchy>`,
      },
      'adb -s 9fc52f30 shell input swipe 2000 500 300 500 300': { stdout: '' },
    });

    await expect(callAndroidDriverTool('get_device_state', {}, { sessionId: 'landscape' }))
      .resolves.toMatchObject({ ok: true });
    await expect(callAndroidDriverTool('swipe', {
      start: { x: 2000, y: 500 },
      end: { x: 300, y: 500 },
    }, { sessionId: 'landscape' })).resolves.toEqual({
      ok: true,
      data: {
        device_serial: '9fc52f30',
        start: { x: 2000, y: 500 },
        end: { x: 300, y: 500 },
        duration_ms: 300,
      },
    });
    const wmSizeCalls = spawnMock.mock.calls.filter((call) => (
      (call[1] as string[]).join(' ') === '-s 9fc52f30 shell wm size'
    ));
    expect(wmSizeCalls).toHaveLength(1);
  });

  it('maps tap by element index to adb shell input tap', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
      },
      'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
      'adb -s emulator-5554 shell wm density': { stdout: 'Physical density: 440\n' },
      'adb -s emulator-5554 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n',
      },
      'adb -s emulator-5554 exec-out screencap -p': { stdout: png },
      'adb -s emulator-5554 exec-out uiautomator dump /dev/tty': { stdout: sampleUiDump() },
      'adb -s emulator-5554 shell input tap 540 160': { stdout: '' },
    });

    const stateResult = await callAndroidDriverTool('get_device_state', {});
    expect(stateResult.ok).toBe(true);

    const result = await callAndroidDriverTool('tap', { element_index: 1 });
    expect(result).toEqual({
      ok: true,
      data: {
        device_serial: 'emulator-5554',
        x: 540,
        y: 160,
      },
    });
    expect(spawnMock.mock.calls[7]?.[1]).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'tap',
      '540',
      '160',
    ]);
  });

  it('keeps element index snapshots isolated by session', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mockAdbSpawnByArgs({
      'adb devices -l': Array.from({ length: 4 }, () => ({
        stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
      })),
      'adb -s emulator-5554 shell wm size': [
        { stdout: 'Physical size: 1080x2400\n' },
        { stdout: 'Physical size: 1080x2400\n' },
      ],
      'adb -s emulator-5554 shell wm density': [
        { stdout: 'Physical density: 440\n' },
        { stdout: 'Physical density: 440\n' },
      ],
      'adb -s emulator-5554 shell dumpsys window windows': [
        { stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n' },
        { stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n' },
      ],
      'adb -s emulator-5554 exec-out screencap -p': [
        { stdout: png },
        { stdout: png },
      ],
      'adb -s emulator-5554 exec-out uiautomator dump /dev/tty': [
        { stdout: sampleUiDump() },
        { stdout: alternateUiDump() },
      ],
      'adb -s emulator-5554 shell input tap 540 160': { stdout: '' },
      'adb -s emulator-5554 shell input tap 120 460': { stdout: '' },
    });

    await expect(callAndroidDriverTool('get_device_state', {}, { sessionId: 'session-a' }))
      .resolves.toMatchObject({ ok: true });
    await expect(callAndroidDriverTool('get_device_state', {}, { sessionId: 'session-b' }))
      .resolves.toMatchObject({ ok: true });

    await expect(callAndroidDriverTool('tap', { element_index: 1 }, { sessionId: 'session-a' }))
      .resolves.toMatchObject({ ok: true, data: { x: 540, y: 160 } });
    await expect(callAndroidDriverTool('tap', { element_index: 1 }, { sessionId: 'session-b' }))
      .resolves.toMatchObject({ ok: true, data: { x: 120, y: 460 } });
  });

  it('invalidates element snapshots after a mutating action', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    mockAdbSpawnByArgs({
      'adb devices -l': [
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
        {
          stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
        },
      ],
      'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
      'adb -s emulator-5554 shell wm density': { stdout: 'Physical density: 440\n' },
      'adb -s emulator-5554 shell dumpsys window windows': {
        stdout: 'mCurrentFocus=Window{123 u0 com.android.settings/com.android.settings.Settings}\n',
      },
      'adb -s emulator-5554 exec-out screencap -p': { stdout: png },
      'adb -s emulator-5554 exec-out uiautomator dump /dev/tty': { stdout: sampleUiDump() },
      'adb -s emulator-5554 shell input tap 540 160': { stdout: '' },
    });

    await expect(callAndroidDriverTool('get_device_state', {}, { sessionId: 'session-a' }))
      .resolves.toMatchObject({ ok: true });
    await expect(callAndroidDriverTool('tap', { element_index: 1 }, { sessionId: 'session-a' }))
      .resolves.toMatchObject({ ok: true });
    await expect(callAndroidDriverTool('tap', { element_index: 1 }, { sessionId: 'session-a' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'INVALID_NODE' });
  });

  it('rejects coordinate taps outside the current screen bounds', async () => {
    mockAdbSpawnByArgs({
      'adb devices -l': {
        stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
      },
      'adb -s emulator-5554 shell wm size': { stdout: 'Physical size: 1080x2400\n' },
      'adb -s emulator-5554 shell wm density': { stdout: 'Physical density: 440\n' },
    });

    await expect(callAndroidDriverTool('tap', { x: 1080, y: 160 }))
      .resolves.toMatchObject({ ok: false, errorCode: 'ANDROID_DRIVER_ERROR' });
    expect(spawnMock.mock.calls.some((call) => (call[1] as string[]).includes('tap'))).toBe(false);
  });

  it('maps safe input_text values without shell metacharacter expansion', async () => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });
    mockAdbSpawn({ stdout: '' });

    await expect(callAndroidDriverTool('input_text', { text: '100% ready' }))
      .resolves.toEqual({
        ok: true,
        data: {
          device_serial: 'emulator-5554',
          text: '100% ready',
        },
      });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'input',
      'text',
      '100%%sready',
    ]);
  });

  it('uses the configured default device when tool args omit device_serial', async () => {
    setAndroidAutomationSettingsReaderForTest(() => ({
      defaultDeviceSerial: 'phone-b',
      adbPathOverride: null,
    }));
    mockAdbSpawn({
      stdout: `List of devices attached
phone-a device product:a model:Phone_A device:a transport_id:1
phone-b device product:b model:Phone_B device:b transport_id:2
`,
    });
    mockAdbSpawn({ stdout: '' });

    await expect(callAndroidDriverTool('input_text', { text: 'ready' }))
      .resolves.toEqual({
        ok: true,
        data: {
          device_serial: 'phone-b',
          text: 'ready',
        },
      });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '-s',
      'phone-b',
      'shell',
      'input',
      'text',
      'ready',
    ]);
  });

  it('does not fall back to another ready device when the configured default is stale', async () => {
    setAndroidAutomationSettingsReaderForTest(() => ({
      defaultDeviceSerial: 'missing-device',
      adbPathOverride: null,
    }));
    mockAdbSpawn({
      stdout: `List of devices attached
phone-a device product:a model:Phone_A device:a transport_id:1
`,
    });

    await expect(callAndroidDriverTool('input_text', { text: 'ready' }))
      .resolves.toMatchObject({
        ok: false,
        errorCode: 'NO_DEVICE',
      });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('reports a stale configured default in status without selecting another device', async () => {
    setAndroidAutomationSettingsReaderForTest(() => ({
      defaultDeviceSerial: 'missing-device',
      adbPathOverride: null,
    }));
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({
      stdout: `List of devices attached
phone-a device product:a model:Phone_A device:a transport_id:1
`,
    });

    await expect(callAndroidDriverTool('status', {})).resolves.toMatchObject({
      ok: true,
      data: {
        default_device_serial: 'missing-device',
        configured_default_device_serial: 'missing-device',
        issue: 'NO_DEVICE',
        error: 'Default Android device is not connected: missing-device',
      },
    });
  });

  it('does not report an auto default device when multiple devices are ready', async () => {
    mockAdbSpawn({ stdout: 'Android Debug Bridge version 1.0.41\n' });
    mockAdbSpawn({
      stdout: `List of devices attached
phone-a device product:a model:Phone_A device:a transport_id:1
phone-b device product:b model:Phone_B device:b transport_id:2
`,
    });

    await expect(callAndroidDriverTool('status', {})).resolves.toMatchObject({
      ok: true,
      data: {
        default_device_serial: null,
        configured_default_device_serial: null,
        issue: 'MULTIPLE_DEVICES',
      },
    });
  });

  it('rejects unsupported adb text characters instead of dropping them', async () => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });

    await expect(callAndroidDriverTool('input_text', { text: 'a&b' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'ANDROID_DRIVER_ERROR' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    'a;reboot',
    'a`id`',
    'literal%s',
    '中文测试',
  ])('rejects unsafe input_text value %s before invoking adb input', async (text) => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });

    await expect(callAndroidDriverTool('input_text', { text }))
      .resolves.toMatchObject({ ok: false, errorCode: 'ANDROID_DRIVER_ERROR' });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects element index taps before a device snapshot exists', async () => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });

    await expect(callAndroidDriverTool('tap', { element_index: 1 })).resolves.toMatchObject({
      ok: false,
      errorCode: 'INVALID_NODE',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('maps launch_app with package + activity to am start', async () => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });
    mockAdbSpawn({ stdout: 'Starting: Intent { cmp=com.android.settings/.Settings }\n' });

    const result = await callAndroidDriverTool('launch_app', {
      package: 'com.android.settings',
      activity: '.Settings',
    });
    expect(result).toEqual({
      ok: true,
      data: {
        device_serial: 'emulator-5554',
        package: 'com.android.settings',
        activity: '.Settings',
        output: 'Starting: Intent { cmp=com.android.settings/.Settings }',
      },
    });
    expect(spawnMock.mock.calls[1]?.[1]).toEqual([
      '-s',
      'emulator-5554',
      'shell',
      'am',
      'start',
      '-n',
      'com.android.settings/.Settings',
    ]);
  });

  it('rejects launch_app activity values outside Android component syntax', async () => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });

    await expect(callAndroidDriverTool('launch_app', {
      package: 'com.android.settings',
      activity: '.Settings --es unsafe true',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'ANDROID_DRIVER_ERROR',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('rejects launch_app activity values with shell-variable syntax', async () => {
    mockAdbSpawn({
      stdout: `List of devices attached
emulator-5554 device product:sdk_gphone64_arm64 model:Pixel_8 device:emu transport_id:1
`,
    });

    await expect(callAndroidDriverTool('launch_app', {
      package: 'com.example.app',
      activity: '.Outer$Inner',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'ANDROID_DRIVER_ERROR',
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('respects the plugin gate in getAndroidMcpDeps', async () => {
    const isAndroidAutomationEnabled = vi.fn(() => false);
    const deps = getAndroidMcpDeps({ isAndroidAutomationEnabled });
    await expect(deps.callTool('status', {}, { agentKind: 'codex' })).resolves.toEqual({
      ok: false,
      errorCode: 'ANDROID_DRIVER_ERROR',
      message: 'Android automation is disabled in Settings.',
    });
    expect(isAndroidAutomationEnabled).toHaveBeenCalledWith({ agentKind: 'codex' });
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
