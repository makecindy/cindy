/**
 * issueRegionCode — issue 反馈链路的构建区域代号,main(写进 issue 正文)与
 * renderer(提交确认卡片)共用的**唯一事实源**。
 *
 * 为什么需要这个单点:确认卡片的契约是「展示的就是最终写进 issue 的内容」。
 * 区域标注一旦在两侧各写一份「哪些区域要标」的判断,任一侧被改动就会让用户
 * 确认时看到的区域与实际提交的正文不一致,而这种漂移没有任何编译期信号。
 *
 * 代号与登录页区域徽标同一套不对称命名(DESIGN.md §16.3「区域徽标」):
 * cn → `CN`、dev → `Dev`、**global 不标**(值为 null)。
 *
 * ⚠️ global 故意为 null,两条理由叠在一起:
 *  1. 产品叙事硬规则(DESIGN.md §16.3「给 global 恢复徽标即回退该决策,不得
 *     回退」)——Cindy 默认版本不给自己贴标签自证是全球版,只标为特定法规单独
 *     构建的版本;
 *  2. global 是 DEFAULT_CINDY_REGION,「没有这一行」因此是个有含义的信号,不是
 *     漏附加。新增区域时要么给代号,要么明确复用这条默认语义,别让第二个区域也
 *     落进 null——那样两个区域就又分不清了。
 *
 * 代号本身四语同文、不翻译(术语表 region-code-cn / region-code-dev)。但卡片
 * 上的展示文案仍走 i18n(`issueAgent.confirm.regionCode*`,同 login.regionPill.*
 * 的做法),以便日后改判为「中国大陆版」这类可译文案时不必回改组件——本常量因此
 * 只负责「标不标 + 正文写什么」,不直接当卡片文案用。两者的一致性由
 * `renderer/__tests__/issueRegionCode.consistency.test.ts` 逐区域逐语言断言。
 *
 * Record<CindyRegion, …> 是 exhaustiveness 哨兵:`CindyRegion` 新增取值时本对象
 * 会编译报错,提醒一并决定新区域标不标、补齐四语 key。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export const ISSUE_REGION_CODE: Readonly<Record<CindyRegion, string | null>> = Object.freeze({
  cn: 'CN',
  global: null,
  dev: 'Dev',
});

/** 该区域是否需要在卡片与 issue 正文里标注(global / 未知一律 false)。 */
export function shouldLabelIssueRegion(region: CindyRegion | undefined): boolean {
  return !!region && ISSUE_REGION_CODE[region] !== null;
}
