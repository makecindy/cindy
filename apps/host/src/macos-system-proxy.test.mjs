/*
 * 测试价值（放行表第 28 行 28b，第七节第 26 项“macOS 静态系统代理”）
 * - 生产入口与可观察结果：Host 的出站代理解析器 resolveHostOutboundProxy（outbound-proxy.ts，Host 所有出站请求都经它）
 *   在读 macOS 系统代理设置时（useHostSystemProxySettings，生产绑 /usr/sbin/scutil --proxy，这里注入固定的
 *   scutil 输出）给每个上游的代理地址，它记下的出站路径判定（getHostOutboundPathSnapshotFor），以及写进
 *   真实日志文件（initLogger 指向临时目录）的内容。
 * - 规则依据：Chromium 148（Electron 42.11.12）读同一份字典后的处理——proxy_config_service_mac.cc（读哪些键）、
 *   proxy_chain_util_apple.cc（HTTPS 项仍是 HTTP 代理、SOCKS 为 v5、缺端口用默认端口、缺主机忽略该项）、
 *   proxy_config.cc ProxyRules::Apply（按 scheme 选、回落到 SOCKS）、proxy_host_matching_rules.cc 与
 *   scheme_host_port_matcher_rule.cc（例外规则、后写的规则优先、隐式例外）、url_canon_ip.h（`169.254` 即
 *   169.0.0.254）、base/strings/pattern.cc（`?` 匹配零或一个字符）。审核方 2026-11-17 定：PAC 拒绝并记
 *   unknown；只开自动发现时用手动设置并记一条 warn；带用户名的系统代理按 unknown；读设置这层缓存 5 秒、
 *   并发合并，最长 35 秒生效；不记原始输出。
 * - 现有覆盖缺口：outbound-proxy.test.mjs 只覆盖代理环境变量与“不读系统代理”；Host 原来没有读系统代理的代码。
 * - 最小失败输入：HTTPS 项写成 `HTTPS host:port`（核心会当作用不了、直连）；去掉隐式例外；忽略 `*User` 键；
 *   把 scutil 的一行或用户名放进错误信息；缓存去掉或不合并并发。
 * - tier：unit（不起进程、不连网、不执行 scutil；Date 用 mock 计时器推进，日志写临时目录）。
 * - 实测耗时：见 PR（单独运行本文件）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

import { initLogger } from '../../desktop/src/main/logger.ts';
import { getHostOutboundPathSnapshotFor, resolveHostOutboundProxy, useHostSystemProxySettings } from './outbound-proxy.ts';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];
const savedEnv = Object.fromEntries([...PROXY_ENV_KEYS, 'LOG_LEVEL'].map(key => [key, process.env[key]]));
for (const key of PROXY_ENV_KEYS) delete process.env[key];
process.env.LOG_LEVEL = 'info';
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-system-proxy-logs-'));
initLogger({ isPackaged: true, logDir });
// Only Date: the resolver core's 30 s cache, its 5 s unresolved cache and the settings' 5 s cache all read it.
mock.timers.enable({ apis: ['Date'], now: Date.now() });
test.after(() => {
  mock.timers.reset();
  useHostSystemProxySettings(null);
  for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  fs.rmSync(logDir, { recursive: true, force: true });
});

/** scutil --proxy's text for a dictionary (SCPrint: `Key : value`, arrays as `N : item`). */
function scutil(entries) {
  const lines = ['<dictionary> {'];
  for (const [key, value] of Object.entries(entries)) {
    if (Array.isArray(value)) {
      lines.push(`  ${key} : <array> {`, ...value.map((item, i) => `    ${i} : ${item}`), '  }');
    } else {
      lines.push(`  ${key} : ${value}`);
    }
  }
  return `${lines.join('\n')}\n}\n`;
}

