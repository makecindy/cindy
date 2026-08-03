import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

const {
  existsSyncMock,
  readlinkSyncMock,
  spawnMock,
  mcpCallToolMock,
  mcpCloseMock,
  mcpConnectMock,
  transportCloseMock,
  transportCtorMock,
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readlinkSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  mcpCallToolMock: vi.fn(),
  mcpCloseMock: vi.fn(),
  mcpConnectMock: vi.fn(),
  transportCloseMock: vi.fn(),
  transportCtorMock: vi.fn(),
}));

const originalPlatform = process.platform;
const driverResolutionEnvKeys = ['XDT_CUA_DRIVER_PATH', 'LOCALAPPDATA', 'LocalAppData'] as const;
const originalDriverResolutionEnv = new Map<string, string | undefined>(
  driverResolutionEnvKeys.map((key) => [key, process.env[key]]),
);

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value: platform,
    configurable: true,
  });
}

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: existsSyncMock,
    readlinkSync: readlinkSyncMock,
  };
});

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    callTool: mcpCallToolMock,
    close: mcpCloseMock,
    connect: mcpConnectMock,
  })),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation((params) => {
    transportCtorMock(params);
    return {
      close: transportCloseMock,
      stderr: new PassThrough(),
    };
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => (name === 'temp' ? '/tmp' : '/Users/tester')),
  },
}));

import {
  callComputerDriverTool,
  cancelComputerDriverPermissionGrant,
  checkComputerDriverUpdate,
  cleanupAllComputerDriverSessions,
  cleanupComputerDriverSession,
  compareSemver,
  extractDriverSemver,
  getCuaDriverReleaseAssetName,
  resolveCuaDriverHostArch,
  getComputerMcpDeps,
  getComputerDriverStatus,
  grantComputerDriverPermissions,
  installComputerDriver,
  listComputerWindowsForAtMention,
  pauseComputerDriverPermissionProbe,
  pickLatestCuaDriverVersion,
  resetComputerDriverPermissionProbeCacheForTests,
  resetAtMentionWindowCacheForTests,
  resetComputerDriverUpdateStateForTests,
  runProcessWithActivityTimeout,
  sampleInstallProcessTree,
  clearStaleCuaInstallLock,
  extractCurlOutputPath,
  installIdleTimeoutForPlatform,
  matchAssetSizeByFilename,
  pickLatestCuaDriverRelease,
  updateComputerDriver,
} from '../computer.js';

interface MockSpawnOptions {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: Error;
  stdinError?: Error;
}

const driverStdinWrites: string[] = [];

function mockDriverSpawn(options: MockSpawnOptions) {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.unref = vi.fn();
    child.stdin.on('data', (chunk: Buffer) => {
      driverStdinWrites.push(chunk.toString('utf8'));
      if (options.stdinError) {
        child.stdin.emit('error', options.stdinError);
      }
    });

    queueMicrotask(() => {
      if (options.error) {
        child.emit('error', options.error);
        return;
      }
      if (options.stdout) child.stdout.emit('data', Buffer.from(options.stdout));
      if (options.stderr) child.stderr.emit('data', Buffer.from(options.stderr));
      child.emit('close', options.exitCode ?? 0, null);
    });

    return child;
  });
}

function mockNeverSettlingSpawn() {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.unref = vi.fn();
    return child;
  });
}

function mockProcessSnapshotSpawn(processes: Array<{
  pid: number;
  parentPid?: number;
  name: string;
  command: string;
  executable?: string;
}>) {
  if (process.platform === 'win32') {
    mockDriverSpawn({
      stdout: JSON.stringify(processes.map((processInfo) => ({
        ProcessId: processInfo.pid,
        ParentProcessId: processInfo.parentPid ?? 0,
        Name: processInfo.name,
        ExecutablePath: processInfo.executable ?? null,
        CommandLine: processInfo.command,
      }))),
    });
    return;
  }
  mockDriverSpawn({
    stdout: processes
      .map((processInfo) => (
        `${processInfo.pid} ${processInfo.parentPid ?? 0} ${processInfo.command}`
      ))
      .join('\n'),
  });
}

function mockWin32FallbackSpawn(input: {
  windows: Array<{
    windowId: number;
    pid: number;
    title: string;
    left: number;
    top: number;
    width: number;
    height: number;
    isVisible?: boolean;
    isIconic?: boolean;
    isOnScreen?: boolean;
  }>;
  processes: Array<{
    pid: number;
    name: string;
    executable?: string;
  }>;
}) {
  mockDriverSpawn({
    stdout: JSON.stringify({
      Windows: input.windows.map((windowInfo) => ({
        WindowId: windowInfo.windowId,
        ProcessId: windowInfo.pid,
        Title: windowInfo.title,
        Left: windowInfo.left,
        Top: windowInfo.top,
        Width: windowInfo.width,
        Height: windowInfo.height,
        IsVisible: windowInfo.isVisible ?? true,
        IsIconic: windowInfo.isIconic ?? false,
        IsOnScreen: windowInfo.isOnScreen ?? true,
      })),
      Processes: input.processes.map((processInfo) => ({
        ProcessId: processInfo.pid,
        Name: processInfo.name,
        ExecutablePath: processInfo.executable ?? null,
      })),
    }),
  });
}

function isWin32FallbackSpawnCall(call: unknown[]): boolean {
  return call[0] === 'powershell.exe' &&
    Array.isArray(call[1]) &&
    call[1].some((part) => typeof part === 'string' && part.includes('XdtWin32WindowSnapshot'));
}

