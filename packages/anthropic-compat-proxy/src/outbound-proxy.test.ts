import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { generate as generateSelfSignedCert } from 'selfsigned';
import { beforeAll, describe, expect, it, afterEach } from 'vitest';

import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import {
  createEnvOutboundProxyResolver,
  formatAuthority,
  formatHostHeader,
  hasProxyEnvConfig,
  isLoopbackHostname,
  outboundProxyAgentKey,
  parseOutboundProxyUrl,
  redactProxyUrlForLog,
  TunnelingHttpsAgent,
  type OutboundProxyTarget,
} from './outbound-proxy.js';

describe('parseOutboundProxyUrl', () => {
  it('parses plain http proxy urls', () => {
    expect(parseOutboundProxyUrl('http://127.0.0.1:7890')).toEqual({
      kind: 'http',
      url: 'http://127.0.0.1:7890',
      hostname: '127.0.0.1',
      port: 7890,
      authHeader: undefined,
    });
  });

  it('defaults to port 80 when omitted', () => {
    expect(parseOutboundProxyUrl('http://proxy.corp')?.port).toBe(80);
  });

  it('turns userinfo into a basic Proxy-Authorization header and strips it from url', () => {
    const parsed = parseOutboundProxyUrl('http://user:p%40ss@127.0.0.1:8080');
    expect(parsed?.url).toBe('http://127.0.0.1:8080');
    expect(parsed?.authHeader).toBe(`Basic ${Buffer.from('user:p@ss').toString('base64')}`);
  });

  it('rejects unsupported schemes and garbage', () => {
    // https: = TLS-to-proxy, socks4/4a = 无认证无 IPv6 的老协议,都不支持。
    expect(parseOutboundProxyUrl('https://127.0.0.1:7890')).toBeNull();
    expect(parseOutboundProxyUrl('socks4://127.0.0.1:1080')).toBeNull();
    expect(parseOutboundProxyUrl('socks4a://127.0.0.1:1080')).toBeNull();
    expect(parseOutboundProxyUrl('not a url')).toBeNull();
    expect(parseOutboundProxyUrl('')).toBeNull();
    expect(parseOutboundProxyUrl(undefined)).toBeNull();
  });

  it('unbrackets IPv6 proxy hostnames for TCP connect while keeping the bracketed url form', () => {
    // WHATWG URL.hostname 对 IPv6 带方括号;connect host 必须是裸地址(回归:
    // 带括号的 hostname 直接交给 net.connect 会解析失败)。
    const parsed = parseOutboundProxyUrl('http://[::1]:7890');
    expect(parsed).toEqual({
      kind: 'http',
      url: 'http://[::1]:7890',
      hostname: '::1',
      port: 7890,
      authHeader: undefined,
    });
  });

  it('parses socks5 urls, including the socks5h / socks aliases and the default port', () => {
    expect(parseOutboundProxyUrl('socks5://127.0.0.1:1080')).toEqual({
      kind: 'socks5',
      url: 'socks5://127.0.0.1:1080',
      hostname: '127.0.0.1',
      port: 1080,
      username: undefined,
      password: undefined,
    });
    // socks5h 的「域名交给代理解析」就是本实现的固定语义,别名归一成 socks5://。
    expect(parseOutboundProxyUrl('socks5h://127.0.0.1:1080')?.url).toBe('socks5://127.0.0.1:1080');
    expect(parseOutboundProxyUrl('socks://127.0.0.1:1080')?.kind).toBe('socks5');
    // 省略端口 → SOCKS 默认 1080,url 补齐端口便于读日志。
    expect(parseOutboundProxyUrl('socks5://proxy.corp')).toMatchObject({
      url: 'socks5://proxy.corp:1080',
      hostname: 'proxy.corp',
      port: 1080,
    });
    expect(parseOutboundProxyUrl('socks5://[::1]:1080')).toMatchObject({
      url: 'socks5://[::1]:1080',
      hostname: '::1',
    });
  });

  it('keeps socks5 credentials as raw username/password (RFC 1929), not a Basic header', () => {
    const parsed = parseOutboundProxyUrl('socks5://user:p%40ss@127.0.0.1:1080');
    expect(parsed).toMatchObject({ kind: 'socks5', username: 'user', password: 'p@ss' });
    expect(parsed?.url).toBe('socks5://127.0.0.1:1080');
    expect(parsed?.authHeader).toBeUndefined();
  });

  it('drops socks5 credentials that exceed the RFC 1929 single-byte length prefix', () => {
    // 超长凭证无法表达;静默截断会把错的凭证发出去,按「没有凭证」处理更好排查。
    const parsed = parseOutboundProxyUrl(`socks5://${'u'.repeat(256)}:pass@127.0.0.1:1080`);
    expect(parsed).toMatchObject({ kind: 'socks5', username: undefined, password: undefined });
  });

  it('never throws on malformed percent-encoding in userinfo (regression: URIError escaped fail-open)', () => {
    const parsed = parseOutboundProxyUrl('http://user%GG:pa%ZZss@127.0.0.1:8080');
    expect(parsed?.hostname).toBe('127.0.0.1');
    // 解不开的按原文进 Basic,不抛 URIError。
    expect(parsed?.authHeader).toBe(`Basic ${Buffer.from('user%GG:pa%ZZss').toString('base64')}`);
  });
});

