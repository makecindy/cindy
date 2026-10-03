import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  desktopClientBuildEnv,
  loadEndpointManifestBaseUrl,
  loadPeerEndpointManifestBaseUrl,
  mobileClientBundleEnv,
  mobileClientBundleProcessEnv,
  mobileClientBuildEnv,
} from '../shared/client-endpoint-build-env.mjs';
import { resolveReleaseCdnBaseUrl } from '../shared/release-env.mjs';
import {
  assertMobileManifestBuildEnv,
  createMobileManifestBuildSnapshot,
} from '../shared/mobile-manifest-build-guard.cjs';

const tempDirs = [];
const originalReleaseCdn = process.env.XDT_CDN_BASE_URL;
const originalCindyAuthRegion = process.env.CINDY_AUTH_REGION;

afterEach(() => {
  if (originalReleaseCdn === undefined) delete process.env.XDT_CDN_BASE_URL;
  else process.env.XDT_CDN_BASE_URL = originalReleaseCdn;
  if (originalCindyAuthRegion === undefined) delete process.env.CINDY_AUTH_REGION;
  else process.env.CINDY_AUTH_REGION = originalCindyAuthRegion;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test('desktop/mobile 构建从 region 清单的 cdnBaseUrl 生成自举环境变量', () => {
  const repoRoot = writeRepoFixtures();
  delete process.env.CINDY_AUTH_REGION;

  assert.deepEqual(desktopClientBuildEnv({ allowEnvOverride: false, repoRoot }), {
    VITE_CINDY_AUTH_REGION: 'global',
    VITE_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix-global.example.invalid/app',
    VITE_ENDPOINT_MANIFEST_PEER_BASE_URL: 'https://hotfix-cn.example.invalid/app',
  });
  assert.equal(
    Object.hasOwn(desktopClientBuildEnv({ allowEnvOverride: false, repoRoot }), 'VITE_FEISHU_APP_ID'),
    false,
  );
  assert.deepEqual(mobileClientBuildEnv({ authRegion: 'global', repoRoot }), {
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix-global.example.invalid/app',
  });
  assert.deepEqual(mobileClientBundleEnv({ authRegion: 'global', repoRoot }), {
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix-global.example.invalid/app',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL: 'https://hotfix-cn.example.invalid/app',
  });
  assert.deepEqual(mobileClientBundleEnv({ authRegion: 'dev', repoRoot }), {
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'dev',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix-dev.example.invalid/app',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL: 'https://hotfix-global.example.invalid/app',
    EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL:
      'https://hotfix-cn.example.invalid/app',
  });
  assert.equal(
    loadPeerEndpointManifestBaseUrl({ authRegion: 'cn', repoRoot }),
    'https://hotfix-global.example.invalid/app',
  );
});

test('Mobile bundling 进程环境只在 CindyDev 保留 Release 清单基址', () => {
  const repoRoot = writeRepoFixtures();
  const staleBaseEnv = {
    KEEP_ME: '1',
    EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL:
      'https://stale-release.example.invalid/app',
  };

  const cn = mobileClientBundleProcessEnv({
    authRegion: 'cn',
    baseEnv: staleBaseEnv,
    repoRoot,
  });
  assert.equal(cn.KEEP_ME, '1');
  assert.equal(
    Object.hasOwn(
      cn,
      'EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL',
    ),
    false,
  );

  const dev = mobileClientBundleProcessEnv({
    authRegion: 'dev',
    baseEnv: staleBaseEnv,
    repoRoot,
  });
  assert.equal(
    dev.EXPO_PUBLIC_CINDY_DEV_RELEASE_ENDPOINT_MANIFEST_BASE_URL,
    'https://hotfix-cn.example.invalid/app',
  );
});

test('Mobile 生产清单校验接受两区正本及等价 URL，且不修改传入环境', () => {
  const repoRoot = writeRepoFixtures();
  for (const authRegion of ['cn', 'global']) {
    const expected = mobileClientBundleEnv({ authRegion, repoRoot });
    const env = Object.freeze({
      ...expected,
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL:
        `  ${expected.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL.replace('https://hotfix-', 'https://HOTFIX-')}///  `,
    });
    assert.doesNotThrow(() => assertMobileManifestBuildEnv(env, expected));
  }
});

test('Mobile 生产清单校验拒绝缺失、重复、对调及不匹配的最终值', () => {
  const repoRoot = writeRepoFixtures();
  const baseKey = 'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL';
  const peerKey = 'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL';
  for (const authRegion of ['cn', 'global']) {
    const expected = mobileClientBundleEnv({ authRegion, repoRoot });
    for (const key of [baseKey, peerKey]) {
      for (const value of [undefined, '', ' ', 'not-a-url', 'http://example.invalid/app',
        'https://fake-user:fake-secret@example.invalid/app']) {
        assert.throws(() => assertMobileManifestBuildEnv({ ...expected, [key]: value }, expected),
          (error) => error.message.includes(key) && !error.message.includes('fake-secret'));
      }
      assert.throws(() => assertMobileManifestBuildEnv({
        ...expected, [key]: 'https://wrong.example.invalid/app',
      }, expected), /仓内清单不一致/);
    }
    assert.throws(() => assertMobileManifestBuildEnv({
      ...expected,
      [peerKey]: `${expected[baseKey].replace('/app', ':443/app')}/`,
    }, expected), /规范化后不能相同/);
    assert.throws(() => assertMobileManifestBuildEnv({
      ...expected, [baseKey]: expected[peerKey], [peerKey]: expected[baseKey],
    }, expected), /仓内清单不一致/);
    assert.throws(() => assertMobileManifestBuildEnv({
      ...expected, EXPO_PUBLIC_CINDY_AUTH_REGION: 'dev',
    }, expected), /构建区域不一致/);
  }
});

test('Mobile bundling 覆盖 runner 的两区残留值并拦截仓内重复 CDN', () => {
  const repoRoot = writeRepoFixtures();
  const baseEnv = Object.freeze({
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://stale.example.invalid/app',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL: 'https://stale.example.invalid/app',
  });
  const expected = mobileClientBundleEnv({ authRegion: 'global', repoRoot });
  assert.deepEqual(mobileClientBundleProcessEnv({ authRegion: 'global', repoRoot, baseEnv }), expected);

  fs.writeFileSync(path.join(repoRoot, 'config', 'endpoint.global.json'), JSON.stringify({
    schemaVersion: 1, cdnBaseUrl: 'https://HOTFIX-CN.example.invalid:443/app///',
  }));
  for (const authRegion of ['cn', 'global']) {
    assert.throws(() => mobileClientBundleProcessEnv({ authRegion, repoRoot, baseEnv }), /不能相同/);
  }
  assert.doesNotThrow(() => assertMobileManifestBuildEnv({
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'dev',
  }, { EXPO_PUBLIC_CINDY_AUTH_REGION: 'dev' }));
});

test('Mobile 转换缓存按三个原始构建值隔离，且不回显值或受无关 env 影响', () => {
  const env = Object.freeze(mobileClientBundleEnv({ authRegion: 'global', repoRoot: writeRepoFixtures() }));
  const snapshot = createMobileManifestBuildSnapshot(env);
  assert.match(snapshot.cacheKey, /^cindy-mobile-manifest-v1:[a-f0-9]{64}$/);
  assert.equal(createMobileManifestBuildSnapshot({ ...env }).cacheKey, snapshot.cacheKey);
  assert.doesNotThrow(() => snapshot.assertUnchanged({ ...env, UNRELATED_ENV: '1' }));
  assert.equal(createMobileManifestBuildSnapshot({ ...env, UNRELATED_ENV: '1' }).cacheKey, snapshot.cacheKey);
  for (const key of Object.keys(env)) {
    for (const value of [undefined, '', `${env[key]} `, 'fake-secret']) {
      const changed = { ...env, [key]: value };
      const next = createMobileManifestBuildSnapshot(changed);
      assert.notEqual(next.cacheKey, snapshot.cacheKey);
      assert.doesNotMatch(next.cacheKey, /fake-secret/);
      assert.throws(() => snapshot.assertUnchanged(changed),
        (error) => error.message.includes('重启 Metro') && !error.message.includes('fake-secret'));
    }
  }
});

test('Mobile 构建快照仅保留稳定 CindyDev 的开发覆盖，跨构建身份必须重启', () => {
  const dev = {
    EXPO_PUBLIC_CINDY_AUTH_REGION: 'dev',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'http://localhost:1234',
    EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL: 'http://localhost:5678',
  };
  const snapshot = createMobileManifestBuildSnapshot(dev);
  const changedDev = { ...dev, EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'http://localhost:9999' };
  assert.doesNotThrow(() => snapshot.assertUnchanged(changedDev));
  assert.doesNotThrow(() => assertMobileManifestBuildEnv(changedDev, dev));
  for (const authRegion of ['cn', 'global']) {
    const release = mobileClientBundleEnv({ authRegion, repoRoot: writeRepoFixtures() });
    assert.throws(() => snapshot.assertUnchanged(release), /重启 Metro/);
    assert.throws(() => createMobileManifestBuildSnapshot(release).assertUnchanged(dev), /重启 Metro/);
  }
});

test('Mobile 构建入口不把动态异常或环境变量值写入失败日志', () => {
  for (const relativePath of [
    'apps/mobile/scripts/build-android.mjs',
    'apps/mobile/scripts/build-ios.mjs',
  ]) {
    const source = fs.readFileSync(path.resolve(relativePath), 'utf8');
    const catchBlock = source.slice(source.lastIndexOf('main().catch('));

    assert.match(catchBlock, /main\(\)\.catch\(\(\) => \{/);
    assert.doesNotMatch(catchBlock, /process\.env/);
    assert.doesNotMatch(catchBlock, /err(?:or)?\??\.(?:message|stack)/i);
    assert.doesNotMatch(catchBlock, /scrubSecretsFromText/);
  }
});

test('Android 构建在子进程启动前失败时输出安全且可执行的诊断', () => {
  const fakeSecret = 'fake-keystore-password-that-must-not-leak';
  const result = spawnSync(
    process.execPath,
    [path.resolve('apps/mobile/scripts/build-android.mjs'), '--region', 'invalid'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        XDT_ANDROID_KEYSTORE_PASSWORD_DEV: fakeSecret,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Android 构建失败（参数检查）/);
  assert.match(result.stderr, /--region cn\|global\|dev/);
  assert.doesNotMatch(result.stderr, new RegExp(fakeSecret));
  assert.doesNotMatch(result.stderr, /详细原因请查看上方构建工具输出/);
});

test('iOS 构建在子进程启动前失败时输出安全且可执行的诊断', () => {
  const fakeSecret = 'fake-ios-signing-secret-that-must-not-leak';
  const result = spawnSync(
    process.execPath,
    [path.resolve('apps/mobile/scripts/build-ios.mjs'), '--region', 'invalid'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        XDT_IOS_SIGNING_SECRET_DEV: fakeSecret,
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /iOS 构建失败（参数检查）/);
  assert.match(result.stderr, /--region cn\|global\|dev/);
  assert.doesNotMatch(result.stderr, new RegExp(fakeSecret));
  assert.doesNotMatch(result.stderr, /详细原因请查看上方构建工具输出/);
});

test('端点清单自举基址缺失、非法协议或携带凭据时 fail closed', () => {
  const repoRoot = writeRepoFixtures();
  const cnPath = path.join(repoRoot, 'config', 'endpoint.json');

  fs.writeFileSync(cnPath, JSON.stringify({ schemaVersion: 1 }));
  assert.throws(() => loadEndpointManifestBaseUrl({ authRegion: 'cn', repoRoot }), /cdnBaseUrl/);

  fs.writeFileSync(
    cnPath,
    JSON.stringify({ schemaVersion: 1, cdnBaseUrl: 'http://hotfix.example.invalid/app' }),
  );
  assert.throws(() => loadEndpointManifestBaseUrl({ authRegion: 'cn', repoRoot }), /HTTPS/);

  fs.writeFileSync(
    cnPath,
    JSON.stringify({ schemaVersion: 1, cdnBaseUrl: 'https://user:pass@hotfix.example.invalid/app' }),
  );
  assert.throws(() => loadEndpointManifestBaseUrl({ authRegion: 'cn', repoRoot }), /HTTPS/);
});

test('发布 CDN 只接受显式 XDT_CDN_BASE_URL', () => {
  delete process.env.XDT_CDN_BASE_URL;
  assert.throws(() => resolveReleaseCdnBaseUrl(), /XDT_CDN_BASE_URL/);
  process.env.XDT_CDN_BASE_URL = 'https://release.example.invalid/app///';
  assert.equal(resolveReleaseCdnBaseUrl(), 'https://release.example.invalid/app');
});

function writeRepoFixtures() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'client-endpoint-build-env-'));
  tempDirs.push(repoRoot);
  const configDir = path.join(repoRoot, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, 'endpoint.json'),
    JSON.stringify({ schemaVersion: 1, cdnBaseUrl: 'https://hotfix-cn.example.invalid/app/' }),
  );
  fs.writeFileSync(
    path.join(configDir, 'endpoint.global.json'),
    JSON.stringify({ schemaVersion: 1, cdnBaseUrl: 'https://hotfix-global.example.invalid/app/' }),
  );
  fs.writeFileSync(
    path.join(configDir, 'endpoint.dev.json'),
    JSON.stringify({ schemaVersion: 1, cdnBaseUrl: 'https://hotfix-dev.example.invalid/app/' }),
  );
  return repoRoot;
}
