/*
 * 测试价值
 * - 生产入口与可观察结果：Host 的登录与会话刷新（main.ts 启动刷新与定期刷新、login-cli.mjs）交给
 *   Cindy 认证客户端的 fetch，在设了代理环境变量时经过代理：明文请求以绝对地址形式到代理，HTTPS
 *   请求向代理发 CONNECT。
 * - 规则依据：放行表第 28 行。Host 其余出站请求都经 hostOutbound 读代理环境变量；登录与会话刷新
 *   原先用 Node 自带的 fetch，连代理环境变量也不读（m1-cp17b 实测），在只能经代理出网的环境里
 *   登录失效后无法刷新。
 * - 最小失败输入：任一处仍用 globalThis.fetch；hostAuthFetch 不经 hostOutbound。
 * - tier：integration（子进程里设代理环境变量，代理是本测试自己的本机监听；目标地址用保留域名，
 *   经代理时本机不解析也不直连，没有请求离开本机）。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// node:test has no default timeout; an explicit bound turns a hang into a failure.
const TEST_TIMEOUT_MS = 120_000;

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const hostDir = path.dirname(srcDir);

const probe = `
  const { hostAuthFetch } = await import('./src/auth-fetch.mjs');
  const out = {};
  try {
    const response = await hostAuthFetch('http://auth.example.test/v1/session/refresh', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"token":"fixture"}',
      signal: AbortSignal.timeout(10_000),
    });
    out.http = { status: response.status, body: await response.text() };
  } catch (error) { out.http = { error: String(error?.cause?.code ?? error) }; }
  try {
    await hostAuthFetch('https://auth.example.test/v1/session/refresh', { method: 'POST', signal: AbortSignal.timeout(10_000) });
    out.https = 'unexpected response';
  } catch (error) { out.https = 'refused as expected'; }
  process.stdout.write(JSON.stringify(out));`;

test('login and session refresh go through the proxy the environment names', { timeout: TEST_TIMEOUT_MS }, async t => {
  const seen = [];
  const connects = [];
  const proxy = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"via":"fixture-proxy"}');
    });
  });
  // An HTTPS target is tunnelled: record the CONNECT target and refuse it.
  proxy.on('connect', (req, socket) => { connects.push(req.url); socket.destroy(); });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const env = { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
  for (const key of ['http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[key];
  const out = await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--import', 'tsx', '--import', './src/loaders/register-raw.mjs', '--input-type=module', '-e', probe],
      { cwd: hostDir, env, encoding: 'utf8', timeout: 60_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`)); else resolve(JSON.parse(stdout));
      });
  });
  assert.deepEqual(out.http, { status: 200, body: '{"via":"fixture-proxy"}' });
  assert.deepEqual(seen, [{ method: 'POST', url: 'http://auth.example.test/v1/session/refresh', body: '{"token":"fixture"}' }]);
  assert.equal(out.https, 'refused as expected');
  assert.deepEqual(connects, ['auth.example.test:443']);
});

