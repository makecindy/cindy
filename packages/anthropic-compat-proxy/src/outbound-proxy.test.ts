import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { describe, expect, it, afterEach } from 'vitest';

import { listenOnAvailableLoopbackPort } from './test-loopback-server.js';
import {
  createEnvOutboundProxyResolver,
  formatAuthority,
  formatHostHeader,
  hasProxyEnvConfig,
  isLoopbackHostname,
  parseOutboundProxyUrl,
  redactProxyUrlForLog,
  TunnelingHttpsAgent,
} from './outbound-proxy.js';

// ─── 测试专用自签名证书(CN/SAN = upstream.test,有效期 100 年)────────────────
// 仅供本测试文件的本地 TLS 桩使用,非任何真实凭证。客户端把它同时当 CA 用
// (自签 = 自己就是根),配合 servername=upstream.test 走完整证书校验,
// 不关闭 rejectUnauthorized。
const TEST_TLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCs7jn9/xp6anHr
73FSJP5Z4Z6rsqFmdp6x6P8737CUzK+HZPhLv1Csd0ssmVpr/01AkTP+Fo000cf5
IDrPdD/DUj+OCEmfXRxJp8HhydunT1rkvlox6Ih+L1UWUBpX4EdC3AeNJPe/lEFe
Jg/9nc2RRlPHw7gm6L2+Hd7Ip/SjPf0yvwELmx8Go2WfJ1q211Y/1T24nRw1PEV1
kTZsY+C232JRQfbl0lK8soEdWiZmWSLHbkn0ULQXIhI7Z60rb8xs2xIILsUynoea
2ooa9nnu9Rjq9iiuDAmLORcNkQNNMSX3mpctLg9sEEfUs+NpOZ8t/iMir1DwxT5N
fybMh4SFAgMBAAECggEAEGKEASJmHloukBXATXGu3dJIR+llbIFpuN6kLEaeAwM/
0FrLQdYPLUAiUcf37sqiRa9cV0NIvsvvoBWjLNvNXNLSrcDwRNa8IuhvsNaA5uHY
cVrtzdPD9vzCGZqeXFwmNFoHpyJtDOxdoy+FDVkhzJV2w7MyJBGiRLysyqNLRRom
6WOCD5UDQwV/8L1XYK3LSrV9cTy0l5cKcY1FQIdQ3a+dt+6PLD+yuGBIWLvvyggq
flRSktRNxaRlFatUIheEdO06VI6UFXla2vDNpu4a1rp7AMJzWRd3gLF/PzyENhjO
ov5loSDlerU+lX5FNWRJoiquwVVBHbs9B4KRpn0qMwKBgQDpRvz59vVGIyAW8OPW
fKhZ7E/XWpB/BwSpdX9kNj+oK4/k8W37MzKLgueE7frdE40OB3+GevKqm0AsNN+L
v6NvEzVh/Gi4FyP3dH2ILiFFYU/tdKvD27PiNLgg4uzW+Cdfyh2DPTmMGj0gjXvb
eO/NjzrVd9IkkzX0CEZmsmBaCwKBgQC9xm4XXJYQS+41/xP0xs1hrt5sdaqVNiXh
XHNp9NBzn2OM+hFoRwGHcbzwJWIxJR6OD5IMNpBUenQE0c5JZOL0gwgbXn/rAqRV
TniF16bv9Uw2cHAx17De3+SsAol7EkUhsIcXS9lxYarcyqLsuNaGq8xbIKEBHmfd
wBMVMU9FrwKBgCSPMpB+SrxePuY5hIuV59CH/49RqzmtQObJ+lgbRGi3wwpvZ/wp
bu98aYpkvZ8uNDoRpMPPuv5P7IPBGZPOSe/bg89CfqrzPXjHsfDIwgAcmyks0sqU
QSHff0fwKIwcQhd6Fpv92WoCprfWVKX10ydVHjRcXfvLcnY3YckwhXc3AoGAcmW1
Y5vKUhSTijUzgHB+yg2xwsvDgqLbfthOMmcDaU+BoS/1Yli7UTx82n6OjHWFz7kP
HxGdO299lJIsug14ylBaiLUUg0Rab5oYCQaQeUHzKTXqTAFre06X+CCnY2sGBWL2
bFKqxzBK4UG9qNlbaF8TlzM6GwSLNB9e4X2R/b0CgYAqoXMa2MeXaA5GzIg9/PeU
UEkXjU841pQbdw49wTiMrk8qm24aiWxu1Z5R79DKpY0jeNxuc03ChzYIXksylQ/L
oMATHYy8OlLJ3j4eQNIwSWh1bIyGXV7Jkv/swynh0VzTGf4UyV4K/v0DErcVO9rP
W0ETJ1ulu43omEuNGkCkdQ==
-----END PRIVATE KEY-----`;

const TEST_TLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUIEXWlocxnpLV63aHJin8lDGkJtEwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNdXBzdHJlYW0udGVzdDAgFw0yNjA3MjQwODQ2MjFaGA8y
MTI2MDYzMDA4NDYyMVowGDEWMBQGA1UEAwwNdXBzdHJlYW0udGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBAKzuOf3/GnpqcevvcVIk/lnhnquyoWZ2
nrHo/zvfsJTMr4dk+Eu/UKx3SyyZWmv/TUCRM/4WjTTRx/kgOs90P8NSP44ISZ9d
HEmnweHJ26dPWuS+WjHoiH4vVRZQGlfgR0LcB40k97+UQV4mD/2dzZFGU8fDuCbo
vb4d3sin9KM9/TK/AQubHwajZZ8nWrbXVj/VPbidHDU8RXWRNmxj4LbfYlFB9uXS
UryygR1aJmZZIsduSfRQtBciEjtnrStvzGzbEgguxTKeh5raihr2ee71GOr2KK4M
CYs5Fw2RA00xJfealy0uD2wQR9Sz42k5ny3+IyKvUPDFPk1/JsyHhIUCAwEAAaNt
MGswHQYDVR0OBBYEFOMEEoDze4qD05At9+bjkHfP3+HwMB8GA1UdIwQYMBaAFOME
EoDze4qD05At9+bjkHfP3+HwMA8GA1UdEwEB/wQFMAMBAf8wGAYDVR0RBBEwD4IN
dXBzdHJlYW0udGVzdDANBgkqhkiG9w0BAQsFAAOCAQEAaiSXH428BzaOf+4D34V+
j6Sisp4j2Zeo/DILTOG/TN9kYS3twTzXgAZ62EsvBEPmIuivI6rzOdmYGAHKM+RH
MH/NZG6D5REdRnoJA9UUOxSGYO6MIAZMb3OzUl0EjWTKnFuDq39Cko6e5+SkM+Pr
e5s74zkHfTJVmhViyWFls/3UYO5dB/CpiHA0/lUZF1tAEsvm1iPGvXjQRSvi7GCy
5T5F2ERHMZ7vla/ijDGwPz4dI5pFfbSFbbx+0dAKZsper5sWdxh9iq5fITlGgaGR
WZ55rszyYN4IK5//d86AdI6N3eYVVf0L0N6PH7zv+vuMr46qO93skYlSbnU7RIos
lg==
-----END CERTIFICATE-----`;

