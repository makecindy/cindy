# @cindy/design-tokens

Cindy 设计 token 的 **DTCG 影子层**（reference → semantic → component）。

本包只是字典，**零运行时接线**：Desktop / Mobile / 任何产品 package 都不得依赖它。生产生成切换在路线图 **DS-8**；在那之前，Desktop 颜色数值权威仍是 `apps/desktop/src/renderer/themes/colors.ts`，本包的取值必须与 DS-2b 冻结快照逐值一致。

## 弃坑条款

治理合同 §7：影子包在约定复查期内没有真实消费者时应删除。

- **复查日期：2026-11-01**
- DS-4 已开工：component 层随 Button 消费建立。零运行时接线红线仍到 DS-8。
- 届时若仍无生产生成切换且无人维护，按治理合同 §7 评估是否删除

## 数据源

分类与建层的唯一数据源是 DS-2b 冻结快照：

`apps/desktop/src/renderer/themes/__tests__/fixtures/desktop-color-defaults.json`

不重新解析 `colors.ts`。重新生成：在本包目录执行 `pnpm generate`（脚本 `src/generate.ts`）。连续两次生成必须字节一致。守卫测试会核对。

## 三层

| 层 | 路径 | 内容 |
| --- | --- | --- |
| reference | `src/reference/color.json` | semantic / component 角色实际引用的原始色值（不铺全色板） |
| semantic | `src/semantic/color.json` | DESIGN.md §10 Tier-1 的 surface / border / text / accent 四族 + status 语义；每个角色 light/dark = 冻结快照现值 |
| component | `src/component/color.json` | DS-4 起随消费组件建立。**刻意很薄**：DS-4 的 Button hover / pressed 是 `color-mix` 运行期派生值（暗色下 `--surface-hover` 与 `--surface-chip` 同值，alias 会让悬停不可见），按治理合同 §3.4 只在 `classification.json` 登记、不建模；本层只收 `button-cta-hover` 这类能落回 semantic 的纯 alias |

依赖单向：component → semantic → reference。不装 Terrazzo（DS-8）。

色值一律用标准 DTCG 颜色对象（`$type: "color"` + `{colorSpace, components[, alpha]}`）：
HSL triplet（`60 12.5% 97%`）→ `{"colorSpace":"hsl","components":[60,12.5,97]}`；
hex / rgba / transparent → srgb 分量（0–1）+ 可选 alpha。不用自定义 `$type`
（`"other"` 不是标准 DTCG 类型——Terrazzo 2.7.1 实测会静默丢弃这类 token，
DS-8 接线时无法生成 CSS 变量；裸 triplet 字符串也会被解析成黑色）。

加严保护值按治理合同 §1.1 标记 **protected**，分两种 mode：Tier-1 slot（U2 二级信息色 `text-secondary` / `text-secondary-cross`）按 §3.2「名称与用途延续」**照常 semantic 建模** + protected 元数据——保护限制的是改值须经裁决，不是禁止迁移；Tier-3 singleton（`annotation-accent`、CINDY 皮肤族品牌红 `login-brand-accent` / `login-brand-accent-pressed`）按「保留原位，逐项裁决，默认不动」只登记、不建模。皮肤族其余值在 cindy-light/dark 主题 override 里，不在本快照默认值中。

语义豁免色（DESIGN.md §10 theme-invariant 族：`destructive` / `error-*` / `warning-*` / `focus-ring*`）与 protected 不同：**照常 semantic 建模**，但在 `classification.json` 携带 `exemption` 元数据（外部主题不可覆盖、跨主题恒定）。DS-8 生成主题入口时据此区分可覆写 semantic 与必须保留原值的豁免族；治理合同 §3.2 要求 Tier-3 豁免色按此迁移。DESIGN.md §10 豁免表其余未建模项（`diff-*` / `login-error-fg` 等）进 shadow 层时再登记。

## 多入口投放合同（只写合同，DS-8 才接线）

每个消费者届时只消费自己的子集，由同一份 DTCG 生成，不得再手写第二份数值：

| 消费者 | DS-8 起消费什么 |
| --- | --- |
| Desktop ColorRegistry | semantic + 后续 component；`registerColor` 的 id / 默认 light/dark 由生成物提供 |
| CSS Variables（`:root` / `theme-vars`） | 同一套 semantic id 的 kebab-case CSS 变量 |
| Tailwind 映射 | 现有 `tailwind.config.ts` 色名继续指向上述 CSS 变量，不另造色板 |
| Mobile TS Token | `apps/mobile/src/theme/tokens.ts` 改为引用生成子集；须另立高风险 PR（冷更边界） |
| DESIGN.md 机器摘要 | §10 Tier-1 表与 §16.1 登录表由本包生成摘要替换人工维护 |

本张不产出任何被产品消费的生成物。

## 分类登记

`src/classification.json` 覆盖冻结快照全部 id，四类互斥完备：

1. **literal** — 直接数值，reference 层候选
2. **alias** — `var(--…)` / `hsl(var(--…))`，semantic/component 候选
3. **hsl-triplet** — `-hsl` 后缀族，与对应 hex 必须指同一颜色（DS-8 起由生成器保证）
4. **runtime-derived-or-protected** — 运行期计算值、非颜色、双模式不全、加严保护值；只登记存在、负责人与去向，不建模
