import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMobileEnv,
  REQUIRED_MOBILE_ENV_KEYS,
} from '../../scripts/ensure-mobile-env.mjs';
import { mobileClientBundleEnv } from '../../../../scripts/shared/client-endpoint-build-env.mjs';

const roots: string[] = [];

// 2026-07 端点清单重构后,.env 必填键收缩为构建身份 + 本区/对端清单自举基址;
// 业务端点初值 dev 走仓内 config/endpoint.json,不再进 .env 必填集。
const productionEnv = {
  EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
  EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix.example.invalid/app',
  EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL:
    'https://hotfix-peer.example.invalid/app',
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mobile simulator env bootstrap', () => {
  it('creates apps/mobile .env from eas production profile env', () => {
    const mobileDir = createMobileFixture({ production: { env: productionEnv } });

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.created).toBe(true);
    expect(result.addedKeys).toEqual(REQUIRED_MOBILE_ENV_KEYS);
    expect(env).toMatchObject(productionEnv);
    expect(env).not.toHaveProperty('EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED');
  });

  it('preserves existing user values and only fills missing or empty required keys', () => {
    const mobileDir = createMobileFixture({
      production: { env: productionEnv },
    });
    writeFileSync(
      join(mobileDir, '.env'),
      [
        '# local overrides',
        'EXPO_PUBLIC_CINDY_AUTH_REGION=global',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=',
        'EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED=1',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.created).toBe(false);
    expect(result.addedKeys).toEqual([
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
    ]);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('global');
    expect(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL).toBe(
      productionEnv.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL,
    );
    expect(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL).toBe(
      productionEnv.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL,
    );
    expect(env.EXPO_PUBLIC_XDT_DEV_LOGIN_ENABLED).toBe('1');
  });

  it('replaces copied example placeholders and quoted empty values', () => {
    const mobileDir = createMobileFixture({ production: { env: productionEnv } });
    writeEnvExample(mobileDir);
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION=',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=""',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=""',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.addedKeys).toEqual(REQUIRED_MOBILE_ENV_KEYS);
    expect(env).toMatchObject(productionEnv);
  });

  it('keeps a fully populated .env valid when eas.json only carries a subset of keys', () => {
    // 回归:真实仓库 eas.json production env 只有 REGION(清单基址在私有端点配置里)。
    // .env 必填 key 都有真实值时不应再要求 defaults 齐备(曾出现「第二次运行必炸」)。
    const mobileDir = createMobileFixture({
      production: { env: { EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn' } },
    });
    writeEnvExample(mobileDir);
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION=global',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://hotfix.user.example.com/app',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=https://hotfix-peer.user.example.com/app',
        'EXPO_PUBLIC_CINDY_AUTH_BASE_URL=https://auth.user.example.com',
        'EXPO_PUBLIC_XDT_API_BASE_URL=https://api.user.example.com',
        'EXPO_PUBLIC_XDT_DEVICE_LINK_API_BASE_URL=https://relay.user.example.com',
        'EXPO_PUBLIC_XDT_MOBILE_VOICE_LITELLM_BASE_URL=https://gateway.user.example.com',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.addedKeys).toEqual([]);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('global');
    expect(env.EXPO_PUBLIC_CINDY_AUTH_BASE_URL).toBe('https://auth.user.example.com');
  });

  it('preserves real user values even when they are quoted', () => {
    const mobileDir = createMobileFixture({ production: { env: productionEnv } });
    writeEnvExample(mobileDir);
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION="global"',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL="https://hotfix.custom.example.invalid/app"',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL="https://hotfix-peer.custom.example.invalid/app"',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });
    const env = readEnvMap(join(mobileDir, '.env'));

    expect(result.addedKeys).toEqual([]);
    expect(env.EXPO_PUBLIC_CINDY_AUTH_REGION).toBe('"global"');
    expect(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL).toBe(
      '"https://hotfix.custom.example.invalid/app"',
    );
    expect(env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL).toBe(
      '"https://hotfix-peer.custom.example.invalid/app"',
    );
  });

  it('accepts complete existing env when the inherited EAS profile omits the manifest base', () => {
    const mobileDir = createMobileFixture({
      production: { env: { EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn' } },
    });
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION=global',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://hotfix.global.example.invalid/app',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=https://hotfix.cn.example.invalid/app',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir });

    expect(result.addedKeys).toEqual([]);
    expect(readEnvMap(join(mobileDir, '.env'))).toMatchObject({
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'global',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL: 'https://hotfix.global.example.invalid/app',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL:
        'https://hotfix.cn.example.invalid/app',
    });
  });

  it('synchronizes both region keys when a local dev command selects a region', () => {
    const mobileDir = createMobileFixture({
      production: { env: { EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn' } },
    });
    writeFileSync(
      join(mobileDir, '.env'),
      [
        'EXPO_PUBLIC_CINDY_AUTH_REGION=cn',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=https://hotfix.cn.example.invalid/app',
        'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=https://hotfix.global.example.invalid/app',
        '',
      ].join('\n'),
    );

    const result = ensureMobileEnv({ mobileDir, authRegion: 'global' });

    expect(result.addedKeys).toEqual(REQUIRED_MOBILE_ENV_KEYS);
    expect(readEnvMap(join(mobileDir, '.env'))).toMatchObject(
      mobileClientBundleEnv({ authRegion: 'global' }),
    );
  });
});

function createMobileFixture(build: Record<string, unknown>) {
  const mobileDir = mkdtempSync(join(tmpdir(), 'xdt-mobile-env-'));
  roots.push(mobileDir);
  writeFileSync(join(mobileDir, 'eas.json'), JSON.stringify({ build }, null, 2));
  return mobileDir;
}

function readEnvMap(envPath: string) {
  const out: Record<string, string> = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    out[line.slice(0, index)] = line.slice(index + 1);
  }
  return out;
}

function writeEnvExample(mobileDir: string) {
  writeFileSync(
    join(mobileDir, '.env.example'),
    [
      'EXPO_PUBLIC_CINDY_AUTH_REGION=cn',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL=',
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL=',
      '',
    ].join('\n'),
  );
}
