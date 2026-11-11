/**
 * claude-cli-proxy-bridge —— 本机 CONNECT 端口,每条隧道按目标重新解析出口(直连 / HTTP 代理 /
 * SOCKS5);只做 TCP 转发、只接受 CONNECT。
 */
import http from 'node:http';
import { connect as netConnect, createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { startSocks5Stub, type Socks5Stub } from '../../../../../../packages/anthropic-compat-proxy/src/test-socks5-stub.js';
import { closeClaudeCliProxyBridge, ensureClaudeCliProxyBridge } from '../claude-cli-proxy-bridge.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  await closeClaudeCliProxyBridge();
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function listen(server: Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function startEchoServer(): Promise<number> {
  return listen(createServer((socket) => socket.pipe(socket)));
}

/** 最小 HTTP CONNECT 代理:记录目标,一律接到 tunnelToPort。 */
async function startHttpConnectProxy(tunnelToPort: number): Promise<{ port: number; targets: string[] }> {
  const targets: string[] = [];
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on('connect', (req, client: Socket) => {
    targets.push(req.url ?? '');
    const upstream = netConnect(tunnelToPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  return { port: await listen(server), targets };
}

async function startStub(options: Parameters<typeof startSocks5Stub>[0]): Promise<Socks5Stub> {
  const stub = await startSocks5Stub(options);
  cleanups.push(() => stub.close());
  return stub;
}

function bridgePort(url: string): number {
  return Number(new URL(url).port);
}

/** 向桥发一段原始请求;收到响应头后可再发数据,读到 `until` 出现(或连接关闭)为止。 */
function exchange(port: number, request: string, until: string, followUp?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, '127.0.0.1');
    let received = '';
    let sent = false;
    socket.on('data', (chunk) => {
      received += chunk.toString('utf8');
      if (followUp && !sent && received.includes('\r\n\r\n')) {
        sent = true;
        socket.write(followUp);
      }
      if (received.includes(until)) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(received));
    socket.write(request);
  });
}

const connectTo = (authority: string) => `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`;

describe('claude-cli-proxy-bridge', () => {
  it('SOCKS5 出口:经代理打隧道,域名交给代理解析,数据原样双向转发', async () => {
    const echoPort = await startEchoServer();
    const stub = await startStub({ tunnelToPort: echoPort });
    const resolver = vi.fn(async () => `socks5://127.0.0.1:${stub.port}`);
    const url = await ensureClaudeCliProxyBridge(resolver);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const received = await exchange(bridgePort(url), connectTo('api.anthropic.com:443'), 'ping', 'ping');
    expect(received).toContain('HTTP/1.1 200 Connection Established');
    expect(received).toContain('ping');
    expect(resolver).toHaveBeenCalledWith('https://api.anthropic.com/');
    expect(stub.requests).toEqual([expect.objectContaining({ host: 'api.anthropic.com', port: 443 })]);
  });

  it('HTTP 代理出口:经上游 CONNECT', async () => {
    const echoPort = await startEchoServer();
    const proxy = await startHttpConnectProxy(echoPort);
    const url = await ensureClaudeCliProxyBridge(async () => `http://127.0.0.1:${proxy.port}`);
    const received = await exchange(bridgePort(url), connectTo('claude.ai:443'), 'hello', 'hello');
    expect(received).toContain('HTTP/1.1 200 Connection Established');
    expect(received).toContain('hello');
    expect(proxy.targets).toEqual(['claude.ai:443']);
  });

  it('按目标逐条判定:PAC 例外 / 内网主机直连,其余走代理', async () => {
    const echoPort = await startEchoServer();
    const stub = await startStub({ tunnelToPort: echoPort });
    const resolver = vi.fn(async (target: string) =>
      target.startsWith('https://127.0.0.1') ? null : `socks5://127.0.0.1:${stub.port}`);
    const url = await ensureClaudeCliProxyBridge(resolver);

    const direct = await exchange(bridgePort(url), connectTo(`127.0.0.1:${echoPort}`), 'intranet', 'intranet');
    expect(direct).toContain('intranet');
    expect(resolver).toHaveBeenCalledWith(`https://127.0.0.1:${echoPort}/`);
    expect(stub.requests).toEqual([]);

    await exchange(bridgePort(url), connectTo('api.anthropic.com:443'), 'x', 'x');
    expect(stub.requests).toEqual([expect.objectContaining({ host: 'api.anthropic.com', port: 443 })]);
  });

  it('CONNECT 到 80 端口也能解析目标', async () => {
    const stub = await startStub({ tunnelToPort: await startEchoServer() });
    const resolver = vi.fn(async () => `socks5://127.0.0.1:${stub.port}`);
    const url = await ensureClaudeCliProxyBridge(resolver);
    await exchange(bridgePort(url), connectTo('example.test:80'), 'x', 'x');
    expect(resolver).toHaveBeenCalledWith('https://example.test:80/');
    expect(stub.requests).toEqual([expect.objectContaining({ host: 'example.test', port: 80 })]);
  });

  it('只接受 CONNECT:明文 HTTP 请求 405,不做正向代理', async () => {
    const resolver = vi.fn(async () => null);
    const url = await ensureClaudeCliProxyBridge(resolver);
    const received = await exchange(
      bridgePort(url),
      'GET http://example.test/ HTTP/1.1\r\nHost: example.test\r\n\r\n',
      'CONNECT only',
    );
    expect(received).toContain('405');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('上游建隧道失败 → 502', async () => {
    const stub = await startStub({ replyCode: 0x05 });
    const url = await ensureClaudeCliProxyBridge(async () => `socks5://127.0.0.1:${stub.port}`);
    const received = await exchange(bridgePort(url), connectTo('api.anthropic.com:443'), '502');
    expect(received).toContain('HTTP/1.1 502 Bad Gateway');
  });

  it('复用同一个端口;新隧道用最近一次给的解析器', async () => {
    const echoPort = await startEchoServer();
    const first = await startStub({ tunnelToPort: echoPort });
    const second = await startStub({ tunnelToPort: echoPort });
    const urlA = await ensureClaudeCliProxyBridge(async () => `socks5://127.0.0.1:${first.port}`);
    const urlB = await ensureClaudeCliProxyBridge(async () => `socks5://127.0.0.1:${second.port}`);
    expect(urlB).toBe(urlA);
    await exchange(bridgePort(urlB), connectTo('claude.ai:443'), 'x', 'x');
    expect(first.requests).toEqual([]);
    expect(second.requests).toEqual([expect.objectContaining({ host: 'claude.ai', port: 443 })]);
  });
});
