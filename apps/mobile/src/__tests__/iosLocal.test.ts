// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
const NPKG_INSTALL_URL = 'https://npkg.example.invalid/install/4567';
import {
  parseNpkgInstallLinks,
  compareBuildNumbers,
  assertBuildNumberMonotonic,
  buildExportOptionsPlist,
  buildReleaseRecord,
  buildAppStoreInstallLinks,
  selectRecordInstallLinks,
  fetchBaselineBuildNumber,
  nextDateBuildNumber,
  replaceBuildNumberInAppJson,
  resolveIosSigningEnv,
} from '../../scripts/lib/ios-local.mjs';

const resp = (status, { json, ok } = {}) => ({
  status,
  ok: ok ?? (status >= 200 && status < 300),
  json: json ?? (async () => ({})),
});

describe('parseNpkgInstallLinks', () => {
  it('从 release-ios.sh 输出提取 install / itms / childId', () => {
    const out = [
      '  安装链接(发这个):',
      `    ${NPKG_INSTALL_URL}`,
      '  itms-services : itms-services://?action=download-manifest&url=https%3A%2F%2Fx%2Fplist%2F4567',
    ].join('\n');
    const r = parseNpkgInstallLinks(out);
    expect(r.installUrl).toBe(NPKG_INSTALL_URL);
    expect(r.childId).toBe('4567');
    expect(r.itmsUrl).toContain('itms-services://');
  });
  it('无链接 → 全 null', () => {
    expect(parseNpkgInstallLinks('nothing here')).toEqual({ installUrl: null, itmsUrl: null, childId: null });
  });
});

describe('compareBuildNumbers / assertBuildNumberMonotonic', () => {
  it('数值串比较', () => {
    expect(compareBuildNumbers('2026070102', '2026070101')).toBe(1);
    expect(compareBuildNumbers('2026070101', '2026070101')).toBe(0);
  });
  it('首发(无 previous)放行', () => {
    expect(assertBuildNumberMonotonic('2026070101', null)).toBe(true);
    expect(assertBuildNumberMonotonic('2026070101', '')).toBe(true);
  });
  it('递增放行,非递增抛错', () => {
    expect(assertBuildNumberMonotonic('2026070102', '2026070101')).toBe(true);
    expect(() => assertBuildNumberMonotonic('2026070101', '2026070101')).toThrow(/必须大于/);
    expect(() => assertBuildNumberMonotonic('', '1')).toThrow();
  });
});

