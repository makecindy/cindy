/**
 * 日志上报目标的构建期注入校验。
 *
 * 这一层承接了原先由 typecheck 提供的 fail-closed 保证（值写在 TS 的
 * `Record<CindyRegion, …>` 里时，「新增区域忘了做选择」会直接编译失败）。值搬进
 * gitignore 的 JSON 后，唯一能拦下漏配的地方就是这里，所以每条硬失败都必须有用例钉住——
 * 把它们改成"缺失就静默跳过"会让一次漏配变成发版后才发现的观测能力真空。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  LOG_UPLOAD_TARGET_ENV,
  desktopLogUploadBuildEnv,
  loadLogUploadTargets,
  slsEndpointHost,
} from '../shared/log-upload-build-env.mjs';

const VALID = {
  schemaVersion: 1,
  cn: { project: 'cn-proj', logstore: 'cn-log', slsRegion: 'cn-shanghai' },
  global: { project: 'global-proj', logstore: 'global-log', slsRegion: 'ap-southeast-1' },
  dev: null,
};

/**
 * 本文件建过的临时目录。用 `afterEach` 统一回收，与 `client-endpoint-build-env.test.mjs`
 * 同款——不用在测试执行期调 `test.after()` 注册根级钩子（那依赖 node:test 的导出形态与
 * 「运行中注册根钩子」这个未承诺的行为）。
 */
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 建一个本用例专属的临时目录（结束时由 afterEach 回收）。 */
function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 把一份配置写进临时文件，返回路径。逐个用例独立目录，结束即清理。 */
function writeConfig(config) {
  const file = path.join(makeTempDir('cindy-log-upload-cfg-'), 'log-upload.json');
  fs.writeFileSync(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
}

function loadWith(config) {
  return loadLogUploadTargets({ configPath: writeConfig(config) });
}

function assertThrowsMatching(config, pattern) {
  assert.throws(() => loadWith(config), pattern);
}

test('slsEndpointHost: 只拼区域代号，不带协议不带 project 前缀', () => {
  assert.equal(slsEndpointHost('cn-shanghai'), 'cn-shanghai.log.aliyuncs.com');
  assert.equal(slsEndpointHost('ap-southeast-1'), 'ap-southeast-1.log.aliyuncs.com');
});

test('合法配置: 按区域返回归一化目标', () => {
  const targets = loadWith(VALID);
  assert.deepEqual(targets.cn, {
    region: 'cn',
    project: 'cn-proj',
    logstore: 'cn-log',
    endpointHost: 'cn-shanghai.log.aliyuncs.com',
  });
  assert.deepEqual(targets.global, {
    region: 'global',
    project: 'global-proj',
    logstore: 'global-log',
    endpointHost: 'ap-southeast-1.log.aliyuncs.com',
  });
  assert.equal(targets.dev, null);
});

test('dev 可缺省(缺 key 与显式 null 等价)', () => {
  const withoutDev = { ...VALID };
  delete withoutDev.dev;
  assert.equal(loadWith(withoutDev).dev, null);
});

test('cn 缺失 ⇒ 抛错(发行区域漏配属发版事故,不是功能关闭)', () => {
  const noCn = { ...VALID, cn: null };
  assertThrowsMatching(noCn, /缺少必填区域 cn/);
});

test('global 缺失 ⇒ 抛错', () => {
  const noGlobal = { ...VALID, global: null };
  assertThrowsMatching(noGlobal, /缺少必填区域 global/);
});

test('文件不存在 ⇒ 抛错并说明真值来源', () => {
  const dir = makeTempDir('cindy-log-upload-missing-');
  assert.throws(
    () => loadLogUploadTargets({ configPath: path.join(dir, 'log-upload.json') }),
    /缺少日志上报配置[\s\S]*cindy-build-scripts/,
  );
});

/**
 * 2026-08-04 review P1：版本无关 / 开源打包用 allowMissing，配置文件缺失时不抛、返回 null
 * （功能整体关闭），拉仓即可打包。但只放宽「缺失」——文件在但内容损坏仍硬失败。
 */
test('allowMissing: 文件不存在 ⇒ 返回 null（不抛）', () => {
  const dir = makeTempDir('cindy-log-upload-allowmissing-');
  assert.equal(
    loadLogUploadTargets({ configPath: path.join(dir, 'log-upload.json'), allowMissing: true }),
    null,
  );
});

test('allowMissing 只放宽「缺失」：文件在但坏 JSON 仍抛', () => {
  const badPath = writeConfig('{ not json');
  assert.throws(
    () => loadLogUploadTargets({ configPath: badPath, allowMissing: true }),
    /不是合法 JSON/,
  );
});

test('desktopLogUploadBuildEnv: allowMissing + 文件缺失 ⇒ 注入空串（版本无关/开源打包）', () => {
  const dir = makeTempDir('cindy-log-upload-buildenv-missing-');
  const env = desktopLogUploadBuildEnv({
    authRegion: 'global',
    configPath: path.join(dir, 'log-upload.json'),
    allowMissing: true,
  });
  assert.equal(env[LOG_UPLOAD_TARGET_ENV], '');
});

test('desktopLogUploadBuildEnv: 默认(发行打包)文件缺失仍抛 —— 不静默关掉发行观测', () => {
  const dir = makeTempDir('cindy-log-upload-buildenv-required-');
  assert.throws(
    () =>
      desktopLogUploadBuildEnv({
        authRegion: 'global',
        configPath: path.join(dir, 'log-upload.json'),
      }),
    /缺少日志上报配置/,
  );
});

test('坏 JSON / 非 object / schemaVersion 非法 ⇒ 抛错', () => {
  assertThrowsMatching('{ not json', /不是合法 JSON/);
  assertThrowsMatching('[]', /必须是 JSON object/);
  assertThrowsMatching({ ...VALID, schemaVersion: 0 }, /schemaVersion 非法/);
  assertThrowsMatching({ cn: VALID.cn, global: VALID.global }, /schemaVersion 非法/);
});

test('区域配置字段缺失或空 ⇒ 抛错', () => {
  for (const field of ['project', 'logstore', 'slsRegion']) {
    const broken = { ...VALID, cn: { ...VALID.cn, [field]: '' } };
    assertThrowsMatching(broken, new RegExp(`缺少非空字符串字段 cn\\.${field}`));
    const missing = { ...VALID, cn: { ...VALID.cn } };
    delete missing.cn[field];
    assertThrowsMatching(missing, new RegExp(`缺少非空字符串字段 cn\\.${field}`));
  }
});

test('区域配置不是 object ⇒ 抛错', () => {
  assertThrowsMatching({ ...VALID, cn: 'cn-proj' }, /cn 必须是 JSON object 或 null/);
  assertThrowsMatching({ ...VALID, cn: [] }, /cn 必须是 JSON object 或 null/);
});

test('project / logstore 名不合法 ⇒ 抛错', () => {
  assertThrowsMatching(
    { ...VALID, cn: { ...VALID.cn, project: 'CN-Proj' } },
    /不是合法 SLS project 名/,
  );
  assertThrowsMatching(
    { ...VALID, cn: { ...VALID.cn, project: '-leading-hyphen' } },
    /不是合法 SLS project 名/,
  );
  assertThrowsMatching(
    { ...VALID, cn: { ...VALID.cn, logstore: 'log store' } },
    /不是合法 SLS logstore 名/,
  );
});

test('slsRegion 写成完整域名 ⇒ 抛错(否则会拼成 ...log.aliyuncs.com.log.aliyuncs.com)', () => {
  assertThrowsMatching(
    { ...VALID, cn: { ...VALID.cn, slsRegion: 'cn-shanghai.log.aliyuncs.com' } },
    /只写区域代号/,
  );
});

test('⚠️ 两个区域共用同一个 project ⇒ 抛错(跨区域隔离,有事故先例)', () => {
  const shared = {
    ...VALID,
    global: { ...VALID.global, project: VALID.cn.project },
  };
  assertThrowsMatching(shared, /共用同一个 project/);
});

test('⚠️ 两个区域共用同一个 logstore ⇒ 抛错', () => {
  const shared = {
    ...VALID,
    global: { ...VALID.global, logstore: VALID.cn.logstore },
  };
  assertThrowsMatching(shared, /共用同一个 logstore/);
});

test('两个区域共用同一个 slsRegion 是允许的(同城不同 project 是合法部署)', () => {
  const sameRegion = {
    ...VALID,
    global: { ...VALID.global, slsRegion: VALID.cn.slsRegion },
  };
  const targets = loadWith(sameRegion);
  assert.equal(targets.cn.endpointHost, targets.global.endpointHost);
  assert.notEqual(targets.cn.project, targets.global.project);
});

test('desktopLogUploadBuildEnv: 只注入本构建区域那一个目标', () => {
  const configPath = writeConfig(VALID);
  const cnEnv = desktopLogUploadBuildEnv({ authRegion: 'cn', configPath });
  const payload = JSON.parse(cnEnv[LOG_UPLOAD_TARGET_ENV]);
  assert.equal(payload.region, 'cn');
  assert.equal(payload.project, 'cn-proj');
  // cn 包里物理上不含 global 的地址 —— 这是比"运行时按 region 选"更强的隔离。
  assert.ok(!cnEnv[LOG_UPLOAD_TARGET_ENV].includes('global-proj'));
  assert.ok(!cnEnv[LOG_UPLOAD_TARGET_ENV].includes('global-log'));
});

test('desktopLogUploadBuildEnv: dev 缺省 ⇒ 空串(该渠道功能整体关闭)', () => {
  const configPath = writeConfig(VALID);
  const devEnv = desktopLogUploadBuildEnv({ authRegion: 'dev', configPath });
  assert.equal(devEnv[LOG_UPLOAD_TARGET_ENV], '');
});

test('desktopLogUploadBuildEnv: 非法 region ⇒ 抛错(不静默落到某个默认区)', () => {
  const configPath = writeConfig(VALID);
  assert.throws(
    () => desktopLogUploadBuildEnv({ authRegion: 'nowhere', configPath }),
    /Invalid Cindy auth region/,
  );
});

test('注入串可被客户端解析回同一目标(两侧形状对齐)', () => {
  const configPath = writeConfig(VALID);
  const raw = desktopLogUploadBuildEnv({ authRegion: 'global', configPath })[
    LOG_UPLOAD_TARGET_ENV
  ];
  const payload = JSON.parse(raw);
  // 客户端 parseInjectedTarget 要求的四个字段齐全,且 endpointHost 是纯主机名。
  assert.deepEqual(Object.keys(payload).sort(), [
    'endpointHost',
    'logstore',
    'project',
    'region',
  ]);
  assert.ok(!payload.endpointHost.includes('://'));
  assert.ok(!payload.endpointHost.includes('/'));
  assert.ok(!payload.endpointHost.startsWith(`${payload.project}.`));
});

test('仓内 .example 是合法配置骨架(照抄改值即可用,dev 为 null)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..');
  const examplePath = path.join(repoRoot, 'config', 'log-upload.json.example');
  const targets = loadLogUploadTargets({ configPath: examplePath });
  assert.ok(targets.cn, 'example 的 cn 应可解析');
  assert.ok(targets.global, 'example 的 global 应可解析');
  assert.equal(targets.dev, null);
});
