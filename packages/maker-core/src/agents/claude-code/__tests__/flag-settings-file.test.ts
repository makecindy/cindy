import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  DEVICE_HOSTED_GUEST_ROUTE_HEADER,
  type AgentDeps,
  type DeviceHostedSession,
} from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const writeFileMock = vi.fn();
const mkdtempMock = vi.fn();

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdtemp: (...args: Parameters<typeof actual.promises.mkdtemp>) => mkdtempMock(...args),
      writeFile: (...args: unknown[]) => writeFileMock(...args),
    },
  };
});

// 被测模块导入的是被 mock 过的命名空间, 断言侧要走真实实现, 否则会自我递归。
const realFs = (await vi.importActual<typeof import('node:fs')>('node:fs')).promises;

const { materializeClaudeFlagSettings, CLAUDE_INLINE_SETTINGS_ARGV_BUDGET } = await import(
  '../flag-settings-file.js'
);
const { ClaudeCodeAgent } = await import('../index.js');

const longSettings = () => ({
  availableModels: Array.from({ length: 1000 }, (_, index) => `vendor/model-${index}-gateway-route`),
});

const createdDirs: string[] = [];

beforeEach(() => {
  writeFileMock.mockReset();
  mkdtempMock.mockReset();
  createdDirs.length = 0;
  writeFileMock.mockImplementation(realFs.writeFile);
  mkdtempMock.mockImplementation(async (...args: Parameters<typeof realFs.mkdtemp>) => {
    const dir = await realFs.mkdtemp(...args);
    createdDirs.push(dir);
    return dir;
  });
});

describe('materializeClaudeFlagSettings', () => {
  it('keeps short settings inline without touching the filesystem', async () => {
    const settings = { apiKeyHelper: '' };
    await expect(materializeClaudeFlagSettings(settings)).resolves.toEqual({ kind: 'inline', settings });
    expect(mkdtempMock).not.toHaveBeenCalled();
  });

  it('removes the temp directory when the first write fails', async () => {
    writeFileMock.mockRejectedValueOnce(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

    await expect(materializeClaudeFlagSettings(longSettings())).rejects.toMatchObject({ code: 'ENOSPC' });

    // mkdtemp 已经建成目录, 写入失败时调用方拿不到 disposer, 只能由这里删掉。
    expect(createdDirs).toHaveLength(1);
    expect(path.dirname(createdDirs[0])).toBe(os.tmpdir());
    await expect(realFs.stat(createdDirs[0])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes a long catalog to a file and disposes it', async () => {
    const delivery = await materializeClaudeFlagSettings(longSettings());
    expect(delivery.kind).toBe('file');
    if (delivery.kind !== 'file') return;
    const parsed = JSON.parse(await realFs.readFile(delivery.settingsPath, 'utf8')) as {
      availableModels: string[];
    };
    expect(parsed.availableModels).toHaveLength(1000);
    expect(JSON.stringify(longSettings()).length).toBeGreaterThan(CLAUDE_INLINE_SETTINGS_ARGV_BUDGET);
    await delivery.dispose();
    await expect(realFs.stat(delivery.settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// 测试价值：受邀者路由令牌是凭证。设置超过命令行上限时会整份序列化进临时文件，
// 文件里不能出现 routeToken；会话仍要从子进程环境拿到同一个请求头。
// 最小输入：一个受邀者会话 + 一份超过内联预算的模型白名单；tier unit，无进程或网络。
const ROUTE_TOKEN = 'guest-route-token-must-not-hit-disk';
const sessionTempDirs: string[] = [];
const liveHandles: Array<{ close: () => Promise<void> }> = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createFakeQuery() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async () => []),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

describe('guest route token stays off spilled settings files', () => {
  afterEach(async () => {
    await Promise.all(liveHandles.splice(0).map((handle) => handle.close()));
    sdkMock.query.mockReset();
    if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    await Promise.all(sessionTempDirs.splice(0).map((dir) => realFs.rm(dir, { recursive: true, force: true })));
  });

  it('writes an over-budget guest catalog without the route token, and still passes the header on env', async () => {
    const configDir = await realFs.mkdtemp(path.join(os.tmpdir(), 'maker-core-flag-settings-'));
    sessionTempDirs.push(configDir);
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = path.join(configDir, 'workspace');
    await realFs.mkdir(workingDir, { recursive: true });
    sdkMock.query.mockReturnValue(createFakeQuery());

    const modelIds = Array.from({ length: 1000 }, (_, index) => `shared/model-${index}-gateway-route`);
    const auth: AuthAdapter = {
      async getState() {
        return { authenticated: true };
      },
      async triggerLogin() {
        return { authenticated: true };
      },
      async logout() {},
      async getAuthEnv() {
        return {};
      },
    };
    const deps: AgentDeps = {
      auth,
      runtimeConfig: {},
      binaryPath: process.execPath,
      logger: createNoopLogger(),
    };
    const deviceHosted: DeviceHostedSession = {
      workingDir,
      extraDirs: [],
      writableDirs: [],
      platform: 'darwin',
      shell: 'zsh',
      isGitRepo: false,
      tunnelUrl: 'http://127.0.0.1:4000/t/tok/',
      tunnelToken: 'tok',
      mcpServers: [],
      guest: true,
      guestProvider: { providerId: 'shared-provider', modelIds, routeToken: ROUTE_TOKEN },
    };
    const handle = await new ClaudeCodeAgent(deps).startSession({
      sessionId: 'guest-flag-settings',
      model: modelIds[0]!,
      providerId: 'shared-provider',
      workingDir,
      permissionMode: 'acceptEdits',
      deviceHosted,
    });
    liveHandles.push(handle);

    const options = sdkMock.query.mock.calls.at(-1)?.[0]?.options as {
      env?: Record<string, string>;
      settings?: string;
    } | undefined;
    if (!options) throw new Error('expected sdk query options');
    expect(typeof options.settings).toBe('string');
    const written = await realFs.readFile(options.settings as string, 'utf8');
    expect(written).not.toContain(ROUTE_TOKEN);
    expect(written).not.toContain('ANTHROPIC_CUSTOM_HEADERS');
    expect(options.env?.ANTHROPIC_CUSTOM_HEADERS?.split('\n')).toContain(
      `${DEVICE_HOSTED_GUEST_ROUTE_HEADER}: ${ROUTE_TOKEN}`,
    );
  });
});