describe('parseOutboundProxyUrl', () => {
  it('parses plain http proxy urls', () => {
    expect(parseOutboundProxyUrl('http://127.0.0.1:7890')).toEqual({
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
    expect(parseOutboundProxyUrl('https://127.0.0.1:7890')).toBeNull();
    expect(parseOutboundProxyUrl('socks5://127.0.0.1:7891')).toBeNull();
    expect(parseOutboundProxyUrl('not a url')).toBeNull();
    expect(parseOutboundProxyUrl('')).toBeNull();
    expect(parseOutboundProxyUrl(undefined)).toBeNull();
  });

  it('never throws on malformed percent-encoding in userinfo (regression: URIError escaped fail-open)', () => {
    const parsed = parseOutboundProxyUrl('http://user%GG:pa%ZZss@127.0.0.1:8080');
    expect(parsed?.hostname).toBe('127.0.0.1');
    // 解不开的按原文进 Basic,不抛 URIError。
    expect(parsed?.authHeader).toBe(`Basic ${Buffer.from('user%GG:pa%ZZss').toString('base64')}`);
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
    const tls = createHttpsServer({ key: TEST_TLS_KEY, cert: TEST_TLS_CERT }, (_req, res) => {
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
        { host, port, path: '/probe', agent, ca: TEST_TLS_CERT, servername: 'upstream.test' },
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
      url: 'http://127.0.0.1:1',
      hostname: '127.0.0.1',
      port: 1,
    });
    cleanups.push(() => agent.destroy());

    await expect(requestViaAgent(agent, '127.0.0.1', 443)).rejects.toThrow(/outbound proxy http:\/\/127\.0\.0\.1:1 unreachable/);
  });
});
