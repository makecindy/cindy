// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
import {
  SELF_HOST_REGIONS,
  validateSelfHostRegions,
  resolveSelfHostRegion,
  regionEnvSuffix,
  regionEnvOverrides,
  formatSelfHostReleaseCommand,
  assertRegionOssComplete,
  missingSelfHostBakeFields,
  resolveIosInstallEntryMode,
  stripSelfHostRegionEnv,
} from '../../scripts/lib/self-host-region.mjs';

// 一份结构完整的合法配置(oss/signing 叶子值都填,供 resolve/override/assert 用例复用)。
const VALID = {
  cn: {
    authRegion: 'cn',
    iosBundleId: 'com.xd.cindycn',
    iosAppStoreId: '6788711632',
    androidPackage: 'com.xd.cindycn',
    androidStoreUrl: '',
    npkgExpectBundle: 'com.xd.cindycn',
    tapdb: { clientId: 'tap-client', clientToken: 'tap-token' },
    oss: { cdnBaseUrl: 'https://cdn.cn/x', bucket: 'b-cn', prefix: 'p', ossRegion: 'oss-cn-shanghai' },
    iosSigning: { teamId: 'T', profileName: 'P', signIdentity: 'I', profilePath: '' },
    androidSigning: { keyAlias: 'a', keystorePath: '/k.jks' },
  },
  global: {
    authRegion: 'global',
    iosBundleId: 'com.xd.cindy',
    iosAppStoreId: '6787894640',
    androidPackage: 'com.xd.cindy',
    androidStoreUrl: '',
    npkgExpectBundle: 'com.xd.cindy',
    google: {
      webClientId: 'web.apps.googleusercontent.com',
      iosClientId: 'ios.apps.googleusercontent.com',
      iosUrlScheme: 'com.googleusercontent.apps.ios',
    },
    tapdb: { clientId: 'tap-client', clientToken: 'tap-token' },
    oss: { cdnBaseUrl: 'https://cdn.app/x', bucket: 'b-g', prefix: 'p', ossRegion: 'oss-ap' },
    iosSigning: { teamId: 'T2', profileName: 'P2', signIdentity: 'I2', profilePath: '' },
    androidSigning: { keyAlias: 'ag', keystorePath: '/kg.jks' },
  },
  // dev 第三目标(2026-07-20):块必须存在,叶子允许留空(用时才强校验)。
  dev: {
    authRegion: 'dev',
    iosBundleId: '',
    iosAppStoreId: '',
    androidPackage: '',
    androidStoreUrl: '',
    npkgExpectBundle: '',
    tapdb: { clientId: '', clientToken: '' },
    oss: { cdnBaseUrl: '', bucket: '', prefix: '', ossRegion: '' },
    iosSigning: { teamId: '', profileName: '', signIdentity: '', profilePath: '' },
    androidSigning: { keyAlias: '', keystorePath: '' },
  },
};

const clone = () => JSON.parse(JSON.stringify(VALID));

describe('SELF_HOST_REGIONS', () => {
  it('只认 cn / global / dev', () => {
    expect([...SELF_HOST_REGIONS]).toEqual(['cn', 'global', 'dev']);
  });
});

describe('dev 第三目标(装载宽松、用时强校验)', () => {
  it('dev 块全留空 → 装载通过(不拖垮 cn/global 打包机)', () => {
    expect(() => validateSelfHostRegions(clone())).not.toThrow();
  });
  it('dev 不得配置 google(行为语义归 cn 系)', () => {
    const bad = clone();
    bad.dev.google = { webClientId: 'x', iosClientId: 'y', iosUrlScheme: 'z' };
    expect(() => validateSelfHostRegions(bad)).toThrow(/dev 不得配置 google/);
  });
  it('resolve dev 且身份未填 → 报缺失字段与建议命名', () => {
    expect(() => resolveSelfHostRegion({ region: 'dev' }, { regions: validateSelfHostRegions(clone()) }))
      .toThrow(/dev 渠道尚未配置[\s\S]*iosBundleId[\s\S]*com\.xd\.cindydev/);
  });
  it('resolve dev 且身份已填 → 正常返回块', () => {
    const filled = clone();
    filled.dev.iosBundleId = 'com.xd.cindydev';
    filled.dev.androidPackage = 'com.xd.cindydev';
    filled.dev.npkgExpectBundle = 'com.xd.cindydev';
    const block = resolveSelfHostRegion({ region: 'dev' }, { regions: validateSelfHostRegions(filled) });
    expect(block.iosBundleId).toBe('com.xd.cindydev');
  });
});