const HTTP = { HTTPEnable: 1, HTTPProxy: '10.0.0.1', HTTPPort: 3128 };
const HTTPS = { HTTPSEnable: 1, HTTPSProxy: '10.0.0.2', HTTPSPort: 3129 };
const SOCKS = { SOCKSEnable: 1, SOCKSProxy: '10.0.0.3', SOCKSPort: 1081 };
const VIA_HTTP = 'http://10.0.0.1:3128';
const VIA_HTTPS = 'http://10.0.0.2:3129';
const VIA_SOCKS = 'socks5://10.0.0.3:1081';

/** Resolves one upstream with fresh caches under the given scutil output; returns the forwarding address. */
async function resolveUnder(output, upstream) {
  mock.timers.tick(40_000);
  useHostSystemProxySettings(async () => output);
  return resolveHostOutboundProxy(upstream);
}

function snapshotOf(upstream) {
  const snapshot = getHostOutboundPathSnapshotFor([upstream]);
  assert.ok(snapshot, `a judgement for ${upstream}`);
  const { at: _at, ...rest } = snapshot;
  return rest;
}

/** The text of every main log file the logger has written, once it contains `expected`. */
async function logsContaining(expected) {
  let text = '';
  for (let i = 0; i < 5000 && !text.includes(expected); i += 1) {
    await new Promise(resolve => setImmediate(resolve));
    text = fs.readdirSync(logDir).filter(name => name.startsWith('main-')).map(name => fs.readFileSync(path.join(logDir, name), 'utf8')).join('');
  }
  assert.ok(text.includes(expected), `the log has "${expected}"`);
  return text;
}

