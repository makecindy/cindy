// @ts-nocheck —— 被测对象是 .mjs 发布工具模块,vitest 跑其纯函数。
import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import {
  androidGradleTasksForArtifacts,
  assertAndroidUploadCertificateSha256,
  normalizeAndroidCertificateSha256,
  readAndroidVersionCode,
  readAndroidCertificateSha256FromPemOutput,
  nextSequentialVersionCode,
  replaceVersionCodeInAndroidVersionJson,
  resolveAndroidArtifactKinds,
  resolveAndroidUploadCertificateSha256,
  resolveAndroidSigningEnv,
  patchBuildGradleSigning,
  patchGradlePropertiesMemory,
} from '../../scripts/lib/android-local.mjs';

describe('resolveAndroidArtifactKinds', () => {
  it('按地区默认:cn/dev 只出 APK,global 同时出 APK + AAB', () => {
    expect(resolveAndroidArtifactKinds('cn')).toEqual(['apk']);
    expect(resolveAndroidArtifactKinds('dev')).toEqual(['apk']);
    expect(resolveAndroidArtifactKinds('global')).toEqual(['apk', 'aab']);
  });

  it('global 支持显式选择单产物或双产物,返回顺序确定', () => {
    expect(resolveAndroidArtifactKinds('global', 'apk')).toEqual(['apk']);
    expect(resolveAndroidArtifactKinds('global', 'aab')).toEqual(['aab']);
    expect(resolveAndroidArtifactKinds('global', 'aab,apk')).toEqual(['apk', 'aab']);
  });

  it('拒绝未知/重复/空产物以及非 global AAB', () => {
    expect(() => resolveAndroidArtifactKinds('global', 'ipa')).toThrow(/仅支持/);
    expect(() => resolveAndroidArtifactKinds('global', 'apk,apk')).toThrow(/重复/);
    expect(() => resolveAndroidArtifactKinds('global', true)).toThrow(/必须指定/);
    expect(() => resolveAndroidArtifactKinds('cn', 'apk,aab')).toThrow(/仅用于 global/);
  });
});

describe('androidGradleTasksForArtifacts', () => {
  it('把产物确定性映射到 release tasks', () => {
    expect(androidGradleTasksForArtifacts(['apk'])).toEqual(['assembleRelease']);
    expect(androidGradleTasksForArtifacts(['apk', 'aab'])).toEqual(['assembleRelease', 'bundleRelease']);
  });

  it('空产物集合 fail closed', () => {
    expect(() => androidGradleTasksForArtifacts([])).toThrow(/至少需要一种/);
  });
});

describe('Google Play upload certificate pin', () => {
  const SHA256 = '0123456789abcdef'.repeat(4);
  const COLON_SHA256 = SHA256.toUpperCase().match(/.{2}/g)?.join(':') ?? '';

  it('归一化 Play Console / keytool 常见指纹格式', () => {
    expect(normalizeAndroidCertificateSha256(SHA256)).toBe(SHA256);
    expect(normalizeAndroidCertificateSha256(`SHA-256: ${COLON_SHA256}`)).toBe(SHA256);
    expect(() => normalizeAndroidCertificateSha256('not-a-fingerprint')).toThrow(/64 位/);
  });

  it('按 region 从独立 env 读取 pin,缺失或非法时 fail closed', () => {
    expect(resolveAndroidUploadCertificateSha256('global', {
      XDT_ANDROID_UPLOAD_CERT_SHA256_GLOBAL: COLON_SHA256,
    })).toBe(SHA256);
    expect(() => resolveAndroidUploadCertificateSha256('global', {})).toThrow(
      /XDT_ANDROID_UPLOAD_CERT_SHA256_GLOBAL/,
    );
    expect(() => resolveAndroidUploadCertificateSha256('global', {
      XDT_ANDROID_UPLOAD_CERT_SHA256_GLOBAL: 'bad',
    })).toThrow(/64 位/);
  });

  it('从 keytool RFC 输出读取 signer 证书;无 PEM 时拒绝未签名 AAB', () => {
    const pem = rootCertificates[0];
    const expected = new X509Certificate(pem).fingerprint256.replaceAll(':', '').toLowerCase();
    expect(readAndroidCertificateSha256FromPemOutput(`Signer #1\n${pem}\n`)).toBe(expected);
    expect(() => readAndroidCertificateSha256FromPemOutput('jar 未签名')).toThrow(/未找到 PEM/);
  });

  it('实际 signer 必须与独立 upload cert pin 一致', () => {
    expect(assertAndroidUploadCertificateSha256(SHA256, COLON_SHA256)).toBe(SHA256);
    expect(() => assertAndroidUploadCertificateSha256(SHA256, 'f'.repeat(64))).toThrow(
      /上传证书不符/,
    );
  });
});