describe('resolveIosSigningEnv（从 region JSON 的 iosSigning 取值,非机密)', () => {
  const FULL_IDENTITY = 'Apple Development: Jane Doe (ABCD1234EF)';
  const REGION = {
    authRegion: 'cn',
    iosSigning: { teamId: 'TEAM123456', profileName: 'some_profile', signIdentity: FULL_IDENTITY },
  };
  const withSigning = (patch) => ({ ...REGION, iosSigning: { ...REGION.iosSigning, ...patch } });
  it('三项齐全 → 透传;profilePath 可选缺省为空串,exportMethod 缺省 development', () => {
    expect(resolveIosSigningEnv(REGION)).toEqual({
      teamId: 'TEAM123456', profileName: 'some_profile', identity: FULL_IDENTITY, profilePath: '',
      exportMethod: 'development',
    });
    expect(resolveIosSigningEnv(withSigning({ profilePath: '/tmp/p.mobileprovision' })).profilePath)
      .toBe('/tmp/p.mobileprovision');
  });
  it('缺任一必填项 → 抛错并点名缺失字段(不回落)', () => {
    expect(() => resolveIosSigningEnv(withSigning({ teamId: '' }))).toThrow(/teamId/);
    expect(() => resolveIosSigningEnv(withSigning({ profileName: ' ' }))).toThrow(/profileName/);
    expect(() => resolveIosSigningEnv(withSigning({ signIdentity: undefined }))).toThrow(/signIdentity/);
  });
  it('全缺 → 错误信息按序列出全部三项', () => {
    expect(() => resolveIosSigningEnv({ authRegion: 'cn', iosSigning: {} })).toThrow(/teamId, profileName, signIdentity/);
  });
  it('signIdentity 是裸类型名(自动选择器)→ 拒:多证书钥匙串下钉不住证书', () => {
    expect(() => resolveIosSigningEnv(withSigning({ signIdentity: 'Apple Development' }))).toThrow(/完整证书名/);
    expect(() => resolveIosSigningEnv(withSigning({ signIdentity: 'Apple Distribution' }))).toThrow(/完整证书名/);
  });
  it('signIdentity 是不含冒号的部分名 → 拒(CODE_SIGN_IDENTITY 模糊匹配同样有歧义)', () => {
    expect(() => resolveIosSigningEnv(withSigning({ signIdentity: 'Jane Doe (ABCD1234EF)' }))).toThrow(/完整证书名/);
  });
  it('signIdentity 含冒号但掐掉末尾括号 ID → 拒(仍是部分名,钉不住)', () => {
    expect(() => resolveIosSigningEnv(withSigning({ signIdentity: 'Apple Development: Jane Doe' }))).toThrow(/完整证书名/);
    expect(() => resolveIosSigningEnv(withSigning({ signIdentity: 'Apple Development: Jane Doe (abcd)' }))).toThrow(/完整证书名/);
  });
  it('signIdentity 是 40 位 SHA-1 → 放行', () => {
    const sha1 = 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678';
    expect(resolveIosSigningEnv(withSigning({ signIdentity: sha1 })).identity).toBe(sha1);
  });
  it('exportMethod 留空 → development;白名单值透传', () => {
    expect(resolveIosSigningEnv(withSigning({ exportMethod: '' })).exportMethod).toBe('development');
    expect(resolveIosSigningEnv(withSigning({ exportMethod: 'enterprise' })).exportMethod).toBe('enterprise');
    expect(resolveIosSigningEnv(withSigning({ exportMethod: 'app-store' })).exportMethod).toBe('app-store');
    expect(resolveIosSigningEnv(withSigning({ exportMethod: 'ad-hoc' })).exportMethod).toBe('ad-hoc');
  });
  it('exportMethod 非白名单值 → 拒(防拼错被 xcodebuild 晚期才报)', () => {
    expect(() => resolveIosSigningEnv(withSigning({ exportMethod: 'adhoc' }))).toThrow(/exportMethod/);
    expect(() => resolveIosSigningEnv(withSigning({ exportMethod: 'AppStore' }))).toThrow(/exportMethod/);
  });
});

describe('buildExportOptionsPlist', () => {
  it('含 development / manual / team / profile 映射', () => {
    const plist = buildExportOptionsPlist({ teamId: 'TEAMID1234', bundleId: 'com.xd.cindycn', profileName: 'cindycn_dev' });
    expect(plist).toContain('<string>development</string>');
    expect(plist).toContain('<string>manual</string>');
    expect(plist).toContain('<string>TEAMID1234</string>');
    expect(plist).toContain('<key>com.xd.cindycn</key>');
    expect(plist).toContain('<string>cindycn_dev</string>');
  });
  it('传 signingCertificate 时钉死 export 证书', () => {
    const plist = buildExportOptionsPlist({
      teamId: 'TEAMID1234', bundleId: 'com.xd.cindycn', profileName: 'cindycn_dev',
      signingCertificate: 'Apple Development: Jane Doe (ABCD1234EF)',
    });
    expect(plist).toContain('<key>signingCertificate</key>');
    expect(plist).toContain('<string>Apple Development: Jane Doe (ABCD1234EF)</string>');
  });
  it('不传 signingCertificate 时输出不含该键(向后兼容)', () => {
    const plist = buildExportOptionsPlist({ teamId: 'TEAMID1234', bundleId: 'com.xd.cindycn', profileName: 'cindycn_dev' });
    expect(plist).not.toContain('signingCertificate');
  });
  it('signingCertificate 值做 XML 转义(意外特殊字符不产出坏 plist)', () => {
    const plist = buildExportOptionsPlist({
      teamId: 'TEAMID1234', bundleId: 'com.xd.cindycn', profileName: 'cindycn_dev',
      signingCertificate: 'Apple Development: A & B <Co> (ID)',
    });
    expect(plist).toContain('<string>Apple Development: A &amp; B &lt;Co&gt; (ID)</string>');
  });
  it('缺参抛错', () => {
    expect(() => buildExportOptionsPlist({ teamId: 'x', bundleId: 'y' })).toThrow();
  });
  it('传 method 时使用指定分发方式(纯构建 exportMethod 直通)', () => {
    const plist = buildExportOptionsPlist({
      teamId: 'TEAMID1234', bundleId: 'com.xd.cindycn', profileName: 'cindycn_dist', method: 'enterprise',
    });
    expect(plist).toContain('<string>enterprise</string>');
    expect(plist).not.toContain('<string>development</string>');
  });
});