// [name, settings, upstream, forwarding address (null: direct), Chromium 148 source]
const MANUAL_ROWS = [
  ['no proxy enabled', {}, 'https://api.example.test/', null, 'proxy_config.cc ProxyRules::Apply: empty rules'],
  ['HTTP only: http upstream', HTTP, 'http://api.example.test/', VIA_HTTP, 'proxies_for_http'],
  ['HTTP only: https upstream goes direct', HTTP, 'https://api.example.test/', null, 'MapUrlSchemeToProxyList: no https list, no fallback'],
  ['HTTPS only: the HTTPS proxy is an HTTP proxy', HTTPS, 'https://api.example.test/', VIA_HTTPS, 'proxy_chain_util_apple.cc kCFProxyTypeHTTPS → SCHEME_HTTP'],
  ['HTTPS only: http upstream goes direct', HTTPS, 'http://api.example.test/', null, 'MapUrlSchemeToProxyList'],
  ['SOCKS only covers http', SOCKS, 'http://api.example.test/', VIA_SOCKS, 'fallback_proxies, SOCKS5'],
  ['SOCKS only covers https', SOCKS, 'https://api.example.test/', VIA_SOCKS, 'fallback_proxies, SOCKS5'],
  ['HTTP + SOCKS: https falls back to SOCKS', { ...HTTP, ...SOCKS }, 'https://api.example.test/', VIA_SOCKS, 'MapUrlSchemeToProxyList fallback'],
  ['HTTPS + SOCKS: http falls back to SOCKS', { ...HTTPS, ...SOCKS }, 'http://api.example.test/', VIA_SOCKS, 'MapUrlSchemeToProxyList fallback'],
  ['all three: http', { ...HTTP, ...HTTPS, ...SOCKS }, 'http://api.example.test/', VIA_HTTP, 'per-scheme list first'],
  ['all three: https', { ...HTTP, ...HTTPS, ...SOCKS }, 'https://api.example.test/', VIA_HTTPS, 'per-scheme list first'],
  ['wss: SOCKS, then HTTPS, then HTTP', { ...HTTP, ...HTTPS }, 'wss://api.example.test/', VIA_HTTPS, 'GetProxyListForWebSocketScheme'],
  ['missing HTTPS port: 80', { HTTPSEnable: 1, HTTPSProxy: '10.0.0.2' }, 'https://api.example.test/', 'http://10.0.0.2:80', 'GetDefaultPortForScheme(SCHEME_HTTP)'],
  ['missing SOCKS port: 1080', { SOCKSEnable: 1, SOCKSProxy: '10.0.0.3' }, 'https://api.example.test/', 'socks5://10.0.0.3:1080', 'GetDefaultPortForScheme(SCHEME_SOCKS5)'],
  ['enabled without a host: ignored', { HTTPSEnable: 1, HTTPSPort: 3129 }, 'https://api.example.test/', null, 'ProxyDictionaryToProxyChain: no host key'],
  ['an empty host: ignored', { HTTPSEnable: 1, HTTPSProxy: '', HTTPSPort: 3129 }, 'https://api.example.test/', null, 'ProxyServer::FromSchemeHostAndPort: empty host'],
  ['not enabled: ignored', { HTTPSEnable: 0, HTTPSProxy: '10.0.0.2', HTTPSPort: 3129 }, 'https://api.example.test/', null, 'GetBoolFromDictionary'],
  ['host canonicalised', { HTTPSEnable: 1, HTTPSProxy: 'Proxy.Corp.EXAMPLE', HTTPSPort: 8080 }, 'https://api.example.test/', 'http://proxy.corp.example:8080', 'url::CanonicalizeHost'],
  ['IPv6 proxy host bracketed', { HTTPSEnable: 1, HTTPSProxy: 'fd00::1', HTTPSPort: 8080 }, 'https://api.example.test/', 'http://[fd00::1]:8080', 'FromSchemeHostAndPort adds brackets'],
  ['a host that fails canonicalisation: ignored', { HTTPSEnable: 1, HTTPSProxy: 'proxy:8080', HTTPSPort: 3129, ...SOCKS }, 'https://api.example.test/', VIA_SOCKS, 'FromSchemeHostAndPort: CanonicalizeHost fails'],
  ['a port that is not a number: the default', { ...HTTPS, HTTPSPort: 'abc' }, 'https://api.example.test/', 'http://10.0.0.2:80', 'GetValueFromDictionary<CFNumberRef>: other types read as missing'],
  ['an Enable that is not a number: off', { ...HTTPS, HTTPSEnable: 'TRUE' }, 'https://api.example.test/', null, 'GetBoolFromDictionary: default false'],
  ['ExceptionsList that is not an array: none', { ...HTTPS, ExceptionsList: 'api.example.test' }, 'https://api.example.test/', VIA_HTTPS, 'GetValueFromDictionary<CFArrayRef>'],
  ['a blank user names no one', { ...HTTPS, HTTPSUser: '' }, 'https://api.example.test/', VIA_HTTPS, 'no user to authenticate with'],
];

test('manual proxies give the address Chromium gives for each setting', async t => {
  for (const [name, settings, upstream, expected, source] of MANUAL_ROWS) {
    await t.test(name, async () => assert.equal(await resolveUnder(scutil(settings), upstream), expected, source));
  }
  assert.equal(await resolveUnder('No proxy configuration available\n', 'https://none.example.test/'), null);
  assert.deepEqual(snapshotOf('https://none.example.test/'), { source: 'system', kind: 'direct', upstream: 'https://none.example.test' });
  await resolveUnder(scutil(HTTPS), 'https://proxied.example.test/v1');
  assert.deepEqual(snapshotOf('https://proxied.example.test'), { source: 'system', kind: 'proxy', proxy: VIA_HTTPS, upstream: 'https://proxied.example.test' });
});

