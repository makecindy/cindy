/**
 * toastColors.test.ts
 * ---------------------------------------------------------------------------
 * E5D 状态色定稿落地(扩簇)2026-07-17:Toast 四色(info/success/warning/error)
 * 原Toast 列为 docs/design-rules/cindy-design-system.md §2 语义豁免(B 组,跨主题 hardcode)。设计师 R3 A 组
 * 扩充定稿后豁免解除,四色并入状态色族:
 *   info #417CDD / success #2AAE5B / warning #F3A115 / error #D91F37
 * 与全局状态色同值(success=done 绿、error=状态族 error、warning=warning 前景)。
 *
 * 本测试直接断言 VARIANT_MAP 颜色字面量,防漂移。Toast 豁免解除后纳入定稿合同。
 */
import { describe, it, expect } from 'vitest';
import { VARIANT_MAP } from '@/components/ui/toast/Toast';

describe('E5D Toast 四色定稿(2026-07-17,豁免解除)', () => {
  const FINAL: Record<string, string> = {
    info: '#417CDD',
    success: '#2AAE5B',
    warning: '#F3A115',
    error: '#D91F37',
  };

  for (const [variant, hex] of Object.entries(FINAL)) {
    it(`Toast.${variant} color = 定稿 ${hex}`, () => {
      expect(
        VARIANT_MAP[variant as keyof typeof VARIANT_MAP]?.color,
        `${variant} 应为定稿 ${hex}`,
      ).toBe(hex);
    });
  }

  it('Toast 包含中性 loading 与四种状态提示', () => {
    expect(Object.keys(VARIANT_MAP).sort()).toEqual(['error', 'info', 'loading', 'success', 'warning']);
  });
});