describe('local 模式(本地 Xcode / Simulator 构建装载宽松)', () => {
  it('cn/global 叶子值全留空 → local 模式装载通过;release(默认)模式维持严格拒绝', () => {
    const relaxed = clone();
    relaxed.cn.iosBundleId = '';
    relaxed.cn.tapdb = { clientId: '', clientToken: '' };
    relaxed.global.tapdb = { clientId: '', clientToken: '' };
    relaxed.global.google = { webClientId: '', iosClientId: '', iosUrlScheme: '' };
    expect(() => validateSelfHostRegions(relaxed, { mode: 'local' })).not.toThrow();
    expect(() => validateSelfHostRegions(relaxed)).toThrow(/iosBundleId 必须是非空字符串/);
    expect(() => validateSelfHostRegions(relaxed, { mode: 'release' })).toThrow(/非空/);
  });
  it('local 模式 google 部分填写 → 抛错(要么全空要么全填且格式合法)', () => {
    const partial = clone();
    partial.global.google = {
      webClientId: 'web.apps.googleusercontent.com',
      iosClientId: '',
      iosUrlScheme: '',
    };
    expect(() => validateSelfHostRegions(partial, { mode: 'local' }))
      .toThrow(/global\.google\.iosClientId 必须是非空字符串/);
  });
  it('local 模式 google 全填 → 格式校验照常生效', () => {
    const badFormat = clone();
    badFormat.global.google = {
      webClientId: 'not-a-google-id',
      iosClientId: 'ios.apps.googleusercontent.com',
      iosUrlScheme: 'com.googleusercontent.apps.ios',
    };
    expect(() => validateSelfHostRegions(badFormat, { mode: 'local' }))
      .toThrow(/webClientId 必须是 Google OAuth client id/);
  });
  it('local 模式仍要求 authRegion 一致与块结构完整', () => {
    const bad = clone();
    bad.cn.authRegion = '';
    expect(() => validateSelfHostRegions(bad, { mode: 'local' })).toThrow(/authRegion 必须等于/);
    const noTapdb = clone();
    delete noTapdb.cn.tapdb;
    expect(() => validateSelfHostRegions(noTapdb, { mode: 'local' })).toThrow(/tapdb 必须是 object/);
  });
});

describe('validateSelfHostRegions', () => {
  it('结构完整 → 返回冻结的 { cn, global }', () => {
    const r = validateSelfHostRegions(clone());
    expect(r.cn.iosBundleId).toBe('com.xd.cindycn');
    expect(r.global.androidPackage).toBe('com.xd.cindy');
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.cn.tapdb)).toBe(true);
    expect(Object.isFrozen(r.global.google)).toBe(true);
    expect(Object.isFrozen(r.cn.oss)).toBe(true);
  });
  it('非对象 / 缺 region 块 → 抛错', () => {
    expect(() => validateSelfHostRegions(null)).toThrow(/必须是 JSON object/);
    const noGlobal = clone();
    delete noGlobal.global;
    expect(() => validateSelfHostRegions(noGlobal)).toThrow(/缺少 region 配置块: global/);
  });
  it('authRegion 与 key 不一致 → 抛错', () => {
    const bad = clone();
    bad.cn.authRegion = 'global';
    expect(() => validateSelfHostRegions(bad)).toThrow(/cn\.authRegion 必须等于/);
  });
  it('身份字段为空 → 抛错', () => {
    const bad = clone();
    bad.cn.iosBundleId = '';
    expect(() => validateSelfHostRegions(bad)).toThrow(/cn\.iosBundleId 必须是非空字符串/);
  });
  it('App Store ID 必须是纯数字', () => {
    const bad = clone();
    bad.global.iosAppStoreId = 'id6787894640';
    expect(() => validateSelfHostRegions(bad)).toThrow(/global\.iosAppStoreId 必须是纯数字/);
  });
  it('Android 商店地址可留空；非空时必须是绝对 URL/deep link', () => {
    const configured = clone();
    configured.global.androidStoreUrl = 'market://details?id=com.xd.cindy';
    expect(() => validateSelfHostRegions(configured)).not.toThrow();
    const bad = clone();
    bad.cn.androidStoreUrl = 'not-a-url';
    expect(() => validateSelfHostRegions(bad)).toThrow(/cn\.androidStoreUrl 必须是绝对 URL/);
  });
  it('TapDB 公开配置缺失或为空 → 抛错', () => {
    const missing = clone();
    delete missing.cn.tapdb;
    expect(() => validateSelfHostRegions(missing)).toThrow(/cn\.tapdb 必须是 object/);
    const empty = clone();
    empty.global.tapdb.clientToken = '';
    expect(() => validateSelfHostRegions(empty)).toThrow(/global\.tapdb\.clientToken 必须是非空字符串/);
  });
  it('Google 仅允许 global,且三个公开客户端字段必须完整匹配', () => {
    const cnGoogle = clone();
    cnGoogle.cn.google = { ...cnGoogle.global.google };
    expect(() => validateSelfHostRegions(cnGoogle)).toThrow(/cn 不得配置 google/);

    const missing = clone();
    delete missing.global.google;
    expect(() => validateSelfHostRegions(missing)).toThrow(/global\.google 必须是 object/);

    const mismatchedScheme = clone();
    mismatchedScheme.global.google.iosUrlScheme = 'com.googleusercontent.apps.wrong';
    expect(() => validateSelfHostRegions(mismatchedScheme)).toThrow(/iosUrlScheme 必须由 iosClientId 反写/);
  });
  it('oss 叶子值允许留空(dry-run 未配置态),但键必须存在', () => {
    const dryRun = clone();
    dryRun.cn.oss = { cdnBaseUrl: '', bucket: '', prefix: '', ossRegion: '' };
    expect(() => validateSelfHostRegions(dryRun)).not.toThrow();
    const missingKey = clone();
    missingKey.cn.oss = { cdnBaseUrl: '', bucket: '', prefix: '' }; // 缺 ossRegion
    expect(() => validateSelfHostRegions(missingKey)).toThrow(/cn\.oss\.ossRegion/);
  });
});