// [name, ExceptionsList (or settings), upstream, bypassed]
const BYPASS_ROWS = [
  ['a host name matches only itself', ['example.com'], 'https://example.com/', true],
  ['a host name does not match its subdomains', ['example.com'], 'https://www.example.com/', false],
  ['*.domain matches subdomains', ['*.example.com'], 'https://www.example.com/', true],
  ['*.domain does not match the domain', ['*.example.com'], 'https://example.com/', false],
  ['.domain is *.domain', ['.example.com'], 'https://www.example.com/', true],
  ['host:port needs that port', ['example.com:8443'], 'https://example.com:8443/', true],
  ['host:port, other port', ['example.com:8443'], 'https://example.com/', false],
  ['scheme://host only for that scheme', ['http://example.com'], 'https://example.com/', false],
  ['scheme://host, same scheme', ['http://example.com'], 'http://example.com/', true],
  ['rules are lower-cased', ['EXAMPLE.COM'], 'https://example.com/', true],
  ['? matches zero characters', ['ex?mple.com'], 'https://exmple.com/', true],
  ['? matches one character', ['ex?mple.com'], 'https://example.com/', true],
  ['? does not match two', ['ex?mple.com'], 'https://exaample.com/', false],
  ['an IP literal', ['10.1.2.3'], 'https://10.1.2.3/', true],
  ['an IP literal, other address', ['10.1.2.3'], 'https://10.1.2.4/', false],
  ['a bracketed IPv6 literal', ['[fd00::5]'], 'https://[fd00::5]/', true],
  ['an IPv4 block', ['10.0.0.0/8'], 'https://10.9.9.9/', true],
  ['an IPv4 block does not match host names', ['10.0.0.0/8'], 'https://ten.example.test/', false],
  ['an IPv6 block', ['fd00::/8'], 'https://[fd12::1]/', true],
  ['169.254/16 is 169.0.0.254/16 (url_canon_ip.h)', ['169.254/16'], 'https://169.0.3.4/', true],
  ['169.254/16 does not cover 169.1.x.x', ['169.254/16'], 'https://169.1.0.1/', false],
  ['a path is no rule: dropped', ['example.com/path'], 'https://example.com/', false],
  ['one item is not split at commas', ['a.example.com, b.example.com'], 'https://a.example.com/', false],
  ['the macOS default list', ['*.local', '169.254/16'], 'https://printer.local/', true],
  ['<-loopback> removes the implicit rules', ['<-loopback>'], 'https://localhost/', false],
  ['a later rule overrides an earlier one', ['localhost', '<-loopback>'], 'https://localhost/', false],
  ['an earlier rule loses to a later one', ['<-loopback>', 'localhost'], 'https://localhost/', true],
  ['simple host names, when excluded', { ExcludeSimpleHostnames: 1 }, 'https://intranet/', true],
  ['simple host names: dotted names still proxied', { ExcludeSimpleHostnames: 1 }, 'https://intranet.corp/', false],
  ['simple host names: an IP is not one', { ExcludeSimpleHostnames: 1 }, 'https://10.0.0.9/', false],
  ['simple host names: a listed rule overrides <local>', { ExcludeSimpleHostnames: 1, ExceptionsList: ['<-loopback>'] }, 'https://localhost/', false],
];

// Implicit rules: Chromium 148 on macOS (proxy_host_matching_rules.cc MatchesImplicitRules); no 0.0.0.0 rule yet.
const IMPLICIT_ROWS = [
  ['localhost', 'https://localhost/', true],
  ['*.localhost', 'https://foo.localhost/', true],
  ['127/8', 'https://127.0.0.5/', true],
  ['[::1]', 'https://[::1]/', true],
  ['[::ffff:127.0.0.1]', 'https://[::ffff:127.0.0.1]/', true],
  ['169.254/16', 'https://169.254.1.1/', true],
  ['[::ffff:169.254.1.1]', 'https://[::ffff:169.254.1.1]/', true],
  ['[fe80::]/10', 'https://[fe80::1]/', true],
  ['169.255.x.x is not link-local', 'https://169.255.0.1/', false],
  ['0.0.0.0 is not bypassed in 148', 'https://0.0.0.0/', false],
];