describe('outboundProxyAgentKey', () => {
  const socks = (username: string, password: string): OutboundProxyTarget => ({
    kind: 'socks5', url: 'socks5://127.0.0.1:1080', hostname: '127.0.0.1', port: 1080, username, password,
  });

  it('never collides across credentials that contain the separator', () => {
    // 回归:拼接式 key 下 `a:b`+`c` 与 `a`+`b:c` 都产生 "a:b:c",第二次查询会复用
    // 按第一组凭证建的 agent,用错身份去认证。
    expect(outboundProxyAgentKey(socks('a:b', 'c'), 'https:'))
      .not.toBe(outboundProxyAgentKey(socks('a', 'b:c'), 'https:'));
    expect(outboundProxyAgentKey(socks('u', 'p'), 'https:'))
      .toBe(outboundProxyAgentKey(socks('u', 'p'), 'https:'));
  });

  it('separates upstream protocols and proxy kinds', () => {
    expect(outboundProxyAgentKey(socks('u', 'p'), 'http:'))
      .not.toBe(outboundProxyAgentKey(socks('u', 'p'), 'https:'));
    const http: OutboundProxyTarget = {
      kind: 'http', url: 'http://127.0.0.1:1080', hostname: '127.0.0.1', port: 1080,
    };
    expect(outboundProxyAgentKey(http, 'https:'))
      .not.toBe(outboundProxyAgentKey({ ...socks('', ''), username: undefined, password: undefined }, 'https:'));
  });
});

describe('formatAuthority', () => {
  it('brackets IPv6 literals and leaves hostnames/IPv4 alone', () => {
    expect(formatAuthority('2001:db8::1', 443)).toBe('[2001:db8::1]:443');
    expect(formatAuthority('example.com', 8080)).toBe('example.com:8080');
    expect(formatAuthority('10.0.0.1', 80)).toBe('10.0.0.1:80');
    // URL.hostname 已带方括号的形态不能二次包裹。
    expect(formatAuthority('[2001:db8::1]', 443)).toBe('[2001:db8::1]:443');
  });
});

describe('formatHostHeader', () => {
  it('omits default ports, keeps non-default ports, brackets IPv6', () => {
    expect(formatHostHeader('example.com', 80, 'http:')).toBe('example.com');
    expect(formatHostHeader('example.com', 443, 'https:')).toBe('example.com');
    expect(formatHostHeader('example.com', 8080, 'http:')).toBe('example.com:8080');
    expect(formatHostHeader('2001:db8::1', 80, 'http:')).toBe('[2001:db8::1]');
    expect(formatHostHeader('2001:db8::1', 8080, 'http:')).toBe('[2001:db8::1]:8080');
  });
});

describe('redactProxyUrlForLog', () => {
  it('drops credentials, keeps scheme and host', () => {
    expect(redactProxyUrlForLog('http://user:secret@10.0.0.1:8080')).toBe('http://10.0.0.1:8080');
    expect(redactProxyUrlForLog('garbage')).toBe('<unparseable proxy url>');
  });
});

