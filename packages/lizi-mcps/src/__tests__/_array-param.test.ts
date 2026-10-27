import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { coerceStringArrayParam, stringArrayParam } from '../xdt-helper/_array-param.js';

// 与 imagesListSchema(PR #5649)/queued_message_ids(#6369)实测的四类误传形态
// 对齐;这里守住共享实现本身,各工具的接线用例在各自的测试文件里。
describe('coerceStringArrayParam', () => {
  const schema = stringArrayParam(z.array(z.string().min(1)).min(2));

  it('passes a flat array through unchanged', () => {
    expect(schema.parse(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('flattens a one-level-nested array', () => {
    expect(schema.parse([['a', 'b']])).toEqual(['a', 'b']);
    expect(schema.parse(['a', ['b']])).toEqual(['a', 'b']);
  });

  it('unwraps the XML-style {item:[...]} wrapper', () => {
    expect(schema.parse({ item: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('wraps a single-element-collapsed {item:string} and bare string', () => {
    const unbounded = stringArrayParam(z.array(z.string().min(1)));
    expect(unbounded.parse({ item: 'a' })).toEqual(['a']);
    expect(unbounded.parse('a')).toEqual(['a']);
  });

  it('keeps element and bound checks after coercion', () => {
    expect(() => schema.parse({ foo: ['a', 'b'] })).toThrow(); // 无 item 键:不是数组
    expect(() => schema.parse({ item: '' })).toThrow(); // 折叠出空串:元素 min(1)
    expect(() => schema.parse({ item: 'a' })).toThrow(); // 折叠出单元素:数组 min(2)
    expect(() => schema.parse(['a', { x: 1 }])).toThrow(); // 非字符串条目
  });

  it('coerces without breaking the optional wrapper', () => {
    const optional = stringArrayParam(z.array(z.string()).max(2)).optional();
    expect(optional.parse(undefined)).toBeUndefined();
    expect(optional.parse({ item: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('is a no-op for non-coercible junk handed straight to zod', () => {
    expect(coerceStringArrayParam(42)).toBe(42);
    expect(coerceStringArrayParam(null)).toBe(null);
  });
});
