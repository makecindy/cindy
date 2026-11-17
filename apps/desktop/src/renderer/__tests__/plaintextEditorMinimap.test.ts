import { describe, expect, it } from 'vitest';

import { parseMinimapMarkLabel } from '../components/markdown/PlaintextEditor';

/**
 * MARK 标注是缩略图上唯一由我们自己解析的输入：写错一个冒号/空格就不该显示标签，
 * 也不该把普通注释当成章节标题。解析规则只服务于渲染，不改文档。
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
    const label = parseMinimapMarkLabel(`// MARK: ${'x'.repeat(200)}`);
    expect(label).toHaveLength(80);
  });
});
