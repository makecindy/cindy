/**
 * server.test.ts
 * ---------------------------------------------------------------------------
 * 回环 HTTP 入口的行为契约:鉴权先行、路由形状、错误状态码。
 * 真起 socket(listen(0) 内核分配端口),因为这里要验的正是 HTTP 层本身;
 * service 用内存 fake,不碰 maker / 数据库。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { startPartnerBridgeServer, type PartnerBridgeServer } from '../server.js';
import type { PartnerTaskService } from '../taskService.js';
import type { PartnerTaskRecord } from '../types.js';

const TOKEN = 'test-token-0123456789';

function taskRecord(overrides: Partial<PartnerTaskRecord> = {}): PartnerTaskRecord {
  return {
    taskId: 'ptask-known',
    key: 'k',
    prompt: 'p',
    sessionId: 'sess-1',
    status: 'running',
    text: null,
    attachments: [],
    errorCode: null,
    error: null,
    createdAt: 1,
    finishedAt: null,
    ...overrides,
  };
}

function createService(): PartnerTaskService {
  return {
    submit: async (request) =>
      request.prompt
        ? { ok: true, task: taskRecord({ key: request.key, prompt: request.prompt }) }
        : { ok: false, errorCode: 'INVALID_REQUEST', message: 'prompt 不能为空' },
    get: (taskId) => (taskId === 'ptask-known' ? taskRecord() : null),
    cancel: async (taskId) =>
      taskId === 'ptask-known'
        ? { ok: true, task: taskRecord({ status: 'cancelled' }) }
        : { ok: false, errorCode: 'NOT_FOUND', message: '没有这个任务' },
    runningCount: () => 0,
  };
}

let server: PartnerBridgeServer | null = null;

afterEach(async () => {
  await server?.shutdown();
  server = null;
});

async function start(): Promise<string> {
  server = await startPartnerBridgeServer({
    service: createService(),
    token: TOKEN,
    log: { info: () => {}, warn: () => {} },
  });
  return `http://127.0.0.1:${server.port}`;
}

describe('partner bridge server', () => {
  it('没有 token / 错误 token 一律 401', async () => {
    const base = await start();
    const noToken = await fetch(`${base}/v1/health`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`${base}/v1/health`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrongToken.status).toBe(401);
  });

  it('health 与任务提交走通', async () => {
    const base = await start();
    const headers = { authorization: `Bearer ${TOKEN}` };

    const health = await fetch(`${base}/v1/health`, { headers });
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, version: 1, running: 0 });

    const submitted = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'k', prompt: '干点活' }),
    });
    expect(submitted.status).toBe(202);
    const body = (await submitted.json()) as { taskId: string; status: string };
    expect(body.taskId).toBe('ptask-known');
    expect(body.status).toBe('running');
  });

  it('任务查询与取消按状态码分流', async () => {
    const base = await start();
    const headers = { authorization: `Bearer ${TOKEN}` };

    expect((await fetch(`${base}/v1/tasks/ptask-known`, { headers })).status).toBe(200);
    expect((await fetch(`${base}/v1/tasks/missing`, { headers })).status).toBe(404);
    expect(
      (await fetch(`${base}/v1/tasks/ptask-known/cancel`, { method: 'POST', headers })).status,
    ).toBe(200);
    expect(
      (await fetch(`${base}/v1/tasks/missing/cancel`, { method: 'POST', headers })).status,
    ).toBe(404);
  });

  it('非法请求体与错误方法被明确拒绝', async () => {
    const base = await start();
    const headers = { authorization: `Bearer ${TOKEN}` };

    const empty = await fetch(`${base}/v1/tasks`, { method: 'POST', headers });
    expect(empty.status).toBe(400);
    const broken = await fetch(`${base}/v1/tasks`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(broken.status).toBe(400);
    const wrongMethod = await fetch(`${base}/v1/tasks`, { headers });
    expect(wrongMethod.status).toBe(405);
    const unknown = await fetch(`${base}/v1/nope`, { headers });
    expect(unknown.status).toBe(404);
  });
});
