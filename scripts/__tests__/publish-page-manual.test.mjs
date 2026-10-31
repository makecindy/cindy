// 页面生成手册发布脚本（scripts/publish-page-manual.mjs）的单测。
//
// 测试价值
// - 生产入口与可观察结果：调用 CLI 实际使用的 runPublishPageManual(argv, deps)；断言按
//   「版本号 + sha256」拼出的 OSS key / CDN 地址、跳过与报错语义、注入的 OSS 客户端收到
//   （或没收到）的写入，以及 --check-cdn 的核对结论。
// - 规则依据：客户端按 app.getVersion() 与内置手册的 sha256 拼地址，同一 key 只能有一种内容；
//   版本号、区域、发版提交只取自打包产出的 build-info.json（package-desktop.mjs 注明它是发布侧
//   唯一输入），版本无关包不发布，版本号不能是 0.0.0 或含路径字符，检出必须是发版提交；
//   区域不跨区兜底（docs/product-rules/region-and-editions.md §2.2、scripts/shared/oss.mjs）。
// - 现有覆盖缺口：新脚本；参照的 publish-wallpaper-videos.mjs 与 oss.mjs 均无测试。
// - 最小失败输入：远端已有同 key 对象；缺少 --build-info 或拼错的模式参数；build-info 的
//   version 为 null / 0.0.0 / `1.2.3/../x`、commitSha 与检出不一致；CDN 返回 404 或内容不符。
// - tier：unit。临时目录造 build-info 与手册，git 状态注入，内存 fake OSS 客户端 / fetch，
//   不连网、不读凭证。
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
const VERSION = '0.1.122-beta';
const COMMIT = 'a'.repeat(40);
const RELATIVE = `mcp-apps/manual/${VERSION}/${MANUAL_SHA}.md`;

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

// 在临时目录写一份 build-info.json，返回对应的 --build-info 参数。
function buildInfoArg(repoRoot, fields = {}) {
  const file = path.join(repoRoot, `build-info-${fs.readdirSync(repoRoot).length}.json`);
  fs.writeFileSync(file, JSON.stringify({
    version: VERSION,
    versionless: false,
    region: 'global',
    commitSha: COMMIT,
    mcpAppsManual: { sha256: MANUAL_SHA, size: Buffer.byteLength(MANUAL) },
    ...fields,
  }));
  return `--build-info=${file}`;
}

