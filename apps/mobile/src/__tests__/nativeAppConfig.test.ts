import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const managedEnvKeys = [
  'CINDY_CN_APP_STORE_ID',
  'CINDY_GLOBAL_APP_STORE_ID',
  'EAS_BUILD_PROFILE',
  'EAS_OWNER',
  'EAS_PROJECT_ID',
  'EXPO_PUBLIC_APP_VARIANT',
  'EXPO_PUBLIC_BETA_DEV',
  'EXPO_PUBLIC_CINDY_AUTH_REGION',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL',
  'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
  'EXPO_PUBLIC_XDT_OTA_SELFHOST',
  'EXPO_PUBLIC_XDT_OTA_URL',
  'EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID',
  'EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID',
  'EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME',
  'CINDY_USE_LOCAL_REGION_CONFIG',
  'CINDY_SELF_HOST_REGIONS_FILE',
];
let previousEnv: Record<string, string | undefined>;
const temporaryDirs: string[] = [];

beforeEach(() => {
  previousEnv = Object.fromEntries(
    managedEnvKeys.map((key) => [key, process.env[key]]),
  );
  for (const key of managedEnvKeys) delete process.env[key];
});

afterEach(() => {
  for (const key of managedEnvKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of temporaryDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('mobile native app config', () => {
  it('defaults to the CN app identity and requires an explicit Global build', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    const cn = buildConfig({ config: appJson.expo });
    expect(cn.scheme).toBe('cindycn');
    expect(cn.ios.bundleIdentifier).toBe('com.xd.cindycn');
    expect(cn.android.package).toBe('com.xd.cindycn');
    expect(cn.extra.cindy.authRegion).toBe('cn');

    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    const global = buildConfig({ config: appJson.expo });
    expect(global.scheme).toBe('cindy');
    expect(global.ios.bundleIdentifier).toBe('com.xd.cindy');
    expect(global.android.package).toBe('com.xd.cindy');
    expect(global.extra.cindy.authRegion).toBe('global');

    process.env.EXPO_PUBLIC_APP_VARIANT = 'beta';
    process.env.EXPO_PUBLIC_BETA_DEV = 'carol';
    expect(buildConfig({ config: appJson.expo }).name).toBe(
      'Cindy Beta (carol)',
    );
  });

  it('injects the peer manifest URL into Metro without adding it to the Expo fingerprint', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    const cn = buildConfig({ config: appJson.expo });
    expect(
      process.env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL,
    ).toBe('https://hotfix.cindy.app/cindy');
    expect(cn.extra.xdtProductionEnv).toEqual({
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
      EXPO_PUBLIC_ENDPOINT_MANIFEST_BASE_URL:
        'https://hotfix.cindy.com.cn/cindy',
    });
    expect(cn.extra.xdtProductionEnv).not.toHaveProperty(
      'EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
    );
    const runtimeEnvSource = readFileSync(
      resolve(process.cwd(), 'src/config/env.ts'),
      'utf8',
    );
    expect(runtimeEnvSource).toContain(
      'process.env.EXPO_PUBLIC_ENDPOINT_MANIFEST_PEER_BASE_URL',
    );
  });

  it('injects EAS owner / projectId / updates from env and omits them when unset', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    // 仓库不带账号绑定:app.json 无 owner / updates / extra.eas。
    expect(appJson.expo.owner).toBeUndefined();
    expect(appJson.expo.updates).toBeUndefined();
    expect(appJson.expo.extra?.eas).toBeUndefined();

    // env 未设(dev / 外部 fork)→ resolved config 不带账号绑定。
    const bare = buildConfig({ config: appJson.expo });
    expect(bare.owner).toBeUndefined();
    expect(bare.updates).toBeUndefined();
    expect(bare.extra.eas).toBeUndefined();

    // env 注入(官方发布路径)→ owner / projectId / updates.url 就位;
    // 注回原值时 resolved config 逐字节不变,故不触发冷更(见 mobile-development.md)。
    process.env.EAS_OWNER = 'acme-org';
    process.env.EAS_PROJECT_ID = '11111111-2222-3333-4444-555555555555';
    const injected = buildConfig({ config: appJson.expo });
    expect(injected.owner).toBe('acme-org');
    expect(injected.extra.eas).toEqual({
      projectId: '11111111-2222-3333-4444-555555555555',
    });
    expect(injected.updates).toEqual({
      url: 'https://u.expo.dev/11111111-2222-3333-4444-555555555555',
      enabled: true,
    });
  });

  it('self-host builds use endpoint-driven OTA without baking the update server URL', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    const regular = buildConfig({ config: appJson.expo });
    // 账号绑定改为 env 注入后,app.json 不再带 updates;env 未设 → 无 OTA 配置。
    expect(regular.updates).toBeUndefined();

    const configDir = mkdtempSync(join(tmpdir(), 'cindy-selfhost-regions-'));
    temporaryDirs.push(configDir);
    const regionsPath = join(configDir, 'regions.json');
    writeFileSync(regionsPath, JSON.stringify({
      cn: {
        iosBundleId: 'com.xd.cindycn',
        androidPackage: 'com.xd.cindycn',
        tapdb: { clientId: 'json-id', clientToken: 'json-token' },
      },
      global: {
        iosBundleId: 'com.xd.cindy',
        androidPackage: 'com.xd.cindy',
        google: {
          webClientId: 'web.apps.googleusercontent.com',
          iosClientId: 'ios.apps.googleusercontent.com',
          iosUrlScheme: 'com.googleusercontent.apps.ios',
        },
        tapdb: { clientId: 'json-id', clientToken: 'json-token' },
      },
    }));
    process.env.CINDY_SELF_HOST_REGIONS_FILE = regionsPath;
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    // 即使调用环境残留旧变量,自建原生 config 也不得再消费真实更新地址。
    process.env.EXPO_PUBLIC_XDT_OTA_URL = 'https://must-not-be-baked.example.com';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID = 'ambient-web';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID = 'ambient-ios';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME = 'ambient-scheme';
    const selfHosted = buildConfig({ config: appJson.expo });
    expect(selfHosted.updates).toMatchObject({
      url: 'https://selfhost.invalid/manifest',
      checkAutomatically: 'NEVER',
      disableAntiBrickingMeasures: true,
    });
    expect(JSON.stringify(selfHosted)).not.toContain('must-not-be-baked.example.com');
    // 自建 app 身份按 region 从 self-host-regions.json(.example 回落)取,而非写死。
    expect(selfHosted.ios.bundleIdentifier).toBe('com.xd.cindycn');
    expect(selfHosted.android.package).toBe('com.xd.cindycn');
    expect(selfHosted.extra.cindy.tapdb).toEqual({
      clientId: 'json-id',
      clientToken: 'json-token',
      region: 'cn',
    });
    expect(selfHosted.extra.cindy).not.toHaveProperty('google');
    expect(selfHosted.plugins).not.toContainEqual(
      expect.arrayContaining(['@react-native-google-signin/google-signin']),
    );

    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    const selfHostedGlobal = buildConfig({ config: appJson.expo });
    expect(selfHostedGlobal.ios.bundleIdentifier).toBe('com.xd.cindy');
    expect(selfHostedGlobal.android.package).toBe('com.xd.cindy');
    expect(selfHostedGlobal.extra.cindy.tapdb.region).toBe('global');
    expect(selfHostedGlobal.extra.cindy.google).toEqual({
      webClientId: 'web.apps.googleusercontent.com',
      iosClientId: 'ios.apps.googleusercontent.com',
      iosUrlScheme: 'com.googleusercontent.apps.ios',
    });
    expect(selfHostedGlobal.plugins).toContainEqual([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: 'com.googleusercontent.apps.ios' },
    ]);
  });

  it('keeps the existing EAS Google environment path outside self-host builds', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));
    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID =
      'eas-web.apps.googleusercontent.com';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID =
      'eas-ios.apps.googleusercontent.com';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME =
      'com.googleusercontent.apps.eas-ios';

    const global = buildConfig({ config: appJson.expo });
    expect(global.extra.cindy).toEqual({ authRegion: 'global' });
    expect(global.plugins).toContainEqual([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: 'com.googleusercontent.apps.eas-ios' },
    ]);
  });

  it('local Xcode / Simulator builds use the selected region JSON without enabling self-host OTA', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));
    const configDir = mkdtempSync(join(tmpdir(), 'cindy-local-regions-'));
    temporaryDirs.push(configDir);
    const regionsPath = join(configDir, 'regions.json');
    writeFileSync(regionsPath, JSON.stringify({
      cn: {
        iosBundleId: 'com.local.cindycn',
        androidPackage: 'com.local.cindycn',
        tapdb: { clientId: 'cn-json-id', clientToken: 'cn-json-token' },
      },
      global: {
        iosBundleId: 'com.local.cindy',
        androidPackage: 'com.local.cindy',
        google: {
          webClientId: 'local-web.apps.googleusercontent.com',
          iosClientId: 'local-ios.apps.googleusercontent.com',
          iosUrlScheme: 'com.googleusercontent.apps.local-ios',
        },
        tapdb: { clientId: 'global-json-id', clientToken: 'global-json-token' },
      },
    }));
    process.env.CINDY_SELF_HOST_REGIONS_FILE = regionsPath;
    process.env.CINDY_USE_LOCAL_REGION_CONFIG = '1';
    process.env.EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME =
      'com.googleusercontent.apps.ambient';

    const cn = buildConfig({ config: appJson.expo });
    expect(cn.ios.bundleIdentifier).toBe('com.local.cindycn');
    expect(cn.extra.cindy.regionConfigSource).toBe('self-host-regions');
    expect(cn.extra.cindy.tapdb.clientId).toBe('cn-json-id');
    expect(cn.extra.cindy).not.toHaveProperty('google');
    expect(cn.updates).toBeUndefined();
    expect(cn.plugins).not.toContainEqual(
      expect.arrayContaining(['@react-native-google-signin/google-signin']),
    );

    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    const global = buildConfig({ config: appJson.expo });
    expect(global.ios.bundleIdentifier).toBe('com.local.cindy');
    expect(global.extra.cindy.google.webClientId).toBe(
      'local-web.apps.googleusercontent.com',
    );
    expect(global.plugins).toContainEqual([
      '@react-native-google-signin/google-signin',
      { iosUrlScheme: 'com.googleusercontent.apps.local-ios' },
    ]);
    expect(global.updates).toBeUndefined();
  });

  it('local builds tolerate empty TapDB/Google config while self-host release stays strict', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));
    const configDir = mkdtempSync(join(tmpdir(), 'cindy-local-regions-notapdb-'));
    temporaryDirs.push(configDir);
    const regionsPath = join(configDir, 'regions.json');
    writeFileSync(regionsPath, JSON.stringify({
      cn: {
        iosBundleId: 'com.local.cindycn',
        androidPackage: 'com.local.cindycn',
        tapdb: { clientId: '', clientToken: '' },
      },
      global: {
        iosBundleId: 'com.local.cindy',
        androidPackage: 'com.local.cindy',
        google: { webClientId: '', iosClientId: '', iosUrlScheme: '' },
        tapdb: { clientId: '', clientToken: '' },
      },
    }));
    process.env.CINDY_SELF_HOST_REGIONS_FILE = regionsPath;
    process.env.CINDY_USE_LOCAL_REGION_CONFIG = '1';

    // 本地构建:TapDB 留空 → 正常构建,extra.cindy 不烘焙 tapdb 键(运行时统计 no-op)。
    const cn = buildConfig({ config: appJson.expo });
    expect(cn.ios.bundleIdentifier).toBe('com.local.cindycn');
    expect(cn.extra.cindy.regionConfigSource).toBe('self-host-regions');
    expect(cn.extra.cindy).not.toHaveProperty('tapdb');

    // 本地 global:google 全空 → 跳过 Google 登录插件,不报错。
    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    const globalLocal = buildConfig({ config: appJson.expo });
    expect(globalLocal.extra.cindy).not.toHaveProperty('google');
    expect(globalLocal.plugins).not.toContainEqual(
      expect.arrayContaining(['@react-native-google-signin/google-signin']),
    );

    // google 部分填写 → 明确报错,不静默丢弃。
    writeFileSync(regionsPath, JSON.stringify({
      cn: {
        iosBundleId: 'com.local.cindycn',
        androidPackage: 'com.local.cindycn',
        tapdb: { clientId: '', clientToken: '' },
      },
      global: {
        iosBundleId: 'com.local.cindy',
        androidPackage: 'com.local.cindy',
        google: {
          webClientId: 'w.apps.googleusercontent.com',
          iosClientId: '',
          iosUrlScheme: '',
        },
        tapdb: { clientId: '', clientToken: '' },
      },
    }));
    expect(() => buildConfig({ config: appJson.expo })).toThrow(/global\.google 三个字段/);

    // 自建发布线:TapDB 留空必须 fail-closed,防止静默发出无统计的正式包。
    delete process.env.CINDY_USE_LOCAL_REGION_CONFIG;
    delete process.env.EXPO_PUBLIC_CINDY_AUTH_REGION;
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    expect(() => buildConfig({ config: appJson.expo })).toThrow(/tapdb\.clientId\/clientToken/);
  });

  it('local builds fall back to the blank template with built-in identity when the regions file is missing', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));
    // 指向一个不存在的文件:本地构建应回落仓内空白模板,不阻断。
    process.env.CINDY_SELF_HOST_REGIONS_FILE = join(
      tmpdir(),
      `cindy-missing-${process.pid}`,
      'regions.json',
    );
    process.env.CINDY_USE_LOCAL_REGION_CONFIG = '1';

    const cn = buildConfig({ config: appJson.expo });
    expect(cn.ios.bundleIdentifier).toBe('com.xd.cindycn');
    expect(cn.android.package).toBe('com.xd.cindycn');
    expect(cn.extra.cindy.regionConfigSource).toBe('self-host-regions');
    expect(cn.extra.cindy).not.toHaveProperty('tapdb');
    expect(cn.extra.cindy).not.toHaveProperty('google');

    // 自建发布线缺文件仍硬报错。
    delete process.env.CINDY_USE_LOCAL_REGION_CONFIG;
    process.env.EXPO_PUBLIC_XDT_OTA_SELFHOST = '1';
    expect(() => buildConfig({ config: appJson.expo })).toThrow(/缺少地区构建配置/);
  });

  it('fails closed when a store build lacks its regional App Store numeric ID', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    process.env.EAS_BUILD_PROFILE = 'production';
    expect(() => buildConfig({ config: appJson.expo })).toThrow(
      'CINDY_CN_APP_STORE_ID',
    );
    process.env.CINDY_CN_APP_STORE_ID = '1234567890';
    expect(buildConfig({ config: appJson.expo }).extra.cindy).toEqual({
      authRegion: 'cn',
    });

    process.env.EAS_BUILD_PROFILE = 'production-global';
    process.env.EXPO_PUBLIC_CINDY_AUTH_REGION = 'global';
    delete process.env.CINDY_CN_APP_STORE_ID;
    expect(() => buildConfig({ config: appJson.expo })).toThrow(
      'CINDY_GLOBAL_APP_STORE_ID',
    );
    process.env.CINDY_GLOBAL_APP_STORE_ID = '9876543210';
    expect(buildConfig({ config: appJson.expo }).extra.cindy).toEqual({
      authRegion: 'global',
    });
  });

  it('supports iPad and phone landscape and versions native builds from app.json', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const eas = JSON.parse(
      readFileSync(resolve(process.cwd(), 'eas.json'), 'utf8'),
    );
    const phoneOrientations =
      appJson.expo.ios.infoPlist.UISupportedInterfaceOrientations;
    const tabletOrientations =
      appJson.expo.ios.infoPlist['UISupportedInterfaceOrientations~ipad'];

    expect(appJson.expo.orientation).toBe('default');
    expect(appJson.expo.ios.supportsTablet).toBe(true);
    expect(phoneOrientations).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(phoneOrientations).toContain('UIInterfaceOrientationLandscapeRight');
    expect(tabletOrientations).toContain('UIInterfaceOrientationLandscapeLeft');
    expect(tabletOrientations).toContain(
      'UIInterfaceOrientationLandscapeRight',
    );
    expect(appJson.expo.ios.buildNumber).toMatch(/^\d{10}$/);
    expect(appJson.expo.android.versionCode).toBeUndefined();
    expect(eas.cli.appVersionSource).toBe('local');
    expect(eas.build.production.extends).toBe('store-cn-base');
    expect(eas.build['production-global'].extends).toBe('store-global-base');
  });

  it('keeps iOS status bar appearance view-controller based (iOS 27 requirement)', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const buildConfig = require(resolve(process.cwd(), 'app.config.js'));

    // iOS 27 起 RN StatusBar 的废弃全局链路失效,状态栏样式依赖 VC-based 通道
    // (react-native-screens screen options)。该键被误删/翻回 false 时,浅色模式
    // 状态栏会停在白字且无法 JS 热修(冷更锁定),必须由本断言挡住。
    expect(
      appJson.expo.ios.infoPlist.UIViewControllerBasedStatusBarAppearance,
    ).toBe(true);
    // app.config.js 不得剥离该键:以 resolved config 为准再断言一次。
    const cn = buildConfig({ config: appJson.expo });
    expect(cn.ios.infoPlist.UIViewControllerBasedStatusBarAppearance).toBe(true);
  });

  it('keeps audio capture foreground-only in native builds', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const audioPlugin = appJson.expo.plugins.find(
      (plugin: unknown) => Array.isArray(plugin) && plugin[0] === 'expo-audio',
    );
    const imagePickerPlugin = appJson.expo.plugins.find(
      (plugin: unknown) =>
        Array.isArray(plugin) && plugin[0] === 'expo-image-picker',
    );

    expect(audioPlugin).toEqual([
      'expo-audio',
      {
        microphonePermission: 'Cindy needs microphone access for voice input in remote sessions.',
        recordAudioAndroid: true,
        enableBackgroundPlayback: false,
        enableBackgroundRecording: false,
      },
    ]);
    expect(imagePickerPlugin).toEqual([
      'expo-image-picker',
      expect.objectContaining({
        microphonePermission:
          'Cindy needs microphone access for voice input in remote sessions.',
      }),
    ]);
    const foregroundOnlyPluginIndex = appJson.expo.plugins.indexOf(
      './plugins/with-foreground-only-audio',
    );
    const audioPluginIndex = appJson.expo.plugins.indexOf(audioPlugin);
    expect(foregroundOnlyPluginIndex).toBeGreaterThanOrEqual(0);
    expect(foregroundOnlyPluginIndex).toBeLessThan(audioPluginIndex);
    expect(appJson.expo.ios.infoPlist.UIBackgroundModes ?? []).not.toContain('audio');
  });

  it('uses the Android system photo picker without broad media permissions', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const mediaLibraryPlugin = appJson.expo.plugins.find(
      (plugin: unknown) =>
        Array.isArray(plugin) && plugin[0] === 'expo-media-library',
    );

    expect(mediaLibraryPlugin).toEqual([
      'expo-media-library',
      expect.objectContaining({ granularPermissions: [] }),
    ]);
    expect(appJson.expo.android.blockedPermissions).toEqual(
      expect.arrayContaining([
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
      ]),
    );
  });

  it('keeps Metro React resolution on the mobile app dependency', () => {
    const metroConfig = readFileSync(
      resolve(process.cwd(), 'metro.config.js'),
      'utf8',
    );
    expect(metroConfig).toContain("react: path.join(appNodeModules, 'react')");
    expect(metroConfig).not.toContain("react: path.join(workspaceNodeModules, 'react')");
    expect(metroConfig).toContain("'auth-client'");
    expect(metroConfig).toContain("'@cindy/device-link-protocol'");
  });

  it('Metro nodeModulesPaths 覆盖 workspace TS 源码包各自的 node_modules(pnpm hoisted 布局下 workspace: 链接不提升到根,只在消费方包自己的 node_modules)', () => {
    // 2026-07-16 iOS 冷更实踩:disableHierarchicalLookup 后漏列这些目录,
    // packages/device-link 引用的仓内 @cindy/device-link-protocol
    // 在 expo export:embed 打 bundle 时 Unable to resolve → ARCHIVE FAILED。
    // 期望路径从 metro.config.js 自身位置推导(它内部用 __dirname 计算),不依赖测试进程 cwd。
    const metroConfigPath = require.resolve('../../metro.config.js');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const metroConfig = require(metroConfigPath);
    const appDir = dirname(metroConfigPath);
    const paths: string[] = metroConfig.resolver.nodeModulesPaths;
    // path.join 产物在 Windows 上是反斜杠,比较前统一归一为 POSIX 分隔符(规则 15)。
    const posix = (p: string) => p.split(sep).join('/');
    for (const packageName of ['auth-client', 'device-link', 'maker-shared', 'model-providers']) {
      expect(paths.some((p) => posix(p).endsWith(`packages/${packageName}/node_modules`))).toBe(true);
    }
    // 追加在 app / workspace 根之后:常规依赖命中顺序不变(精确断言前两位,防止顺序被换)。
    expect(paths[0]).toBe(join(appDir, 'node_modules'));
    expect(paths[1]).toBe(join(resolve(appDir, '../..'), 'node_modules'));
  });

  it('wires first-party Apple, public Google, and the minimal official WeChat bridge', () => {
    const appJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'app.json'), 'utf8'),
    );
    const packageJson = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
    );
    const configSource = readFileSync(
      resolve(process.cwd(), 'app.config.js'),
      'utf8',
    );
    const pluginSource = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/plugin/index.js'),
      'utf8',
    );
    const iosPodspec = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatLogin.podspec',
      ),
      'utf8',
    );
    const androidGradle = readFileSync(
      resolve(process.cwd(), 'modules/xdt-wechat-login/android/build.gradle'),
      'utf8',
    );
    const moduleConfig = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/expo-module.config.json',
      ),
      'utf8',
    );
    const iosCoordinator = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatAuthCoordinator.swift',
      ),
      'utf8',
    );
    const iosWechatPodfilePlugin = readFileSync(
      resolve(process.cwd(), 'plugins/with-wechat-opensdk-modulemap.js'),
      'utf8',
    );
    const iosSubscriber = readFileSync(
      resolve(
        process.cwd(),
        'modules/xdt-wechat-login/ios/XdtWechatLoginAppDelegateSubscriber.swift',
      ),
      'utf8',
    );

    expect(appJson.expo.ios.usesAppleSignIn).toBe(true);
    expect(appJson.expo.plugins).toContain('expo-apple-authentication');
    expect(packageJson.dependencies['expo-apple-authentication']).toBeTruthy();
    expect(
      packageJson.dependencies['@react-native-google-signin/google-signin'],
    ).toBe('16.1.2');
    expect(packageJson.dependencies['xdt-wechat-login']).toBe(
      'file:./modules/xdt-wechat-login',
    );
    expect(
      existsSync(
        resolve(
          process.cwd(),
          'modules/xdt-feishu-login/expo-module.config.json',
        ),
      ),
    ).toBe(false);
    expect(configSource).toContain(
      "'@react-native-google-signin/google-signin'",
    );
    expect(configSource).toContain("'xdt-wechat-login/plugin'");
    expect(pluginSource).toContain("'weixinULAPI'");
    expect(pluginSource).toContain("'.wxapi.WXEntryActivity'");
    expect(pluginSource).toContain('withWechatEntryActivity(config, appId)');
    expect(pluginSource).toContain('createWXAPI(this, ${kotlinAppId}, false)');
    expect(iosPodspec).toContain("s.dependency 'WechatOpenSDK', '2.0.5'");
    expect(androidGradle).toContain('wechat-sdk-android:6.8.38');
    expect(moduleConfig).toContain('XdtWechatLoginAppDelegateSubscriber');
    expect(iosCoordinator).toContain(
      'WXApi.handleOpenUniversalLink(userActivity, delegate: self)',
    );
    expect(iosCoordinator).toContain('#if targetEnvironment(simulator)');
    expect(iosCoordinator).toContain('ERR_WECHAT_UNAVAILABLE_ON_SIMULATOR');
    expect(iosWechatPodfilePlugin).toContain(
      'xdt-wechat-login: arm64 simulator stub linkage',
    );
    expect(iosWechatPodfilePlugin).toContain(
      "other_linker_flags[:libraries].delete?('WechatOpenSDK')",
    );
    expect(iosWechatPodfilePlugin).toContain(
      "OTHER_LDFLAGS[sdk=iphoneos*]",
    );
    expect(iosSubscriber).toContain('continue userActivity: NSUserActivity');
  });

  it('independently injects the WeChat simulator hook into an existing Podfile', () => {
    const plugin = require(
      resolve(process.cwd(), 'plugins/with-wechat-opensdk-modulemap.js'),
    ) as {
      injectPostInstallHooks(contents: string): string;
    };
    const oldPodfile = `
post_install do |installer|
  # xdt-wechat-login: WechatOpenSDK modulemap
  # xdt-wechat-login: arm64 simulator stub linkage
end
`;

    const upgradedPodfile = plugin.injectPostInstallHooks(oldPodfile);
    expect(upgradedPodfile.match(/WechatOpenSDK modulemap/g)).toHaveLength(1);
    expect(upgradedPodfile).toContain(
      'xdt-wechat-login: arm64 simulator stub linkage v3',
    );
    expect(upgradedPodfile.match(/arm64 simulator stub linkage v3/g)).toHaveLength(1);
    expect(plugin.injectPostInstallHooks(upgradedPodfile)).toBe(upgradedPodfile);
  });
});
