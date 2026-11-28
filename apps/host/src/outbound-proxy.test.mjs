/*
 * 测试价值
 * - 生产入口与可观察结果：Host 的出站代理解析器 resolveHostOutboundProxy（outbound-proxy.ts，hostOutbound、
 *   回环代理、Claude 命令行网络环境都用它）对每个上游给出的代理地址，以及它记下的出站路径判定
 *   （getHostOutboundPathSnapshotFor，Codex 后端不可达时报给用户的那句话的来源）。
 * - 规则依据：放行表第 28 行 28a。Host 从只读环境变量的解析器改成桌面的共用解析核心加“无系统代理”
 *   的端口，转发结果必须不变；没有代理环境变量时，判定只能记成没问出来（unknown，session_unavailable），
 *   不能记成确认直连——Host 没有读系统代理，报成 direct 是谎报（第二节“Codex 后端不可达时的出站路径”）。
 * - 现有覆盖缺口：auth-fetch.test.mjs 只覆盖 HTTP_PROXY 与 HTTPS_PROXY 同设、经代理的那一种配置；
 *   codex-proxy-gate.test.mjs 的上游都是本机地址，解析器在包里就被跳过。没有设置组合、NO_PROXY、
 *   一个变量都不设的用例，也没有判定的用例。
 * - 最小失败输入：设了 HTTP_PROXY、上游是 https（应直连）；只设 NO_PROXY（应直连）；没有代理环境变量
 *   时把判定记成 direct（Host 端口改成返回 'DIRECT'）。
 * - tier：unit（只调解析器，不发请求、不连网）。
 * - 实测耗时：见 PR（单独运行本文件）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getHostOutboundPathSnapshotFor, resolveHostOutboundProxy } from './outbound-proxy.ts';

const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'];

/** Runs fn with exactly the given proxy variables set (the runner's own proxy variables removed). */
async function withProxyEnv(t, env, fn) {
  const saved = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of PROXY_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  });
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return fn();
}

// Each row: proxy variables → upstream → the address the Host forwards through (null = direct). These
// are the results the environment-only resolver gave before 28a; the forwarding verdict must not move.
const ENV_ROWS = [
  ['credentialed HTTPS_PROXY, returned verbatim', { HTTPS_PROXY: 'http://user:secret@127.0.0.1:7890' }, 'https://api.example.test/v1', 'http://user:secret@127.0.0.1:7890'],
  ['lowercase https_proxy', { https_proxy: 'http://127.0.0.1:7890' }, 'https://api.example.test/v1', 'http://127.0.0.1:7890'],
  ['HTTP_PROXY does not cover an https upstream', { HTTP_PROXY: 'http://127.0.0.1:7890' }, 'https://api.example.test/v1', null],
  ['HTTP_PROXY covers an http upstream', { HTTP_PROXY: 'http://127.0.0.1:7890' }, 'http://api.example.test/v1', 'http://127.0.0.1:7890'],
  ['ALL_PROXY as the fallback', { ALL_PROXY: 'socks5://127.0.0.1:7891' }, 'https://api.example.test/v1', 'socks5://127.0.0.1:7891'],
  ['NO_PROXY exempts the upstream domain', { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'example.test' }, 'https://api.example.test/v1', null],
  ['a loopback upstream is never proxied', { HTTPS_PROXY: 'http://127.0.0.1:7890' }, 'https://127.0.0.1:8443/v1', null],
  ['no proxy variable at all', {}, 'https://api.example.test/v1', null],
  ['only NO_PROXY', { NO_PROXY: 'other.example' }, 'https://api.example.test/v1', null],
];

test('the Host forwards through the same proxy for every proxy-variable setting as before', async t => {
  for (const [name, env, upstream, expected] of ENV_ROWS) {
    await t.test(name, st => withProxyEnv(st, env, async () => {
      assert.equal(await resolveHostOutboundProxy(upstream), expected);
    }));
  }
});

test('without proxy variables the Host records an unresolved path, not a confirmed direct one', async t => {
  for (const [name, env, upstream] of [
    ['no proxy variable at all', {}, 'https://none.example.test/v1'],
    ['only NO_PROXY', { NO_PROXY: 'other.example' }, 'https://no-proxy-only.example.test/v1'],
  ]) {
    await t.test(name, st => withProxyEnv(st, env, async () => {
      assert.equal(await resolveHostOutboundProxy(upstream), null);
      const { at, ...snapshot } = getHostOutboundPathSnapshotFor([upstream]);
      assert.equal(typeof at, 'number');
      assert.deepEqual(snapshot, { source: 'system', kind: 'unknown', reason: 'session_unavailable', upstream: new URL(upstream).origin });
    }));
  }
  // With a proxy variable the judgement is the environment's, with the address redacted.
  await withProxyEnv(t, { HTTPS_PROXY: 'http://user:secret@127.0.0.1:7890' }, async () => {
    await resolveHostOutboundProxy('https://env.example.test/v1');
    const { at: _at, ...snapshot } = getHostOutboundPathSnapshotFor(['https://env.example.test']);
    assert.deepEqual(snapshot, { source: 'env', kind: 'proxy', proxy: 'http://127.0.0.1:7890', upstream: 'https://env.example.test' });
  });
});