function withMobileDir(json: unknown, fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'xdt-android-ver-'));
  try {
    writeFileSync(join(dir, 'android-version.json'), typeof json === 'string' ? json : JSON.stringify(json));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('readAndroidVersionCode', () => {
  it('读正整数 versionCode', () => {
    withMobileDir({ versionCode: 7 }, (dir) => expect(readAndroidVersionCode(dir)).toBe(7));
  });
  it('非正整数 / 缺失 → 抛错', () => {
    withMobileDir({ versionCode: 0 }, (dir) => expect(() => readAndroidVersionCode(dir)).toThrow(/正整数/));
    withMobileDir({ versionCode: 1.5 }, (dir) => expect(() => readAndroidVersionCode(dir)).toThrow(/正整数/));
    withMobileDir({ versionCode: '3' }, (dir) => expect(() => readAndroidVersionCode(dir)).toThrow(/正整数/));
    withMobileDir({}, (dir) => expect(() => readAndroidVersionCode(dir)).toThrow(/正整数/));
  });
  it('文件不存在 / 非法 JSON → 抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xdt-android-ver-'));
    expect(() => readAndroidVersionCode(dir)).toThrow(/失败/);
    writeFileSync(join(dir, 'android-version.json'), 'not json');
    expect(() => readAndroidVersionCode(dir)).toThrow(/失败/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('resolveAndroidSigningEnv（path/alias 来自 region JSON,两口令来自 env 后缀)', () => {
  const CN = { authRegion: 'cn', androidSigning: { keystorePath: '/tmp/x.jks', keyAlias: 'custom' } };
  const GLOBAL = { authRegion: 'global', androidSigning: { keystorePath: '/tmp/g.jks', keyAlias: 'g' } };
  const CN_PW = { XDT_ANDROID_KEYSTORE_PASSWORD: 'a', XDT_ANDROID_KEY_PASSWORD: 'b' };

  it('JSON 路径/alias + env 口令齐全 → 透传', () => {
    const env = resolveAndroidSigningEnv(CN, CN_PW);
    expect(env.XDT_ANDROID_KEYSTORE_PATH).toBe('/tmp/x.jks');
    expect(env.XDT_ANDROID_KEY_ALIAS).toBe('custom');
    expect(env.XDT_ANDROID_KEYSTORE_PASSWORD).toBe('a');
    expect(env.XDT_ANDROID_KEY_PASSWORD).toBe('b');
  });
  it('cn 口令回落无后缀旧名;_CN 后缀优先', () => {
    expect(resolveAndroidSigningEnv(CN, CN_PW).XDT_ANDROID_KEYSTORE_PASSWORD).toBe('a');
    expect(
      resolveAndroidSigningEnv(CN, { ...CN_PW, XDT_ANDROID_KEYSTORE_PASSWORD_CN: 'cnpw' }).XDT_ANDROID_KEYSTORE_PASSWORD,
    ).toBe('cnpw');
  });
  it('global 口令必须带 _GLOBAL 后缀(无后缀不回落)', () => {
    expect(() => resolveAndroidSigningEnv(GLOBAL, CN_PW)).toThrow(/XDT_ANDROID_KEYSTORE_PASSWORD_GLOBAL/);
    const ok = resolveAndroidSigningEnv(GLOBAL, {
      XDT_ANDROID_KEYSTORE_PASSWORD_GLOBAL: 'gpw',
      XDT_ANDROID_KEY_PASSWORD_GLOBAL: 'gkey',
    });
    expect(ok.XDT_ANDROID_KEYSTORE_PASSWORD).toBe('gpw');
    expect(ok.XDT_ANDROID_KEY_PASSWORD).toBe('gkey');
  });
  it('缺 JSON 字段 → 点名 keystorePath/keyAlias;缺 env 口令 → 点名 env 名', () => {
    expect(() => resolveAndroidSigningEnv({ authRegion: 'cn', androidSigning: { keyAlias: 'x' } }, CN_PW)).toThrow(/keystorePath/);
    expect(() => resolveAndroidSigningEnv(CN, { XDT_ANDROID_KEY_PASSWORD: 'b' })).toThrow(/XDT_ANDROID_KEYSTORE_PASSWORD_CN/);
  });
});

// Expo prebuild(SDK 56 / RN 0.85)android/app/build.gradle 的代表性片段。
const TEMPLATE_GRADLE = `android {
    ndkVersion rootProject.ext.ndkVersion
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            shrinkResources (findProperty('android.enableShrinkResourcesInReleaseBuilds')?.toBoolean() ?: false)
            minifyEnabled enableProguardInReleaseBuilds
        }
    }
}
`;

describe('patchBuildGradleSigning', () => {
  it('注入 release signingConfig 且把 release buildType 切到 .release', () => {
    const out = patchBuildGradleSigning(TEMPLATE_GRADLE);
    // 注入了 env 驱动的 release 签名块
    expect(out).toContain('storeFile file(System.getenv("XDT_ANDROID_KEYSTORE_PATH"))');
    expect(out).toContain('keyPassword System.getenv("XDT_ANDROID_KEY_PASSWORD")');
    // release buildType 现在用 signingConfigs.release
    expect(out).toMatch(/release\s*\{[\s\S]*?signingConfig signingConfigs\.release/);
    // debug buildType 仍用 signingConfigs.debug(未误伤)
    expect(out).toMatch(/debug\s*\{\s*signingConfig signingConfigs\.debug/);
    // 注入的 release 签名块口令走 getenv,不出现明文赋值(如 storePassword 'xxx')
    expect(out).toContain('storePassword System.getenv("XDT_ANDROID_KEYSTORE_PASSWORD")');
    expect(out).not.toContain('storePassword System.getenv("XDT_ANDROID_KEYSTORE_PASSWORD") \'');
  });
  it('幂等:已 patch 再跑原样返回', () => {
    const once = patchBuildGradleSigning(TEMPLATE_GRADLE);
    const twice = patchBuildGradleSigning(once);
    expect(twice).toBe(once);
  });
  it('找不到锚点 → 抛错(不静默出 debug 签名包)', () => {
    expect(() => patchBuildGradleSigning('android {\n  buildTypes { release { minifyEnabled true } }\n}')).toThrow(/signingConfigs/);
    expect(() => patchBuildGradleSigning('')).toThrow();
  });
});

describe('patchGradlePropertiesMemory', () => {
  it('bump 已有 jvmargs 的 Xmx / MaxMetaspaceSize', () => {
    const out = patchGradlePropertiesMemory('org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m\n');
    expect(out).toContain('-Xmx4096m');
    expect(out).toContain('-XX:MaxMetaspaceSize=2048m');
    expect(out).not.toContain('512m');
  });
  it('保留该行其它 flag', () => {
    const out = patchGradlePropertiesMemory('org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m -Dfile.encoding=UTF-8\n');
    expect(out).toContain('-Dfile.encoding=UTF-8');
  });
  it('缺 jvmargs 行 → 追加', () => {
    const out = patchGradlePropertiesMemory('org.gradle.daemon=true\n');
    expect(out).toMatch(/org\.gradle\.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=2048m/);
    expect(out).toContain('org.gradle.daemon=true');
  });
  it('幂等:已是目标值再跑不变', () => {
    const once = patchGradlePropertiesMemory('org.gradle.jvmargs=-Xmx2048m -XX:MaxMetaspaceSize=512m\n');
    expect(patchGradlePropertiesMemory(once)).toBe(once);
  });
});

describe('nextSequentialVersionCode(冷更自动 bump)', () => {
  it('max(current, previous) + 1', () => {
    expect(nextSequentialVersionCode(4, 4)).toBe(5);
    expect(nextSequentialVersionCode(4, '9')).toBe(10);
    expect(nextSequentialVersionCode(4, null)).toBe(5);
  });
  it('非正整数 → 抛错回退手动 bump', () => {
    expect(() => nextSequentialVersionCode('1.2', 3)).toThrow(/不是正整数/);
    expect(() => nextSequentialVersionCode(4, '2026070601x')).toThrow(/不是正整数/);
    expect(() => nextSequentialVersionCode(0, null)).toThrow(/不是正整数/);
  });
  it('current/previous 全空 → 抛错', () => {
    expect(() => nextSequentialVersionCode(null, null)).toThrow(/至少一个/);
  });
});

describe('replaceVersionCodeInAndroidVersionJson', () => {
  const RAW = '{\n  "versionCode": 4,\n  "_comment": "自建 Android 线的整包 versionCode"\n}\n';

  it('只替换 versionCode,保留 _comment 与格式', () => {
    const out = replaceVersionCodeInAndroidVersionJson(RAW, 5);
    expect(out).toBe(RAW.replace('"versionCode": 4', '"versionCode": 5'));
    expect(JSON.parse(out).versionCode).toBe(5);
    expect(JSON.parse(out)._comment).toContain('自建 Android 线');
  });
  it('0 处或多处 versionCode → 抛错防误替换', () => {
    expect(() => replaceVersionCodeInAndroidVersionJson('{}', 5)).toThrow(/出现 0 处/);
    expect(() => replaceVersionCodeInAndroidVersionJson(RAW + RAW, 5)).toThrow(/出现 2 处/);
  });
  it('新号非正整数 → 抛错', () => {
    expect(() => replaceVersionCodeInAndroidVersionJson(RAW, 5.5)).toThrow(/正整数/);
    expect(() => replaceVersionCodeInAndroidVersionJson(RAW, 0)).toThrow(/正整数/);
  });
});