function mockRawProcessSnapshotSpawn(stdout: string) {
  mockDriverSpawn({ stdout });
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function waitForCondition(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1_000) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

function driverSessionGeneration(session: string, base: string): number | null {
  const prefix = `${base}-cua-`;
  if (!session.startsWith(prefix)) return null;
  const rest = session.slice(prefix.length);
  const separatorIndex = rest.lastIndexOf('-');
  if (separatorIndex < 0) return null;
  const nonce = rest.slice(0, separatorIndex);
  const generation = Number(rest.slice(separatorIndex + 1));
  if (!/^[a-f0-9]{12}$/.test(nonce) || !Number.isInteger(generation)) return null;
  return generation;
}

function expectDriverSessionGenerations(sessions: string[], base: string, generations: number[]): void {
  expect(sessions.map((session) => driverSessionGeneration(session, base))).toEqual(generations);
  const nonces = new Set(sessions.map((session) => session.slice(`${base}-cua-`.length, session.lastIndexOf('-'))));
  expect(nonces.size).toBe(1);
}

function mockWorkspaceRootExists(workspaceRoot: string): void {
  const markers = new Set([
    path.win32.normalize(path.win32.join(workspaceRoot, '.git')).toLowerCase(),
    path.win32.normalize(path.win32.join(workspaceRoot, 'pnpm-workspace.yaml')).toLowerCase(),
  ]);
  existsSyncMock.mockImplementation((candidate) => (
    markers.has(path.win32.normalize(String(candidate)).toLowerCase())
  ));
}

describe('computer mcp integration', () => {
  beforeEach(async () => {
    setPlatform(originalPlatform);
    await cleanupAllComputerDriverSessions();
    resetComputerDriverPermissionProbeCacheForTests();
    resetAtMentionWindowCacheForTests();
    existsSyncMock.mockReset().mockReturnValue(false);
    spawnMock.mockReset();
    driverStdinWrites.length = 0;
    readlinkSyncMock.mockReset();
    mcpCallToolMock.mockReset();
    mcpCloseMock.mockReset().mockResolvedValue(undefined);
    mcpConnectMock.mockReset().mockResolvedValue(undefined);
    transportCloseMock.mockReset().mockResolvedValue(undefined);
    transportCtorMock.mockReset();
    for (const key of driverResolutionEnvKeys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of driverResolutionEnvKeys) {
      const value = originalDriverResolutionEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('reports installed when cua-driver --version succeeds', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.1.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    if (process.platform === 'darwin') {
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });
    }

    await expect(getComputerDriverStatus()).resolves.toMatchObject({
      installed: true,
      executablePath: expect.any(String),
      version: 'cua-driver 0.1.0',
      daemonRunning: true,
      installCommand: expect.stringContaining('cua-driver'),
      docsUrl: 'https://cua.ai/docs/cua-driver',
      permissionState: {
        platform: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        status: process.platform === 'darwin' ? 'granted' : 'not_required',
      },
    });
    expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'doctor')).toBe(false);
  });

  it('does not probe or autostart the permission daemon while waiting for the real app drag', async () => {
    setPlatform('darwin');
    await pauseComputerDriverPermissionProbe();
    mockDriverSpawn({ stdout: 'cua-driver 0.7.1\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });

    await expect(getComputerDriverStatus({
      forcePermissionProbe: true,
      freshPermissionProbe: true,
      bypassPermissionProbeCache: true,
    })).resolves.toMatchObject({
      installed: true,
      daemonRunning: true,
      permissionState: {
        platform: 'macos',
        status: 'missing',
        accessibility: 'missing',
        reason: 'Waiting for CuaDriver to be added in System Settings.',
      },
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(driverStdinWrites).toEqual([]);
  });

  it('runs cua-driver doctor only for explicit deep status checks', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.1.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({ stdout: '{"ok":true,"probes":[]}\n' });
    if (process.platform === 'darwin') {
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });
    }

    await expect(getComputerDriverStatus({ includeDoctor: true })).resolves.toMatchObject({
      installed: true,
      doctor: {
        ok: true,
        probes: [],
      },
    });
    expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['doctor', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  });

  it('reports not installed when the driver cannot be spawned', async () => {
    mockDriverSpawn({ error: new Error('ENOENT') });

    await expect(getComputerDriverStatus()).resolves.toMatchObject({
      installed: false,
      executablePath: null,
      version: null,
      daemonRunning: false,
      installCommand: expect.stringContaining('cua-driver'),
      docsUrl: 'https://cua.ai/docs/cua-driver',
      error: 'ENOENT',
    });
  });

  it('passes tool calls through a long-lived cua-driver MCP session and parses JSON output', async () => {
    const oldDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ':99';
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"window_id":7}' }],
    });

    try {
      await expect(callComputerDriverTool('list_windows', {
        on_screen_only: true,
        session: 'session-1',
      }, { sessionId: 'session-1' })).resolves.toEqual({
        ok: true,
        window_id: 7,
      });
    } finally {
      if (oldDisplay === undefined) {
        delete process.env.DISPLAY;
      } else {
        process.env.DISPLAY = oldDisplay;
      }
    }
    expect(transportCtorMock).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.stringContaining('cua-driver'),
      args: ['mcp'],
      env: expect.objectContaining({
        DISPLAY: ':99',
        PATH: expect.any(String),
      }),
      stderr: 'pipe',
    }));
    expect(mcpConnectMock).toHaveBeenCalledTimes(1);
    const payload = mcpCallToolMock.mock.calls[0]?.[0]?.arguments as {
      on_screen_only?: boolean;
      session: string;
    };
    expect(payload.on_screen_only).toBe(true);
    expectDriverSessionGenerations([payload.session], 'session-1', [0]);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('prefers structured MCP content over human-readable text summaries', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '✅ Listed 2 windows' }],
      structuredContent: {
        ok: true,
        windows: [
          { window_id: 7, title: 'XDMaker' },
          { window_id: 8, title: 'Terminal' },
        ],
      },
    });

    await expect(callComputerDriverTool('list_windows', {
      on_screen_only: true,
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual({
      ok: true,
      windows: [
        { window_id: 7, title: 'XDMaker' },
        { window_id: 8, title: 'Terminal' },
      ],
    });
  });

  it('does not invoke Win32 fallback when Cua list_windows succeeds on Windows', async () => {
    setPlatform('win32');
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"XDMaker"}]}' }],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        name: 'Electron',
        command: 'C:\\Tools\\electron.exe D:\\xdt-maker',
        executable: 'C:\\Tools\\electron.exe',
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'electron',
      session: 'session-windows-cua-success',
    }, { sessionId: 'session-windows-cua-success' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          window_id: 7,
          pid: 123,
          process: {
            name: 'Electron',
          },
        },
      ],
    });

    expect(spawnMock.mock.calls.some(isWin32FallbackSpawnCall)).toBe(false);
  });

  it('does not use the reserved PowerShell $PID variable in the Win32 fallback script', async () => {
    setPlatform('win32');
    mcpCallToolMock.mockRejectedValueOnce(new Error('cua-driver mcp tool list_windows timed out after 45000ms'));
    mockWin32FallbackSpawn({ windows: [], processes: [] });

    await expect(callComputerDriverTool('list_windows', {}, { sessionId: 'session-win32-script-static' })).resolves.toMatchObject({
      ok: true,
      windows: [],
    });

    const scriptArgs = spawnMock.mock.calls.find(isWin32FallbackSpawnCall)?.[1] as unknown[] | undefined;
    const script = scriptArgs
      ?.find((part): part is string => typeof part === 'string' && part.includes('XdtWin32WindowSnapshot'));
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)');
    expect(script).toContain('$procId');
    expect(script).not.toMatch(/\$pid\b/i);
  });

  it('enriches list_windows with generic process identity without forwarding local filters', async () => {
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"XDMaker"},{"pid":456,"window_id":8,"app_name":"Terminal","title":"zsh"}]}' }],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        parentPid: 42,
        name: 'Electron',
        command: `/Applications/Electron.app/Contents/MacOS/Electron ${workspaceRoot} --inspect`,
        executable: '/Applications/Electron.app/Contents/MacOS/Electron',
      },
      {
        pid: 456,
        parentPid: 1,
        name: 'Terminal',
        command: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
        executable: '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal',
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      on_screen_only: true,
      query: 'xdmaker',
      workspace_root: workspaceRoot,
      process_name: 'electron',
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 123,
          window_id: 7,
          process: {
            pid: 123,
            parent_pid: 42,
            name: 'Electron',
            command: expect.stringContaining(workspaceRoot),
          },
          identity: {
            kind: 'electron-dev',
            confidence: 0.75,
            labels: expect.arrayContaining(['electron']),
          },
        },
      ],
    });

    const payload = mcpCallToolMock.mock.calls[0]?.[0]?.arguments as Record<string, unknown>;
    expect(payload.on_screen_only).toBe(true);
    expect(payload.query).toBeUndefined();
    expect(payload.workspace_root).toBeUndefined();
    expect(payload.process_name).toBeUndefined();
  });

  it('filters list_windows locally by process name', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"App"},{"pid":456,"window_id":8,"app_name":"Safari","title":"Docs"}]}' }],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        name: 'Electron',
        command: '/Applications/Electron.app/Contents/MacOS/Electron',
      },
      {
        pid: 456,
        name: 'Safari',
        command: '/Applications/Safari.app/Contents/MacOS/Safari',
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'safari',
      session: 'session-filter',
    }, { sessionId: 'session-filter' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 456,
          window_id: 8,
          process: {
            name: 'Safari',
          },
        },
      ],
    });
  });

  it('keeps macOS app paths with spaces intact when enriching windows', async () => {
    if (process.platform === 'win32') return;

    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":789,"window_id":9,"app_name":"Google Chrome","title":"Docs"}]}' }],
    });
    mockRawProcessSnapshotSpawn(
      '789 1 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer\n',
    );

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'chrome',
      session: 'session-spaced-app',
    }, { sessionId: 'session-spaced-app' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 789,
          process: {
            name: 'Google Chrome',
            command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer',
            executable: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          },
          identity: {
            kind: 'browser',
          },
        },
      ],
    });
  });

  it('keeps list_windows usable when process enrichment is unavailable', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"XDMaker"}]}' }],
    });
    mockDriverSpawn({ error: new Error('ps unavailable') });

    await expect(callComputerDriverTool('list_windows', {
      query: 'xdmaker',
      session: 'session-no-processes',
    }, { sessionId: 'session-no-processes' })).resolves.toEqual({
      ok: true,
      windows: [
        {
          pid: 123,
          window_id: 7,
          app_name: 'Electron',
          title: 'XDMaker',
          process: { pid: 123 },
        },
      ],
    });
  });

  it('marks process-backed list_windows filters unavailable when enrichment fails', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"XDMaker"}]}' }],
    });
    mockDriverSpawn({ error: new Error('ps unavailable') });

    await expect(callComputerDriverTool('list_windows', {
      workspace_root: '/repo',
      process_name: 'electron',
      session: 'session-no-process-filter',
    }, { sessionId: 'session-no-process-filter' })).resolves.toEqual({
      ok: true,
      enrichment: 'unavailable',
      windows: [],
    });
  });

  it('marks process-backed list_windows filters unavailable when process snapshot exits non-zero', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"XDMaker"}]}' }],
    });
    mockDriverSpawn({ stderr: 'ps permission denied', exitCode: 1 });

    await expect(callComputerDriverTool('list_windows', {
      workspace_root: '/repo',
      session: 'session-process-exit-failure',
    }, { sessionId: 'session-process-exit-failure' })).resolves.toEqual({
      ok: true,
      enrichment: 'unavailable',
      windows: [],
    });
  });

  it('bypasses cached process snapshots for process-backed list_windows filters', async () => {
    const workspaceRoot = path.join(process.cwd(), 'fixtures', 'fresh-app');
    mcpCallToolMock
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":111,"window_id":1,"app_name":"Electron","title":"Old"}]}' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":222,"window_id":2,"app_name":"Electron","title":"Fresh"}]}' }],
      });
    mockProcessSnapshotSpawn([
      {
        pid: 111,
        name: 'Electron',
        command: '/Applications/Electron.app/Contents/MacOS/Electron /tmp/old-app',
      },
    ]);
    mockProcessSnapshotSpawn([
      {
        pid: 222,
        name: 'Electron',
        command: `/Applications/Electron.app/Contents/MacOS/Electron ${workspaceRoot}`,
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      query: 'old',
      session: 'session-process-cache',
    }, { sessionId: 'session-process-cache' })).resolves.toMatchObject({
      ok: true,
      windows: [{ pid: 111 }],
    });
    await expect(callComputerDriverTool('list_windows', {
      workspace_root: workspaceRoot,
      session: 'session-process-cache',
    }, { sessionId: 'session-process-cache' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 222,
          title: 'Fresh',
        },
      ],
    });
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('marks process-backed list_windows filters unavailable when Windows process JSON is invalid', async () => {
    setPlatform('win32');
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"XDMaker"}]}' }],
    });
    mockDriverSpawn({ stdout: '{not-json', exitCode: 0 });

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'electron',
      session: 'session-windows-invalid-json',
    }, { sessionId: 'session-windows-invalid-json' })).resolves.toEqual({
      ok: true,
      enrichment: 'unavailable',
      windows: [],
    });
    expect(spawnMock.mock.calls.at(-1)?.[0]).toBe('powershell.exe');
  });

  it('keeps workspace_root matching case-sensitive outside Windows', async () => {
    if (originalPlatform === 'win32') return;

    setPlatform('linux');
    const workspaceRoot = '/workspace/XDMaker';
    const lowerCaseRoot = '/workspace/xdmaker';
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"Upper"},{"pid":456,"window_id":8,"app_name":"Electron","title":"Lower"}]}' }],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        name: 'Electron',
        command: `/usr/bin/electron ${workspaceRoot}`,
      },
      {
        pid: 456,
        name: 'Electron',
        command: `/usr/bin/electron ${lowerCaseRoot}`,
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      workspace_root: workspaceRoot,
      session: 'session-case-sensitive-workspace',
    }, { sessionId: 'session-case-sensitive-workspace' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 123,
          title: 'Upper',
        },
      ],
    });
  });

  it('reads Linux process cwd only for returned window pids', async () => {
    setPlatform('linux');
    readlinkSyncMock.mockImplementation((target: string) => {
      if (target === '/proc/222/cwd') return '/workspace/fresh-app';
      throw new Error(`unexpected readlink ${target}`);
    });
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":222,"window_id":2,"app_name":"Electron","title":"Fresh"}]}' }],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 111,
        name: 'Electron',
        command: '/usr/bin/electron /tmp/old-app',
      },
      {
        pid: 222,
        name: 'Electron',
        command: '/usr/bin/electron',
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      workspace_root: '/workspace/fresh-app',
      session: 'session-linux-lazy-cwd',
    }, { sessionId: 'session-linux-lazy-cwd' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 222,
          process: {
            cwd: '/workspace/fresh-app',
          },
        },
      ],
    });
    expect(readlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(readlinkSyncMock).toHaveBeenCalledWith('/proc/222/cwd');
  });

  it('matches workspace_root on path boundaries instead of raw prefixes', async () => {
    const workspaceRoot = path.join(process.cwd(), 'fixtures', 'XDMaker');
    const siblingRoot = `${workspaceRoot}-old`;
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[{"pid":123,"window_id":7,"app_name":"Electron","title":"Target"},{"pid":456,"window_id":8,"app_name":"Electron","title":"Sibling"}]}' }],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        name: 'Electron',
        command: `/Applications/Electron.app/Contents/MacOS/Electron ${workspaceRoot}`,
      },
      {
        pid: 456,
        name: 'Electron',
        command: `/Applications/Electron.app/Contents/MacOS/Electron ${siblingRoot}`,
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      workspace_root: workspaceRoot,
      session: 'session-workspace-boundary',
    }, { sessionId: 'session-workspace-boundary' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          pid: 123,
          window_id: 7,
          title: 'Target',
        },
      ],
    });
  });

  it('preserves non-text MCP content when no structured payload is available', async () => {
    const mcpResult = {
      content: [
        { type: 'text', text: '✅ Captured screenshot' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      ],
    };
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce(mcpResult);

    await expect(callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual(mcpResult);
  });

  it('requires a host session before dispatching computer-use tool calls', async () => {
    await expect(callComputerDriverTool('list_windows', {})).rejects.toThrow(
      `Computer Use tool calls require an active ${BRAND_NAME} session`,
    );

    expect(mcpConnectMock).not.toHaveBeenCalled();
    expect(mcpCallToolMock).not.toHaveBeenCalled();
  });

  it('writes get_window_state screenshots to a temp file by default', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"screenshot_file_path":"/tmp/xdt-maker-cua/window.png"}' }],
      });

    await expect(callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual({
      ok: true,
      screenshot_file_path: '/tmp/xdt-maker-cua/window.png',
    });

    const payload = mcpCallToolMock.mock.calls[2]?.[0]?.arguments as {
      screenshot_out_file?: string;
    };
    expect(payload.screenshot_out_file).toMatch(/xdt-maker-cua[/\\]get_window_state-7-/);
  });

  it('preserves explicit get_window_state screenshot output paths', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"screenshot_file_path":"/tmp/custom.png"}' }],
      });

    await callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      screenshot_out_file: '/tmp/custom.png',
      session: 'session-1',
    }, { sessionId: 'session-1' });

    const payload = mcpCallToolMock.mock.calls[2]?.[0]?.arguments as {
      pid?: number;
      window_id?: number;
      capture_mode?: string;
      screenshot_out_file?: string;
      session: string;
    };
    expect(payload).toMatchObject({
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      screenshot_out_file: '/tmp/custom.png',
    });
    expectDriverSessionGenerations([payload.session], 'session-1', [0]);
  });

  it('does not add screenshot output paths for ax-only window state reads', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"tree_markdown":"button"}' }],
      });

    await callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'ax',
      session: 'session-1',
    }, { sessionId: 'session-1' });

    const payload = mcpCallToolMock.mock.calls[2]?.[0]?.arguments as {
      pid?: number;
      window_id?: number;
      capture_mode?: string;
      session: string;
    };
    expect(payload).toMatchObject({
      pid: 123,
      window_id: 7,
      capture_mode: 'ax',
    });
    expectDriverSessionGenerations([payload.session], 'session-1', [0]);
  });

  it('styles the TapTap cursor once per long-lived MCP session before actions', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"clicked":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"clicked":true}' }] });

    await expect(callComputerDriverTool('click', {
      pid: 123,
      window_id: 7,
      x: 10,
      y: 20,
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual({ ok: true, clicked: true });
    await expect(callComputerDriverTool('click', {
      pid: 123,
      window_id: 7,
      x: 11,
      y: 21,
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual({ ok: true, clicked: true });

    const toolCalls = mcpCallToolMock.mock.calls.map((call) => call[0]?.name);
    expect(toolCalls).toEqual([
      'set_agent_cursor_motion',
      'set_agent_cursor_style',
      'click',
      'click',
    ]);
    expect(mcpConnectMock).toHaveBeenCalledTimes(1);
  });

  it('retries TapTap cursor styling after a transient styling failure', async () => {
    mcpCallToolMock
      .mockRejectedValueOnce(new Error('motion unavailable'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"clicked":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"clicked":true}' }] });

    await expect(callComputerDriverTool('click', {
      pid: 123,
      window_id: 7,
      x: 10,
      y: 20,
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual({ ok: true, clicked: true });
    await expect(callComputerDriverTool('click', {
      pid: 123,
      window_id: 7,
      x: 11,
      y: 21,
      session: 'session-1',
    }, { sessionId: 'session-1' })).resolves.toEqual({ ok: true, clicked: true });

    const toolCalls = mcpCallToolMock.mock.calls.map((call) => call[0]?.name);
    expect(toolCalls).toEqual([
      'set_agent_cursor_motion',
      'set_agent_cursor_style',
      'click',
      'set_agent_cursor_motion',
      'set_agent_cursor_style',
      'click',
    ]);
  });

  it('throws the driver stderr when a tool call exits non-zero', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      isError: true,
      content: [{ type: 'text', text: 'permission denied' }],
    });

    await expect(callComputerDriverTool('list_windows', { session: 'session-1' }, { sessionId: 'session-1' })).rejects.toThrow(
      'permission denied',
    );
  });

  it('cleans up a broken CUA MCP client after transport failures so the session can recover', async () => {
    mcpCallToolMock
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":7}]}' }] });

    await expect(callComputerDriverTool('list_windows', { session: 'session-recover' }, { sessionId: 'session-recover' })).rejects.toThrow(
      'transport closed',
    );
    await expect(callComputerDriverTool('list_windows', { session: 'session-recover' }, { sessionId: 'session-recover' })).resolves.toEqual({
      ok: true,
      windows: [{ window_id: 7 }],
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
  });

  it('chunks long type_text calls before sending them to cua-driver', async () => {
    const longText = 'a'.repeat(850);
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":400}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":400}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":50}' }] });

    await expect(callComputerDriverTool('type_text', {
      pid: 123,
      window_id: 7,
      text: longText,
      session: 'caller-supplied',
    }, { sessionId: 'session-long-text' })).resolves.toEqual({
      ok: true,
      inserted: 850,
      chunks: 3,
      chars: 850,
      lastResult: { ok: true, inserted: 50 },
    });

    const typeCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'type_text');
    expect(typeCalls).toHaveLength(3);
    expect(typeCalls.map((call) => (call?.arguments as { text: string }).text.length)).toEqual([400, 400, 50]);
    expectDriverSessionGenerations(
      typeCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-long-text',
      [0, 0, 0],
    );
  });

  it('preserves a failed type_text chunk result without forcing aggregate success', async () => {
    const longText = 'a'.repeat(850);
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":400}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":false,"error":"focused element rejected input","inserted":12}' }] });

    await expect(callComputerDriverTool('type_text', {
      pid: 123,
      window_id: 7,
      text: longText,
      session: 'caller-supplied',
    }, { sessionId: 'session-long-text-failure' })).resolves.toEqual({
      ok: false,
      error: 'focused element rejected input',
      inserted: 412,
      chunks: 2,
      chars: 412,
      lastResult: { ok: false, error: 'focused element rejected input', inserted: 12 },
    });

    const typeCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'type_text');
    expect(typeCalls).toHaveLength(2);
    expect(typeCalls.map((call) => (call?.arguments as { text: string }).text.length)).toEqual([400, 400]);
  });

  it('retries only the remaining type_text chunks after a stale driver session', async () => {
    const longText = 'a'.repeat(850);
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":400}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":400}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":50}' }] });

    await expect(callComputerDriverTool('type_text', {
      pid: 123,
      window_id: 7,
      text: longText,
      session: 'caller-supplied',
    }, { sessionId: 'session-type-retry' })).resolves.toEqual({
      ok: true,
      inserted: 850,
      chunks: 3,
      chars: 850,
      lastResult: { ok: true, inserted: 50 },
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
    const typeCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'type_text');
    expect(typeCalls.map((call) => (call?.arguments as { text: string }).text.length)).toEqual([400, 400, 400, 50]);
    expectDriverSessionGenerations(
      typeCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-type-retry',
      [0, 0, 1, 1],
    );
  });

  it('does not count failed retry type_text chunks as inserted', async () => {
    const longText = 'a'.repeat(850);
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"inserted":400}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":false,"error":"focused element rejected input"}' }] });

    await expect(callComputerDriverTool('type_text', {
      pid: 123,
      window_id: 7,
      text: longText,
      session: 'caller-supplied',
    }, { sessionId: 'session-type-retry-failure' })).resolves.toEqual({
      ok: false,
      error: 'focused element rejected input',
      inserted: 400,
      chunks: 2,
      chars: 400,
      lastResult: { ok: false, error: 'focused element rejected input' },
    });

    const typeCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'type_text');
    expect(typeCalls.map((call) => (call?.arguments as { text: string }).text.length)).toEqual([400, 400, 400]);
    expectDriverSessionGenerations(
      typeCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-type-retry-failure',
      [0, 0, 1],
    );
  });

  it('rotates the driver session and retries once when cua-driver reports session ended', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"screenshot_file_path":"/tmp/recovered.png"}' }] });

    await expect(callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'caller-supplied',
    }, { sessionId: 'session-stale' })).resolves.toEqual({
      ok: true,
      screenshot_file_path: '/tmp/recovered.png',
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
    const stateCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'get_window_state');
    expectDriverSessionGenerations(
      stateCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-stale',
      [0, 1],
    );
  });

  it('rotates the driver session and retries once when cua-driver reports not connected', async () => {
    mcpCallToolMock
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":9}]}' }] });

    await expect(callComputerDriverTool('list_windows', {
      session: 'caller-supplied',
    }, { sessionId: 'session-not-connected' })).resolves.toEqual({
      ok: true,
      windows: [{ window_id: 9 }],
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
    const listCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'list_windows');
    expectDriverSessionGenerations(
      listCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-not-connected',
      [0, 1],
    );
  });

  it('rotates the driver session and retries once when cua-driver returns Not connected as an error result', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'Not connected' }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":9}]}' }] });

    await expect(callComputerDriverTool('list_windows', {
      session: 'caller-supplied',
    }, { sessionId: 'session-not-connected-error' })).resolves.toEqual({
      ok: true,
      windows: [{ window_id: 9 }],
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
    const listCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'list_windows');
    expectDriverSessionGenerations(
      listCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-not-connected-error',
      [0, 1],
    );
  });

  it('falls back to one-shot CLI when cua-driver returns Not connected as plain text on a basic state tool', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Not connected' }] });
    mockDriverSpawn({ stdout: '{"ok":true,"width":1920,"height":1080}\n' });

    await expect(callComputerDriverTool('get_screen_size', {}, { sessionId: 'session-not-connected-plain' })).resolves.toEqual({
      ok: true,
      width: 1920,
      height: 1080,
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['call', 'get_screen_size'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(driverStdinWrites).toEqual(['{}\n']);
    const screenCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'get_screen_size');
    expect(screenCalls).toHaveLength(1);
    expect(screenCalls.every((call) => (call?.arguments as Record<string, unknown>).session === undefined)).toBe(true);
  });

  it('falls back to one-shot CLI for basic state tools after a cua-driver MCP timeout', async () => {
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock.mockReturnValueOnce(timedOutCall.promise);
      mockDriverSpawn({ stdout: '{"ok":true,"width":1920,"height":1080}\n' });

      const call = callComputerDriverTool('get_screen_size', {}, { sessionId: 'session-light-timeout' });
      const assertion = expect(call).resolves.toEqual({
        ok: true,
        width: 1920,
        height: 1080,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(mcpConnectMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['call', 'get_screen_size'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      expect(driverStdinWrites).toEqual(['{}\n']);
      const screenCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'get_screen_size');
      expect(screenCalls).toHaveLength(1);
      expect(screenCalls.every((mockCall) => (mockCall?.arguments as Record<string, unknown>).session === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores stdin stream errors while the one-shot CLI fallback process resolves normally', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Not connected' }] });
    mockDriverSpawn({
      stdout: '{"ok":true,"width":1280,"height":720}\n',
      stdinError: new Error('stdin closed'),
    });

    await expect(callComputerDriverTool('get_screen_size', {}, { sessionId: 'session-cli-stdin-error' })).resolves.toEqual({
      ok: true,
      width: 1280,
      height: 720,
    });

    expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['call', 'get_screen_size'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(driverStdinWrites).toEqual(['{}\n']);
  });

  it('falls back to one-shot CLI for get_cursor_position after a cua-driver MCP timeout', async () => {
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock.mockReturnValueOnce(timedOutCall.promise);
      mockDriverSpawn({ stdout: '{"ok":true,"x":120,"y":240}\n' });

      const call = callComputerDriverTool('get_cursor_position', {}, { sessionId: 'session-cursor-position-timeout' });
      const assertion = expect(call).resolves.toEqual({
        ok: true,
        x: 120,
        y: 240,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(mcpConnectMock).toHaveBeenCalledTimes(1);
      expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['call', 'get_cursor_position'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      expect(driverStdinWrites).toEqual(['{}\n']);
      const cursorCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'get_cursor_position');
      expect(cursorCalls).toHaveLength(1);
      expect(cursorCalls.every((mockCall) => (mockCall?.arguments as Record<string, unknown>).session === undefined)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to one-shot CLI when get_screen_size returns Not connected as an error result', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: 'Not connected' }],
      });
    mockDriverSpawn({ stdout: '{"ok":true,"width":2560,"height":1440}\n' });

    await expect(callComputerDriverTool('get_screen_size', {}, { sessionId: 'session-screen-error-result' })).resolves.toEqual({
      ok: true,
      width: 2560,
      height: 1440,
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(expect.stringContaining('cua-driver'), ['call', 'get_screen_size'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(driverStdinWrites).toEqual(['{}\n']);
    const screenCalls = mcpCallToolMock.mock.calls
      .map((mockCall) => mockCall[0])
      .filter((mockCall) => mockCall?.name === 'get_screen_size');
    expect(screenCalls).toHaveLength(1);
  });

  it('returns degraded Win32 list_windows data when Windows Cua list_windows times out', async () => {
    setPlatform('win32');
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock.mockReturnValueOnce(timedOutCall.promise);
      mockWin32FallbackSpawn({
        windows: [
          {
            windowId: 7,
            pid: 123,
            title: 'XDMaker',
            left: 10,
            top: 20,
            width: 800,
            height: 600,
          },
        ],
        processes: [
          {
            pid: 123,
            name: 'electron',
            executable: 'C:\\Tools\\electron.exe',
          },
        ],
      });

      const call = callComputerDriverTool('list_windows', {}, { sessionId: 'session-win32-list-timeout' });
      const assertion = expect(call).resolves.toMatchObject({
        ok: true,
        source: 'xdmaker_win32_fallback',
        degraded: true,
        accessibility_unavailable: true,
        windows: [
          {
            window_id: 7,
            hwnd: 7,
            pid: 123,
            app_name: 'electron',
            title: 'XDMaker',
            bounds: {
              x: 10,
              y: 20,
              width: 800,
              height: 600,
            },
            is_on_screen: true,
            source: 'xdmaker_win32_fallback',
            accessibility_unavailable: true,
            process: {
              pid: 123,
              name: 'electron',
              executable: 'C:\\Tools\\electron.exe',
            },
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;

      expect(mcpConnectMock).toHaveBeenCalledTimes(1);
      expect(mcpCloseMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
      const fallbackResult = await call as { windows: Array<Record<string, unknown>> };
      const fallbackWindow = fallbackResult.windows[0];
      expect(fallbackWindow).not.toHaveProperty('element_index');
      const listCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'list_windows');
      expect(listCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke Win32 fallback for stale, transport, permission, or non-timeout list_windows failures on Windows', async () => {
    setPlatform('win32');
    const scenarios = [
      {
        sessionId: 'session-win32-no-fallback-stale',
        first: { content: [{ type: 'text', text: 'Not connected' }] },
        followups: [
          { content: [{ type: 'text', text: '{"ok":true}' }] },
          { content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }] },
        ],
        expected: 'resolve',
      },
      {
        sessionId: 'session-win32-no-fallback-transport',
        firstError: new Error('transport closed'),
        followups: [
          { content: [{ type: 'text', text: '{"ok":true}' }] },
          { content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }] },
        ],
        expected: 'reject',
        message: 'transport closed',
      },
      {
        sessionId: 'session-win32-no-fallback-permission',
        first: {
          isError: true,
          content: [{ type: 'text', text: 'permission denied' }],
        },
        expected: 'reject',
        message: 'permission denied',
      },
      {
        sessionId: 'session-win32-no-fallback-invalid-args',
        first: {
          isError: true,
          content: [{ type: 'text', text: 'invalid argument: pid is required' }],
        },
        expected: 'reject',
        message: 'invalid argument: pid is required',
      },
    ];

    for (const scenario of scenarios) {
      spawnMock.mockClear();
      mcpCallToolMock.mockReset();
      mcpCloseMock.mockClear();
      mcpConnectMock.mockClear();
      await cleanupComputerDriverSession(scenario.sessionId);

      if (scenario.firstError) {
        mcpCallToolMock.mockRejectedValueOnce(scenario.firstError);
      } else {
        mcpCallToolMock.mockResolvedValueOnce(scenario.first);
      }
      for (const followup of scenario.followups ?? []) {
        mcpCallToolMock.mockResolvedValueOnce(followup);
      }

      const call = callComputerDriverTool('list_windows', {}, { sessionId: scenario.sessionId });
      if (scenario.expected === 'resolve') {
        await expect(call).resolves.toMatchObject({ ok: true });
      } else {
        await expect(call).rejects.toThrow(scenario.message);
      }
      expect(spawnMock.mock.calls.some(isWin32FallbackSpawnCall)).toBe(false);
    }
  });

  it('does not invoke Win32 fallback when non-Windows Cua list_windows times out', async () => {
    setPlatform('linux');
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock.mockReturnValueOnce(timedOutCall.promise);

      const call = callComputerDriverTool('list_windows', {}, { sessionId: 'session-linux-list-timeout' });
      const assertion = expect(call).rejects.toThrow('cua-driver mcp tool list_windows timed out after 45000ms');
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;

      expect(mcpConnectMock).toHaveBeenCalledTimes(1);
      expect(mcpCloseMock).toHaveBeenCalledTimes(1);
      expect(spawnMock.mock.calls.some(isWin32FallbackSpawnCall)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies process name, query, on-screen, and workspace filters to Win32 list_windows fallback', async () => {
    setPlatform('win32');
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    const electronExecutable = path.join(workspaceRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    mockWorkspaceRootExists(workspaceRoot);
    mcpCallToolMock.mockRejectedValueOnce(new Error('cua-driver mcp tool list_windows timed out after 45000ms'));
    mockWin32FallbackSpawn({
      windows: [
        {
          windowId: 7,
          pid: 123,
          title: 'XDMaker Console',
          left: 10,
          top: 20,
          width: 800,
          height: 600,
          isOnScreen: true,
        },
        {
          windowId: 8,
          pid: 456,
          title: 'Hidden XDMaker',
          left: 0,
          top: 0,
          width: 800,
          height: 600,
          isOnScreen: false,
        },
        {
          windowId: 9,
          pid: 789,
          title: 'Browser Docs',
          left: 30,
          top: 40,
          width: 800,
          height: 600,
          isOnScreen: true,
        },
      ],
      processes: [
        {
          pid: 123,
          name: 'electron',
          executable: electronExecutable,
        },
        {
          pid: 456,
          name: 'electron',
          executable: electronExecutable,
        },
        {
          pid: 789,
          name: 'chrome',
          executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        },
      ],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        name: 'electron',
        command: `"${electronExecutable}" ${workspaceRoot}`,
        executable: electronExecutable,
      },
      {
        pid: 456,
        name: 'electron',
        command: `"${electronExecutable}" ${workspaceRoot}`,
        executable: electronExecutable,
      },
      {
        pid: 789,
        name: 'chrome',
        command: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        executable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'electron',
      query: 'console',
      on_screen_only: true,
      workspace_root: workspaceRoot,
    }, { sessionId: 'session-win32-fallback-filter' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          window_id: 7,
          pid: 123,
          title: 'XDMaker Console',
          source: 'xdmaker_win32_fallback',
          accessibility_unavailable: true,
          identity: {
            workspace_root: path.win32.normalize(workspaceRoot),
          },
        },
      ],
    });
    expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'powershell.exe')).toHaveLength(2);
  });

  it('keeps Win32 list_windows fallback process metadata when the workspace process snapshot fails', async () => {
    setPlatform('win32');
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    const electronExecutable = path.join(workspaceRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    mockWorkspaceRootExists(workspaceRoot);
    mcpCallToolMock.mockRejectedValueOnce(new Error('cua-driver mcp tool list_windows timed out after 45000ms'));
    mockWin32FallbackSpawn({
      windows: [
        {
          windowId: 7,
          pid: 123,
          title: 'XDMaker Console',
          left: 10,
          top: 20,
          width: 800,
          height: 600,
          isOnScreen: true,
        },
      ],
      processes: [
        {
          pid: 123,
          name: 'electron',
          executable: electronExecutable,
        },
      ],
    });
    mockDriverSpawn({ stderr: 'Get-CimInstance failed', exitCode: 1 });

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'electron',
      workspace_root: workspaceRoot,
    }, { sessionId: 'session-win32-fallback-cim-fails' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          window_id: 7,
          pid: 123,
          title: 'XDMaker Console',
          process: {
            pid: 123,
            name: 'electron',
            executable: electronExecutable,
          },
          identity: {
            workspace_root: path.win32.normalize(workspaceRoot),
          },
        },
      ],
    });
    expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'powershell.exe')).toHaveLength(2);
  });

  it('keeps Win32 list_windows fallback process fields when the workspace process snapshot is partial', async () => {
    setPlatform('win32');
    const workspaceRoot = path.resolve(process.cwd(), '../..');
    const electronExecutable = path.join(workspaceRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
    mockWorkspaceRootExists(workspaceRoot);
    mcpCallToolMock.mockRejectedValueOnce(new Error('cua-driver mcp tool list_windows timed out after 45000ms'));
    mockWin32FallbackSpawn({
      windows: [
        {
          windowId: 7,
          pid: 123,
          title: 'XDMaker Console',
          left: 10,
          top: 20,
          width: 800,
          height: 600,
          isOnScreen: true,
        },
      ],
      processes: [
        {
          pid: 123,
          name: 'electron',
          executable: electronExecutable,
        },
      ],
    });
    mockProcessSnapshotSpawn([
      {
        pid: 123,
        name: 'electron',
        command: 'electron.exe --inspect',
      },
    ]);

    await expect(callComputerDriverTool('list_windows', {
      process_name: 'electron',
      workspace_root: workspaceRoot,
    }, { sessionId: 'session-win32-fallback-cim-partial' })).resolves.toMatchObject({
      ok: true,
      windows: [
        {
          window_id: 7,
          pid: 123,
          title: 'XDMaker Console',
          process: {
            pid: 123,
            name: 'electron',
            command: 'electron.exe --inspect',
            executable: electronExecutable,
          },
          identity: {
            workspace_root: path.win32.normalize(workspaceRoot),
          },
        },
      ],
    });
    expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'powershell.exe')).toHaveLength(2);
  });

  it('returns the original list_windows failure when Win32 fallback fails', async () => {
    setPlatform('win32');
    mcpCallToolMock.mockRejectedValueOnce(new Error('cua-driver mcp tool list_windows timed out after 45000ms'));
    mockDriverSpawn({ stderr: 'Add-Type failed', exitCode: 1 });

    await expect(callComputerDriverTool('list_windows', {}, { sessionId: 'session-win32-fallback-fails' })).rejects.toThrow(
      'cua-driver mcp tool list_windows timed out after 45000ms',
    );
    expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
  });

  it('does not hang when Win32 list_windows fallback times out', async () => {
    setPlatform('win32');
    vi.useFakeTimers();
    try {
      mcpCallToolMock.mockRejectedValueOnce(new Error('cua-driver mcp tool list_windows timed out after 45000ms'));
      mockNeverSettlingSpawn();

      const call = callComputerDriverTool('list_windows', {}, { sessionId: 'session-win32-fallback-timeout' });
      const assertion = expect(call).rejects.toThrow('cua-driver mcp tool list_windows timed out after 45000ms');
      await vi.advanceTimersByTimeAsync(4_000);
      await assertion;
      expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not invoke Win32 fallback when Cua list_apps succeeds on Windows', async () => {
    setPlatform('win32');
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"apps":[{"name":"XDMaker","pid":123}]}' }],
    });

    await expect(callComputerDriverTool('list_apps', {}, { sessionId: 'session-windows-apps-success' })).resolves.toEqual({
      ok: true,
      apps: [
        {
          name: 'XDMaker',
          pid: 123,
        },
      ],
    });
    expect(spawnMock.mock.calls.some(isWin32FallbackSpawnCall)).toBe(false);
  });

  it('returns degraded running-app data when Windows Cua list_apps times out', async () => {
    setPlatform('win32');
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock.mockReturnValueOnce(timedOutCall.promise);
      mockWin32FallbackSpawn({
        windows: [
          {
            windowId: 7,
            pid: 123,
            title: 'XDMaker',
            left: 10,
            top: 20,
            width: 800,
            height: 600,
          },
          {
            windowId: 8,
            pid: 123,
            title: 'XDMaker Settings',
            left: 40,
            top: 50,
            width: 500,
            height: 400,
          },
        ],
        processes: [
          {
            pid: 123,
            name: 'xdt-maker',
            executable: 'E:\\xdt-maker\\xdt-maker.exe',
          },
        ],
      });

      const call = callComputerDriverTool('list_apps', {}, { sessionId: 'session-win32-apps-timeout' });
      const assertion = expect(call).resolves.toMatchObject({
        ok: true,
        source: 'xdmaker_win32_fallback',
        degraded: true,
        running_apps_only: true,
        installed_app_metadata_unavailable: true,
        accessibility_unavailable: true,
        apps: [
          {
            pid: 123,
            name: 'xdt-maker',
            app_name: 'xdt-maker',
            executable: 'E:\\xdt-maker\\xdt-maker.exe',
            is_running: true,
            running_windows_only: true,
            installed_app_metadata_unavailable: true,
            source: 'xdmaker_win32_fallback',
            accessibility_unavailable: true,
            window_count: 2,
            windows: [
              {
                window_id: 7,
                title: 'XDMaker',
                source: 'xdmaker_win32_fallback',
                accessibility_unavailable: true,
              },
              {
                window_id: 8,
                title: 'XDMaker Settings',
                source: 'xdmaker_win32_fallback',
                accessibility_unavailable: true,
              },
            ],
          },
        ],
      });
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
      expect(spawnMock.mock.calls.filter(isWin32FallbackSpawnCall)).toHaveLength(1);
      const appCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'list_apps');
      expect(appCalls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries lightweight non-CLI tools once after a cua-driver MCP timeout', async () => {
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock
        .mockReturnValueOnce(timedOutCall.promise)
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"enabled":true}' }] });

      const call = callComputerDriverTool('get_agent_cursor_state', {}, { sessionId: 'session-light-mcp-timeout' });
      const assertion = expect(call).resolves.toEqual({
        ok: true,
        enabled: true,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(mcpConnectMock).toHaveBeenCalledTimes(2);
      expect(mcpCloseMock).toHaveBeenCalledTimes(1);
      const cursorCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'get_agent_cursor_state');
      expect(cursorCalls).toHaveLength(2);
      expectDriverSessionGenerations(
        cursorCalls.map((mockCall) => (mockCall?.arguments as { cursor_id: string }).cursor_id),
        'session-light-mcp-timeout',
        [0, 1],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries move_cursor once after a cua-driver MCP timeout and reapplies cursor style', async () => {
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
        .mockReturnValueOnce(timedOutCall.promise)
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"moved":true}' }] });

      const call = callComputerDriverTool('move_cursor', { x: 10, y: 20 }, { sessionId: 'session-move-timeout' });
      const assertion = expect(call).resolves.toEqual({
        ok: true,
        moved: true,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await assertion;

      expect(mcpConnectMock).toHaveBeenCalledTimes(2);
      expect(mcpCloseMock).toHaveBeenCalledTimes(1);
      const motionCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'set_agent_cursor_motion');
      const styleCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'set_agent_cursor_style');
      const moveCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'move_cursor');
      expect(motionCalls).toHaveLength(2);
      expect(styleCalls).toHaveLength(2);
      expect(moveCalls).toHaveLength(2);
      expectDriverSessionGenerations(
        moveCalls.map((mockCall) => (mockCall?.arguments as { cursor_id: string }).cursor_id),
        'session-move-timeout',
        [0, 1],
      );
      expectDriverSessionGenerations(
        motionCalls.map((mockCall) => (mockCall?.arguments as { cursor_id: string }).cursor_id),
        'session-move-timeout',
        [0, 1],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry long window enumeration tools after a cua-driver MCP timeout', async () => {
    setPlatform('linux');
    vi.useFakeTimers();
    try {
      const timedOutCall = createDeferred<unknown>();
      mcpCallToolMock.mockReturnValueOnce(timedOutCall.promise);

      const call = callComputerDriverTool('list_windows', {
        session: 'caller-supplied',
      }, { sessionId: 'session-long-timeout' });
      const assertion = expect(call).rejects.toThrow('cua-driver mcp tool list_windows timed out after 45000ms');
      await vi.advanceTimersByTimeAsync(45_000);
      await assertion;
      expect(mcpConnectMock).toHaveBeenCalledTimes(1);
      expect(mcpCloseMock).toHaveBeenCalledTimes(1);
      const listCalls = mcpCallToolMock.mock.calls
        .map((mockCall) => mockCall[0])
        .filter((mockCall) => mockCall?.name === 'list_windows');
      expect(listCalls).toHaveLength(1);
      expectDriverSessionGenerations(
        listCalls.map((mockCall) => (mockCall?.arguments as { session: string }).session),
        'session-long-timeout',
        [0],
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up the fresh CUA MCP client when stale-session retry fails', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockRejectedValueOnce(new Error('transport closed'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"screenshot_file_path":"/tmp/recovered-again.png"}' }] });

    await expect(callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'caller-supplied',
    }, { sessionId: 'session-stale-retry-fails' })).rejects.toThrow('transport closed');

    await expect(callComputerDriverTool('get_window_state', {
      pid: 123,
      window_id: 7,
      capture_mode: 'vision',
      session: 'caller-supplied',
    }, { sessionId: 'session-stale-retry-fails' })).resolves.toEqual({
      ok: true,
      screenshot_file_path: '/tmp/recovered-again.png',
    });

    expect(mcpConnectMock).toHaveBeenCalledTimes(3);
    expect(mcpCloseMock).toHaveBeenCalledTimes(2);
    const stateCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'get_window_state');
    expectDriverSessionGenerations(
      stateCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-stale-retry-fails',
      [0, 1, 2],
    );
  });

  it('does not delete a fresh CUA MCP client from a concurrent stale failure', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
    });
    await callComputerDriverTool('list_windows', { session: 'session-concurrent-stale' }, { sessionId: 'session-concurrent-stale' });

    mcpCallToolMock.mockClear();
    const firstOldCall = createDeferred<unknown>();
    const secondOldCall = createDeferred<unknown>();
    const oldEndSession = createDeferred<unknown>();
    const firstFreshCall = createDeferred<unknown>();
    const secondFreshCall = createDeferred<unknown>();
    let oldCalls = 0;
    let freshCalls = 0;

    mcpCallToolMock.mockImplementation((call: { name: string; arguments: Record<string, unknown> }) => {
      if (
        call.name === 'list_windows' &&
        driverSessionGeneration(String(call.arguments.session), 'session-concurrent-stale') === 0
      ) {
        oldCalls += 1;
        return oldCalls === 1 ? firstOldCall.promise : secondOldCall.promise;
      }
      if (call.name === 'end_session') {
        return oldEndSession.promise;
      }
      if (
        call.name === 'list_windows' &&
        driverSessionGeneration(String(call.arguments.session), 'session-concurrent-stale') === 1
      ) {
        freshCalls += 1;
        return freshCalls === 1 ? firstFreshCall.promise : secondFreshCall.promise;
      }
      throw new Error(`unexpected call ${call.name} ${String(call.arguments.session)}`);
    });

    const first = callComputerDriverTool(
      'list_windows',
      { session: 'caller-supplied' },
      { sessionId: 'session-concurrent-stale' },
    );
    const second = callComputerDriverTool(
      'list_windows',
      { session: 'caller-supplied' },
      { sessionId: 'session-concurrent-stale' },
    );

    await waitForCondition(() => oldCalls === 2);
    firstOldCall.resolve({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] });
    await waitForCondition(() => mcpCallToolMock.mock.calls.some((call) => call[0]?.name === 'end_session'));
    oldEndSession.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await waitForCondition(() => freshCalls === 1);

    secondOldCall.resolve({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] });
    await waitForCondition(() => freshCalls === 2);
    firstFreshCall.resolve({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":7}]}' }] });
    secondFreshCall.resolve({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":8}]}' }] });

    await expect(first).resolves.toEqual({ ok: true, windows: [{ window_id: 7 }] });
    await expect(second).resolves.toEqual({ ok: true, windows: [{ window_id: 8 }] });
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);

    const sessionArgs = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'list_windows')
      .map((call) => (call?.arguments as { session: string }).session);
    expectDriverSessionGenerations(sessionArgs, 'session-concurrent-stale', [0, 0, 1, 1]);
  });

  it('does not retry stale tool calls after the session closes during cleanup', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
    });
    await callComputerDriverTool('list_windows', { session: 'session-close-during-stale' }, { sessionId: 'session-close-during-stale' });

    mcpCallToolMock.mockClear();
    const oldCall = createDeferred<unknown>();
    const oldEndSession = createDeferred<unknown>();

    mcpCallToolMock.mockImplementation((call: { name: string; arguments: Record<string, unknown> }) => {
      if (
        call.name === 'click' &&
        driverSessionGeneration(String(call.arguments.session), 'session-close-during-stale') === 0
      ) {
        return oldCall.promise;
      }
      if (call.name === 'end_session') {
        return oldEndSession.promise;
      }
      throw new Error(`unexpected call ${call.name} ${String(call.arguments.session)}`);
    });

    const click = callComputerDriverTool(
      'click',
      { pid: 123, window_id: 7, x: 10, y: 20, session: 'caller-supplied' },
      { sessionId: 'session-close-during-stale' },
    );

    await waitForCondition(() => mcpCallToolMock.mock.calls.some((call) => call[0]?.name === 'click'));
    oldCall.resolve({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] });
    await waitForCondition(() => mcpCallToolMock.mock.calls.some((call) => call[0]?.name === 'end_session'));

    const close = cleanupComputerDriverSession('session-close-during-stale');
    oldEndSession.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });

    await close;
    await expect(click).rejects.toThrow('session ended; tool call ignored');
    expect(mcpConnectMock).toHaveBeenCalledTimes(1);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
    const clickSessions = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'click')
      .map((call) => (call?.arguments as { session: string }).session);
    expectDriverSessionGenerations(clickSessions, 'session-close-during-stale', [0]);
  });

  it('cleans up the fresh client when the session closes before stale retry dispatch', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
    });
    await callComputerDriverTool('list_windows', { session: 'session-close-before-retry' }, { sessionId: 'session-close-before-retry' });

    mcpCallToolMock.mockClear();
    const staleClick = createDeferred<unknown>();
    const oldEndSession = createDeferred<unknown>();
    const freshStyle = createDeferred<unknown>();
    let freshStyleCalls = 0;

    mcpCallToolMock.mockImplementation((call: { name: string; arguments: Record<string, unknown> }) => {
      const session = String(call.arguments.session ?? call.arguments.cursor_id);
      const generation = driverSessionGeneration(session, 'session-close-before-retry');
      if (call.name === 'click' && generation === 0) {
        return staleClick.promise;
      }
      if (call.name === 'end_session') {
        return oldEndSession.promise;
      }
      if (call.name === 'set_agent_cursor_motion' && generation === 1) {
        freshStyleCalls += 1;
        return freshStyle.promise;
      }
      if (call.name === 'set_agent_cursor_style' && generation === 1) {
        return { content: [{ type: 'text', text: '{"ok":true}' }] };
      }
      throw new Error(`unexpected call ${call.name} ${session}`);
    });

    const click = callComputerDriverTool(
      'click',
      { pid: 123, window_id: 7, x: 10, y: 20, session: 'caller-supplied' },
      { sessionId: 'session-close-before-retry' },
    );

    await waitForCondition(() => mcpCallToolMock.mock.calls.some((call) => call[0]?.name === 'click'));
    staleClick.resolve({ content: [{ type: 'text', text: '"session ended; tool call ignored"' }] });
    await waitForCondition(() => mcpCallToolMock.mock.calls.some((call) => call[0]?.name === 'end_session'));
    oldEndSession.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });
    await waitForCondition(() => freshStyleCalls === 1);

    const close = cleanupComputerDriverSession('session-close-before-retry');
    freshStyle.resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });

    await close;
    await expect(click).rejects.toThrow('session ended; tool call ignored');
    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
    expect(mcpCloseMock).toHaveBeenCalledTimes(2);
    const clickSessions = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'click')
      .map((call) => (call?.arguments as { session: string }).session);
    expectDriverSessionGenerations(clickSessions, 'session-close-before-retry', [0]);
  });

  it('cleans up the session-owned CUA MCP proxy on session close', async () => {
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
    });
    await callComputerDriverTool('list_windows', { session: 'session-cleanup' }, { sessionId: 'session-cleanup' });

    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true}' }],
    });
    await cleanupComputerDriverSession('session-cleanup');

    const endSessionPayload = mcpCallToolMock.mock.lastCall?.[0]?.arguments as { session: string };
    expectDriverSessionGenerations([endSessionPayload.session], 'session-cleanup', [0]);
    expect(mcpCloseMock).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a driver session id after explicit session cleanup', async () => {
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":8}]}' }] });

    await callComputerDriverTool('list_windows', { session: 'session-cleanup-reuse' }, { sessionId: 'session-cleanup-reuse' });
    await cleanupComputerDriverSession('session-cleanup-reuse');
    await expect(callComputerDriverTool('list_windows', {
      session: 'caller-supplied',
    }, { sessionId: 'session-cleanup-reuse' })).resolves.toEqual({
      ok: true,
      windows: [{ window_id: 8 }],
    });

    const listCalls = mcpCallToolMock.mock.calls
      .map((call) => call[0])
      .filter((call) => call?.name === 'list_windows');
    expectDriverSessionGenerations(
      listCalls.map((call) => (call?.arguments as { session: string }).session),
      'session-cleanup-reuse',
      [0, 1],
    );
  });

  it('waits for stale cleanup before recreating a CUA MCP session with the same id', async () => {
    let resolveEndSession: (() => void) | undefined;
    mcpCallToolMock
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }] })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveEndSession = () => resolve({ content: [{ type: 'text', text: '{"ok":true}' }] });
      }))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[{"window_id":7}]}' }] });

    await callComputerDriverTool('list_windows', { session: 'session-race' }, { sessionId: 'session-race' });

    const cleanup = cleanupComputerDriverSession('session-race');
    const retry = callComputerDriverTool('list_windows', { session: 'session-race' }, { sessionId: 'session-race' });

    await Promise.resolve();
    expect(mcpConnectMock).toHaveBeenCalledTimes(1);

    resolveEndSession?.();
    await cleanup;
    await expect(retry).resolves.toEqual({ ok: true, windows: [{ window_id: 7 }] });
    expect(mcpConnectMock).toHaveBeenCalledTimes(2);
  });

  it('checks current Computer Use opt-in before dispatching MCP tool calls', async () => {
    const isComputerUseEnabled = vi.fn(() => false);
    const prepareRuntimeBeforeUse = vi.fn(async () => undefined);
    const deps = getComputerMcpDeps({ isComputerUseEnabled, prepareRuntimeBeforeUse });

    await expect(deps.callTool('list_windows', {}, { agentKind: 'codex' }))
      .rejects.toThrow('Computer Use is disabled');
    expect(isComputerUseEnabled).toHaveBeenCalledWith({ agentKind: 'codex' });
    expect(prepareRuntimeBeforeUse).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('closes active MCP sessions and blocks tool dispatch while permission onboarding is paused', async () => {
    setPlatform('darwin');
    mcpCallToolMock
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true}' }],
      });

    await callComputerDriverTool(
      'list_windows',
      {},
      { sessionId: 'session-permission-guide-pause' },
    );
    await pauseComputerDriverPermissionProbe();

    expect(mcpCloseMock).toHaveBeenCalledOnce();
    await expect(callComputerDriverTool(
      'list_windows',
      {},
      { sessionId: 'session-permission-guide-pause' },
    )).rejects.toThrow('permission onboarding is active');
    expect(mcpConnectMock).toHaveBeenCalledOnce();
  });

  it('prepares the runtime before dispatching the first enabled tool call', async () => {
    const prepareRuntimeBeforeUse = vi.fn(async () => undefined);
    mcpCallToolMock.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
    });
    const deps = getComputerMcpDeps({
      isComputerUseEnabled: () => true,
      prepareRuntimeBeforeUse,
    });

    await expect(deps.callTool(
      'list_windows',
      {},
      { sessionId: 'session-runtime-gate' },
    )).resolves.toEqual({ ok: true, windows: [] });
    expect(prepareRuntimeBeforeUse).toHaveBeenCalledTimes(1);
    expect(prepareRuntimeBeforeUse.mock.invocationCallOrder[0]).toBeLessThan(
      mcpCallToolMock.mock.invocationCallOrder[0]!,
    );
  });

  it('prepares the runtime only once for subsequent tool calls', async () => {
    const prepareRuntimeBeforeUse = vi.fn(async () => undefined);
    mcpCallToolMock
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
      })
      .mockResolvedValueOnce({
        content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }],
      });
    const deps = getComputerMcpDeps({
      isComputerUseEnabled: () => true,
      prepareRuntimeBeforeUse,
    });

    await deps.callTool('list_windows', {}, { sessionId: 'session-runtime-gate-once' });
    await deps.callTool('list_windows', {}, { sessionId: 'session-runtime-gate-once' });

    expect(prepareRuntimeBeforeUse).toHaveBeenCalledTimes(1);
  });

  it('runs the official installer and returns refreshed status', async () => {
    mockDriverSpawn({ stdout: 'installed\n' });
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    if (process.platform === 'darwin') {
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });
    }

    await expect(installComputerDriver()).resolves.toMatchObject({
      ok: true,
      stdout: 'installed\n',
      status: {
        installed: true,
        version: 'cua-driver 0.5.8',
      },
    });
    expect(spawnMock.mock.calls[0]?.[0]).toMatch(process.platform === 'win32' ? /powershell/i : '/bin/bash');
  });

  it('keeps macOS status checks side-effect-free when the daemon is stopped', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    mockDriverSpawn({ stderr: 'Cua Driver daemon is not running\n', exitCode: 1 });

    await expect(getComputerDriverStatus()).resolves.toMatchObject({
      installed: true,
      daemonRunning: false,
      permissionState: {
        platform: 'macos',
        required: true,
        status: 'unknown',
      },
    });
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'serve')).toBe(false);
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'permissions')).toBe(false);
  });

  it('can inspect a running macOS daemon without triggering the permission probe', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });

    await expect(getComputerDriverStatus({ skipPermissionProbe: true })).resolves.toMatchObject({
      installed: true,
      daemonRunning: true,
      permissionState: {
        platform: 'macos',
        status: 'unknown',
      },
    });
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'permissions')).toBe(false);
  });

  it('keeps page-entry status checks passive on CuaDriver versions before 0.12.2', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.12.1\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });

    await expect(getComputerDriverStatus({
      forcePermissionProbe: true,
      bypassPermissionProbeCache: true,
      passivePermissionProbeOnly: true,
    })).resolves.toMatchObject({
      installed: true,
      daemonRunning: true,
      permissionState: {
        platform: 'macos',
        status: 'unknown',
      },
    });
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'permissions')).toBe(false);
  });

  it('refreshes page-entry permissions through the read-only 0.12.2 status command', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.12.2\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(getComputerDriverStatus({
      forcePermissionProbe: true,
      bypassPermissionProbeCache: true,
      passivePermissionProbeOnly: true,
    })).resolves.toMatchObject({
      installed: true,
      permissionState: {
        accessibility: 'granted',
        screenRecording: 'granted',
        status: 'granted',
      },
    });
    expect(spawnMock).toHaveBeenCalledWith(
      'cua-driver',
      ['permissions', 'status', '--json'],
      expect.objectContaining({ windowsHide: true }),
    );
  });

  it('bootstraps macOS @ windows from the passive permission status after restart', async () => {
    setPlatform('darwin');
    mockDriverSpawn({ stdout: 'cua-driver 0.12.2\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });
    mockDriverSpawn({ stdout: '{"ok":true,"windows":[{"window_id":7,"pid":70}]}\n' });

    await expect(listComputerWindowsForAtMention()).resolves.toEqual({
      ok: true,
      windows: [{ window_id: 7, pid: 70 }],
    });
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['--version'],
      ['status'],
      ['permissions', 'status', '--json'],
      ['call', 'list_windows'],
    ]);
  });

  it('keeps macOS @ windows hidden without probing on older drivers', async () => {
    setPlatform('darwin');
    mockDriverSpawn({ stdout: 'cua-driver 0.12.1\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });

    await expect(listComputerWindowsForAtMention()).resolves.toEqual({
      ok: true,
      windows: [],
    });
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['--version'],
      ['status'],
    ]);
  });

  it('does not autostart the macOS permission daemon from the @ palette', async () => {
    setPlatform('darwin');
    mockDriverSpawn({ stdout: 'cua-driver 0.12.2\n' });
    mockDriverSpawn({ stderr: 'Cua Driver daemon is not running\n', exitCode: 1 });

    await expect(listComputerWindowsForAtMention()).resolves.toEqual({
      ok: true,
      windows: [],
    });
    expect(spawnMock.mock.calls.map((call) => call[1])).toEqual([
      ['--version'],
      ['status'],
    ]);
  });

  it('can force a macOS permission probe even when the daemon status is stopped', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.6.8\n' });
    mockDriverSpawn({ stderr: 'Cua Driver daemon is not running\n', exitCode: 1 });
    // daemon 掉线的强制探测会先尝试自愈启动(open);这里模拟 app bundle 缺失
    // (open 非零退出)→ 放弃自愈,仍应继续走 CLI 探测。
    mockDriverSpawn({ stderr: 'Unable to find application named CuaDriver\n', exitCode: 1 });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      installed: true,
      daemonRunning: false,
      permissionState: {
        platform: 'macos',
        status: 'granted',
        accessibility: 'granted',
        screenRecording: 'granted',
      },
    });
    expect(spawnMock).toHaveBeenCalledWith('cua-driver', ['permissions', 'status', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(spawnMock.mock.calls.some((call) => call[1]?.[0] === 'doctor')).toBe(false);
  });

  it('treats failed macOS permission probes as unknown instead of missing', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.6.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stderr: 'permission status unavailable\n',
      exitCode: 1,
    });

    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      installed: true,
      permissionState: {
        platform: 'macos',
        status: 'unknown',
        reason: 'permission status unavailable',
      },
    });
  });

  it('treats a capturable macOS screen as screen recording ready', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'cua-driver 0.6.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":false,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      installed: true,
      permissionState: {
        platform: 'macos',
        status: 'granted',
        screenRecording: 'missing',
        screenRecordingCapturable: 'granted',
      },
    });
  });

  it('treats a stale macOS screen recording grant (recorded but not capturable) as missing', async () => {
    if (process.platform !== 'darwin') return;

    // driver 二进制更新后的典型 stale grant:TCC 数据库记录还在(screen_recording=true),
    // 但 ScreenCaptureKit 实测已被拒(capturable=false),实际截屏必失败。必须报 missing
    // 并附 stale 原因,把用户指回系统设置重新授权 —— 报 granted 会把坏状态藏起来。
    mockDriverSpawn({ stdout: 'cua-driver 0.6.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      installed: true,
      permissionState: {
        platform: 'macos',
        status: 'missing',
        screenRecording: 'granted',
        screenRecordingCapturable: 'missing',
        reason: expect.stringContaining('stale grant'),
      },
    });
  });

  it('reuses the broken permission probe result while the daemon pid is unchanged', async () => {
    if (process.platform !== 'darwin') return;

    // daemon 端的 capturable 实测在授权坏掉时每次都会触发 macOS 授权弹窗,因此同一个
    // daemon(pid 未变)只允许实测一次,后续 status 复用缓存 —— 不再反复弹窗。
    const daemonStdout = 'Cua Driver daemon is running\n  socket: /tmp/cua-driver.sock\n  pid: 4242\n';
    const brokenPayload =
      '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n';
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: daemonStdout });
    mockDriverSpawn({ stdout: brokenPayload });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      permissionState: { status: 'missing', screenRecordingCapturable: 'missing' },
    });

    // 第二次 status:只 mock version + daemon status 两个 spawn —— 若错误地再次探测
    // 权限,spawn 队列耗尽会让状态落到 unknown,下面的断言会失败。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: daemonStdout });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      permissionState: { status: 'missing', screenRecordingCapturable: 'missing' },
    });
    const permissionProbeCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions');
    expect(permissionProbeCalls).toHaveLength(1);
  });

  it('re-probes permissions after the daemon restarts with a new pid', async () => {
    if (process.platform !== 'darwin') return;

    const brokenPayload =
      '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n';
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({ stdout: brokenPayload });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      permissionState: { status: 'missing' },
    });

    // macOS 重新授权屏幕录制会杀掉 daemon;pid 变化 ⇒ 状态可能已修复,必须重新实测。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 9999\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      permissionState: { status: 'granted', screenRecordingCapturable: 'granted' },
    });
  });

  it('autostarts the daemon for a forced permission probe when it is down, then probes it', async () => {
    if (process.platform !== 'darwin') return;

    // macOS 修改屏幕录制授权会杀掉 daemon 且 macOS 侧没有 autostart;设置面板的
    // 显式探测应把它拉起来(必须带 --no-permissions-gate,避免 serve 首启 gate
    // 自己弹授权框 + 打开系统设置)再对新 daemon 做探测。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 });
    mockDriverSpawn({ stdout: '' }); // open -n -g -a CuaDriver … → exit 0
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 7777\n' }); // 自愈后的轮询
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      installed: true,
      daemonRunning: true,
      permissionState: { status: 'granted' },
    });
    const openCall = spawnMock.mock.calls.find((call) => call[0] === 'open');
    expect(openCall?.[1]).toEqual(['-n', '-g', '-a', 'CuaDriver', '--args', 'serve', '--no-permissions-gate']);
  }, 10_000);

  it('allows an immediate re-autostart after a successful one (throttle only cools down failures)', async () => {
    if (process.platform !== 'darwin') return;

    const healthyPayload =
      '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n';
    // 第一次:daemon 掉线 → 自愈成功。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 });
    mockDriverSpawn({ stdout: '' }); // open
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({ stdout: healthyPayload });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      daemonRunning: true,
    });

    // 授权引导中 macOS 又杀掉 daemon(如用户授了屏幕录制):必须能立刻再拉起,
    // 不被 30s 节流卡住 —— 节流只惩罚「起不来」的失败重试。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 });
    mockDriverSpawn({ stdout: '' }); // open(第二次)
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 5555\n' });
    mockDriverSpawn({ stdout: healthyPayload });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      daemonRunning: true,
      permissionState: { status: 'granted' },
    });
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'open')).toHaveLength(2);
  }, 10_000);

  it('throttles daemon autostart attempts when the daemon stays down', async () => {
    if (process.platform !== 'darwin') return;

    // 第一次:open 成功但 daemon 在等待窗口内一直没起来(后续 spawn 全部失败)。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 });
    mockDriverSpawn({ stdout: '' }); // open → exit 0
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('daemon not running\n'));
        child.emit('close', 1, null);
      });
      return child;
    });

    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      daemonRunning: false,
      permissionState: { status: 'unknown' },
    });
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'open')).toHaveLength(1);

    // 第二次(30s 节流窗口内):不再尝试 open,直接维持 unknown,避免 spawn 风暴。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      daemonRunning: false,
      permissionState: { status: 'unknown' },
    });
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'open')).toHaveLength(1);
  }, 15_000);

  it('restarts the daemon for a fresh permission probe so accessibility revocation is detected', async () => {
    if (process.platform !== 'darwin') return;

    existsSyncMock.mockImplementation((candidate) => String(candidate).includes('CuaDriver.app'));
    // AX 撤销对运行中的 daemon 不可见:fresh 探测必须 stop → 自愈拉起 → 对新进程实测。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({ stdout: 'daemon stopped\n' }); // cua-driver stop
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 }); // stop 后复查
    mockDriverSpawn({ stdout: '' }); // open(autostart) → exit 0
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 9999\n' }); // 自愈轮询
    mockDriverSpawn({
      stdout:
        '{"accessibility":false,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(
      getComputerDriverStatus({ forcePermissionProbe: true, freshPermissionProbe: true }),
    ).resolves.toMatchObject({
      daemonRunning: true,
      permissionState: { status: 'missing', accessibility: 'missing', screenRecordingCapturable: 'granted' },
    });
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'stop')).toHaveLength(1);
    expect(spawnMock.mock.calls.filter((call) => call[0] === 'open')).toHaveLength(1);
  }, 10_000);

  it('fresh probe restarts and live-probes even while screen recording is broken', async () => {
    if (process.platform !== 'darwin') return;

    existsSyncMock.mockImplementation((candidate) => String(candidate).includes('CuaDriver.app'));
    // 先种下「屏幕录制坏状态」缓存(capturable=missing @ pid 4242)——被动路径会复用它。
    const daemonStdout = 'Cua Driver daemon is running\n  pid: 4242\n';
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: daemonStdout });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      permissionState: { screenRecordingCapturable: 'missing' },
    });

    // fresh(用户显式点重新检查)不许被弹窗抑制缓存挡成「点了没反应」:必须重启 + 实测。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: daemonStdout });
    mockDriverSpawn({ stdout: 'daemon stopped\n' }); // cua-driver stop
    mockDriverSpawn({ stderr: 'daemon not running\n', exitCode: 1 }); // stop 后复查
    mockDriverSpawn({ stdout: '' }); // open(autostart)
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 9999\n' }); // 自愈轮询
    mockDriverSpawn({
      stdout:
        '{"accessibility":false,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(
      getComputerDriverStatus({ forcePermissionProbe: true, freshPermissionProbe: true }),
    ).resolves.toMatchObject({
      permissionState: { status: 'missing', accessibility: 'missing' },
    });
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'stop')).toHaveLength(1);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions')).toHaveLength(2);
  }, 10_000);

  it('fresh probe never stops the daemon when the app bundle is missing (CLI-only install)', async () => {
    if (process.platform !== 'darwin') return;

    // 无 /Applications/CuaDriver.app(existsSync 默认 false)时自愈 `open` 必失败:
    // 绝不能把健康 daemon 停掉变成拉不回来的破坏性动作,退化为不重启的现场实测。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(
      getComputerDriverStatus({ forcePermissionProbe: true, freshPermissionProbe: true }),
    ).resolves.toMatchObject({
      daemonRunning: true,
      permissionState: { status: 'granted' },
    });
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'stop')).toHaveLength(0);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions')).toHaveLength(1);
  });

  it('fresh probe skips the daemon restart while cua MCP sessions are active but still live-probes', async () => {
    if (process.platform !== 'darwin') return;

    existsSyncMock.mockImplementation((candidate) => String(candidate).includes('CuaDriver.app'));
    // 起一个 cua MCP 会话(agent 正在操作电脑)。
    mcpCallToolMock.mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true,"windows":[]}' }] });
    await callComputerDriverTool('list_windows', {}, { sessionId: 'fresh-guard-session' });

    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(
      getComputerDriverStatus({ forcePermissionProbe: true, freshPermissionProbe: true }),
    ).resolves.toMatchObject({
      permissionState: { status: 'granted' },
    });
    // 不重启(别打断 agent),但仍现场实测。
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'stop')).toHaveLength(0);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions')).toHaveLength(1);
  });

  it('fresh/bypass probes start a new probe instead of joining a stale in-flight one', async () => {
    if (process.platform !== 'darwin') return;

    // p1(被动路径)卡在一个悬挂的 permissions 探测上(模拟对旧 daemon 的慢探测)。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    let hangingProbe:
      | (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> })
      | undefined;
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      hangingProbe = child;
      return child;
    });
    const p1 = getComputerDriverStatus({ forcePermissionProbe: true });
    await new Promise((resolve) => setTimeout(resolve, 20)); // 让 p1 走到探测

    // p2(bypass,「必须第一手」语义)不许 join p1 的在途探测,必须新起一个。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(
      getComputerDriverStatus({ forcePermissionProbe: true, bypassPermissionProbeCache: true }),
    ).resolves.toMatchObject({ permissionState: { status: 'granted' } });
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions')).toHaveLength(2);

    // 收尾:放行 p1,避免悬挂 promise 泄漏到后续用例。
    hangingProbe?.stderr.emit('data', Buffer.from('slow probe\n'));
    hangingProbe?.emit('close', 1, null);
    await p1;
  });

  it('bypasses the broken-probe cache when the grant flow asks for a fresh status', async () => {
    if (process.platform !== 'darwin') return;

    const daemonStdout = 'Cua Driver daemon is running\n  pid: 4242\n';
    const brokenPayload =
      '{"accessibility":false,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n';
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: daemonStdout });
    mockDriverSpawn({ stdout: brokenPayload });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true })).resolves.toMatchObject({
      permissionState: { status: 'missing', accessibility: 'missing' },
    });

    // 授权流程刷新状态必须绕过缓存现场实测(例如辅助功能刚被授予、daemon pid 未变)。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: daemonStdout });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(getComputerDriverStatus({ forcePermissionProbe: true, bypassPermissionProbeCache: true })).resolves.toMatchObject({
      permissionState: { status: 'missing', accessibility: 'granted' },
    });
    const permissionProbeCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions');
    expect(permissionProbeCalls).toHaveLength(2);
  });

  it('runs the cua-driver macOS permission grant flow and returns refreshed status', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'permission granted\n' });
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(grantComputerDriverPermissions()).resolves.toMatchObject({
      ok: true,
      stdout: 'permission granted\n',
      status: {
        permissionState: {
          status: 'granted',
        },
      },
    });
    expect(spawnMock).toHaveBeenCalledWith('cua-driver', ['permissions', 'grant'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  });

  it('leaves row creation to the phase-one guide while its drag step is active', async () => {
    setPlatform('darwin');
    await pauseComputerDriverPermissionProbe();
    mockDriverSpawn({ stdout: 'cua-driver 0.12.2\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is not running\n' });

    await expect(grantComputerDriverPermissions()).resolves.toMatchObject({
      ok: false,
      status: {
        permissionState: {
          status: 'missing',
          accessibility: 'missing',
          reason: 'Waiting for CuaDriver to be added in System Settings.',
        },
      },
    });
    expect(
      spawnMock.mock.calls.some(
        (call) => call[1]?.[0] === 'permissions' && call[1]?.[1] === 'grant',
      ),
    ).toBe(false);
  });

  it('preserves the preflight permission snapshot while the phase-one guide is active', async () => {
    setPlatform('darwin');
    await pauseComputerDriverPermissionProbe();
    const preflightStatus: ComputerDriverStatus = {
      installed: true,
      executablePath: '/Applications/CuaDriver.app/Contents/MacOS/cua-driver',
      version: '0.12.2',
      daemonRunning: true,
      installCommand: 'test',
      docsUrl: 'https://cua.ai/docs/cua-driver',
      permissionState: {
        platform: 'macos',
        required: true,
        status: 'missing',
        accessibility: 'granted',
        screenRecording: 'missing',
        screenRecordingCapturable: 'missing',
        canGrant: true,
      },
    };

    await expect(grantComputerDriverPermissions(preflightStatus)).resolves.toMatchObject({
      ok: false,
      status: {
        permissionState: {
          accessibility: 'granted',
          screenRecording: 'missing',
        },
      },
    });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('kills the in-flight grant child when the user cancels the permission guide', async () => {
    if (process.platform !== 'darwin') return;

    // 挂死的 grant 子进程(上游会一直等用户完成授权,长达 210s)。
    let grantChild:
      | (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> })
      | undefined;
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: ReturnType<typeof vi.fn>;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      grantChild = child;
      return child;
    });
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":false,"screen_recording":false,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(grantComputerDriverPermissions()).resolves.toMatchObject({ ok: false });

    // 用户点「取消」:在途 grant 子进程必须被收割,原生授权流程随之停止。
    cancelComputerDriverPermissionGrant();
    expect(grantChild?.kill).toHaveBeenCalledTimes(1);

    // 下一次授权是全新流程(重新 spawn),不是复用已被放弃的旧流程。
    mockDriverSpawn({ stdout: 'permission granted\n' });
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
    });
    await expect(grantComputerDriverPermissions()).resolves.toMatchObject({ ok: true });
    const grantSpawns = spawnMock.mock.calls.filter((call) => call[1]?.[0] === 'permissions' && call[1]?.[1] === 'grant');
    expect(grantSpawns).toHaveLength(2);
  });

  it('restarts a stale macOS permission grant flow so users do not need to restart the app', async () => {
    if (process.platform !== 'darwin') return;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-03T02:00:00.000Z'));
    try {
      // 挂死的 grant 子进程:上游 `permissions grant` 会一直等用户完成授权。
      let staleChild:
        | (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> })
        | undefined;
      spawnMock.mockImplementationOnce(() => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        staleChild = child;
        return child;
      });
      mockDriverSpawn({ stdout: 'cua-driver 0.6.8\n' });
      mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":false,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
      });

      const firstGrant = grantComputerDriverPermissions();
      await vi.advanceTimersByTimeAsync(750);
      await expect(firstGrant).resolves.toMatchObject({
        ok: false,
        status: { permissionState: { status: 'missing' } },
      });
      // 授权仍在等用户操作,复用窗口内不许收割在途流程。
      expect(staleChild?.kill).not.toHaveBeenCalled();

      // 用户走开又回来:超过复用窗口的旧流程必须被杀掉重启,否则按钮点了没反应。
      await vi.advanceTimersByTimeAsync(16_000);
      mockDriverSpawn({ stdout: 'permission granted\n' });
      mockDriverSpawn({ stdout: 'cua-driver 0.6.8\n' });
      mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });

      await expect(grantComputerDriverPermissions()).resolves.toMatchObject({
        ok: true,
        status: { permissionState: { status: 'granted' } },
      });
      expect(staleChild?.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stale status probes do not kill a grant flow started after the probe began', async () => {
    if (process.platform !== 'darwin') return;

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T02:00:00.000Z'));
    try {
      const grantedPayload =
        '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n';
      const makeHangingChild = () => {
        const child = new EventEmitter() as EventEmitter & {
          stdout: EventEmitter;
          stderr: EventEmitter;
          kill: ReturnType<typeof vi.fn>;
        };
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = vi.fn();
        return child;
      };

      // A:一次 status 探测在 permissions 子进程处挂起(证据采集始于 grant 之前)。
      mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
      mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
      let staleProbeChild: ReturnType<typeof makeHangingChild> | undefined;
      spawnMock.mockImplementationOnce(() => {
        staleProbeChild = makeHangingChild();
        return staleProbeChild;
      });
      const staleStatus = getComputerDriverStatus({ forcePermissionProbe: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(staleProbeChild).toBeDefined();

      // B:此后用户发起 grant(子进程挂起等待系统授权)。
      let grantChild: ReturnType<typeof makeHangingChild> | undefined;
      spawnMock.mockImplementationOnce(() => {
        grantChild = makeHangingChild();
        return grantChild;
      });
      mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
      mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
      mockDriverSpawn({
        stdout:
          '{"accessibility":false,"screen_recording":false,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
      });
      const grantPromise = grantComputerDriverPermissions();
      await vi.advanceTimersByTimeAsync(750);
      await expect(grantPromise).resolves.toMatchObject({ ok: false });
      expect(grantChild?.kill).not.toHaveBeenCalled();

      // A 的探测此刻才回并报 granted(stale 证据):不得误杀 B 的在途 grant。
      staleProbeChild!.stdout.emit('data', Buffer.from(grantedPayload));
      staleProbeChild!.emit('close', 0, null);
      await expect(staleStatus).resolves.toMatchObject({
        permissionState: { status: 'granted' },
      });
      expect(grantChild?.kill).not.toHaveBeenCalled();

      // 对照:grant 在途期间发起的 status 确认 granted,仍应收割该 grant 子进程。
      mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
      mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n  pid: 4242\n' });
      mockDriverSpawn({ stdout: grantedPayload });
      await expect(
        getComputerDriverStatus({ forcePermissionProbe: true, bypassPermissionProbeCache: true }),
      ).resolves.toMatchObject({ permissionState: { status: 'granted' } });
      expect(grantChild?.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns partial macOS permission status while the grant flow is still incomplete', async () => {
    if (process.platform !== 'darwin') return;

    mockDriverSpawn({ stdout: 'permission prompt opened\n' });
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    mockDriverSpawn({
      stdout:
        '{"accessibility":true,"screen_recording":false,"screen_recording_capturable":false,"source":{"attribution":"driver-daemon"}}\n',
    });

    await expect(grantComputerDriverPermissions()).resolves.toMatchObject({
      ok: false,
      stdout: 'permission prompt opened\n',
      status: {
        permissionState: {
          status: 'missing',
          accessibility: 'granted',
          screenRecording: 'missing',
        },
      },
    });
  });
});


function currentPlatformReleaseAsset(version: string, size = 21147689) {
  const name = getCuaDriverReleaseAssetName(version);
  if (!name) throw new Error(`unsupported test platform: ${process.platform}/${process.arch}`);
  return { name, size, state: 'uploaded' as const };
}

/** 标准更新检查 mock:matching-refs 返回 0.7.0,后续请求返回可安装 release。 */
function mockRefsThenReleaseFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.7.0' }],
    })
    .mockResolvedValue({
      ok: true,
      json: async () => ({
        tag_name: 'cua-driver-rs-v0.7.0',
        assets: [currentPlatformReleaseAsset('0.7.0')],
      }),
    });
}

