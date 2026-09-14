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
  it('setExtraDirs 后下一次 send 走 resume+fork,不用 fresh:true', async () => {
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
    sdkMock.query.mockReturnValue(firstQuery);
    const agent = new ClaudeCodeAgent(createDeps());
    const handle = await agent.startSession({
      sessionId: 'session-library-extradirs',
      model: 'claude-opus-4-6',
      workingDir,
      resumeSessionId: sdkSessionId,
    });

    const libraryRoot = '/Users/example/libraries/xd-mivo';
    await handle.setExtraDirs?.([libraryRoot]);

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
    expect(firstQuery.close).toHaveBeenCalled();

    const source = await fs.readFile(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain('pendingRewindTo = sdkSessionId');
    expect(source).toContain('directoryGrantRebuild ? {} : { resumeSessionAt: resumeAt }');
    expect(source).toContain('extraDirsCopyFallbackEnabled = false');

    await handle.close();
  });
});