describe('isLoopbackHostname', () => {
  it('matches loopback shapes only', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isLoopbackHostname('127.1.2.3')).toBe(true);
    expect(isLoopbackHostname('localhost')).toBe(true);
    expect(isLoopbackHostname('sub.localhost')).toBe(true);
    expect(isLoopbackHostname('::1')).toBe(true);
    // WHATWG URL.hostname 的 IPv6 形态带方括号,同样要识别。
    expect(isLoopbackHostname('[::1]')).toBe(true);
    expect(isLoopbackHostname('api.anthropic.com')).toBe(false);
    expect(isLoopbackHostname('10.0.0.1')).toBe(false);
  });
});

describe('createEnvOutboundProxyResolver', () => {
  it('routes https targets via HTTPS_PROXY and http targets via HTTP_PROXY', () => {
    const resolve = createEnvOutboundProxyResolver({
      HTTPS_PROXY: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:2',
    });
    expect(resolve('https://chatgpt.com:443')).toBe('http://127.0.0.1:1');
    expect(resolve('http://gateway.corp:80')).toBe('http://127.0.0.1:2');
  });

  it('supports lowercase spellings and ALL_PROXY fallback', () => {
    expect(createEnvOutboundProxyResolver({ https_proxy: 'http://127.0.0.1:3' })('https://x.test')).toBe('http://127.0.0.1:3');
    expect(createEnvOutboundProxyResolver({ ALL_PROXY: 'http://127.0.0.1:4' })('https://x.test')).toBe('http://127.0.0.1:4');
    expect(createEnvOutboundProxyResolver({ all_proxy: 'http://127.0.0.1:5' })('http://x.test')).toBe('http://127.0.0.1:5');
  });

  it('honors NO_PROXY exact host, subdomain, leading dot, port and wildcard forms', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:1' };
    const r = (noProxy: string, url: string) =>
      createEnvOutboundProxyResolver({ ...env, NO_PROXY: noProxy })(url);
    expect(r('example.com', 'https://example.com')).toBeNull();
    expect(r('example.com', 'https://api.example.com')).toBeNull();
    expect(r('.example.com', 'https://api.example.com')).toBeNull();
    expect(r('example.com', 'https://notexample.com')).toBe('http://127.0.0.1:1');
    expect(r('example.com:8443', 'https://example.com:8443')).toBeNull();
    expect(r('example.com:8443', 'https://example.com')).toBe('http://127.0.0.1:1');
    expect(r('*', 'https://anything.test')).toBeNull();
  });

  it('matches bare IPv6 literals in NO_PROXY without misparsing the tail as a port', () => {
    const env = { HTTPS_PROXY: 'http://127.0.0.1:1' };
    const r = (noProxy: string, url: string) =>
      createEnvOutboundProxyResolver({ ...env, NO_PROXY: noProxy })(url);
    // 裸 IPv6:末段纯数字也不能被拆成端口(回归:`2001:db8::1` 曾被拆成 host `2001:db8::` + port 1)。
    expect(r('2001:db8::1', 'https://[2001:db8::1]')).toBeNull();
    expect(r('2001:db8::1', 'https://[2001:db8::99]')).toBe('http://127.0.0.1:1');
    // [v6]:port 无歧义带端口形式:端口一致命中,不一致不命中。
    expect(r('[2001:db8::1]:8443', 'https://[2001:db8::1]:8443')).toBeNull();
    expect(r('[2001:db8::1]:8443', 'https://[2001:db8::1]')).toBe('http://127.0.0.1:1');
    expect(r('[2001:db8::1]', 'https://[2001:db8::1]')).toBeNull();
  });

  it('never proxies loopback targets and tolerates bad urls', () => {
    const resolve = createEnvOutboundProxyResolver({ HTTPS_PROXY: 'http://127.0.0.1:1' });
    expect(resolve('https://127.0.0.1:9999')).toBeNull();
    expect(resolve('http://localhost:3333')).toBeNull();
    expect(resolve('not-a-url')).toBeNull();
  });
});

describe('hasProxyEnvConfig', () => {
  it('detects any proxy env var, ignoring NO_PROXY alone', () => {
    expect(hasProxyEnvConfig({})).toBe(false);
    expect(hasProxyEnvConfig({ NO_PROXY: '*' })).toBe(false);
    expect(hasProxyEnvConfig({ HTTPS_PROXY: 'http://x:1' })).toBe(true);
    expect(hasProxyEnvConfig({ all_proxy: 'http://x:1' })).toBe(true);
    expect(hasProxyEnvConfig({ HTTPS_PROXY: '   ' })).toBe(false);
  });
});