describe('computer driver update check', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    resetComputerDriverUpdateStateForTests();
  });

  it('extractDriverSemver pulls x.y.z out of raw --version output shapes', () => {
    expect(extractDriverSemver('0.5.8')).toBe('0.5.8');
    expect(extractDriverSemver('cua-driver 0.5.8\n')).toBe('0.5.8');
    expect(extractDriverSemver('CuaDriver v0.10.2 (release)')).toBe('0.10.2');
    expect(extractDriverSemver('')).toBeNull();
    expect(extractDriverSemver(null)).toBeNull();
    expect(extractDriverSemver('no version here')).toBeNull();
  });

  it('compareSemver compares numerically per segment, not lexically', () => {
    expect(compareSemver('0.5.8', '0.5.8')).toBe(0);
    expect(compareSemver('0.5.8', '0.6.0')).toBeLessThan(0);
    expect(compareSemver('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
  });

  it('pickLatestCuaDriverVersion ignores other monorepo components and picks semver max', () => {
    expect(
      pickLatestCuaDriverVersion([
        'agent-v0.8.4',
        'cua-driver-rs-v0.6.8',
        'cli-v0.1.12',
        'cua-driver-rs-v0.7.0',
        'cua-driver-rs-v0.5.8',
        'computer-server-v0.3.42',
      ]),
    ).toBe('0.7.0');
    expect(pickLatestCuaDriverVersion(['agent-v0.8.4', 'cli-v0.1.12'])).toBeNull();
    expect(pickLatestCuaDriverVersion([])).toBeNull();
  });

  it('reports updateAvailable when upstream has a newer cua-driver tag', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    const fetchImpl = vi
      .fn()
      // matching-refs:全量 driver tag(乱序也无妨,semver max)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.6.8' },
          { ref: 'refs/tags/cua-driver-rs-v0.7.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.5.8' },
        ],
      })
      // release-by-tag:asset 列表
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.7.0',
          assets: [currentPlatformReleaseAsset('0.7.0')],
        }),
      });

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: '0.5.8',
      latestVersion: '0.7.0',
      updateAvailable: true,
      updating: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('git/matching-refs/tags/cua-driver-rs-v');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('releases/tags/cua-driver-rs-v0.7.0');
  });

  it('reports no update when local version already matches the latest tag (single request)', async () => {
    mockDriverSpawn({ stdout: '0.7.0\n' });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.7.0' }],
    });

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: '0.7.0',
      latestVersion: '0.7.0',
      updateAvailable: false,
      updating: false,
    });
    // 无更新时不拉 assets,恒定 1 个请求
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('silently reports no update when the driver is not installed locally', async () => {
    mockDriverSpawn({ error: Object.assign(new Error('spawn cua-driver ENOENT'), { code: 'ENOENT' }) });
    const fetchImpl = vi.fn();

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      updating: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('silently reports no update when the releases API fails or rate-limits', async () => {
    mockDriverSpawn({ stdout: '0.5.8\n' });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 403 });

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: '0.5.8',
      latestVersion: null,
      updateAvailable: false,
      updating: false,
    });
  });

  it('silently reports no update on malformed API payloads', async () => {
    mockDriverSpawn({ stdout: '0.5.8\n' });
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      // matching-refs 返回非数组(异常形态)
      json: async () => ({ message: 'unexpected object payload' }),
    });

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: '0.5.8',
      latestVersion: null,
      updateAvailable: false,
      updating: false,
    });
  });

  it('serves the cached result instantly on subsequent checks (no network wait)', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    const firstFetch = mockRefsThenReleaseFetch();
    await checkComputerDriverUpdate(firstFetch as unknown as typeof fetch);

    // 第二次立即返回缓存;且距上次检查未满节流窗口,不应触发后台刷新
    // (未鉴权 GitHub API 限额有限,面板频繁开合不能放大请求量)。
    const hangingFetch = vi.fn().mockReturnValue(new Promise(() => {}));
    await expect(
      checkComputerDriverUpdate(hangingFetch as unknown as typeof fetch),
    ).resolves.toEqual({
      currentVersion: '0.5.8',
      latestVersion: '0.7.0',
      updateAvailable: true,
      updating: false,
    });
    expect(hangingFetch).not.toHaveBeenCalled();
  });

  it('keeps the cached "update available" result when a background refresh fails', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    const okFetch = mockRefsThenReleaseFetch();
    await checkComputerDriverUpdate(okFetch as unknown as typeof fetch);

    // 越过节流窗口后,后台刷新网络失败(latestVersion 拿不到)不应把已知的
    // 更新入口抹掉。只 fake Date 以推进节流窗口,真实 timer 保持可用。
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
      const failingFetch = vi.fn().mockResolvedValue({ ok: false, status: 500 });
      await checkComputerDriverUpdate(failingFetch as unknown as typeof fetch);
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      // 节流窗口外确实触发了后台刷新
      expect(failingFetch).toHaveBeenCalledTimes(1);

      mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
      const hangingFetch = vi.fn().mockReturnValue(new Promise(() => {}));
      await expect(
        checkComputerDriverUpdate(hangingFetch as unknown as typeof fetch),
      ).resolves.toMatchObject({ latestVersion: '0.7.0', updateAvailable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a newer verified target when its background probe transiently falls back', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const initialFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.12.0' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.12.0',
          assets: [currentPlatformReleaseAsset('0.12.0')],
        }),
      });
    await checkComputerDriverUpdate(initialFetch as unknown as typeof fetch);

    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
      const refreshedFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [
            { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
            { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
          ],
        })
        .mockResolvedValueOnce({ ok: false, status: 503 })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            tag_name: 'cua-driver-rs-v0.11.0',
            assets: [currentPlatformReleaseAsset('0.11.0')],
          }),
        });

      await expect(
        checkComputerDriverUpdate(refreshedFetch as unknown as typeof fetch),
      ).resolves.toMatchObject({ latestVersion: '0.12.0', updateAvailable: true });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      expect(refreshedFetch).toHaveBeenCalledTimes(3);

      const hangingFetch = vi.fn().mockReturnValue(new Promise(() => {}));
      await expect(
        checkComputerDriverUpdate(hangingFetch as unknown as typeof fetch),
      ).resolves.toMatchObject({ latestVersion: '0.12.0', updateAvailable: true });
      expect(hangingFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('updateComputerDriver joins one in-flight install and clears the cached check on success', async () => {
    // 先塞一个"有更新"缓存
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    const fetchImpl = mockRefsThenReleaseFetch();
    await checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch);

    // installComputerDriver 的 spawn 序列:installer + status(version/daemon[/permissions])
    mockDriverSpawn({ stdout: 'installed\n' });
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    if (process.platform === 'darwin') {
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });
    }

    const installerCallsBefore = spawnMock.mock.calls.length;
    // 并发两次调用(模拟面板关闭前发起 + 重开后 join),应共享同一次安装
    const [first, second] = await Promise.all([
      updateComputerDriver(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      updateComputerDriver(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ]);
    expect(first).toBe(second);
    expect(first.ok).toBe(true);
    const installerRuns = spawnMock.mock.calls
      .slice(installerCallsBefore)
      .filter((call) => String(call[0]).match(/bash|powershell/i)).length;
    expect(installerRuns).toBe(1);
    const installerCall = spawnMock.mock.calls
      .slice(installerCallsBefore)
      .find((call) => String(call[0]).match(/bash|powershell/i));
    expect(installerCall?.[2]?.env?.CUA_DRIVER_RS_VERSION).toBe('0.7.0');

    // 成功后缓存被清:下一次 check 重新走网络(注入 no-update 响应验证)
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    const refreshedFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.7.0' }],
    });
    await expect(
      checkComputerDriverUpdate(refreshedFetch as unknown as typeof fetch),
    ).resolves.toEqual({
      currentVersion: '0.7.0',
      latestVersion: '0.7.0',
      updateAvailable: false,
      updating: false,
    });
    expect(refreshedFetch).toHaveBeenCalledTimes(1);
  });

  it('reports updating=true while a driver update install is in flight', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    const fetchImpl = mockRefsThenReleaseFetch();
    await checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch);

    // 安装脚本挂起 → updateComputerDriver 处于 in-flight
    mockNeverSettlingSpawn();
    const updatePromise = updateComputerDriver(undefined, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    const hangingFetch = vi.fn().mockReturnValue(new Promise(() => {}));
    await expect(
      checkComputerDriverUpdate(hangingFetch as unknown as typeof fetch),
    ).resolves.toMatchObject({ updateAvailable: true, updating: true });
    // 更新进行中不应触发后台刷新
    expect(hangingFetch).not.toHaveBeenCalled();

    // 收尾:让挂起的安装超时路径不影响其它测试 —— 直接重置状态
    resetComputerDriverUpdateStateForTests();
    void updatePromise.catch(() => {});
  });
});

