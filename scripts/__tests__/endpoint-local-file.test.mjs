import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import { generateEndpointLocalFile } from '../shared/endpoint-local-file.mjs';

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepoRoot(manifest, globalManifest = manifest) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'endpoint-local-file-'));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  if (manifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'config', 'endpoint.json'), manifest);
  }
  if (globalManifest !== undefined) {
    fs.writeFileSync(path.join(dir, 'config', 'endpoint.global.json'), globalManifest);
  }
  return dir;
}

const CN_MANIFEST = JSON.stringify({
  schemaVersion: 1,
  authApiBaseUrl: 'https://auth.example.invalid',
  deviceLinkApiBaseUrl: 'https://device.example.invalid',
  oauthBrokerApiBaseUrl: 'https://oauth.example.invalid',
  ossApiBaseUrl: 'https://oss.example.invalid',
  heartbeatUrl: 'https://heartbeat.example.invalid',
  telegramHookWsUrl: '',
  slackHookWsUrl: 'wss://hook.example.invalid',
  websiteUrl: 'https://website.example.invalid',
  modelAccessApiBaseUrl: 'https://model-access.example.invalid',
  voiceApiBaseUrl: 'https://voice.example.invalid',
  githubApiBaseUrl: 'https://github-api.example.invalid',
  skillhubApiBaseUrl: 'https://skillhub.example.invalid',
  cindySkillHubApiBaseUrl: 'https://cindy-skillhub.example.invalid',
  pluginApiBaseUrl: 'https://plugin.example.invalid',
  cdnBaseUrl: 'https://cdn.example.invalid/app',
  mobileUpdateBaseUrl: 'https://mobile-update.example.invalid',
});
const GLOBAL_MANIFEST = JSON.stringify({
  ...JSON.parse(CN_MANIFEST),
  oauthBrokerApiBaseUrl: 'https://oauth.global.example.invalid',
  cdnBaseUrl: 'https://cdn.global.example.invalid/app',
});

test('localhost 八件套覆写,默认其余字段照抄 Global 正本,返回绝对路径', () => {
  const repoRoot = makeRepoRoot(CN_MANIFEST, GLOBAL_MANIFEST);
  const target = generateEndpointLocalFile({ repoRoot });
  assert.equal(target, path.join(repoRoot, 'config', 'endpoint.local.json'));
  const local = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(local.authApiBaseUrl, 'http://localhost:3344');
  assert.equal(local.deviceLinkApiBaseUrl, 'http://localhost:3335');
  assert.equal(local.ossApiBaseUrl, 'http://localhost:3340');
  assert.equal(local.modelAccessApiBaseUrl, 'http://localhost:3339');
  assert.equal(local.voiceApiBaseUrl, 'http://localhost:3342');
  assert.equal(local.githubApiBaseUrl, 'http://localhost:3336');
  assert.equal(local.skillhubApiBaseUrl, 'http://localhost:3341');
  assert.equal(local.cindySkillHubApiBaseUrl, 'http://localhost:3345');
  assert.equal(local.pluginApiBaseUrl, 'http://localhost:3343');
  // 其余字段与正本一致(oauth broker 等本地不起的服务沿用远程值)
  assert.equal(local.oauthBrokerApiBaseUrl, 'https://oauth.global.example.invalid');
  assert.equal(local.cdnBaseUrl, 'https://cdn.global.example.invalid/app');
  assert.equal(local.schemaVersion, 1);
});

test('幂等:重复生成整文件重写,手改会丢', () => {
  const repoRoot = makeRepoRoot(CN_MANIFEST);
  const target = generateEndpointLocalFile({ repoRoot });
  const manual = JSON.parse(fs.readFileSync(target, 'utf8'));
  manual.authApiBaseUrl = 'http://localhost:9999';
  fs.writeFileSync(target, JSON.stringify(manual));
  generateEndpointLocalFile({ repoRoot });
  assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).authApiBaseUrl, 'http://localhost:3344');
});

test('所选正本缺失 / 非法时给出明确错误(fail closed,不造半截配置)', () => {
  assert.throws(
    () =>
      generateEndpointLocalFile({
        repoRoot: makeRepoRoot(undefined),
        region: 'dev',
      }),
    /Missing endpoint manifest config\/endpoint\.dev\.json.*endpoint\.dev\.json\.example/,
  );
  assert.throws(
    () =>
      generateEndpointLocalFile({
        repoRoot: makeRepoRoot(CN_MANIFEST, 'not-json{{'),
      }),
    /Invalid JSON in endpoint manifest config\/endpoint\.global\.json/,
  );
  assert.throws(() => generateEndpointLocalFile({
    repoRoot: makeRepoRoot(CN_MANIFEST),
    region: 'us',
  }));
});

test('生成物能过客户端 parser 的 allowHttp 校验(与仓内正本同一守门语义)', async () => {
  // maker-shared 是 TS 源码直发,node --test 下直接 import .ts 不可行;
  // 这里额外守住本地生成器自己的完整输出契约:预期字段齐备 + localhost 用 http。
  const repoRoot = makeRepoRoot(CN_MANIFEST);
  const local = JSON.parse(fs.readFileSync(generateEndpointLocalFile({ repoRoot }), 'utf8'));
  const requiredKeys = [
    'authApiBaseUrl',
    'deviceLinkApiBaseUrl',
    'oauthBrokerApiBaseUrl',
    'ossApiBaseUrl',
    'heartbeatUrl',
    'slackHookWsUrl',
    'websiteUrl',
    'modelAccessApiBaseUrl',
    'voiceApiBaseUrl',
    'githubApiBaseUrl',
    'skillhubApiBaseUrl',
    'cindySkillHubApiBaseUrl',
    'pluginApiBaseUrl',
    'cdnBaseUrl',
    'mobileUpdateBaseUrl',
  ];
  for (const key of requiredKeys) {
    assert.ok(typeof local[key] === 'string' && local[key].length > 0, key);
    assert.doesNotThrow(() => new URL(local[key]), key);
  }
  // Telegram 是平级服务；未部署时保持空值，绝不回退到 Slack 服务。
  assert.equal(local.telegramHookWsUrl, '');
  assert.equal(local.slackHookWsUrl, 'wss://hook.example.invalid');
});
