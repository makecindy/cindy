/**
 * cindy-docs/csv.ts 的 RFC 4180 口径测试。
 *
 * 这些用例就是解析口径本身:改了实现就必须来这里说明改的是哪一条,
 * 而不是把断言改成新行为。
 */

import { describe, expect, it } from 'vitest';

import { delimiterForExtension, parseDelimited } from '../cindy-docs/csv.js';

const csv = (text: string) => parseDelimited(text, { delimiter: ',' });

describe('parseDelimited', () => {
  it('切出基本的行列', () => {
    expect(csv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('引号字段里的分隔符不切分', () => {
    expect(csv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
  });

  it('两个连续引号转义成一个引号', () => {
    expect(csv('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });

  it('引号字段里可以跨行', () => {
    expect(csv('a,"line1\nline2",c')).toEqual([['a', 'line1\nline2', 'c']]);
  });

  it('CRLF / LF / 裸 CR 都算一次换行', () => {
    expect(csv('a\r\nb\nc\rd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('剥掉 UTF-8 BOM,避免污染第一列表头', () => {
    expect(csv('﻿区域,收入')).toEqual([['区域', '收入']]);
  });

  it('结尾换行不产生额外空行', () => {
    expect(csv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('空文本返回零行', () => {
    expect(csv('')).toEqual([]);
  });

  it('字段中间的引号按普通字符处理(与 Excel 一致)', () => {
    expect(csv('a"b,c')).toEqual([['a"b', 'c']]);
  });

  it('未闭合引号按读到文件尾收尾,不抛错', () => {
    expect(csv('a,"unterminated')).toEqual([['a', 'unterminated']]);
  });

  it('保留空字段', () => {
    expect(csv('a,,c')).toEqual([['a', '', 'c']]);
  });

  it('tsv 用制表符切分', () => {
    expect(parseDelimited('a\tb\n1\t2', { delimiter: '\t' })).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});

describe('delimiterForExtension', () => {
  it('tsv / tab 用制表符,其余用逗号', () => {
    expect(delimiterForExtension('.tsv')).toBe('\t');
    expect(delimiterForExtension('.TAB')).toBe('\t');
    expect(delimiterForExtension('.csv')).toBe(',');
    expect(delimiterForExtension('.txt')).toBe(',');
  });
});
