import { describe, expect, it } from 'vitest';

import { isStrictCompatibleSchema } from '../strict-schema.js';

/** 全必填 + additionalProperties:false 的最小合规对象 schema。 */
function conforming(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  };
}

describe('isStrictCompatibleSchema', () => {
  it('全必填 + additionalProperties:false 的简单对象 schema 合规', () => {
    expect(isStrictCompatibleSchema(conforming())).toBe(true);
  });

  it('存在 optional 字段(required 未覆盖全部 property)不合规 —— Edit 的 replace_all 形态', () => {
    const schema = conforming();
    (schema.properties as Record<string, unknown>).replace_all = { type: 'boolean' };
    // required 仍是三个字段,replace_all 是 optional
    expect(isStrictCompatibleSchema(schema)).toBe(false);
  });

  it('required 指向不存在的 property 不合规', () => {
    const schema = conforming();
    (schema.required as string[]).push('ghost_field');
    expect(isStrictCompatibleSchema(schema)).toBe(false);
  });

  it('缺 additionalProperties:false 不合规(含显式 true)', () => {
    const missing = conforming();
    delete missing.additionalProperties;
    expect(isStrictCompatibleSchema(missing)).toBe(false);

    const explicitTrue = conforming();
    explicitTrue.additionalProperties = true;
    expect(isStrictCompatibleSchema(explicitTrue)).toBe(false);
  });

  it('缺 required 不合规(即使 properties 为空)', () => {
    expect(isStrictCompatibleSchema({ type: 'object', properties: {}, additionalProperties: false })).toBe(false);
    // 空对象 + required:[] 合规
    expect(isStrictCompatibleSchema({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    })).toBe(true);
  });

  it('白名单外关键字不合规 —— 复杂 MCP schema 形态(propertyNames / maxItems / pattern / oneOf / $ref)', () => {
    for (const extra of [
      { propertyNames: { type: 'string' } },
      { maxItems: 4 },
      { pattern: '^[a-z]+$' },
      { oneOf: [{ type: 'string' }] },
      { $ref: '#/$defs/x' },
      { default: 'x' },
      { minLength: 1 },
      { format: 'uri' },
    ]) {
      const schema = { ...conforming(), ...extra };
      expect(isStrictCompatibleSchema(schema), JSON.stringify(extra)).toBe(false);
    }
  });

  it('嵌套 property 不合规会连坐整个 schema', () => {
    const schema = conforming();
    (schema.properties as Record<string, unknown>).nested = {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a'], // b 是 optional → 不合规
      additionalProperties: false,
    };
    (schema.required as string[]).push('nested');
    expect(isStrictCompatibleSchema(schema)).toBe(false);
  });

  it('嵌套对象 / 数组 items / enum / const / nullable 联合类型合规', () => {
    expect(isStrictCompatibleSchema({
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['a', 'b'] },
        // 检查器有意要求每个节点显式带 type(保守面),裸 const 节点不合规
        tag: { type: 'string', const: 'fixed' },
        note: { type: ['string', 'null'], description: 'nullable' },
        list: { type: 'array', items: { type: 'string' } },
        child: {
          type: 'object',
          properties: { x: { type: 'integer' } },
          required: ['x'],
          additionalProperties: false,
        },
      },
      required: ['mode', 'tag', 'note', 'list', 'child'],
      additionalProperties: false,
    })).toBe(true);
  });

  it('array 缺 items 不合规;非 array 带 items 不合规', () => {
    const noItems = conforming();
    (noItems.properties as Record<string, unknown>).list = { type: 'array' };
    (noItems.required as string[]).push('list');
    expect(isStrictCompatibleSchema(noItems)).toBe(false);

    const strayItems = conforming();
    (strayItems.properties as Record<string, unknown>).file_path = { type: 'string', items: { type: 'string' } };
    expect(isStrictCompatibleSchema(strayItems)).toBe(false);
  });

  it('anyOf 节点只能与 description 共存,分支各自校验', () => {
    const ok = conforming();
    (ok.properties as Record<string, unknown>).value = {
      description: 'either',
      anyOf: [{ type: 'string' }, { type: 'number' }],
    };
    (ok.required as string[]).push('value');
    expect(isStrictCompatibleSchema(ok)).toBe(true);

    const mixed = conforming();
    (mixed.properties as Record<string, unknown>).value = {
      type: 'string',
      anyOf: [{ type: 'string' }],
    };
    (mixed.required as string[]).push('value');
    expect(isStrictCompatibleSchema(mixed)).toBe(false);
  });

  it('根节点必须是 type:"object";非对象输入一律不合规', () => {
    expect(isStrictCompatibleSchema(undefined)).toBe(false);
    expect(isStrictCompatibleSchema(null)).toBe(false);
    expect(isStrictCompatibleSchema('object')).toBe(false);
    expect(isStrictCompatibleSchema({ type: 'string' })).toBe(false);
    expect(isStrictCompatibleSchema({ type: ['object', 'null'], properties: {}, required: [], additionalProperties: false })).toBe(false);
  });

  it('未知 type 值不合规', () => {
    const schema = conforming();
    (schema.properties as Record<string, unknown>).file_path = { type: 'file' };
    expect(isStrictCompatibleSchema(schema)).toBe(false);
  });

  it('空 enum 不合规(上游 grammar 编译对空 enum 直接 400)', () => {
    const schema = conforming();
    (schema.properties as Record<string, unknown>).file_path = { type: 'string', enum: [] };
    expect(isStrictCompatibleSchema(schema)).toBe(false);
  });

  it('超深嵌套(防御性递归上限)不合规而不是抛错', () => {
    let leaf: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 24; i += 1) {
      leaf = {
        type: 'object',
        properties: { child: leaf },
        required: ['child'],
        additionalProperties: false,
      };
    }
    expect(isStrictCompatibleSchema(leaf)).toBe(false);
  });
});
