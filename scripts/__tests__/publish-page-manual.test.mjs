// 页面生成手册发布脚本（scripts/publish-page-manual.mjs）的单测。
//
// 测试价值
// - 生产入口与可观察结果：调用 CLI 实际使用的 runPublishPageManual(argv, deps)；断言按内容
//   寻址的 OSS key / CDN 地址、跳过与报错语义、注入的 OSS 客户端收到（或没收到）的写入，
//   以及 --check-cdn 的核对结论。
// - 规则依据：客户端按内置手册的 sha256 拼地址，同一 key 只能有一种内容；发布入口必须显式
//   指定区域且不跨区兜底（docs/product-rules/region-and-editions.md §2.2、scripts/shared/oss.mjs）。
// - 现有覆盖缺口：新脚本；参照的 publish-wallpaper-videos.mjs 与 oss.mjs 均无测试。
// - 最小失败输入：远端已有同 key 对象；缺失或拼错的区域 / 模式参数；CDN 返回 404 或内容不符。
// - tier：unit。临时目录 + 内存 fake OSS 客户端 / fetch，不连网、不读凭证。
// - 实测耗时：node --test scripts/__tests__/publish-page-manual.test.mjs 约 0.2 秒。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPublishPageManual } from '../publish-page-manual.mjs';
import { PLUGIN_PAGE_MANUAL_SKILL_PATH } from '../../apps/desktop/src/shared/pluginPageManual.mjs';

const MANUAL = '# Cindy 交互页面生成手册\n\n测试内容\n';
const MANUAL_SHA = createHash('sha256').update(MANUAL).digest('hex');
const RELATIVE = `plugin-pages/manual/${MANUAL_SHA}.md`;

function fixture({ withManual = true, endpoint } = {}) {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-page-manual-'));
  if (withManual) {
    const manual = path.join(repoRoot, 'apps/desktop/resources/system-skills', PLUGIN_PAGE_MANUAL_SKILL_PATH);
    fs.mkdirSync(path.dirname(manual), { recursive: true });
    fs.writeFileSync(manual, MANUAL);
  }
  if (endpoint) {
    fs.mkdirSync(path.join(repoRoot, 'config'));
    fs.writeFileSync(path.join(repoRoot, 'config', endpoint.file), JSON.stringify({ cdnBaseUrl: endpoint.cdnBaseUrl }));
  }
  return repoRoot;
}

