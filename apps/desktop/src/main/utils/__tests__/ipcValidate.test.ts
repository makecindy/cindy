/**
 * IPC 边界的参数校验判据。
 *
 * 这里只覆盖 requireNullableString —— 它与 optionalNullableString 的差别
 * (缺字段报错 vs 缺字段当 undefined)是 renderer 一次调用疏忽会不会静默清掉
 * 用户设置的分界线,值得单独钉住。
 */

import { describe, expect, it } from 'vitest';

import { optionalNullableString, requireNullableString } from '../ipcValidate.js';

describe('requireNullableString', () => {
  it('接受显式 null 与非空字符串', () => {
    expect(requireNullableString(null, 'alias')).toBeNull();
    expect(requireNullableString('cindy', 'alias')).toBe('cindy');
  });

  it('字段缺失即拒 —— 缺字段不等于「清空」', () => {
    // 这条是本函数存在的理由: 把 {} 当成 { alias: null } 会让 renderer 的一次
    // 调用疏忽变成一次静默的破坏性写入(清掉用户已保存的默认工作目录)。
    expect(() => requireNullableString(undefined, 'alias')).toThrow('alias is required');
    expect(() => requireNullableString(({} as Record<string, unknown>).alias, 'alias')).toThrow(
      'INVALID_PARAMS',
    );
    // 对照: optionalNullableString 在这里返回 undefined 而不报错, 所以它不能用在
    // 「null 有破坏性语义」的位置。
    expect(optionalNullableString(undefined)).toBeUndefined();
  });

  it('非字符串一律拒, 不做 String() 强转', () => {
    // 123 强转成 "123" 后可能正好命中一个名叫 "123" 的合法别名。
    expect(() => requireNullableString(123, 'alias')).toThrow('INVALID_PARAMS');
    expect(() => requireNullableString({}, 'alias')).toThrow('INVALID_PARAMS');
    expect(() => requireNullableString(['cindy'], 'alias')).toThrow('INVALID_PARAMS');
  });

  it('空串与纯空白拒 —— 别名不能是空的', () => {
    expect(() => requireNullableString('', 'alias')).toThrow('INVALID_PARAMS');
    expect(() => requireNullableString('   ', 'alias')).toThrow('INVALID_PARAMS');
  });
});