test('exceptions and the implicit rules bypass the proxy as in Chromium', async t => {
  for (const [name, rules, upstream, bypassed] of BYPASS_ROWS) {
    const settings = Array.isArray(rules) ? { ...HTTP, ...HTTPS, ExceptionsList: rules } : { ...HTTP, ...HTTPS, ...rules };
    const proxied = upstream.startsWith('https:') ? VIA_HTTPS : VIA_HTTP;
    await t.test(name, async () => assert.equal(await resolveUnder(scutil(settings), upstream), bypassed ? null : proxied));
  }
  for (const [name, upstream, bypassed] of IMPLICIT_ROWS) {
    await t.test(`implicit: ${name}`, async () => assert.equal(await resolveUnder(scutil(HTTPS), upstream), bypassed ? null : VIA_HTTPS));
  }
});

test('without the Chromium proxy helper, PAC is unresolved, direct, with a warn; auto-discovery alone uses the manual settings', async () => {
  const PAC = { ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'http://pac.example.test/proxy.pac' };
  assert.equal(await resolveUnder(scutil({ ...PAC, ...HTTPS }), 'https://pac.example.test/'), null);
  assert.deepEqual(snapshotOf('https://pac.example.test'), { source: 'system', kind: 'unknown', reason: 'resolve_failed', upstream: 'https://pac.example.test' });
  assert.equal(await resolveUnder(scutil({ ...PAC, ProxyAutoDiscoveryEnable: 1, ...HTTPS }), 'https://pac-wpad.example.test/'), null);
  assert.equal(snapshotOf('https://pac-wpad.example.test').kind, 'unknown');
  await logsContaining('proxy auto-config (PAC) URL, and the Chromium proxy helper had no answer');
  // Enabled without a URL, or with one that is not a valid URL: Chromium has no PAC URL (has_pac_url) and
  // uses the manual settings.
  assert.equal(await resolveUnder(scutil({ ProxyAutoConfigEnable: 1, ...HTTPS }), 'https://pac-no-url.example.test/'), VIA_HTTPS);
  assert.equal(await resolveUnder(scutil({ ProxyAutoConfigEnable: 1, ProxyAutoConfigURLString: 'proxy.pac', ...HTTPS }), 'https://pac-bad-url.example.test/'), VIA_HTTPS);

  // Auto-discovery without a PAC URL: the manual settings, and one warn for as long as it stays on.
  const reads = [];
  useHostSystemProxySettings(async () => { reads.push(1); return scutil({ ProxyAutoDiscoveryEnable: 1, ...HTTPS }); });
  mock.timers.tick(40_000);
  assert.equal(await resolveHostOutboundProxy('https://wpad-1.example.test/'), VIA_HTTPS);
  mock.timers.tick(6_000);
  assert.equal(await resolveHostOutboundProxy('https://wpad-2.example.test/'), VIA_HTTPS);
  assert.equal(reads.length, 2, 'two readings of the settings');
  const text = await logsContaining('auto-discovery (WPAD) is not tried on the Host');
  assert.equal(text.split('auto-discovery (WPAD) is not tried on the Host').length - 1, 1, 'one warn while it stays on');
  assert.equal(await resolveUnder(scutil({ ProxyAutoDiscoveryEnable: 1 }), 'https://wpad-only.example.test/'), null);
});

test('settings the Host cannot use are unresolved, not guessed, and a failed reading is not kept', async () => {
  for (const [name, output] of [
    ['unreadable output', 'HTTPSEnable = 1\n'],
    ['a port out of range', scutil({ ...HTTPS, HTTPSPort: 70000 })],
    ['a host that is not a host', scutil({ ...HTTPS, HTTPSProxy: 'proxy.example/path' })],
    ['an unclosed dictionary', '<dictionary> {\n  HTTPSEnable : 1\n'],
  ]) {
    const upstream = `https://${name.replaceAll(' ', '-')}.example.test/`;
    assert.equal(await resolveUnder(output, upstream), null, name);
    assert.deepEqual(snapshotOf(upstream), { source: 'system', kind: 'unknown', reason: 'resolve_failed', upstream: new URL(upstream).origin }, name);
  }
  // A reading that fails, then one that works: the next request after the core's 5 s reads again.
  let fail = true;
  useHostSystemProxySettings(async () => { if (fail) throw new Error('scutil --proxy failed (ETIMEDOUT)'); return scutil(HTTPS); });
  mock.timers.tick(40_000);
  assert.equal(await resolveHostOutboundProxy('https://retry.example.test/'), null);
  fail = false;
  mock.timers.tick(5_001);
  assert.equal(await resolveHostOutboundProxy('https://retry.example.test/'), VIA_HTTPS);
});