describe('buildReleaseRecord', () => {
  it('组装记录,可选字段按需带上', () => {
    const r = buildReleaseRecord({
      version: '1.2.0', buildNumber: '2026070101', runtimeVersion: 'rtv1',
      installUrl: 'https://x/install/1', itmsUrl: 'itms-services://?u=1', releaseNotes: 'fix',
    });
    expect(r).toMatchObject({ version: '1.2.0', runtimeVersion: 'rtv1', releaseNotes: 'fix' });
    expect(r.minVersion).toBeUndefined();
  });
  it('缺 runtimeVersion 或安装地址抛错', () => {
    expect(() => buildReleaseRecord({ installUrl: 'x' })).toThrow();
    expect(() => buildReleaseRecord({ runtimeVersion: 'r' })).toThrow();
  });
});

describe('buildAppStoreInstallLinks', () => {
  it('数字 App Store ID 生成网页地址与 App Store deep link', () => {
    expect(buildAppStoreInstallLinks('6788711632')).toEqual({
      installUrl: 'https://apps.apple.com/app/id6788711632',
      itmsUrl: 'itms-apps://itunes.apple.com/app/id6788711632',
    });
  });
  it('非数字或空 ID fail closed', () => {
    expect(() => buildAppStoreInstallLinks('id123')).toThrow(/numeric App Store ID/);
    expect(() => buildAppStoreInstallLinks('')).toThrow(/numeric App Store ID/);
  });
});

describe('selectRecordInstallLinks', () => {
  const enterprise = {
    installUrl: 'https://cdn.dev.invalid/ios/1.2.3/2026072201/install.html',
    itmsUrl: 'itms-services://?action=download-manifest&url=https://cdn.dev.invalid/ios/1.2.3/2026072201/manifest.plist',
  };
  it('appstore 模式 → 由数字 ID 生成商店链接(忽略企业链接)', () => {
    expect(selectRecordInstallLinks({ mode: 'appstore', appStoreId: '6788711632' }, enterprise)).toEqual({
      installUrl: 'https://apps.apple.com/app/id6788711632',
      itmsUrl: 'itms-apps://itunes.apple.com/app/id6788711632',
    });
  });
  it('enterprise 模式 → 直接返回企业重签安装页/itms 链接', () => {
    expect(selectRecordInstallLinks({ mode: 'enterprise', appStoreId: '' }, enterprise)).toEqual(enterprise);
  });
  it('enterprise 模式但企业链接缺失 → fail closed', () => {
    expect(() => selectRecordInstallLinks({ mode: 'enterprise' }, { installUrl: '', itmsUrl: '' }))
      .toThrow(/企业重签安装入口缺少/);
  });
  it('appstore 模式空 ID 仍 fail closed(不静默放行)', () => {
    expect(() => selectRecordInstallLinks({ mode: 'appstore', appStoreId: '' }, enterprise))
      .toThrow(/numeric App Store ID/);
  });
});

