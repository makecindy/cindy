import { createServer as createHttpServer, request as httpRequest, type Server as HttpServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { generate as generateSelfSignedCert } from 'selfsigned';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { OutboundProxyTarget } from './outbound-proxy.js';
import { ipv6ToBytes, socks5Connect, Socks5HttpAgent, Socks5HttpsAgent } from './socks5.js';
import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import { startSocks5Stub as startStub, type Socks5Stub, type Socks5StubOptions } from './test-socks5-stub.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** 起桩并登记清理。 */
async function startSocks5Stub(options: Socks5StubOptions = {}): Promise<Socks5Stub> {
  const stub = await startStub(options);
  cleanups.push(() => stub.close());
  return stub;
}

function target(port: number, credentials?: { username: string; password: string }): OutboundProxyTarget {
  return {
    kind: 'socks5',
    url: `socks5://127.0.0.1:${port}`,
    hostname: '127.0.0.1',
    port,
    ...credentials,
  };
}

describe('ipv6ToBytes', () => {
  it('expands compressed forms and embedded IPv4', () => {
    expect(ipv6ToBytes('::1')?.toString('hex')).toBe('00000000000000000000000000000001');
    expect(ipv6ToBytes('2001:db8::1')?.toString('hex')).toBe('20010db8000000000000000000000001');
    expect(ipv6ToBytes('::ffff:1.2.3.4')?.toString('hex')).toBe('00000000000000000000ffff01020304');
    expect(ipv6ToBytes('fe80::1%en0')?.toString('hex')).toBe('fe800000000000000000000000000001');
    expect(ipv6ToBytes('2001:0db8:0000:0000:0000:0000:0000:0001')?.toString('hex'))
      .toBe('20010db8000000000000000000000001');
  });

  it('rejects malformed input instead of emitting a wrong address', () => {
    expect(ipv6ToBytes('2001:db8')).toBeNull();
    expect(ipv6ToBytes('gggg::1')).toBeNull();
    expect(ipv6ToBytes('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
});

describe('socks5Connect', () => {
  it('hands the destination domain to the proxy verbatim (ATYP=0x03, no local DNS)', async () => {
    // 本 feature 的核心:本机解不出上游域名也要能连上 —— 域名必须原样进 CONNECT 请求。
    const stub = await startSocks5Stub();
    const socket = await socks5Connect(target(stub.port), 'llm-proxy.example.invalid', 443);
    socket.destroy();

    expect(stub.requests).toEqual([{ atyp: 0x03, host: 'llm-proxy.example.invalid', port: 443 }]);
    expect(stub.offeredMethods).toEqual([[0x00]]);
  });

  it('encodes IPv4 / IPv6 literals with their own address types', async () => {
    const v4 = await startSocks5Stub();
    (await socks5Connect(target(v4.port), '93.184.216.34', 8443)).destroy();
    expect(v4.requests).toEqual([{ atyp: 0x01, host: '93.184.216.34', port: 8443 }]);

    const v6 = await startSocks5Stub();
    (await socks5Connect(target(v6.port), '2001:db8::1', 443)).destroy();
    expect(v6.requests).toEqual([{ atyp: 0x04, host: '2001:db8:0:0:0:0:0:1', port: 443 }]);
  });

  it('strips IPv6 brackets before classifying the destination', async () => {
    // 回归:上游 URL 里的 IPv6 经 WHATWG URL 解析后 hostname 恒带方括号,Node 又把它
    // 原样传到 agent 的 options.host。不剥就会当成域名(ATYP=0x03)连括号发出去,
    // 代理拿去做 DNS 解析必然失败。
    const stub = await startSocks5Stub();
    (await socks5Connect(target(stub.port), '[2001:db8::1]', 443)).destroy();
    expect(stub.requests).toEqual([{ atyp: 0x04, host: '2001:db8:0:0:0:0:0:1', port: 443 }]);
  });

  it('performs RFC 1929 username/password authentication with raw credentials', async () => {
    const stub = await startSocks5Stub({ requireAuth: true });
    const socket = await socks5Connect(
      target(stub.port, { username: 'user', password: 'p@ss' }),
      'upstream.invalid',
      443,
    );
    socket.destroy();

    expect(stub.offeredMethods).toEqual([[0x00, 0x02]]);
    expect(stub.credentials).toEqual([{ username: 'user', password: 'p@ss' }]);
  });

  it('reads bound addresses of every reply type so tunnel bytes stay clean', async () => {
    for (const replyAddressType of ['ipv4', 'domain', 'ipv6'] as const) {
      const upstream = createHttpServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ replyAddressType }));
      });
      const upstreamPort = await listenOnAvailableLoopbackPort(upstream);
      cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));
      const stub = await startSocks5Stub({ tunnelToPort: upstreamPort, replyAddressType });
      const agent = new Socks5HttpAgent(target(stub.port));
      cleanups.push(() => agent.destroy());

      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: 'upstream.invalid', port: 80, path: '/probe', agent }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => { text += chunk; });
          res.on('end', () => resolve(text));
        });
        req.on('error', reject);
        req.end();
      });
      expect(JSON.parse(body)).toEqual({ replyAddressType });
    }
  });

  it('surfaces authentication failure, method rejection, refusal and unreachable proxies distinctly', async () => {
    const authFail = await startSocks5Stub({ requireAuth: true, authShouldFail: true });
    await expect(socks5Connect(target(authFail.port, { username: 'u', password: 'bad' }), 'x.invalid', 443))
      .rejects.toThrow(/rejected the username\/password credentials/);

    const noMethod = await startSocks5Stub({ rejectAllMethods: true });
    await expect(socks5Connect(target(noMethod.port), 'x.invalid', 443))
      .rejects.toThrow(/requires authentication but none is configured/);

    const refused = await startSocks5Stub({ replyCode: 0x05 });
    await expect(socks5Connect(target(refused.port), 'x.invalid', 443))
      .rejects.toThrow(/CONNECT x\.invalid:443 failed: connection refused/);

    const hostUnreachable = await startSocks5Stub({ replyCode: 0x04 });
    await expect(socks5Connect(target(hostUnreachable.port), 'x.invalid', 443))
      .rejects.toThrow(/CONNECT x\.invalid:443 failed: host unreachable/);

    // 端口 1 基本必然拒绝连接;错误要指向代理不可达而非上游。
    await expect(socks5Connect(target(1), 'x.invalid', 443))
      .rejects.toThrow(/outbound proxy socks5:\/\/127\.0\.0\.1:1 unreachable/);
  });

  it('fails fast on credentials too long for the RFC 1929 length prefix', async () => {
    // parseOutboundProxyUrl 会把超长凭证降级成无凭证,但 agent 是公开导出的 ——
    // 宿主自己造 target 时长度会静默溢出成错误的帧(300 → 44),必须挡在发送前。
    const stub = await startSocks5Stub({ requireAuth: true });
    await expect(socks5Connect(target(stub.port, { username: 'u'.repeat(256), password: 'p' }), 'x.invalid', 443))
      .rejects.toThrow(/credentials exceed the RFC 1929 limit of 255 bytes/);
    await expect(socks5Connect(target(stub.port, { username: 'u', password: 'p'.repeat(256) }), 'x.invalid', 443))
      .rejects.toThrow(/credentials exceed the RFC 1929 limit of 255 bytes/);
  });

  it('rejects an auth reply whose subnegotiation version is not 0x01', async () => {
    // 版本对不上说明流已经错位,status 字节不可信,不能当认证成功继续。
    const stub = await startSocks5Stub({ requireAuth: true, authReplyVersion: 0x05 });
    await expect(socks5Connect(target(stub.port, { username: 'u', password: 'p' }), 'x.invalid', 443))
      .rejects.toThrow(/unexpected auth subnegotiation version 0x05/);
  });

  it('fails immediately when the proxy hangs up mid-handshake instead of waiting for the timeout', async () => {
    // 提前 EOF 必须当场失败:握手超时是 15s,空等到那里等于把一次请求白白挂死。
    // (本用例默认 5s 超时,退化成空等会直接测超时。)
    const stub = await startSocks5Stub({ closeAfterConnect: true });
    await expect(socks5Connect(target(stub.port), 'x.invalid', 443))
      .rejects.toThrow(/closed the connection during the SOCKS5 handshake/);
    expect(stub.requests).toEqual([{ atyp: 0x03, host: 'x.invalid', port: 443 }]);
  });

  it('rejects destinations that cannot be encoded instead of sending a truncated one', async () => {
    const stub = await startSocks5Stub();
    await expect(socks5Connect(target(stub.port), `${'a'.repeat(256)}.invalid`, 443))
      .rejects.toThrow(/cannot encode destination/);
  });
});

