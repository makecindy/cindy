/**
 * 自定义渠道本机端点的行为契约: 走 Unix domain socket(不占端口),
 * 鉴权先行、按连接路由、body 校验、超限拒绝、重启复用同一路径。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  normalizeInbound,
  readPersistedSocketPath,
  resolveSocketPath,
  startCustomEndpoint,
  urlFor,
  type CustomEndpointHandle,
} from '../endpoint';

const TOKEN = 'a'.repeat(64);

let endpoint: CustomEndpointHandle | null = null;
let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-im-'));
});

afterEach(async () => {
  await endpoint?.shutdown();
  endpoint = null;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

interface Res {
  status: number;
  body: string;
}

/** 走 socket 文件发请求(测试里不依赖 curl)。 */
function request(
  socketPath: string,
  pathname: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        agent: false,
        path: pathname,
        method: options.method ?? 'POST',
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

async function start(): Promise<CustomEndpointHandle> {
  endpoint = await startCustomEndpoint({
    discoveryDir: dir,
    log: { info: () => {}, warn: () => {} },
  });
  return endpoint;
}

describe('custom im endpoint (unix socket)', () => {
  it.skipIf(process.platform === 'win32')('不监听任何 TCP 端口, socket 文件权限 0600', async () => {
    const handle = await start();
    const stat = fs.statSync(handle.socketPath);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('没有 token / 错 token 都是 401, 且不触发投递', async () => {
    const handle = await start();
    let delivered = 0;
    handle.register('abc123', { token: TOKEN, handle: () => void (delivered += 1) });
    const target = '/im/custom/abc123/inbound';

    expect((await request(handle.socketPath, target, { body: '{}' })).status).toBe(401);
    expect(
      (
        await request(handle.socketPath, target, {
          headers: { authorization: 'Bearer nope' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(delivered).toBe(0);
  });

  it('未知连接 404, 合法请求 202 并投递', async () => {
    const handle = await start();
    const seen: unknown[] = [];
    handle.register('abc123', { token: TOKEN, handle: (m) => void seen.push(m) });
    const headers = { authorization: `Bearer ${TOKEN}` };

    expect(
      (
        await request(handle.socketPath, '/im/custom/missing/inbound', {
          headers,
          body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
        })
      ).status,
    ).toBe(404);

    const ok = await request(handle.socketPath, '/im/custom/abc123/inbound', {
      headers,
      body: JSON.stringify({ conversationId: 'c1', text: 'hi' }),
    });
    expect(ok.status).toBe(202);
    expect(seen).toEqual([{ conversationId: 'c1', text: 'hi' }]);
  });

  it('非法 body 400; 超过 1MiB 413; 非 POST 405', async () => {
    const handle = await start();
    const delivered: unknown[] = [];
    handle.register('abc123', { token: TOKEN, handle: (message) => void delivered.push(message) });
    const headers = { authorization: `Bearer ${TOKEN}` };
    const target = '/im/custom/abc123/inbound';

    expect((await request(handle.socketPath, target, { headers, body: '{nope' })).status).toBe(400);
    expect(
      (
        await request(handle.socketPath, target, {
          headers,
          body: JSON.stringify({ conversationId: 'c1', text: 'x'.repeat(1_100_000) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (await request(handle.socketPath, target, { method: 'GET', headers })).status,
    ).toBe(405);
    expect(delivered).toEqual([]);
    const accepted = await request(handle.socketPath, target, {
      headers,
      body: JSON.stringify({ conversationId: 'c1', text: 'after-oversized-body' }),
    });
    expect(accepted.status).toBe(202);
    expect(delivered).toEqual([{ conversationId: 'c1', text: 'after-oversized-body' }]);
  });

  it('发现文件只含 socketPath, 不含 token, 权限 0600', async () => {
    const handle = await start();
    const file = path.join(dir, 'endpoint.json');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(body.socketPath).toBe(handle.socketPath);
    expect(JSON.stringify(body)).not.toContain('token');
    expect(body.port).toBeUndefined();
  });

  it('重启复用同一 socket 路径, 探测旧文件不误删在用的 socket', async () => {
    const first = await start();
    const socketPath = first.socketPath;
    expect(readPersistedSocketPath(dir)).toBe(socketPath);

    // 同一 socket 已被监听: 第二次启动必须明确失败, 且不破坏第一个实例。
    await expect(
      startCustomEndpoint({
        discoveryDir: dir,
        log: { info: () => {}, warn: () => {} },
      }),
    ).rejects.toThrow(/CUSTOM_ENDPOINT_SOCKET_IN_USE/);

    const handle = first;
    handle.register('abc123', { token: TOKEN, handle: () => {} });
    const ok = await request(socketPath, '/im/custom/abc123/inbound', {
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ conversationId: 'c1', text: 'still-alive' }),
    });
    expect(ok.status).toBe(202);
  });

  it.skipIf(process.platform === 'win32')('进程被强杀留下的 socket 文件会被清理后重建', async () => {
    const socketPath = resolveSocketPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    // 真造一次崩溃: 子进程监听 socket 后被 SIGKILL, 文件留在原地且没人监听。
    const child = spawn(
      process.execPath,
      ['-e', 'require("net").createServer().listen(process.argv[1]);setInterval(()=>{},1e6)', socketPath],
      { stdio: 'ignore' },
    );
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    expect(fs.statSync(socketPath).isSocket()).toBe(true);

    endpoint = await startCustomEndpoint({
      discoveryDir: dir,
      log: { info: () => {}, warn: () => {} },
    });
    expect(endpoint.socketPath).toBe(socketPath);
  });

  it('崩溃残留的 socket 文件会被清理后重建', async () => {
    const socketPath = resolveSocketPath(dir);
    fs.mkdirSync(dir, { recursive: true });
    // 造一个没人监听的 socket 占位文件。
    const tmpServer = http.createServer();
    await new Promise<void>((r) => tmpServer.listen(socketPath, () => r()));
    await new Promise<void>((r) => tmpServer.close(() => r()));
    // Node 关闭后可能已删除; 若还在则保留原文件, 由启动逻辑判定不可连后清掉。

    endpoint = await startCustomEndpoint({
      discoveryDir: dir,
      log: { info: () => {}, warn: () => {} },
    });
    expect(endpoint.socketPath).toBe(socketPath);
  });
});

describe('normalizeInbound', () => {
  it('要求 conversationId 与 text, 只收绝对路径附件', () => {
    expect(normalizeInbound({ text: 'hi' })).toBeNull();
    expect(normalizeInbound({ conversationId: 'c1', text: '  ' })).toBeNull();
    expect(
      normalizeInbound({
        conversationId: 'c1',
        text: 'hi',
        attachments: [{ absPath: '/tmp/a.txt' }, { absPath: 'rel.txt' }],
      }),
    ).toEqual({ conversationId: 'c1', text: 'hi', attachments: [{ absPath: '/tmp/a.txt' }] });
  });
});

describe('urlFor', () => {
  it('给出稳定的调用地址(实际请求走 --unix-socket)', () => {
    expect(urlFor('abc123')).toBe('http://localhost/im/custom/abc123/inbound');
  });
});
