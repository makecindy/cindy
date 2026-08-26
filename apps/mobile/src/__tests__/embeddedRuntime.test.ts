import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeFingerprintHash,
  pickIpaFingerprintEntry,
  readEmbeddedRuntimeVersionFromAab,
  readEmbeddedRuntimeVersionFromApk,
  readEmbeddedRuntimeVersionFromIpa,
} from '../../scripts/lib/embedded-runtime.mjs';

const HASH = 'fc6c86d101689e9a86c27e7b33d19fe059329fe2';
const zipAvailable = spawnSync('zip', ['--version'], { encoding: 'utf8' }).status === 0;
const itWithZip = zipAvailable ? it : it.skip;

// 用 zip CLI 把若干 { 条目路径: 内容 } 打成一个 zip,返回 zip 绝对路径(测试完由调用方清理根目录)。
function makeZip(root: string, entries: Record<string, string>): string {
  for (const [rel, content] of Object.entries(entries)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const zipPath = join(root, 'artifact.zip');
  const r = spawnSync('zip', ['-q', '-r', zipPath, ...Object.keys(entries)], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`zip 失败: ${r.stderr}`);
  return zipPath;
}

describe('normalizeFingerprintHash', () => {
  it('去空白并小写归一化合法的 40 位十六进制', () => {
    expect(normalizeFingerprintHash(`  ${HASH}\n`)).toBe(HASH);
    expect(normalizeFingerprintHash(HASH.toUpperCase())).toBe(HASH);
  });

  it('空 / 长度不对 / 非十六进制一律抛错', () => {
    expect(() => normalizeFingerprintHash('')).toThrow();
    expect(() => normalizeFingerprintHash('   ')).toThrow();
    expect(() => normalizeFingerprintHash('abc123')).toThrow(); // 太短
    expect(() => normalizeFingerprintHash(`${HASH}ff`)).toThrow(); // 太长
    expect(() => normalizeFingerprintHash('z'.repeat(40))).toThrow(); // 非十六进制
  });

  it('错误信息带上 source 便于定位', () => {
    expect(() => normalizeFingerprintHash('bad', { source: 'APK xxx' })).toThrow(/APK xxx/);
  });
});

describe('pickIpaFingerprintEntry', () => {
  it('挑 EXUpdates.bundle 内的 fingerprint(iOS 运行时实际读取处)', () => {
    const entries = [
      'Payload/XDMaker.app/Info.plist',
      'Payload/XDMaker.app/EXUpdates.bundle/fingerprint',
      'Payload/XDMaker.app/EXUpdates.bundle/Info.plist',
    ];
    expect(pickIpaFingerprintEntry(entries)).toBe('Payload/XDMaker.app/EXUpdates.bundle/fingerprint');
  });

  it('动态 framework 下 EXUpdates.bundle 更深也能匹配', () => {
    const entries = [
      'Payload/XDMaker.app/Frameworks/EXUpdates.framework/EXUpdates.bundle/fingerprint',
    ];
    expect(pickIpaFingerprintEntry(entries)).toBe(
      'Payload/XDMaker.app/Frameworks/EXUpdates.framework/EXUpdates.bundle/fingerprint',
    );
  });

  it('多个命中取最浅路径(app 根那份)保证确定性', () => {
    const entries = [
      'Payload/XDMaker.app/Frameworks/EXUpdates.framework/EXUpdates.bundle/fingerprint',
      'Payload/XDMaker.app/EXUpdates.bundle/fingerprint',
    ];
    expect(pickIpaFingerprintEntry(entries)).toBe('Payload/XDMaker.app/EXUpdates.bundle/fingerprint');
  });

  it('不把 app 根裸 fingerprint 当作 iOS 运行时读取处', () => {
    // app 根的 Payload/<App>.app/fingerprint 不是 iOS 运行时读取位置,不应匹配。
    expect(() => pickIpaFingerprintEntry(['Payload/XDMaker.app/fingerprint'])).toThrow(/未找到/);
  });

  it('没有匹配条目时抛错', () => {
    expect(() => pickIpaFingerprintEntry([])).toThrow(/未找到/);
    expect(() => pickIpaFingerprintEntry(['assets/fingerprint'])).toThrow(/未找到/);
  });
});

describe('readEmbeddedRuntimeVersionFromApk', () => {
  itWithZip('从 APK 的 assets/fingerprint 读出内嵌 runtimeVersion', () => {
    const root = mkdtempSync(join(tmpdir(), 'xdt-apk-'));
    try {
      const apk = makeZip(root, { 'assets/fingerprint': `${HASH}\n`, 'classes.dex': 'x' });
      expect(readEmbeddedRuntimeVersionFromApk(apk)).toBe(HASH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithZip('APK 缺 assets/fingerprint 时抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'xdt-apk-'));
    try {
      const apk = makeZip(root, { 'classes.dex': 'x' });
      expect(() => readEmbeddedRuntimeVersionFromApk(apk)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readEmbeddedRuntimeVersionFromAab', () => {
  itWithZip('从 AAB base module 的 assets/fingerprint 读出内嵌 runtimeVersion', () => {
    const root = mkdtempSync(join(tmpdir(), 'xdt-aab-'));
    try {
      const aab = makeZip(root, {
        'base/assets/fingerprint': `${HASH}\n`,
        'base/manifest/AndroidManifest.xml': 'protobuf',
      });
      expect(readEmbeddedRuntimeVersionFromAab(aab)).toBe(HASH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithZip('AAB 缺 base/assets/fingerprint 时抛错', () => {
    const root = mkdtempSync(join(tmpdir(), 'xdt-aab-'));
    try {
      const aab = makeZip(root, { 'base/manifest/AndroidManifest.xml': 'protobuf' });
      expect(() => readEmbeddedRuntimeVersionFromAab(aab)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('readEmbeddedRuntimeVersionFromIpa', () => {
  itWithZip('从 EXUpdates.bundle/fingerprint 读出内嵌 runtimeVersion', () => {
    const root = mkdtempSync(join(tmpdir(), 'xdt-ipa-'));
    try {
      const ipa = makeZip(root, {
        'Payload/XDMaker.app/Info.plist': '<plist/>',
        'Payload/XDMaker.app/EXUpdates.bundle/fingerprint': HASH,
      });
      expect(readEmbeddedRuntimeVersionFromIpa(ipa)).toBe(HASH);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itWithZip('.ipa 内缺 EXUpdates.bundle/fingerprint 时抛错(与 APK 失败路径对称)', () => {
    const root = mkdtempSync(join(tmpdir(), 'xdt-ipa-'));
    try {
      const ipa = makeZip(root, { 'Payload/XDMaker.app/Info.plist': '<plist/>' });
      expect(() => readEmbeddedRuntimeVersionFromIpa(ipa)).toThrow(/未找到/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
