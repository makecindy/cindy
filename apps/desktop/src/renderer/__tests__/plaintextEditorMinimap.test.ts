import { describe, expect, it } from 'vitest';

import { minimapMarkTop, parseMinimapMarkLabel } from '../components/markdown/PlaintextEditor';

/**
 * MARK 标注是缩略图上唯一由我们自己解析/摆放的输入：写错冒号不该显示标签，
 * 摆放用错行号会让滚动后的标签全堆到底部（review #10957 P1）。
 */
describe('parseMinimapMarkLabel', () => {
  it('accepts the common MARK spellings', () => {
    expect(parseMinimapMarkLabel('// MARK: 色彩定义')).toBe('色彩定义');
    expect(parseMinimapMarkLabel('  //MARK：- 网络层')).toBe('网络层');
    expect(parseMinimapMarkLabel('    // mark: Layout')).toBe('Layout');
  });

  it('ignores comments that are not MARK headings', () => {
    expect(parseMinimapMarkLabel('// 普通注释')).toBeNull();
    expect(parseMinimapMarkLabel('const MARK = 1;')).toBeNull();
    expect(parseMinimapMarkLabel('// MARK:')).toBeNull();
    expect(parseMinimapMarkLabel('')).toBeNull();
  });

  it('caps the label so one long heading cannot stretch the minimap', () => {
    expect(parseMinimapMarkLabel(`// MARK: ${'x'.repeat(200)}`)).toHaveLength(80);
  });
});

describe('minimapMarkTop', () => {
  it('places the first visible row at the canvas top', () => {
    // 画布高 500、行高 10：刚滚到画布顶部的那一行应该贴顶，而不是被压到底部。
    expect(minimapMarkTop({ rowOffset: 0, offsetTop: 0, canvasHeight: 500, lineHeight: 10 })).toBe(6);
    expect(minimapMarkTop({ rowOffset: 1, offsetTop: 0, canvasHeight: 500, lineHeight: 10 })).toBe(10);
    expect(minimapMarkTop({ rowOffset: 40, offsetTop: 0, canvasHeight: 500, lineHeight: 10 })).toBe(400);
  });

  it('keeps labels inside the canvas when they would overflow', () => {
    expect(minimapMarkTop({ rowOffset: -3, offsetTop: 0, canvasHeight: 500, lineHeight: 10 })).toBe(6);
    expect(minimapMarkTop({ rowOffset: 200, offsetTop: 0, canvasHeight: 500, lineHeight: 10 })).toBe(494);
  });
});