describe('stripSelfHostRegionEnv', () => {
  it('清掉 ambient TapDB / Google 注入键,保留其它构建环境', () => {
    const env = stripSelfHostRegionEnv({
      EXPO_PUBLIC_TAPTAP_CLIENT_ID: 'ambient-id',
      EXPO_PUBLIC_TAPTAP_CLIENT_TOKEN: 'ambient-token',
      EXPO_PUBLIC_TAPDB_CHANNEL: 'ambient-channel',
      EXPO_PUBLIC_TAPDB_REGION: 'global',
      EXPO_PUBLIC_CINDY_GOOGLE_WEB_CLIENT_ID: 'ambient-web',
      EXPO_PUBLIC_CINDY_GOOGLE_IOS_CLIENT_ID: 'ambient-ios',
      EXPO_PUBLIC_CINDY_GOOGLE_IOS_URL_SCHEME: 'ambient-scheme',
      EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn',
    });
    expect(env).toEqual({ EXPO_PUBLIC_CINDY_AUTH_REGION: 'cn' });
  });
});

describe('resolveSelfHostRegion（--region 必填,不 fallback）', () => {
  it('缺 --region → 抛错', () => {
    expect(() => resolveSelfHostRegion({}, { regions: VALID })).toThrow(/必须显式指定 --region/);
    expect(() => resolveSelfHostRegion({ region: '  ' }, { regions: VALID })).toThrow(/必须显式指定 --region/);
  });
  it('非法 --region → 抛错', () => {
    expect(() => resolveSelfHostRegion({ region: 'us' }, { regions: VALID })).toThrow(/只能是/);
  });
  it('合法 --region → 返回对应块', () => {
    expect(resolveSelfHostRegion({ region: 'global' }, { regions: VALID }).iosBundleId).toBe('com.xd.cindy');
    expect(resolveSelfHostRegion({ region: 'cn' }, { regions: VALID }).authRegion).toBe('cn');
  });
});

describe('regionEnvSuffix / regionEnvOverrides', () => {
  it('后缀是 authRegion 大写', () => {
    expect(regionEnvSuffix(VALID.cn)).toBe('CN');
    expect(regionEnvSuffix(VALID.global)).toBe('GLOBAL');
  });
  it('非空 oss → 覆盖 XDT_OSS_*;空值不覆盖', () => {
    const ov = regionEnvOverrides(VALID.global, {});
    expect(ov.XDT_CDN_BASE_URL).toBe('https://cdn.app/x');
    expect(ov.XDT_OSS_BUCKET).toBe('b-g');
    const empty = { ...VALID.cn, oss: { cdnBaseUrl: '', bucket: '', prefix: '', ossRegion: '' } };
    expect(regionEnvOverrides(empty, {})).not.toHaveProperty('XDT_OSS_BUCKET');
  });
  it('AK/SK 带 region 后缀时覆盖 FP_DEV_*;缺省不覆盖(走现有一套)', () => {
    const withKeys = regionEnvOverrides(VALID.global, {
      XDT_OSS_ACCESS_KEY_ID_GLOBAL: 'akg',
      XDT_OSS_ACCESS_KEY_SECRET_GLOBAL: 'skg',
    });
    expect(withKeys.FP_DEV_OSS_ACCESS_KEY_ID).toBe('akg');
    expect(withKeys.FP_DEV_OSS_ACCESS_KEY_SECRET).toBe('skg');
    expect(regionEnvOverrides(VALID.cn, {})).not.toHaveProperty('FP_DEV_OSS_ACCESS_KEY_ID');
  });
});