describe('Socks5HttpAgent', () => {
  it('sends origin-form requests to the real upstream (no absolute-form, no Host rewrite)', async () => {
    const seen: Array<{ url: string; host?: string }> = [];
    const upstream = createHttpServer((req, res) => {
      seen.push({ url: req.url ?? '', host: req.headers.host });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamPort = await listenOnAvailableLoopbackPort(upstream);
    cleanups.push(() => new Promise<void>((r) => upstream.close(() => r())));
    const stub = await startSocks5Stub({ tunnelToPort: upstreamPort });
    const agent = new Socks5HttpAgent(target(stub.port));
    cleanups.push(() => agent.destroy());

    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: 'gateway.invalid', port: 8080, path: '/v1/messages', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    });

    expect(status).toBe(200);
    // SOCKS 是 L4 隧道:请求行仍是 origin-form,Host 指向真实上游,目标由 CONNECT 携带。
    expect(seen).toEqual([{ url: '/v1/messages', host: 'gateway.invalid:8080' }]);
    expect(stub.requests).toEqual([{ atyp: 0x03, host: 'gateway.invalid', port: 8080 }]);
  });
});

describe('Socks5HttpsAgent', () => {
  // 测试自签证书运行时生成(CN/SAN = upstream.test),不在仓库里存任何 PEM 私钥。
  let tlsKey = '';
  let tlsCert = '';
  beforeAll(async () => {
    const pems = await generateSelfSignedCert([{ name: 'commonName', value: 'upstream.test' }], {
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'upstream.test' }] },
      ],
    });
    tlsKey = pems.private;
    tlsCert = pems.cert;
  });

  it('completes end-to-end TLS over the tunnel and reuses the keep-alive connection', async () => {
    const tls = createHttpsServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const tlsPort = await listenOnAvailableLoopbackPort(tls as unknown as HttpServer);
    cleanups.push(() => new Promise<void>((r) => tls.close(() => r())));
    const stub = await startSocks5Stub({ tunnelToPort: tlsPort });
    const agent = new Socks5HttpsAgent(target(stub.port));
    cleanups.push(() => agent.destroy());

    // ca + servername:对自签证书走完整 TLS 校验(链 + 身份),不禁用证书验证 ——
    // 证明隧道之上的 TLS 确实是端到端的。
    const request = (): Promise<number> => new Promise<number>((resolve, reject) => {
      const req = httpsRequest(
        { host: '127.0.0.1', port: tlsPort, path: '/probe', agent, ca: tlsCert, servername: 'upstream.test' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });

    expect(await request()).toBe(200);
    expect(await request()).toBe(200);
    // keep-alive:第二个请求复用同一条隧道,握手只发生一次。
    expect(stub.requests).toEqual([{ atyp: 0x01, host: '127.0.0.1', port: tlsPort }]);
  });

  it('surfaces handshake failures as request errors', async () => {
    const stub = await startSocks5Stub({ replyCode: 0x02 });
    const agent = new Socks5HttpsAgent(target(stub.port));
    cleanups.push(() => agent.destroy());

    await expect(new Promise<number>((resolve, reject) => {
      const req = httpsRequest({ host: 'upstream.invalid', port: 443, path: '/probe', agent }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end();
    })).rejects.toThrow(/CONNECT upstream\.invalid:443 failed: connection not allowed by ruleset/);
  });
});
