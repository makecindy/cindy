#!/usr/bin/env node
// 从仓内提取器机械刷新登录 QA 数据；保留各页面现有的 script 包装。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const check = process.argv.includes('--check');
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

for (const demo of ['login-flow-hifi', 'login-all-hifi']) {
  const directory = new URL(`./${demo}/`, import.meta.url);
  const truth = canonical(JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL('extract.mjs', directory))],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  )));
  const truthPath = new URL('truth.json', directory);
  const htmlPath = new URL('index.html', directory);
  const html = readFileSync(htmlPath, 'utf8');
  const pattern = /(<script id="qa-truth"[^>]*>)([\s\S]*?)(<\/script>)/;
  const block = html.match(pattern);
  assert.ok(block, `${demo}: missing qa-truth block`);
  const prefix = demo === 'login-all-hifi' ? 'const RAW = ' : '';
  assert.ok(block[2].startsWith(prefix), `${demo}: unexpected truth wrapper`);
  if (check) {
    assert.deepEqual(JSON.parse(readFileSync(truthPath, 'utf8')), truth, `${demo}: truth drift`);
    assert.deepEqual(JSON.parse(block[2].slice(prefix.length)), truth, `${demo}: embedded truth drift`);
  } else {
    // 防止产品文案中的 HTML 结束 script；解析后的 JSON 内容保持不变。
    const literal = JSON.stringify(truth)
      .replace(/</g, '\\u003c')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    writeFileSync(truthPath, `${JSON.stringify(truth, null, 2)}\n`);
    writeFileSync(htmlPath, html.replace(pattern, (_match, open, _body, close) => `${open}${prefix}${literal}${close}`));
  }
  process.stdout.write(`${demo}: ${check ? 'current' : 'updated'}\n`);
}