describe('formatSelfHostReleaseCommand', () => {
  it('把当前 region 带进自建线后续命令', () => {
    expect(formatSelfHostReleaseCommand('ios', 'local', VALID.global, { execute: true }))
      .toBe('pnpm mobile:release:ios:local -- --region global --execute');
    expect(formatSelfHostReleaseCommand('android', 'ota', VALID.cn, { execute: true }))
      .toBe('pnpm mobile:release:android:ota -- --region cn --execute');
    expect(formatSelfHostReleaseCommand('ios', 'promote', VALID.global, { yes: true }))
      .toBe('pnpm mobile:release:ios:promote -- --region global --yes');
  });

  it('不允许无效平台、操作或 region', () => {
    expect(() => formatSelfHostReleaseCommand('windows', 'local', VALID.cn)).toThrow(/平台/);
    expect(() => formatSelfHostReleaseCommand('ios', 'publish', VALID.cn)).toThrow(/操作/);
    expect(() => formatSelfHostReleaseCommand('ios', 'local', 'us')).toThrow(/region/);
  });
});

describe('assertRegionOssComplete', () => {
  it('完整 → 通过;有空项 → 抛错点名', () => {
    expect(() => assertRegionOssComplete(VALID.cn)).not.toThrow();
    const partial = { ...VALID.cn, oss: { cdnBaseUrl: 'https://x/y', bucket: '', prefix: 'p', ossRegion: '' } };
    expect(() => assertRegionOssComplete(partial)).toThrow(/bucket, ossRegion/);
  });
});

describe('missingSelfHostBakeFields(selfhost prebuild 硬校验字段自查)', () => {
  it('tapdb 齐全 → cn/global 均无缺失', () => {
    const v = clone();
    expect(missingSelfHostBakeFields(v.cn)).toEqual([]);
    expect(missingSelfHostBakeFields(v.global)).toEqual([]);
  });
  it('tapdb 留空 → 逐项点名(全区域一致,dev 也不例外)', () => {
    const v = clone();
    expect(missingSelfHostBakeFields(v.dev)).toEqual(['tapdb.clientId', 'tapdb.clientToken']);
    v.cn.tapdb.clientToken = ' ';
    expect(missingSelfHostBakeFields(v.cn)).toEqual(['tapdb.clientToken']);
  });
  it('global 缺 google → 点名 google.*;cn 不要求 google', () => {
    const v = clone();
    v.global.google = { webClientId: '', iosClientId: '', iosUrlScheme: '' };
    expect(missingSelfHostBakeFields(v.global)).toEqual([
      'google.webClientId',
      'google.iosClientId',
      'google.iosUrlScheme',
    ]);
    expect(missingSelfHostBakeFields(v.cn)).toEqual([]);
  });
});

describe('resolveIosInstallEntryMode', () => {
  it('配了纯数字 App Store ID(任何 region)→ appstore 模式', () => {
    expect(resolveIosInstallEntryMode(VALID.cn)).toEqual({ mode: 'appstore', appStoreId: '6788711632' });
    expect(resolveIosInstallEntryMode(VALID.global)).toEqual({ mode: 'appstore', appStoreId: '6787894640' });
    const devWithStore = { ...VALID.dev, iosAppStoreId: '9990001112' };
    expect(resolveIosInstallEntryMode(devWithStore)).toEqual({ mode: 'appstore', appStoreId: '9990001112' });
  });
  it('dev 未配商店 ID → enterprise 模式(企业重签安装页作入口)', () => {
    expect(resolveIosInstallEntryMode(VALID.dev)).toEqual({ mode: 'enterprise', appStoreId: '' });
  });
  it('cn/global 未配商店 ID → fail closed(正式线红线不放松)', () => {
    expect(() => resolveIosInstallEntryMode({ ...VALID.cn, iosAppStoreId: '' })).toThrow(/cn\.iosAppStoreId/);
    expect(() => resolveIosInstallEntryMode({ ...VALID.global, iosAppStoreId: '   ' })).toThrow(/global\.iosAppStoreId/);
  });
});
