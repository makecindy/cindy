/**
 * 「崩溃自动上传」开关持久层的**可读性判据**锁（2026-08-04 review copilot）。
 *
 * 授权闸靠 `isLogUploadSettingsReadable()` 区分「文件损坏 ⇒ unknown（保留待补传标记）」与
 * 「合法关闭 ⇒ denied（清空标记）」。判据一旦把损坏当合法，一次坏文件就永久丢掉崩溃现场。
 *
 * `classifyProbe` 是这套判据里不碰 fs / electron 的纯核心，这里直接锁它。
 */
import { describe, expect, it } from 'vitest';

import { __testing } from '../logUploadSettingsStore';

const { classifyProbe } = __testing;

describe('classifyProbe', () => {
  it('文件不存在 ⇒ none（从未自定义，跟随默认关闭，不是故障）', () => {
    expect(classifyProbe(null)).toBe('none');
  });

  it('本 writer 会产出的形状 ⇒ valid', () => {
    expect(classifyProbe(JSON.stringify({ crashAutoUploadEnabled: true }))).toBe('valid');
    expect(classifyProbe(JSON.stringify({ crashAutoUploadEnabled: false }))).toBe('valid');
  });

  it('⚠️ 空对象 `{}` ⇒ invalid（writer 在清空 override 时删文件，从不落 `{}`）', () => {
    // 若判成 valid，isCrashAutoUploadEnabled() 会回落默认 false，闸清空崩溃标记。
    expect(classifyProbe('{}')).toBe('invalid');
  });

  it('⚠️ crashAutoUploadEnabled 存在但不是 boolean ⇒ invalid（normalize 保证写出的一定是 boolean）', () => {
    expect(classifyProbe(JSON.stringify({ crashAutoUploadEnabled: 'yes' }))).toBe('invalid');
    expect(classifyProbe(JSON.stringify({ crashAutoUploadEnabled: 1 }))).toBe('invalid');
    expect(classifyProbe(JSON.stringify({ crashAutoUploadEnabled: null }))).toBe('invalid');
  });

  it('坏 JSON / 非对象 / 数组 ⇒ invalid', () => {
    expect(classifyProbe('{ not json')).toBe('invalid');
    expect(classifyProbe('42')).toBe('invalid');
    expect(classifyProbe('"a string"')).toBe('invalid');
    expect(classifyProbe('[]')).toBe('invalid');
    expect(classifyProbe('null')).toBe('invalid');
  });

  it('含未知键但形状合法（前向兼容）⇒ valid', () => {
    // 未来新增键时旧版本读到它不该整份判损坏；只要不违反已知键的类型约束即可。
    expect(classifyProbe(JSON.stringify({ crashAutoUploadEnabled: true, futureKey: 1 }))).toBe(
      'valid',
    );
    expect(classifyProbe(JSON.stringify({ futureKey: 1 }))).toBe('valid');
  });
});
