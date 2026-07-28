/**
 * issue 区域代号的跨侧一致性 —— 确认卡片(走 i18n)与 issue 正文(走
 * ISSUE_REGION_CODE 常量)必须对同一个区域给出同一个代号。
 *
 * 为什么需要专门一测:确认卡片的契约是「展示的就是最终写进 issue 的内容」,但两侧
 * 走的是不同机制(卡片按 DESIGN.md §16.3 要求走 i18n,便于日后改判为可译文案;正文
 * 直接落常量,因为读者是维护者、不跟随界面语言)。机制不同就没有编译期约束——改了
 * 一边的取值、或新增区域只补了一边,typecheck 与各自的单测都不会响,用户确认时看到
 * 的区域却与实际提交的正文不一致。这一测就是补上那道缺失的信号。
 */

import { describe, expect, it } from 'vitest';

import { ISSUE_REGION_CODE, shouldLabelIssueRegion } from '../../shared/issueRegionCode';
import en from '../i18n/locales/en/common.json';
import ja from '../i18n/locales/ja/common.json';
import ko from '../i18n/locales/ko/common.json';
import zhCN from '../i18n/locales/zh-CN/common.json';

const LOCALES: Record<string, { issueAgent: { confirm: Record<string, unknown> } }> = {
  'zh-CN': zhCN,
  en,
  ja,
  ko,
};

/** region → 卡片 i18n key 后缀(cn → regionCodeCn)。 */
function confirmKeyFor(region: string): string {
  return `regionCode${region.charAt(0).toUpperCase()}${region.slice(1)}`;
}

describe('issue 区域代号:卡片 i18n 与 issue 正文常量一致', () => {
  it('有代号的区域: 四语 i18n 值逐字等于常量,且不被翻译', () => {
    const labeled = Object.entries(ISSUE_REGION_CODE).filter(([, code]) => code !== null);
    // 防塌陷:常量被清空时下面的循环会变成空跑而全绿。
    expect(labeled.length).toBeGreaterThan(0);
    for (const [region, code] of labeled) {
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        expect(
          bundle.issueAgent.confirm[confirmKeyFor(region)],
          `${locale} 的 issueAgent.confirm.${confirmKeyFor(region)} 应为 ${code}(区域代号四语同文、不翻译)`,
        ).toBe(code);
      }
    }
  });

  it('不标注的区域: 四语都不得存在对应 key,避免出现「能显示但正文不写」的半套实现', () => {
    const unlabeled = Object.entries(ISSUE_REGION_CODE).filter(([, code]) => code === null);
    expect(unlabeled.length).toBeGreaterThan(0);
    for (const [region] of unlabeled) {
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        expect(
          bundle.issueAgent.confirm[confirmKeyFor(region)],
          `${locale} 不应有 issueAgent.confirm.${confirmKeyFor(region)}——${region} 按产品规则不标注(DESIGN.md §16.3)`,
        ).toBeUndefined();
      }
    }
  });

  it('global 不标是硬规则(DESIGN.md §16.3 不得回退),缺失 region 同样不标', () => {
    expect(ISSUE_REGION_CODE.global).toBeNull();
    expect(shouldLabelIssueRegion('global')).toBe(false);
    expect(shouldLabelIssueRegion(undefined)).toBe(false);
    expect(shouldLabelIssueRegion('cn')).toBe(true);
    expect(shouldLabelIssueRegion('dev')).toBe(true);
  });
});
