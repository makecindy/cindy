/**
 * regionCode — 构建区域代号「标不标 + 标什么」的**唯一事实源**,main 与 renderer
 * 共用,跨全部消费链路(issue 反馈、侧栏版本行,后续新增的一并接进来)。
 *
 * 为什么必须是单点:区域标注一旦在各处各写一份「哪些区域要标」的判断,任一处被
 * 改动都不会有编译期信号,界面之间就会给同一个构建报出不同的区域身份;issue 链路
 * 还额外有「卡片展示的就是最终写进 issue 正文的内容」这条契约,两侧漂移会直接骗到
 * 用户。原 `issueRegionCode.ts` 只服务 issue 链路,侧栏接入时泛化为本文件。
 *
 * 代号与登录页区域徽标同一套不对称命名(DESIGN.md §16.3「区域徽标」):
 * cn → `CN`、dev → `Dev`、**global 不标**(值为 null)。
 *
 * ⚠️ global 故意为 null,两条理由叠在一起:
 *  1. 产品叙事硬规则(DESIGN.md §16.3「给 global 恢复徽标即回退该决策,不得
 *     回退」;产品侧同源条款 region-and-editions.md §2.3)——Cindy 默认版本不给
 *     自己贴标签自证是全球版,只标为特定法规单独构建的版本;
 *  2. global 是 DEFAULT_CINDY_REGION,「没有这一行」因此是个有含义的信号,不是
 *     漏附加。新增区域时要么给代号,要么明确复用这条默认语义,别让第二个区域也
 *     落进 null——那样两个区域就又分不清了。
 *
 * 代号本身四语同文、不翻译(术语表 region-code-cn / region-code-dev)。但**界面上
 * 的展示文案仍走 i18n**(`issueAgent.confirm.regionCode*`、`sidebar.user.regionCode*`,
 * 同 login.regionPill.* 的做法),以便日后改判为「中国大陆版」这类可译文案时不必回改
 * 组件——本常量因此只负责「标不标 + 写进非界面文本(如 issue 正文)时用什么」,不直接
 * 当界面文案用。各链路 i18n 值与本常量的一致性由
 * `renderer/__tests__/regionCode.consistency.test.ts` 逐链路逐区域逐语言断言。
 *
 * Record<CindyRegion, …> 是 exhaustiveness 哨兵:`CindyRegion` 新增取值时本对象
 * 会编译报错,提醒一并决定新区域标不标、补齐各链路的四语 key。
 */

import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export const CINDY_REGION_CODE: Readonly<Record<CindyRegion, string | null>> = Object.freeze({
  cn: 'CN',
  global: null,
  dev: 'Dev',
});

/**
 * 该区域是否需要在界面与非界面文本里标注(global / 缺失 / 未知一律 false)。
 *
 * ⚠️ 判定用「取到的是字符串」而不是「!== null」:未知 region 在表里取不到值,拿到的是
 * `undefined`,而 `undefined !== null` 成立——那样会把未知区域误判成要标注,继续走进
 * 有代号的渲染分支。类型上 `CindyRegion` 已穷举,但 issue 链路的 region 来自 IPC
 * payload,运行期不受类型保证,这里必须自己 fail-closed(呼应 IssueConfirmCard 的
 * 「region 缺失时按不标处理,不猜」)。
 */
export function shouldLabelRegion(region: CindyRegion | undefined): boolean {
  return !!region && typeof CINDY_REGION_CODE[region] === 'string';
}
