// agent-binary-cdn-fallback 单测：验证 CDN 兜底的 URL 拼接、gunzip、best-effort sha256 校验。
// 用 node 内置 http server mock CDN（manifest + .gz），node 内置 test runner，无 vitest 依赖。
// 直接 `node --test scripts/__tests__/agent-binary-cdn-fallback.test.mjs`。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

import { downloadFromCdn } from '../agent-binary-cdn-fallback.mjs';

const VERSION = '2.1.186';
const BINARY = Buffer.alloc(2048, 9); // 裸二进制内容（>1024）
const GZ = zlib.gzipSync(BINARY);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
const GZ_SHA = sha256(GZ);
const BIN_SHA = sha256(BINARY);

// ── 可配置 mock CDN：每个测试设置 routes（url path → handler） ────────────────
let server;
let base;
let routes; // Map<string, (req,res)=>void>

before(async () => {
  server = http.createServer((req, res) => {
    const urlPath = req.url.split('?')[0];
    const handler = routes.get(urlPath);
    // 显式校验取出的是函数再调用(CodeQL js/unvalidated-dynamic-method-call)
    if (typeof handler !== 'function') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.XDT_CDN_BASE_URL = base;
});

after(async () => {
  delete process.env.XDT_CDN_BASE_URL;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  routes = new Map();
});

function tmpBinPath(name = 'claude') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-fb-test-'));
  return path.join(dir, name);
}

function serveJson(obj) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
}
function serveGz() {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(GZ);
  };
}
function manifest(field, overrides = {}) {
  return {
    [field]: {
      version: VERSION,
      file: `claude-code/${VERSION}/darwin-arm64/claude.gz`,
      sha256: GZ_SHA,
      size: GZ.length,
      binarySha256: BIN_SHA,
      ...overrides,
    },
  };
}

test('downloadFromCdn: 成功兜底——gunzip 后 binPath 内容正确，sha 全校验', async () => {
  routes.set('/manifest-darwin-arm64-canary.json', serveJson(manifest('claudeCode')));
  routes.set(`/claude-code/${VERSION}/darwin-arm64/claude.gz`, serveGz());

  const binPath = tmpBinPath();
  const r = await downloadFromCdn({ kind: 'claude', version: VERSION, platformKey: 'darwin-arm64', binPath });

  assert.equal(r.gzVerified, true);
  assert.equal(r.binaryVerified, true);
  assert.deepEqual(fs.readFileSync(binPath), BINARY);
  // 中转文件清理
  assert.equal(fs.existsSync(`${binPath}.gz.tmp`), false);
  assert.equal(fs.existsSync(`${binPath}.tmp`), false);
});

test('downloadFromCdn: manifest version 不匹配 pin → 跳过 sha 校验仍成功', async () => {
  // canary 拿得到但 version 不符；stable 404 → tryGetManifestAsset 返回 null
  routes.set('/manifest-darwin-arm64-canary.json', serveJson(manifest('claudeCode', { version: '9.9.9' })));
  routes.set(`/claude-code/${VERSION}/darwin-arm64/claude.gz`, serveGz());

  const binPath = tmpBinPath();
  const r = await downloadFromCdn({ kind: 'claude', version: VERSION, platformKey: 'darwin-arm64', binPath });

  assert.equal(r.gzVerified, false);
  assert.equal(r.binaryVerified, false);
  assert.deepEqual(fs.readFileSync(binPath), BINARY);
});

test('downloadFromCdn: .gz sha256 mismatch → 抛错且不落地', async () => {
  routes.set('/manifest-darwin-arm64-canary.json', serveJson(manifest('claudeCode', { sha256: 'deadbeef'.repeat(8) })));
  routes.set(`/claude-code/${VERSION}/darwin-arm64/claude.gz`, serveGz());

  const binPath = tmpBinPath();
  await assert.rejects(
    () => downloadFromCdn({ kind: 'claude', version: VERSION, platformKey: 'darwin-arm64', binPath }),
    /\.gz sha256 mismatch/,
  );
  assert.equal(fs.existsSync(binPath), false);
});

test('downloadFromCdn: 二进制 binarySha256 mismatch → 抛错', async () => {
  routes.set('/manifest-darwin-arm64-canary.json', serveJson(manifest('claudeCode', { binarySha256: 'cafe'.repeat(16) })));
  routes.set(`/claude-code/${VERSION}/darwin-arm64/claude.gz`, serveGz());

  const binPath = tmpBinPath();
  await assert.rejects(
    () => downloadFromCdn({ kind: 'claude', version: VERSION, platformKey: 'darwin-arm64', binPath }),
    /binary sha256 mismatch/,
  );
  assert.equal(fs.existsSync(binPath), false);
});

test('downloadFromCdn: win32 平台拼出 .exe.gz URL', async () => {
  let hitPath = null;
  routes.set('/manifest-win32-x64-canary.json', serveJson({
    codex: { version: VERSION, file: 'x', sha256: GZ_SHA, size: GZ.length, binarySha256: BIN_SHA },
  }));
  routes.set(`/codex/${VERSION}/win32-x64/codex.exe.gz`, (req, res) => {
    hitPath = req.url.split('?')[0];
    res.writeHead(200);
    res.end(GZ);
  });

  const binPath = tmpBinPath('codex.exe');
  const r = await downloadFromCdn({ kind: 'codex', version: VERSION, platformKey: 'win32-x64', binPath });
  assert.equal(hitPath, `/codex/${VERSION}/win32-x64/codex.exe.gz`);
  assert.equal(r.binaryVerified, true);
});

test('downloadFromCdn: ripgrep 没有 manifest 字段时也按约定 URL 兜底成功', async () => {
  let hitPath = null;
  routes.set(`/ripgrep/${VERSION}/darwin-arm64/rg.gz`, (req, res) => {
    hitPath = req.url.split('?')[0];
    res.writeHead(200);
    res.end(GZ);
  });

  const binPath = tmpBinPath('rg');
  const r = await downloadFromCdn({ kind: 'ripgrep', version: VERSION, platformKey: 'darwin-arm64', binPath });
  assert.equal(hitPath, `/ripgrep/${VERSION}/darwin-arm64/rg.gz`);
  assert.equal(r.gzVerified, false);
  assert.equal(r.binaryVerified, false);
  assert.deepEqual(fs.readFileSync(binPath), BINARY);
});

test('downloadFromCdn: 不支持的 kind 直接抛错', async () => {
  const binPath = tmpBinPath('rg');
  await assert.rejects(
    () => downloadFromCdn({ kind: 'gemini', version: VERSION, platformKey: 'darwin-arm64', binPath }),
    /not supported for kind: gemini/,
  );
});
