import { describe, expect, it } from 'vitest';

import { clipByDisplayWidth, displayWidth } from '../sessionOriginLabel';

/**
 * 测试价值
 * - 生产入口与可观察结果：侧栏「↳ 来源短名」用 clipByDisplayWidth 截断来源标题（列表第二行与置顶卡片底部）。
 * - 规则依据：#11610 方案 D——短名按显示宽度截断，中英文都要合理：同一预算下约 8 个汉字或 16 个拉丁字母，
 *   不能只按字符数（只按字符数时中文会比英文宽一倍，挤掉第二行预览）。
 * - 现有覆盖缺口：SessionOriginMark.test.tsx 只验证一条中文长来源。
 * - 最小失败输入：16 个汉字按字符数原样保留；混排或 emoji 被算成 1 个宽度。
 * - tier：unit（纯函数）。
 */
describe('source short name clipped by display width', () => {
  it.each([
    ['fits as is', '准备 Q4 用户调研', '准备 Q4 用户调研'],
    ['Latin keeps about sixteen letters', 'Prepare the complete user research', 'Prepare the com…'],
    ['CJK keeps about eight characters', '为下季度产品规划准备完整的用户调研', '为下季度产品规…'],
    ['mixed text counts wide and narrow characters', 'Q4 用户调研与竞品分析报告', 'Q4 用户调研与竞…'],
    ['no dangling space before the ellipsis', 'Weekly reports and planning', 'Weekly reports…'],
  ])('%s', (_name, input, expected) => {
    expect(clipByDisplayWidth(input)).toBe(expected);
    expect(displayWidth(clipByDisplayWidth(input))).toBeLessThanOrEqual(16);
  });

  it('counts wide symbols and emoji as two columns', () => {
    expect(displayWidth('「」')).toBe(4);
    expect(displayWidth('🚀a')).toBe(3);
  });
});