function deps(repoRoot, overrides = {}) {
  const logs = [];
  return {
    logs,
    repoRoot,
    env: {},
    log: (line) => logs.push(line),
    git: { head: () => COMMIT, isPathClean: () => true },
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

test('dry-run 按版本号与手册 sha256 拼出各区域的 key 与 CDN 地址，不连 OSS 也不访问网络', async () => {
  for (const [region, prefixEnv, cdnEnv] of [
    ['global', 'XDT_GLOBAL_OSS_PREFIX', 'XDT_GLOBAL_CDN_BASE_URL'],
    ['cn', 'XDT_OSS_PREFIX', 'XDT_CDN_BASE_URL'],
    ['dev', 'XDT_DEVCH_OSS_PREFIX', 'XDT_DEVCH_CDN_BASE_URL'],
  ]) {
    const repoRoot = fixture();
    const d = deps(repoRoot, { env: { [prefixEnv]: `pfx-${region}/`, [cdnEnv]: `https://cdn-${region}.test/cindy/` } });
    const result = await runPublishPageManual([buildInfoArg(repoRoot, { region }), '--dry-run'], d);
    assert.equal(result.status, 'dry-run', region);
    assert.equal(result.manual.sha256, MANUAL_SHA, region);
    assert.equal(result.manual.key, `pfx-${region}/${RELATIVE}`, region);
    assert.equal(result.manual.url, `https://cdn-${region}.test/cindy/${RELATIVE}`, region);
  }
});

test('发版提交里没有手册时跳过并打印原因，不连 OSS', async () => {
  const repoRoot = fixture({ withManual: false });
  const d = deps(repoRoot);
  const result = await runPublishPageManual([buildInfoArg(repoRoot, { mcpAppsManual: null })], d);
  assert.equal(result.status, 'skipped');
  assert.equal(d.logs.length, 1);
  assert.match(d.logs[0], /跳过.*PAGE-GENERATION\.md/);
});

test('参数、build-info 或检出不符合发布条件时拒绝执行', async () => {
  for (const [name, options, argv, error] of [
    ['缺少 --build-info', {}, () => ['--dry-run'], /--build-info/],
    ['版本无关包（version 为 null）', {}, (r) => [buildInfoArg(r, { version: null, versionless: true }), '--dry-run'], /版本无关包/],
    ['仓库占位版本 0.0.0', {}, (r) => [buildInfoArg(r, { version: '0.0.0' }), '--dry-run'], /占位/],
    ['版本号带斜杠与 ..', {}, (r) => [buildInfoArg(r, { version: '1.2.3/../x' }), '--dry-run'], /版本号/],
    ['预发布后缀里的 ..', {}, (r) => [buildInfoArg(r, { version: '1.2.3-a..b' }), '--dry-run'], /版本号/],
    ['非法区域', {}, (r) => [buildInfoArg(r, { region: 'eu' }), '--dry-run'], /region/],
    // 错的检出里没有手册时也必须失败，不能当成「这个包没有手册」跳过。
    ['commitSha 与当前检出不一致', { withManual: false }, (r) => [buildInfoArg(r, { commitSha: 'b'.repeat(40) })], /发版提交上执行/],
    // 上传的必须是安装包里实际打进去的那份手册（build-info.mcpAppsManual，打包时写入）。
    ['旧打包脚本产出的 build-info 缺少 mcpAppsManual', {}, (r) => [buildInfoArg(r, { mcpAppsManual: undefined }), '--dry-run'], /缺少 mcpAppsManual/],
    ['仓库手册与包内手册的 sha256 不一致', {}, (r) => [buildInfoArg(r, { mcpAppsManual: { sha256: 'e'.repeat(64), size: 9 } }), '--dry-run'], /不一致/],
    ['包内没有手册，检出里却有', {}, (r) => [buildInfoArg(r, { mcpAppsManual: null }), '--dry-run'], /不一致/],
    ['包内有手册，检出里却没有', { withManual: false }, (r) => [buildInfoArg(r), '--dry-run'], /内置了手册/],
    ['拼错的 --dryrun 不能落到真实发布', {}, (r) => [buildInfoArg(r), '--dryrun'], /未知参数/],
    ['同时 --dry-run 与 --check-cdn', {}, (r) => [buildInfoArg(r), '--dry-run', '--check-cdn'], /不能同时/],
  ]) {
    const repoRoot = fixture(options);
    await assert.rejects(runPublishPageManual(argv(repoRoot), deps(repoRoot)), error, name);
  }
  // 本地改过或删掉（未提交）的手册都不是发版提交里的内容；删掉时也不能当成「没有手册」跳过。
  for (const withManual of [true, false]) {
    const repoRoot = fixture({ withManual });
    await assert.rejects(
      runPublishPageManual([buildInfoArg(repoRoot), '--dry-run'], deps(repoRoot, {
        git: { head: () => COMMIT, isPathClean: () => false },
      })),
      /未提交改动/,
      `手册有未提交改动（文件${withManual ? '存在' : '已删除'}）`,
    );
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
    const repoRoot = fixture();
    const d = deps(repoRoot, {
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
    const run = runPublishPageManual([buildInfoArg(repoRoot)], d);
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
    const run = runPublishPageManual([buildInfoArg(repoRoot), '--check-cdn'], deps(repoRoot, {
      fetch: cdnFetch(objects, `${cdnBase}/`, ''),
    }));
    if (error) await assert.rejects(run, error, name);
    else assert.equal((await run).status, 'verified', name);
  }
});