describe('install activity timeout and stale lock preflight', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  function mockLongRunningInstallSpawn() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    child.unref = vi.fn();
    spawnMock.mockImplementationOnce(() => child);
    return child;
  }

  it('fails after idleTimeoutMs of total silence and kills the child', async () => {
    vi.useFakeTimers();
    try {
      const child = mockLongRunningInstallSpawn();
      const run = runProcessWithActivityTimeout('/bin/bash', ['-c', 'install'], {
        idleTimeoutMs: 180_000,
        hardTimeoutMs: 1_800_000,
        pollIntervalMs: 15_000,
        sampleTree: async () => null,
      });
      const assertion = expect(run).rejects.toThrow(/no install progress for 18\d+s/);
      await vi.advanceTimersByTimeAsync(181_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats stdout/stderr output as progress and resets the idle window', async () => {
    vi.useFakeTimers();
    try {
      const child = mockLongRunningInstallSpawn();
      const run = runProcessWithActivityTimeout('/bin/bash', ['-c', 'install'], {
        idleTimeoutMs: 180_000,
        hardTimeoutMs: 1_800_000,
        pollIntervalMs: 15_000,
        sampleTree: async () => null,
      });
      // 每 170s 吐一次输出,总计超过 3 个 idle 窗口也不能失败
      for (let i = 0; i < 3; i += 1) {
        await vi.advanceTimersByTimeAsync(170_000);
        child.stderr.emit('data', Buffer.from('==> downloading...\n'));
      }
      child.stdout.emit('data', Buffer.from('done\n'));
      child.emit('close', 0, null);
      await expect(run).resolves.toMatchObject({ exitCode: 0 });
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats process-tree snapshot changes (silent download) as progress', async () => {
    vi.useFakeTimers();
    try {
      const child = mockLongRunningInstallSpawn();
      let tick = 0;
      let frozen = false;
      const run = runProcessWithActivityTimeout('/bin/bash', ['-c', 'install'], {
        idleTimeoutMs: 180_000,
        hardTimeoutMs: 1_800_000,
        pollIntervalMs: 15_000,
        // 模拟静默下载:无 stdout/stderr,但 curl 的累计 CPU time 在涨
        sampleTree: async () => (frozen ? 'tree-frozen' : `tree-${(tick += 1)}`),
      });
      const assertion = expect(run).rejects.toThrow(/no install progress/);
      // 快照持续变化:远超 idle 窗口也不失败
      await vi.advanceTimersByTimeAsync(600_000);
      expect(child.kill).not.toHaveBeenCalled();
      // 快照冻结(连接挂死):3 分钟后失败
      frozen = true;
      await vi.advanceTimersByTimeAsync(200_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enforces the hard cap even with continuous activity', async () => {
    vi.useFakeTimers();
    try {
      const child = mockLongRunningInstallSpawn();
      let tick = 0;
      const run = runProcessWithActivityTimeout('/bin/bash', ['-c', 'install'], {
        idleTimeoutMs: 180_000,
        hardTimeoutMs: 1_800_000,
        pollIntervalMs: 15_000,
        sampleTree: async () => `tree-${(tick += 1)}`,
      });
      const assertion = expect(run).rejects.toThrow(/hard cap/);
      await vi.advanceTimersByTimeAsync(1_801_000);
      await assertion;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the install lock only when the holder pid is dead', async () => {
    const os = await import('node:os');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathMod = await import('node:path');
    existsSyncMock.mockImplementation((candidate) => fs.existsSync(String(candidate)));
    const base = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cua-lock-test-'));
    const lockDir = pathMod.join(base, '.install.lock.d');
    const writeLock = (pid: number) => {
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(pathMod.join(lockDir, 'info'), `pid=${pid}\nstarted=now\nargv=test\n`);
    };

    // 无锁 → no-op
    expect(clearStaleCuaInstallLock(lockDir, () => false)).toBe(false);

    // 持有者活着 → 绝不清
    writeLock(4242);
    expect(clearStaleCuaInstallLock(lockDir, () => true)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);

    // 持有者死了 → 清锁
    expect(clearStaleCuaInstallLock(lockDir, () => false)).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(false);

    // info 无 pid 行 → 保守不清
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(pathMod.join(lockDir, 'info'), 'started=now\n');
    expect(clearStaleCuaInstallLock(lockDir, () => false)).toBe(false);
    expect(fs.existsSync(lockDir)).toBe(true);

    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe('driver update download progress helpers', () => {
  it('extractCurlOutputPath parses -o targets from curl command lines', () => {
    expect(
      extractCurlOutputPath(
        'curl -fsSL -o /tmp/tmp.x1/cua-driver-rs-0.7.0-darwin-universal.tar.gz https://github.com/trycua/cua/releases/download/x.tar.gz',
      ),
    ).toBe('/tmp/tmp.x1/cua-driver-rs-0.7.0-darwin-universal.tar.gz');
    expect(extractCurlOutputPath('curl -fsSL -o "/tmp/with space/a.tar.gz" https://x')).toBe(
      '/tmp/with space/a.tar.gz',
    );
    expect(extractCurlOutputPath('curl -fsSL https://x')).toBeNull();
  });

  it('matchAssetSizeByFilename matches by basename', () => {
    const assets = [
      { name: 'cua-driver-rs-0.7.0-darwin-universal.tar.gz', size: 21147689 },
      { name: 'checksums.txt', size: 1437 },
    ];
    expect(
      matchAssetSizeByFilename(assets, '/tmp/tmp.abc/cua-driver-rs-0.7.0-darwin-universal.tar.gz'),
    ).toBe(21147689);
    expect(matchAssetSizeByFilename(assets, '/tmp/unknown.tar.gz')).toBeNull();
  });

  it('pickLatestCuaDriverRelease returns version and assets of the semver-max driver release', () => {
    const release = pickLatestCuaDriverRelease([
      { tag_name: 'agent-v0.8.4', assets: [{ name: 'other', size: 1 }] },
      {
        tag_name: 'cua-driver-rs-v0.6.8',
        assets: [{ name: 'cua-driver-rs-0.6.8-darwin-universal.tar.gz', size: 100 }],
      },
      {
        tag_name: 'cua-driver-rs-v0.7.0',
        assets: [
          { name: 'cua-driver-rs-0.7.0-darwin-universal.tar.gz', size: 21147689 },
          { name: 'bad-entry', size: 'not-a-number' },
        ],
      },
    ]);
    expect(release?.version).toBe('0.7.0');
    expect(release?.assets).toEqual([
      { name: 'cua-driver-rs-0.7.0-darwin-universal.tar.gz', size: 21147689 },
    ]);
    expect(pickLatestCuaDriverRelease([{ tag_name: 'cli-v0.1.12' }])).toBeNull();
  });

  it('maps the assets used by the official installer on every supported platform', () => {
    expect(getCuaDriverReleaseAssetName('0.7.0', 'darwin', 'arm64')).toBe(
      'cua-driver-rs-0.7.0-darwin-universal.tar.gz',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'linux', 'x64')).toBe(
      'cua-driver-rs-0.7.0-linux-x86_64-binary.tar.gz',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'linux', 'arm64')).toBe(
      'cua-driver-rs-0.7.0-linux-arm64-binary.tar.gz',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'linux', 'aarch64')).toBe(
      'cua-driver-rs-0.7.0-linux-arm64-binary.tar.gz',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'win32', 'x64')).toBe(
      'cua-driver-rs-0.7.0-windows-x86_64.zip',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'win32', 'x86_64')).toBe(
      'cua-driver-rs-0.7.0-windows-x86_64.zip',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'win32', 'arm64')).toBe(
      'cua-driver-rs-0.7.0-windows-arm64.zip',
    );
    expect(getCuaDriverReleaseAssetName('0.7.0', 'linux', 'riscv64')).toBeNull();
  });

  it('falls back when Windows os.machine() reports unknown', () => {
    expect(
      resolveCuaDriverHostArch('win32', 'unknown', {
        processArch: 'x64',
        env: { PROCESSOR_ARCHITECTURE: 'ARM64' },
      }),
    ).toBe('arm64');
    expect(
      getCuaDriverReleaseAssetName('0.7.0', 'win32', 'unknown', {
        processArch: 'x64',
        env: { PROCESSOR_ARCHITECTURE: 'ARM64' },
      }),
    ).toBe('cua-driver-rs-0.7.0-windows-arm64.zip');
    expect(
      getCuaDriverReleaseAssetName('0.7.0', 'win32', 'unknown', {
        processArch: 'arm64',
        env: {},
      }),
    ).toBe('cua-driver-rs-0.7.0-windows-arm64.zip');
  });
});

describe('review follow-ups: releases pagination and Windows idle timeout', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    resetComputerDriverUpdateStateForTests();
  });

  it('pages matching-refs only when a page is full, stopping at a short page', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      ref: `refs/tags/cua-driver-rs-v0.1.${i}`,
    }));
    const shortPage = [{ ref: 'refs/tags/cua-driver-rs-v0.7.0' }];
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => fullPage })
      .mockResolvedValueOnce({ ok: true, json: async () => shortPage })
      // assets by tag
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.7.0',
          assets: [currentPlatformReleaseAsset('0.7.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.7.0', updateAvailable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('takes semver max across all driver tags regardless of ref ordering', async () => {
    // matching-refs 按字母序返回,0.10.0 会排在 0.9.0 前 —— 必须数值比较
    mockDriverSpawn({ stdout: 'cua-driver 0.9.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.10.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.9.0' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.10.0',
          assets: [currentPlatformReleaseAsset('0.10.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.10.0', updateAvailable: true });
  });

  it('falls back when the newest tag has no published release', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
        ],
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.11.0',
          assets: [currentPlatformReleaseAsset('0.11.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.11.0', updateAvailable: true });
    expect(String(fetchImpl.mock.calls[1][0])).toContain('cua-driver-rs-v0.12.0');
    expect(String(fetchImpl.mock.calls[2][0])).toContain('cua-driver-rs-v0.11.0');
  });

  it('keeps probing past five incomplete tags to find an older installable update', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.6.0\n' });
    const fetchImpl = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
        { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
        { ref: 'refs/tags/cua-driver-rs-v0.10.0' },
        { ref: 'refs/tags/cua-driver-rs-v0.9.0' },
        { ref: 'refs/tags/cua-driver-rs-v0.8.0' },
        { ref: 'refs/tags/cua-driver-rs-v0.7.0' },
      ],
    });
    for (let index = 0; index < 5; index += 1) {
      fetchImpl.mockResolvedValueOnce({ ok: false, status: 404 });
    }
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        tag_name: 'cua-driver-rs-v0.7.0',
        assets: [currentPlatformReleaseAsset('0.7.0')],
      }),
    });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.7.0', updateAvailable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(7);
  });

  it('accepts installable releases that upstream marks as GitHub prereleases', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.11.0' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.11.0',
          prerelease: true,
          assets: [currentPlatformReleaseAsset('0.11.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.11.0', updateAvailable: true });
  });

  it('skips releases without the current-platform installer asset', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.12.0',
          assets: [{ name: 'checksums.txt', size: 100 }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.11.0',
          assets: [currentPlatformReleaseAsset('0.11.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.11.0', updateAvailable: true });
  });

  it('skips starter and zero-byte platform assets until an uploaded archive is available', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.13.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.13.0',
          assets: [{ ...currentPlatformReleaseAsset('0.13.0'), state: 'starter' }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.12.0',
          assets: [currentPlatformReleaseAsset('0.12.0', 0)],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.11.0',
          assets: [currentPlatformReleaseAsset('0.11.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.11.0', updateAvailable: true });
  });

  it('hides the updater when no newer tag is installable', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.12.0' }],
      })
      .mockResolvedValueOnce({ ok: false, status: 404 });

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: '0.10.0',
      latestVersion: '0.10.0',
      updateAvailable: false,
      updating: false,
    });
    const installerCallsBefore = spawnMock.mock.calls.length;
    await expect(updateComputerDriver()).rejects.toThrow(
      'no verified installable cua-driver update is available',
    );
    expect(spawnMock.mock.calls).toHaveLength(installerCallsBefore);
  });

  it('revalidates on click and falls back when the cached release disappears', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.12.0' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.12.0',
          assets: [currentPlatformReleaseAsset('0.12.0')],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.11.0',
          assets: [currentPlatformReleaseAsset('0.11.0')],
        }),
      });

    await checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch);
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    mockDriverSpawn({ stdout: 'installed\n' });
    mockDriverSpawn({ stdout: 'cua-driver 0.11.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    if (process.platform === 'darwin') {
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });
    }

    const installerCallsBefore = spawnMock.mock.calls.length;
    await updateComputerDriver(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch });
    const installerCall = spawnMock.mock.calls
      .slice(installerCallsBefore)
      .find((call) => String(call[0]).match(/bash|powershell/i));
    expect(installerCall?.[2]?.env?.CUA_DRIVER_RS_VERSION).toBe('0.11.0');
  });

  it('throttles panel refreshes after an update preflight performs a fallback check', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.12.0' }],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.12.0',
          assets: [currentPlatformReleaseAsset('0.12.0')],
        }),
      })
      // update click:cached target disappeared,then fallback sees no other candidate
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.12.0' }],
      });

    await checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
      await expect(
        updateComputerDriver(undefined, { fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).rejects.toThrow('no verified installable cua-driver update is available');

      // 预检失败后主缓存已是 no-update;同会话再次读取应直接清掉残留入口。
      await expect(
        checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
      ).resolves.toMatchObject({ updateAvailable: false, updating: false });

      const reopenedFetch = vi.fn().mockReturnValue(new Promise(() => {}));
      await expect(
        checkComputerDriverUpdate(reopenedFetch as unknown as typeof fetch),
      ).resolves.toMatchObject({ updateAvailable: false, updating: false });
      expect(reopenedFetch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed when a release probe fails with a server error', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.12.0' }],
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await expect(checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch)).resolves.toEqual({
      currentVersion: '0.10.0',
      latestVersion: null,
      updateAvailable: false,
      updating: false,
    });
  });

  it('continues to an older candidate after a transient release probe error', async () => {
    mockDriverSpawn({ stdout: 'cua-driver 0.10.0\n' });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { ref: 'refs/tags/cua-driver-rs-v0.12.0' },
          { ref: 'refs/tags/cua-driver-rs-v0.11.0' },
        ],
      })
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          tag_name: 'cua-driver-rs-v0.11.0',
          assets: [currentPlatformReleaseAsset('0.11.0')],
        }),
      });

    await expect(
      checkComputerDriverUpdate(fetchImpl as unknown as typeof fetch),
    ).resolves.toMatchObject({ latestVersion: '0.11.0', updateAvailable: true });
  });

  it('sends Authorization only when GITHUB_TOKEN/GH_TOKEN is present', async () => {
    const savedGithub = process.env.GITHUB_TOKEN;
    const savedGh = process.env.GH_TOKEN;
    try {
      delete process.env.GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
      const noAuthFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.5.8' }],
      });
      await checkComputerDriverUpdate(noAuthFetch as unknown as typeof fetch);
      expect(noAuthFetch.mock.calls[0][1].headers.Authorization).toBeUndefined();

      resetComputerDriverUpdateStateForTests();
      process.env.GITHUB_TOKEN = 'test-token';
      mockDriverSpawn({ stdout: 'cua-driver 0.5.8\n' });
      const authFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => [{ ref: 'refs/tags/cua-driver-rs-v0.5.8' }],
      });
      await checkComputerDriverUpdate(authFetch as unknown as typeof fetch);
      expect(authFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-token');
    } finally {
      if (savedGithub === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedGithub;
      if (savedGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = savedGh;
    }
  });

  it('join-only update never starts a fresh install when none is in flight', async () => {
    // resume 竞态防护:checkUpdate 报 updating 后原安装恰好完成,joinOnly
    // 调用只读状态返回,不 spawn 安装脚本。
    mockDriverSpawn({ stdout: 'cua-driver 0.7.0\n' });
    mockDriverSpawn({ stdout: 'Cua Driver daemon is running\n' });
    if (process.platform === 'darwin') {
      mockDriverSpawn({
        stdout:
          '{"accessibility":true,"screen_recording":true,"screen_recording_capturable":true,"source":{"attribution":"driver-daemon"}}\n',
      });
    }

    const result = await updateComputerDriver(undefined, { joinOnly: true });
    expect(result.ok).toBe(true);
    expect(result.status.installed).toBe(true);
    // 没有任何 bash/powershell 安装脚本被启动
    const installerRuns = spawnMock.mock.calls.filter((call) =>
      String(call[0]).match(/bash|powershell/i),
    ).length;
    expect(installerRuns).toBe(0);
  });

  it('includes download-file byte growth in the POSIX activity snapshot', async () => {
    if (process.platform === 'win32') return;
    const os = await import('node:os');
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const pathMod = await import('node:path');
    existsSyncMock.mockImplementation((candidate) => fs.existsSync(String(candidate)));
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'cua-dl-test-'));
    const file = pathMod.join(dir, 'cua-driver-rs-0.7.0-darwin-universal.tar.gz');
    fs.writeFileSync(file, Buffer.alloc(1024));

    // ps 输出:同 pgid 的 curl 行,CPU TIME 固定不变(慢速下载阻塞在网络 IO)
    const psLine = `4242  4300 0:00.01 curl -fsSL -o ${file} https://github.com/x.tar.gz\n`;
    mockDriverSpawn({ stdout: psLine });
    const first = await sampleInstallProcessTree(4242);

    fs.writeFileSync(file, Buffer.alloc(4096)); // 文件增长,进程快照不变
    mockDriverSpawn({ stdout: psLine });
    const second = await sampleInstallProcessTree(4242);

    expect(first).toContain('bytes:1024');
    expect(second).toContain('bytes:4096');
    expect(second).not.toBe(first); // 字节增长即活动
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('relaxes the install idle timeout to the hard cap on Windows only', () => {
    expect(installIdleTimeoutForPlatform('win32')).toBe(1_800_000);
    expect(installIdleTimeoutForPlatform('darwin')).toBe(180_000);
    expect(installIdleTimeoutForPlatform('linux')).toBe(180_000);
  });
});
