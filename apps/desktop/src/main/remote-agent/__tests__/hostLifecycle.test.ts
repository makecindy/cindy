/**
 * 被控端任务生命周期收尾：
 *  - 影子工作目录(同步过去的项目与个人说明副本)在任务收尾后删除，替换实例还在用时保留；
 *  - 去重 / 丢弃路径上的上传载荷显式取走，不留着占暂存配额到过期。
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRemoteAgentHost, hostSessionIdFor, type HostedStartInput } from '../host/runHost';

/** 协议层 id 是 36 位 UUID 形态。 */
const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';
const UPLOAD_1 = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOAD_2 = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let root: string;
let runsRoot: string;
let clock = 0;

function idleHandle(input: HostedStartInput): AgentSessionHandle {
  return {
    id: `sdk-${input.hostSessionId}`,
    agentKind: input.kind,
    model: input.options.model,
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    events: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        // 不产生事件。
      },
    }),
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
  };
}

function makeHost(started: Array<() => void>) {
  return createRemoteAgentHost({
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      started.shift()?.();
      return idleHandle(input);
    },
    isControllerAuthorized: () => true,
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot,
    now: () => clock,
  });
}

function openPayload(sessionId: string, projectFiles: Array<{ path: string; data: string }> = []) {
  return {
    sessionId,
    options: { model: 'claude-opus' },
    workspace: { workingDir: '/Users/me/proj', platform: 'darwin', shell: 'bash' },
    projectFiles,
    ancestorFiles: [],
    personal: { files: [] },
    mcpServers: [],
  };
}

/** 把载荷 gzip 后经 upload op 暂存，返回引用(uploadId 分段上传的形态)。 */
async function stageUpload(
  host: ReturnType<typeof createRemoteAgentHost>,
  uploadId: string,
  value: unknown,
): Promise<{ uploadId: string; chunks: number; bytes: number }> {
  const gz = gzipSync(Buffer.from(JSON.stringify(value ?? null), 'utf8'));
  await host.handle('controller-1', {
    op: 'upload',
    uploadId,
    index: 0,
    data: gz.toString('base64'),
  });
  return { uploadId, chunks: 1, bytes: gz.length };
}

function whenStarted(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-host-')));
  runsRoot = path.join(root, 'host');
  clock = 1_000;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionRoot(controller: string, sessionId: string): string {
  const controllerDir = createHash('sha256').update(controller).digest('hex').slice(0, 16);
  return path.join(runsRoot, 'workspaces', controllerDir, hostSessionIdFor(controller, sessionId));
}

describe('hosted shadow workspace cleanup', () => {
  it('removes the shadow workspace once the run is disposed', async () => {
    const starts: Array<() => void> = [];
    const first = whenStarted();
    starts.push(first.resolve);
    const host = makeHost(starts);
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_1, openPayload('task-1')) });
    await first.promise;
    expect(fs.existsSync(sessionRoot('controller-1', 'task-1'))).toBe(true);

    host.dispose();
    await settle();
    await vi.waitFor(() => expect(fs.existsSync(sessionRoot('controller-1', 'task-1'))).toBe(false));
  });

  it('keeps the workspace of a replacement run and removes it when that run ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const starts: Array<() => void> = [];
    const first = whenStarted();
    const second = whenStarted();
    starts.push(first.resolve, second.resolve);
    const host = makeHost(starts);
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_1, openPayload('task-1', [{ path: 'CLAUDE.md', data: Buffer.from('v1').toString('base64') }])) });
    await first.promise;
    // 同一任务重新打开：旧实例让位给新实例，目录按新内容重建。
    await host.handle('controller-1', { op: 'open', runId: RUN_2, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_2, openPayload('task-1', [{ path: 'CLAUDE.md', data: Buffer.from('v2').toString('base64') }])) });
    await second.promise;
    const sessionRootPath = sessionRoot('controller-1', 'task-1');
    expect(fs.readFileSync(path.join(sessionRootPath, 'fs', 'Users', 'me', 'proj', 'CLAUDE.md'), 'utf8')).toBe('v2');

    // 旧实例收尾保留期到点后被清理：替换实例还在用，目录必须保留。
    clock += 61_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(fs.existsSync(sessionRootPath)).toBe(true);
    expect(fs.readFileSync(path.join(sessionRootPath, 'fs', 'Users', 'me', 'proj', 'CLAUDE.md'), 'utf8')).toBe('v2');

    // 替换实例也结束后，目录随之删除。
    await host.handle('controller-1', { op: 'close', runId: RUN_2, mode: 'close', reason: 'navigation' });
    clock += 61_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    await vi.waitFor(() => expect(fs.existsSync(sessionRootPath)).toBe(false));
    host.dispose();
  });
});

describe('duplicate op payloads', () => {
  it('discards the staged upload of a duplicate open instead of leaving it until expiry', async () => {
    const starts: Array<() => void> = [];
    const first = whenStarted();
    starts.push(first.resolve);
    const host = makeHost(starts);
    const payload = openPayload('task-1');
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_1, payload) });
    await first.promise;

    // 同一 runId 重发 open(歧义交付后的重试)：按 id 去重，但载荷要取走。
    const ref2 = await stageUpload(host, UPLOAD_2, payload);
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: ref2 });
    await expect(host.handle('controller-1', { op: 'open', runId: RUN_2, agentKind: 'claude-code', payload: ref2 }))
      .rejects.toThrow(/upload is missing or expired/);
    host.dispose();
  });
});