describe('fetchBaselineBuildNumber (fail-closed)', () => {
  const URL = 'https://cdn/x/release.json';
  it('200 有记录 → 返回 buildNumber', async () => {
    const f = async () => resp(200, { json: async () => ({ buildNumber: '2026070101' }) });
    await expect(fetchBaselineBuildNumber(URL, f)).resolves.toBe('2026070101');
  });
  it('读取 URL 带 ?t= cache-bust(可变指针不被 CDN 边缘钉死)', async () => {
    let seen = '';
    const f = async (u) => { seen = u; return resp(200, { json: async () => ({ buildNumber: '1' }) }); };
    await fetchBaselineBuildNumber(URL, f);
    expect(seen).toMatch(/^https:\/\/cdn\/x\/release\.json\?t=\d+$/);
  });
  it('404 → null(合法首发)', async () => {
    await expect(fetchBaselineBuildNumber(URL, async () => resp(404))).resolves.toBeNull();
  });
  it('200 但缺 buildNumber 字段 → 抛错(记录损坏,fail-closed,不当首发)', async () => {
    const f = async () => resp(200, { json: async () => ({}) });
    await expect(fetchBaselineBuildNumber(URL, f)).rejects.toThrow(/缺 buildNumber/);
  });
  it('500 / 403 → 抛错(不当成首发)', async () => {
    await expect(fetchBaselineBuildNumber(URL, async () => resp(500))).rejects.toThrow(/HTTP 500/);
    await expect(fetchBaselineBuildNumber(URL, async () => resp(403))).rejects.toThrow(/HTTP 403/);
  });
  it('网络错误 → 抛错', async () => {
    const f = async () => { throw new TypeError('Failed to fetch'); };
    await expect(fetchBaselineBuildNumber(URL, f)).rejects.toThrow(/网络错误/);
  });
  it('JSON 解析失败 → 抛错', async () => {
    const f = async () => resp(200, { json: async () => { throw new SyntaxError('bad json'); } });
    await expect(fetchBaselineBuildNumber(URL, f)).rejects.toThrow(/JSON 解析失败/);
  });
});

describe('nextDateBuildNumber(冷更自动 bump)', () => {
  const JUL6 = new Date(2026, 6, 6); // 2026-07-06(本地时区)

  it('无 current/previous → 今天的 YYYYMMDD01', () => {
    expect(nextDateBuildNumber(null, null, JUL6)).toBe('2026070601');
    expect(nextDateBuildNumber('', '', JUL6)).toBe('2026070601');
  });
  it('基线是往日 → 跳到今天的 YYYYMMDD01', () => {
    expect(nextDateBuildNumber('2026070301', '2026070301', JUL6)).toBe('2026070601');
  });
  it('同天再次冷更 → 末两位序号递增', () => {
    expect(nextDateBuildNumber('2026070601', '2026070601', JUL6)).toBe('2026070602');
    expect(nextDateBuildNumber('2026070601', '2026070602', JUL6)).toBe('2026070603');
  });
  it('基线比今天日期基还大(旧线遗留大号)→ 直接 +1 保单调', () => {
    expect(nextDateBuildNumber('4', '2026081599', JUL6)).toBe('2026081600');
  });
  it('月/日补零', () => {
    expect(nextDateBuildNumber(null, null, new Date(2026, 0, 5))).toBe('2026010501');
  });
  it('非纯数字串(带点等)→ 抛错回退手动 bump', () => {
    expect(() => nextDateBuildNumber('1.2.3', null, JUL6)).toThrow(/不是纯数字串/);
    expect(() => nextDateBuildNumber('2026070601', '1.2', JUL6)).toThrow(/不是纯数字串/);
  });
});

describe('replaceBuildNumberInAppJson', () => {
  const RAW = [
    '{',
    '  "expo": {',
    '    "version": "1.0.0",',
    '    "ios": {',
    '      "buildNumber": "2026070301",',
    '      "bundleIdentifier": "com.xd.lizcn"',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  it('只替换 buildNumber 一行,其余格式零改动', () => {
    const out = replaceBuildNumberInAppJson(RAW, '2026070601');
    expect(out).toBe(RAW.replace('"2026070301"', '"2026070601"'));
    expect(JSON.parse(out).expo.ios.buildNumber).toBe('2026070601');
  });
  it('buildNumber 为空串也能替换', () => {
    const out = replaceBuildNumberInAppJson(RAW.replace('"2026070301"', '""'), '2026070601');
    expect(JSON.parse(out).expo.ios.buildNumber).toBe('2026070601');
  });
  it('0 处或多处 buildNumber → 抛错防误替换', () => {
    expect(() => replaceBuildNumberInAppJson('{}', '2026070601')).toThrow(/出现 0 处/);
    expect(() => replaceBuildNumberInAppJson(`${RAW}${RAW}`, '2026070601')).toThrow(/出现 2 处/);
  });
  it('新号非纯数字 → 抛错', () => {
    expect(() => replaceBuildNumberInAppJson(RAW, '1.2.3')).toThrow(/纯数字串/);
  });
});
