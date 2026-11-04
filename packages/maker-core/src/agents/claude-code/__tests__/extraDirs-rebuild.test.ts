/**
 * Claude 中途注入 extraDirs 必须走 rewind 同款 resume+fork 续聊,禁止 fresh:true。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';
import { sanitizeClaudeProjectKey } from '../claude-projects-fs.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

vi.mock('../../shared/image-resizer.js', () => ({
  getDefaultImageResizer: () => ({
    process: vi.fn(async (p: string) => p),
    validateBuffer: vi.fn(async () => true),
  }),
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalIdleTimeout = process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;

function createLogger(): Logger {
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

function createDeps(): AgentDeps {
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
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createLogger(),
  };
}

function createControlledStream() {
  const items: unknown[] = [];
  let waiter: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: unknown) => void } | null =
    null;
  let ended = false;
  const pump = (): void => {
    if (!waiter) return;
    if (items.length > 0) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: false, value: items.shift() });
      return;
    }
    if (ended) {
      const w = waiter;
      waiter = null;
      w.resolve({ done: true, value: undefined });
    }
  };
  return {
    emit(msg: unknown): void {
      items.push(msg);
      pump();
    },
    end(): void {
      ended = true;
      pump();
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise<IteratorResult<unknown>>((resolve, reject) => {
            waiter = { resolve, reject };
            pump();
          }),
      };
    },
  };
}

function createFakeQuery(stream = createControlledStream()) {
  let closed = false;
  return {
    stream,
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    setPermissionMode: vi.fn(async () => {
      if (closed) throw new Error('ProcessTransport is not ready for writing');
    }),
    setModel: vi.fn(async () => {
      if (closed) throw new Error('ProcessTransport is not ready for writing');
    }),
    applyFlagSettings: vi.fn(async () => {
      if (closed) throw new Error('ProcessTransport is not ready for writing');
    }),
    interrupt: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(() => {
      closed = true;
    }),
    rewindFiles: vi.fn(async () => ({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-extradirs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalIdleTimeout === undefined) delete process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS;
  else process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = originalIdleTimeout;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Claude extraDirs mid-session rebuild', () => {
  // 测试价值：startSession / send 必须把 hosted 虚拟目录传进 SDK Query，模型才能从原生环境信息看到它们。
  // Bug：hosted 曾省略 additionalDirectories；PR #8797 修复后又把旧控制端真实路径交给 SDK。
  // 最小失败输入：虚拟根内目录混入本机真实存在的根外目录，或缺少 mirrorRoot；启动与 setter 后都须隔离。
  // 原有用例只覆盖虚拟根内目录，无法发现旧协议下供应商同路径目录的 Skill / 说明加载越界。
  // tier：unit，SDK 用内存 fake，直接检查生产入口生成的 Query 协议与重建行为。
  it.each((['setExtraDirs', 'setWritableDirs'] as const).flatMap((setter) =>
    (['virtual', 'mixed', 'missing-root'] as const).map((scope) => ({ setter, scope })),
  ))('hosted $setter rebuild only exposes virtual directories: $scope', async ({ setter, scope }) => {
    const configDir = await makeTempDir();
    const mirrorRoot = path.join(await makeTempDir(), 'fs');
    const workingDir = path.join(mirrorRoot, 'workspace');
    const initialDir = path.join(mirrorRoot, 'additional', 'dir-0');
    const nextDir = path.join(mirrorRoot, 'additional', 'runtime-0');
    // 同前缀的兄弟目录确实存在：模拟两台电脑用户名相同的旧协议路径，不能靠目录不存在来兜底。
    const outsideDir = `${mirrorRoot}-other`;
    await Promise.all([workingDir, initialDir, nextDir, outsideDir].map((dir) => fs.mkdir(dir, { recursive: true })));
    const foreignDirs = scope === 'virtual' ? [] : [outsideDir];
    const extraDirs = [initialDir, ...(setter === 'setExtraDirs' ? foreignDirs : [])];
    const writableDirs = setter === 'setWritableDirs' ? foreignDirs : [];
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const sdkSessionId = 'sdk-hosted-extradirs';
    const projectDir = path.join(configDir, 'projects', sanitizeClaudeProjectKey(await fs.realpath(workingDir)));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${sdkSessionId}.jsonl`), '{"type":"summary"}\n', 'utf8');

    const firstQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(firstQuery);
    const handle = await new ClaudeCodeAgent(createDeps()).startSession({
      sessionId: 'session-hosted-extradirs',
      model: 'claude-opus-4-6',
      workingDir,
      resumeSessionId: sdkSessionId,
      extraDirs,
      writableDirs,
      deviceHosted: {
        workingDir,
        extraDirs,
        writableDirs,
        platform: process.platform,
        pathPlatform: process.platform,
        shell: 'bash',
        isGitRepo: false,
        tunnelUrl: 'http://127.0.0.1:4000/t/fixture/',
        tunnelToken: 'fixture',
        mcpServers: [],
        ...(scope === 'missing-root' ? {} : { mirrorRoot }),
      },
    });
    try {
      const initialOptions = sdkMock.query.mock.calls[0][0].options;
      expect.soft(initialOptions.additionalDirectories).toEqual(scope === 'missing-root' ? undefined : [initialDir]);
      expect(initialOptions.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep']));

      await handle[setter]?.([nextDir, ...foreignDirs]);
      expect(sdkMock.query).toHaveBeenCalledTimes(1);
      sdkMock.query.mockReturnValue(createFakeQuery());
      await handle.send({ type: 'user', content: 'inspect the attached directory' });

      expect(sdkMock.query).toHaveBeenCalledTimes(2);
      const rebuiltOptions = sdkMock.query.mock.calls[1][0].options;
      expect(rebuiltOptions.additionalDirectories).toEqual(scope === 'missing-root'
        ? undefined
        : setter === 'setWritableDirs' ? [initialDir, nextDir] : [nextDir]);
      expect(rebuiltOptions.resume).toBe(sdkSessionId);
      expect(rebuiltOptions.forkSession).toBe(true);
      expect(rebuiltOptions.resumeSessionAt).toBeUndefined();
      expect(rebuiltOptions).not.toHaveProperty('fresh');
      expect(rebuiltOptions.disallowedTools).toEqual(initialOptions.disallowedTools);
      expect(firstQuery.close).toHaveBeenCalled();
    } finally {
      await handle.close();
    }
  });

  it.each(['none', 'remove', 'disable', 'enable'] as const)('setExtraDirs rebuild preserves conversation and launch skill preferences: %s', async (change) => {
    const configDir = await makeTempDir();
    const workingDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    const sdkSessionId = 'sdk-live-library';
    const normalized = await fs.realpath(workingDir);
    const projectDir = path.join(configDir, 'projects', sanitizeClaudeProjectKey(normalized));
    await fs.mkdir(projectDir, { recursive: true });
    await fs.writeFile(path.join(projectDir, `${sdkSessionId}.jsonl`), '{"type":"summary"}\n', 'utf8');

    const firstQuery = createFakeQuery();
    const closeFirstQuery = firstQuery.close;
    sdkMock.query.mockReturnValue(firstQuery);
    const deps = createDeps();
    const managedDir = path.join(configDir, 'managed', 'example--demo');
    let disabledPaths = change === 'enable' ? [managedDir] : [];
    deps.getDisabledSkillPaths = () => disabledPaths;
    if (change !== 'none') {
      await fs.mkdir(managedDir, { recursive: true });
      await fs.writeFile(path.join(managedDir, 'SKILL.md'), '---\nname: demo\ndescription: Fixture\n---\nBody');
      deps.getManagedSkills = vi.fn(async () => await fs.stat(managedDir).then(() => [{
        kind: 'agent-skill' as const, name: 'demo', source: 'skill' as const,
        path: path.join(managedDir, 'SKILL.md'), claudeCommandName: 'cindy-plugin-example:demo',
      }]).catch(() => []));
    }
    const agent = new ClaudeCodeAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'session-library-extradirs',
      model: 'claude-opus-4-6',
      workingDir,
      resumeSessionId: sdkSessionId,
    });

    if (change === 'remove' || change === 'disable') {
      expect(sdkMock.query.mock.calls[0]?.[0].options.plugins).toHaveLength(1);
    } else {
      expect(sdkMock.query.mock.calls[0]?.[0].options.plugins).toBeUndefined();
    }
    if (change === 'remove') {
      await fs.rm(managedDir, { recursive: true });
    }
    if (change === 'disable') disabledPaths = [managedDir];
    if (change === 'enable') disabledPaths = [];
    const libraryRoot = '/Users/example/libraries/xd-mivo';
    await handle.setExtraDirs?.([libraryRoot], libraryRoot);

    const secondQuery = createFakeQuery();
    sdkMock.query.mockReturnValue(secondQuery);
    await handle.send({ type: 'user', content: 'read the canvas asset' });

    expect(sdkMock.query).toHaveBeenCalledTimes(2);
    const rebuildArgs = sdkMock.query.mock.calls[1]?.[0] as {
      options: Record<string, unknown>;
    };
    expect(rebuildArgs.options.forkSession).toBe(true);
    expect(rebuildArgs.options.resume).toBe(sdkSessionId);
    expect(rebuildArgs.options.additionalDirectories).toEqual([libraryRoot]);
    expect(rebuildArgs.options.resumeSessionAt).toBeUndefined();
    expect(rebuildArgs.options).not.toHaveProperty('fresh');
    expect(closeFirstQuery).toHaveBeenCalled();
    if (change !== 'none') {
      expect(deps.getManagedSkills).toHaveBeenCalledTimes(2);
    }
    if (change === 'disable') {
      expect(rebuildArgs.options.plugins).toHaveLength(1);
    } else {
      expect(rebuildArgs.options.plugins).toBeUndefined();
    }
    const wire = sdkMock.query.mock.calls[1][0].prompt as AsyncIterable<{ message: { content: unknown } }>;
    const next = await wire[Symbol.asyncIterator]().next();
    expect(JSON.stringify(next.value.message.content)).toContain('libraryRoot');
    expect(JSON.stringify(next.value.message.content)).toContain(libraryRoot);


    const source = await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain('pendingRewindTo = durableSdkSessionId');
    expect(source).toContain('directoryGrantRebuild ? {} : { resumeSessionAt: resumeAt }');
    expect(source).toContain('extraDirsCopyFallbackEnabled = false');
    expect(source).toContain('下一 turn 生效,不用 fresh:true');
    expect(source).not.toContain('每 turn 读最新值传给 SDK options.additionalDirectories — 即时生效');

    await handle.close();
  });
});