test('one reading serves 5 s and concurrent requests; a change takes effect within 35 s', async () => {
  let output = scutil(HTTPS);
  let reads = 0;
  useHostSystemProxySettings(async () => { reads += 1; return output; });
  mock.timers.tick(40_000);
  assert.deepEqual(await Promise.all(['https://c1.example.test/', 'https://c2.example.test/'].map(url => resolveHostOutboundProxy(url))), [VIA_HTTPS, VIA_HTTPS]);
  assert.equal(reads, 1, 'concurrent requests share one reading');
  output = scutil({});
  mock.timers.tick(4_999);
  // Not yet re-read: a new upstream still gets the old settings, and the core keeps that verdict 30 s.
  assert.equal(await resolveHostOutboundProxy('https://c3.example.test/'), VIA_HTTPS);
  assert.equal(reads, 1);
  mock.timers.tick(29_999);
  assert.equal(await resolveHostOutboundProxy('https://c3.example.test/'), VIA_HTTPS, 'still cached at 34.998 s after the change');
  mock.timers.tick(2);
  assert.equal(await resolveHostOutboundProxy('https://c3.example.test/'), null, 'the new settings by 35 s');
  assert.equal(reads, 2);
});

test('proxy environment variables come first: the system settings are not read', async t => {
  let reads = 0;
  useHostSystemProxySettings(async () => { reads += 1; return scutil(HTTPS); });
  process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';
  t.after(() => { delete process.env.HTTPS_PROXY; });
  mock.timers.tick(40_000);
  assert.equal(await resolveHostOutboundProxy('https://env-first.example.test/'), 'http://127.0.0.1:7890');
  assert.equal(reads, 0);
});

test('a proxy that names a user is unresolved, and the user is in no log or judgement', async () => {
  const USER = 'proxy-user-fixture-28b';
  const output = scutil({ ...HTTP, HTTPUser: USER, ...HTTPS, HTTPSUser: USER, SOCKSEnable: 0, SOCKSUser: USER });
  assert.equal(await resolveUnder(output, 'https://auth.example.test/'), null, 'the HTTPS proxy names a user');
  assert.deepEqual(snapshotOf('https://auth.example.test'), { source: 'system', kind: 'unknown', reason: 'resolve_failed', upstream: 'https://auth.example.test' });
  // Only the proxy that the request would use matters.
  assert.equal(await resolveUnder(scutil({ ...HTTP, ...HTTPS, HTTPSUser: USER }), 'http://auth-other.example.test/'), VIA_HTTP);
  // An unreadable line that carries the user: the error names the line, not its text.
  assert.equal(await resolveUnder(`<dictionary> {\n  HTTPSUser = ${USER}\n}\n`, 'https://auth-unreadable.example.test/'), null);
  const text = await logsContaining('requires authentication; its password is in the keychain');
  await logsContaining('unrecognised scutil --proxy output (line 2)');
  assert.ok(!text.includes(USER) && !(await logsContaining('line 2')).includes(USER), 'no log line has the user');
  for (const upstream of ['https://auth.example.test', 'http://auth-other.example.test', 'https://auth-unreadable.example.test']) {
    assert.ok(!JSON.stringify(getHostOutboundPathSnapshotFor([upstream])).includes(USER), `no judgement for ${upstream} has the user`);
  }
});