describe('TunnelingHttpsAgent', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
  });

  // 测试自签证书运行时生成(CN/SAN = upstream.test),不在仓库里存任何 PEM 私钥
  // (即使是测试专用的假密钥也会触发 secret scanning / push protection)。
  let tlsKey = '';
  let tlsCert = '';
  beforeAll(async () => {
    // 有效期用默认(365 天)—— 每次运行现生成,不存在过期问题。
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

  /** 起一个最小 CONNECT 代理:记录 CONNECT 目标,把隧道打到本地指定端口。 */
  async function startConnectProxy(tunnelToPort: number): Promise<{
    port: number;
    connects: string[];
    authHeaders: Array<string | undefined>;
  }> {
    const connects: string[] = [];
    const authHeaders: Array<string | undefined> = [];
    const proxy = createHttpServer();
    proxy.on('connect', (req, clientSocket) => {
      connects.push(req.url ?? '');
      authHeaders.push(req.headers['proxy-authorization']);
      const upstreamSocket = netConnect(tunnelToPort, '127.0.0.1', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });
      upstreamSocket.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstreamSocket.destroy());
    });
    const port = await listenOnAvailableLoopbackPort(proxy);
    cleanups.push(() => new Promise<void>((r) => proxy.close(() => r())));
    return { port, connects, authHeaders };
  }

  async function startTlsUpstream(): Promise<number> {
    const tls = createHttpsServer({ key: tlsKey, cert: tlsCert }, (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listenOnAvailableLoopbackPort(tls as unknown as HttpServer);
    cleanups.push(() => new Promise<void>((r) => tls.close(() => r())));
    return port;
  }

  function requestViaAgent(agent: TunnelingHttpsAgent, host: string, port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      // ca + servername:对测试自签证书走完整 TLS 校验(链 + 身份),不禁用证书验证。
      const req = httpsRequest(
        { host, port, path: '/probe', agent, ca: tlsCert, servername: 'upstream.test' },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('tunnels https requests through CONNECT and reuses the keep-alive tunnel', async () => {
    const tlsPort = await startTlsUpstream();
    const { port: proxyPort, connects, authHeaders } = await startConnectProxy(tlsPort);
    const agent = new TunnelingHttpsAgent({
      kind: 'http',
      url: `http://127.0.0.1:${proxyPort}`,
      hostname: '127.0.0.1',
      port: proxyPort,
      authHeader: 'Basic dGVzdDp0ZXN0',
    });
    cleanups.push(() => agent.destroy());

    expect(await requestViaAgent(agent, '127.0.0.1', tlsPort)).toBe(200);
    expect(await requestViaAgent(agent, '127.0.0.1', tlsPort)).toBe(200);

    // keep-alive:第二个请求复用隧道,CONNECT 只发生一次;鉴权头透传。
    expect(connects).toEqual([`127.0.0.1:${tlsPort}`]);
    expect(authHeaders).toEqual(['Basic dGVzdDp0ZXN0']);
  });

  it('surfaces CONNECT rejection as a request error', async () => {
    const proxy = createHttpServer();
    proxy.on('connect', (_req, clientSocket) => {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    });
    const proxyPort = await listenOnAvailableLoopbackPort(proxy);
    cleanups.push(() => new Promise<void>((r) => proxy.close(() => r())));
    const agent = new TunnelingHttpsAgent({
      kind: 'http',
      url: `http://127.0.0.1:${proxyPort}`,
      hostname: '127.0.0.1',
      port: proxyPort,
    });
    cleanups.push(() => agent.destroy());

    await expect(requestViaAgent(agent, '127.0.0.1', 443)).rejects.toThrow(/CONNECT .* failed: HTTP 403/);
  });

  it('surfaces unreachable proxy as a request error', async () => {
    // 端口 1 基本必然拒绝连接;错误信息应指向代理不可达而非上游。
    const agent = new TunnelingHttpsAgent({
      kind: 'http',
      url: 'http://127.0.0.1:1',
      hostname: '127.0.0.1',
      port: 1,
    });
    cleanups.push(() => agent.destroy());

    await expect(requestViaAgent(agent, '127.0.0.1', 443)).rejects.toThrow(/outbound proxy http:\/\/127\.0\.0\.1:1 unreachable/);
  });
});