function deps(repoRoot, overrides = {}) {
  const logs = [];
  return {
    logs,
    repoRoot,
    env: {},
    log: (line) => logs.push(line),
    resolveOssConfig: () => { throw new Error('只读模式不应解析 OSS 发布配置'); },
    createClient: () => { throw new Error('不应创建 OSS 客户端'); },
    fetch: () => { throw new Error('不应访问网络'); },
    ...overrides,
  };
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// 内存 OSS：objects 预置远端状态；puts 记录写入；put 遵守 x-oss-forbid-overwrite。
function fakeOss(objects = new Map(), { raceOn } = {}) {
  const puts = [];
  return {
    puts,
    objects,
    async head(key) {
      const obj = objects.get(key);
      if (!obj) throw Object.assign(new Error('NoSuchKey'), { status: 404, code: 'NoSuchKey' });
      return { meta: obj.meta ?? {}, res: { headers: {} } };
    },
    async get(key) {
      return { content: objects.get(key).body };
    },
    async put(key, body, options) {
      if (raceOn === key) {
        objects.set(key, { body, meta: { sha256: sha(body) } });
        throw Object.assign(new Error('FileAlreadyExists'), { status: 409, code: 'FileAlreadyExists' });
      }
      if (options?.headers?.['x-oss-forbid-overwrite'] === 'true' && objects.has(key)) {
        throw Object.assign(new Error('FileAlreadyExists'), { status: 409, code: 'FileAlreadyExists' });
      }
      puts.push({ key, body: Buffer.from(body), options });
      objects.set(key, { body: Buffer.from(body), meta: options?.meta });
      return {};
    },
  };
}

// 按 CDN 地址回放 OSS 内容的 fetch；用于发布后的回读校验与 --check-cdn。
function cdnFetch(objects, cdnBase, prefix) {
  return async (url, init) => {
    assert.equal(init.redirect, 'error');
    const obj = objects.get(prefix + url.split('?')[0].slice(cdnBase.length));
    if (!obj) return new Response('missing', { status: 404 });
    return new Response(obj.body, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' } });
  };
}

test('dry-run 按手册 sha256 拼出各区域的 key 与 CDN 地址，不连 OSS 也不访问网络', async () => {
  for (const [region, prefixEnv, cdnEnv] of [
    ['global', 'XDT_GLOBAL_OSS_PREFIX', 'XDT_GLOBAL_CDN_BASE_URL'],
    ['cn', 'XDT_OSS_PREFIX', 'XDT_CDN_BASE_URL'],
    ['dev', 'XDT_DEVCH_OSS_PREFIX', 'XDT_DEVCH_CDN_BASE_URL'],
  ]) {
    const d = deps(fixture(), { env: { [prefixEnv]: `pfx-${region}/`, [cdnEnv]: `https://cdn-${region}.test/cindy/` } });
    const result = await runPublishPageManual([`--region=${region}`, '--dry-run'], d);
    assert.equal(result.status, 'dry-run', region);
    assert.equal(result.manual.sha256, MANUAL_SHA, region);
    assert.equal(result.manual.key, `pfx-${region}/${RELATIVE}`, region);
    assert.equal(result.manual.url, `https://cdn-${region}.test/cindy/${RELATIVE}`, region);
  }
});

test('仓库里没有手册时跳过并打印原因，不连 OSS', async () => {
  const d = deps(fixture({ withManual: false }));
  const result = await runPublishPageManual(['--region=global'], d);
  assert.equal(result.status, 'skipped');
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /跳过.*PAGE-GENERATION\.md/);
});

test('区域与模式参数不合法时拒绝执行', async () => {
  for (const [name, argv, error] of [
    ['缺少 --region', [], /--region/],
    ['非法区域', ['--region=eu'], /--region/],
    ['拼错的 --dryrun 不能落到真实发布', ['--region=global', '--dryrun'], /未知参数/],
    ['同时 --dry-run 与 --check-cdn', ['--region=global', '--dry-run', '--check-cdn'], /不能同时/],
  ]) {
    await assert.rejects(runPublishPageManual(argv, deps(fixture())), error, name);
  }
});

test('发布：同一 key 已有相同内容时不再上传，内容不符时拒绝覆盖', async () => {
  const prefix = 'cindy';
  const cdnBase = 'https://cdn.test/cindy';
  const key = `${prefix}/${RELATIVE}`;
  const other = Buffer.from('# 被改过\n');
  for (const [name, objects, ossOptions, error, expectedPuts] of [
    ['远端不存在：上传一次，带不可变缓存与禁止覆盖头', new Map(), {}, null, [key]],
    ['远端已有相同内容：不调用 put', new Map([[key, { body: Buffer.from(MANUAL), meta: { sha256: MANUAL_SHA } }]]), {}, null, []],
    ['远端缺 meta 但内容相同：下载比对后不调用 put', new Map([[key, { body: Buffer.from(MANUAL) }]]), {}, null, []],
    ['并发写入后 409：重新比对相同则视为已发布', new Map(), { raceOn: key }, null, []],
    ['远端内容与 key 不符：拒绝覆盖', new Map([[key, { body: other }]]), {}, /不符/, []],
  ]) {
    const oss = fakeOss(objects, ossOptions);
    const d = deps(fixture(), {
      resolveOssConfig: (region) => {
        assert.equal(region, 'global');
        return { prefix, cdnBase };
      },
      createClient: (region) => {
        assert.equal(region, 'global');
        return oss;
      },
      fetch: cdnFetch(oss.objects, cdnBase, prefix),
    });
    const run = runPublishPageManual(['--region=global'], d);
    if (error) await assert.rejects(run, error, name);
    else assert.equal((await run).status, 'published', name);
    assert.deepEqual(oss.puts.map((p) => p.key), expectedPuts, name);
    for (const put of oss.puts) {
      assert.deepEqual(put.options.headers, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'x-oss-forbid-overwrite': 'true',
      }, name);
      assert.equal(put.options.meta.sha256, MANUAL_SHA, name);
    }
  }
});

test('--check-cdn 只读核对：一致通过，404 或内容不符失败；未配置变量时读端点清单', async () => {
  const cdnBase = 'https://hotfix.test/cindy';
  const repoRoot = fixture({ endpoint: { file: 'endpoint.global.json', cdnBaseUrl: cdnBase } });
  for (const [name, objects, error] of [
    ['一致', new Map([[RELATIVE, { body: Buffer.from(MANUAL) }]]), null],
    ['404', new Map(), /HTTP 404/],
    ['内容不符', new Map([[RELATIVE, { body: Buffer.from('# 旧手册\n') }]]), /不一致/],
  ]) {
    const run = runPublishPageManual(['--region=global', '--check-cdn'], deps(repoRoot, {
      fetch: cdnFetch(objects, `${cdnBase}/`, ''),
    }));
    if (error) await assert.rejects(run, error, name);
    else assert.equal((await run).status, 'verified', name);
  }
});
