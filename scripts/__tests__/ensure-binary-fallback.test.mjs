// ensureBinary 兜底编排的集成测试：单文件分发回退 CDN，目录分发 fail closed。
//
// 关键技巧：用假 platformKey 'test-fallback-platform'。各 update.mjs 的 ensurePlatform 会先
// `PLATFORMS.find(...)` 找不到而立即抛 "Unknown platform key"——**不打真实网络、不碰任何真实
// 平台的二进制目录**，确定性地模拟"上游失败"，再观察 ensureBinary 的兜底分支。mock CDN 提供
// 单文件分发的 manifest + .gz；Codex 完整包不得退化成单文件。node 内置 test runner，无 vitest 依赖。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ensureBinary } from '../ensure-agent-binaries.mjs';

const PLATFORM = 'test-fallback-platform'; // 假平台：上游立即抛 unknown，不打网络、不碰真实二进制
const CLAUDE_PIN = JSON.parse(fs.readFileSync('tools/claude/latest.json', 'utf8')).version;
const RIPGREP_PIN = JSON.parse(fs.readFileSync('tools/ripgrep/latest.json', 'utf8')).version;

const BIN = Buffer.alloc(4096, 5);
const GZ = zlib.gzipSync(BIN);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const dirsToClean = [
  path.join('apps', 'claude-code-bin', PLATFORM),
  path.join('apps', 'codex-package-bin', PLATFORM),
  path.join('apps', 'ripgrep-bin', PLATFORM),
];

let server;
let savedCdnBase;

before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (u === `/manifest-${PLATFORM}-canary.json`) {
      res.end(JSON.stringify({
        claudeCode: { version: CLAUDE_PIN, file: 'x', sha256: sha(GZ), size: GZ.length, binarySha256: sha(BIN) },
        ripgrep: { version: RIPGREP_PIN, file: 'x', sha256: sha(GZ), size: GZ.length, binarySha256: sha(BIN) },
      }));
    } else if (
      u === `/claude-code/${CLAUDE_PIN}/${PLATFORM}/claude.gz` ||
      u === `/ripgrep/${RIPGREP_PIN}/${PLATFORM}/rg.gz`
    ) {
      res.end(GZ);
    } else {
      res.writeHead(404);
      res.end('nf');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  savedCdnBase = process.env.XDT_CDN_BASE_URL;
  process.env.XDT_CDN_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (savedCdnBase === undefined) delete process.env.XDT_CDN_BASE_URL;
  else process.env.XDT_CDN_BASE_URL = savedCdnBase;
  for (const d of dirsToClean) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  await new Promise((r) => server.close(r));
});

test('ensureBinary(claude): 上游失败 → 回退 CDN，落地正确二进制 + .version==pin', async () => {
  const binPath = await ensureBinary('claude', PLATFORM, { force: true });
  assert.ok(fs.readFileSync(binPath).equals(BIN), 'binary content == mock CDN binary');
  const ver = fs.readFileSync(path.join(path.dirname(binPath), '.version'), 'utf8').trim();
  assert.equal(ver, CLAUDE_PIN);
});

test('ensureBinary(codex): 完整目录包拒绝单二进制 CDN 回退', async () => {
  await assert.rejects(
    ensureBinary('codex', PLATFORM, { force: true }),
    /directory distribution.*pnpm update:codex-package/s,
  );
  assert.equal(fs.existsSync(path.join('apps', 'codex-package-bin', PLATFORM)), false);
});

test('ensureBinary(ripgrep): 上游失败 → 回退 CDN，落地正确二进制 + .version==pin', async () => {
  const binPath = await ensureBinary('ripgrep', PLATFORM, { force: true });
  assert.ok(fs.readFileSync(binPath).equals(BIN), 'binary content == mock CDN binary');
  const ver = fs.readFileSync(path.join(path.dirname(binPath), '.version'), 'utf8').trim();
  assert.equal(ver, RIPGREP_PIN);
});
