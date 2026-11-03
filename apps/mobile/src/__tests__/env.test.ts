import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as endpointContract from '@cindy/maker-shared/client-endpoints';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DEVICE_LINK_API_BASE_URL,
  deviceLinkWsUrl,
  getMobileConfigIssues,
  resolveEnvFlag,
  resolveDeviceLinkApiBaseUrl,
  resolveMobileGoogleConfig,
  resolveMobileWechatConfig,
} from '@/config/env';

describe('mobile env', () => {
  it('keeps WeChat public configuration in CN and explicitly configured dev builds', () => {
    const env = {
      EXPO_PUBLIC_CINDY_WECHAT_APP_ID: ' wx-test-mobile ',
      EXPO_PUBLIC_CINDY_WECHAT_UNIVERSAL_LINK: ' https://login.example.com/wechat/ ',
    };
    for (const region of ['cn', 'dev'] as const) {
      expect(resolveMobileWechatConfig(region, env)).toEqual({
        appId: 'wx-test-mobile',
        universalLink: 'https://login.example.com/wechat/',
      });
    }
    expect(resolveMobileWechatConfig('global', env)).toEqual({ appId: '', universalLink: '' });
    expect(resolveMobileWechatConfig('cn', {})).toEqual({ appId: '', universalLink: '' });
  });
  it('resolves the device-link relay base URL(显式值优先,否则回落 env/dev 默认)', () => {
    expect(resolveDeviceLinkApiBaseUrl(undefined)).toBe(DEFAULT_DEVICE_LINK_API_BASE_URL);
    expect(resolveDeviceLinkApiBaseUrl('')).toBe(DEFAULT_DEVICE_LINK_API_BASE_URL);
    expect(resolveDeviceLinkApiBaseUrl(' https://relay.example.com/ ')).toBe('https://relay.example.com');
    expect(deviceLinkWsUrl('https://relay.example.com')).toBe('wss://relay.example.com/api/device-link/ws');
  });

  it('uses region defaults and rejects malformed explicit auth-server URLs', () => {
    expect(getMobileConfigIssues({})).toEqual([]);
    expect(
      getMobileConfigIssues({
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'ftp://auth.example.com',
      }).map((issue) => issue.key),
    ).toEqual(['EXPO_PUBLIC_CINDY_AUTH_BASE_URL']);
    // 文案 key 化(SC-4):issue 只产出 loginMessages key,不携带裸文案
    expect(
      getMobileConfigIssues({
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'ftp://auth.example.com',
      }).map((issue) => issue.messageKey),
    ).toEqual(['configIssueAuthBaseUrl']);
    expect(
      getMobileConfigIssues({
        EXPO_PUBLIC_CINDY_AUTH_BASE_URL: 'https://auth.example.com',
      }),
    ).toEqual([]);
  });

  it('parses boolean env flags for local auth testing', () => {
    expect(resolveEnvFlag(undefined)).toBe(false);
    expect(resolveEnvFlag('')).toBe(false);
    expect(resolveEnvFlag('0')).toBe(false);
    expect(resolveEnvFlag('1')).toBe(true);
    expect(resolveEnvFlag(' true ')).toBe(true);
    expect(resolveEnvFlag('YES')).toBe(true);
  });

  it('本地 / self-host Google 只认 region JSON 写入的 Expo extra', () => {
    const ambient = {
      EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID: 'ambient-web',
      EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID: 'ambient-ios',
      EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME: 'ambient-scheme',
    };
    expect(
      resolveMobileGoogleConfig(
        true,
        {
          webClientId: 'json-web',
          iosClientId: 'json-ios',
          iosUrlScheme: 'json-scheme',
        },
        ambient,
      ),
    ).toEqual({
      webClientId: 'json-web',
      iosClientId: 'json-ios',
      iosUrlScheme: 'json-scheme',
    });
    expect(resolveMobileGoogleConfig(true, undefined, ambient)).toEqual({
      webClientId: '',
      iosClientId: '',
      iosUrlScheme: '',
    });
    expect(resolveMobileGoogleConfig(false, undefined, ambient)).toEqual({
      webClientId: 'ambient-web',
      iosClientId: 'ambient-ios',
      iosUrlScheme: 'ambient-scheme',
    });
  });

  // Unit: evaluate the actual module with isolated build inputs, preserving the
  // production parser. A wrong branch must change the public endpoint output;
  // checking that both require strings exist did not catch that regression.
  it('selects each bundled dev manifest and leaves production loading to startup', () => {
    const compiled = ts.transpileModule(
      readFileSync(resolve(process.cwd(), 'src/config/env.ts'), 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    const manifests = Object.fromEntries(['cn', 'global', 'dev'].map((region) => [
      `../../../../config/endpoint${region === 'cn' ? '' : `.${region}`}.json`,
      { schemaVersion: 1, authApiBaseUrl: `https://${region}.example.invalid` },
    ]));
    for (const region of ['cn', 'global', 'dev']) {
      for (const dev of [false, true]) {
        const exports: Record<string, unknown> = {};
        const loaded: string[] = [];
        runInNewContext(compiled, {
          exports, __DEV__: dev, process: { env: { EXPO_PUBLIC_CINDY_AUTH_REGION: region } },
          require(id: string) {
            if (id === 'expo-application') return {};
            if (id === 'expo-constants') return { default: { expoConfig: null } };
            if (id === '@cindy/maker-shared/client-endpoints') return endpointContract;
            if (id === './endpointManifestLoader') return {};
            if (Object.hasOwn(manifests, id)) { loaded.push(id); return manifests[id]; }
            throw new Error(`Unexpected module: ${id}`);
          },
        });
        expect(exports.AUTH_REGION).toBe(region);
        expect(exports.AUTH_API_BASE_URL).toBe(dev ? `https://${region}.example.invalid` : '');
        expect(loaded).toHaveLength(dev ? 1 : 0);
      }
    }
  });
});
