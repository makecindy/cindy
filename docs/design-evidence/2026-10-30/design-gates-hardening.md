# 门禁加固回放证据（2026-10-30）

对应 [design-governance.md §8「门禁加固（2026-10-30）」](../../design-rules/design-governance.md)。基线为 main `727afb1ad6`，回放日期参数 `today = 2026-10-30`，只在本机运行，不访问 CI。

## 1. 颜色审计：豁免过期与规范外圆角

脚本 hash 与逐条结果见 [design-gates-replay.json](./design-gates-replay.json)：其中 `scriptHashes` 是回放时 `hardcoded-color-audit.mjs`、`design-layer-report.mjs`、豁免表等的 SHA-256，文中计数只绑定这份 JSON，文档里不再重复抄写 hash。

圆角阻断只在确认的样式语境里生效（class 属性、`cn()` 等调用、纯类名字符串、样式对象 `borderRadius:`、CSS 文件）；写在普通文案里的 `rounded-md` 只报告。

**近期命中**：main 最近 100 个 first-parent 合并（`8ee428cca0..cf8bc1e3e8`，窗口随 main 前进，JSON 里是最终一次运行的范围），每个按 `<merge>^1..<merge>` 回放：

- 规范外圆角 block：1 个合并，命中 #8238（`dash/header-round-buttons`，合并提交 `c4c6d736ac`）里 `GitContextBadge.tsx:449` 的 `rounded-md`：PR 链接行的真实 6px 圆角，属于真违规，不是误报。本 PR 创建以来窗口里先后命中过 #7889（`cfd02a20b4`，侧栏 20px 图标按钮）、#8092（`37c5bb9519`，三处 `rounded-md`）和这一处，都在本 PR 创建之后才合进 main，是 CI 在旧基线上先后拦下它们的原因——main 上持续有人新增 6px 圆角，说明门禁有用。
- 颜色 block：0（豁免过期没有拦下任何近期改动）。
- 其余 99 个合并无命中。

**正向对照**：用 `git log -G` 找到历史上新增过规范外圆角的 6 个合并，新规则在其中 4 个各拦下 1 处，另外 2 个只是删除了这类写法，没有命中：

| 合并 | 命中 | 判断 |
| --- | --- | --- |
| #6404 `256940f00b` | `GhostToolCard.tsx` 卡片容器 `rounded-[10px]` | 真问题：容器应为 12px |
| #6009 `3f4ec18ec5` | `InputHandoffDeviceCode.tsx` 卡片 `rounded-[10px]` | 真问题：容器应为 12px |
| #6861 `9245acbbe4` | 13px 插件图标 `<img>` 的 `rounded-[3px]` | 内容自身形状（DESIGN §5 不管辖）→ 由此加入 `design: intrinsic-geometry` 声明通道 |
| #6358 `7b8e3e4a71` | 主题预览缩略图里的色条 `rounded-[3px]` | 插图形状，同上 |

声明通道只在同一行或上方两行内生效，降为 report 后仍出现在审计输出里，由人工审核把关；超出范围的声明不生效（单测覆盖）。

复现：在本分支运行 `audit({ root, baseRef: '<sha>^1', headRef: '<sha>', today: '2026-10-30' })`，取 `findings` 中 `rule === 'off-scale-radius'` 及 `bare-color` 的 block 项。

## 2. PR 设计依据检查

旧脚本（main）与新脚本在 makecindy/cindy 最近 150 个已合并 PR（#7410–#7833）的正文和变更文件上逐个比较：

| 旧 → 新 | 数量 |
| --- | --- |
| 跳过 → 跳过 | 71 |
| 通过 → 通过 | 77 |
| 跳过 → 通过 | 2（#7619、#7492：新计入的 Mobile 界面文件，正文本来就填了规范依据） |
| 通过 → 失败 | 0 |

## 3. Mobile 字色测试

`textColorDiscipline.test.ts`（guard 层）的两条全仓扫描，在含 main 最新代码的树上，存量共 **13 次**，全部登记在测试内的 `KNOWN_TEXT_COLOR_DEBT`（12 次，11 条）与 `KNOWN_PLACEHOLDER_DEBT`（1 次）里，按「文件 样式名 token」加次数登记：

| 文件 | token | 次数 | 说明 |
| --- | --- | --- | --- |
| `MobilePrimitives.tsx` 选中徽标 | `cta` | 1 | 与 `textPrimary` 两模式同值 |
| `PluginDetailView.tsx` / `.ios.tsx` | `inputCaret` | 1 + 2 | 展开 / 收起用光标蓝 |
| `RemoteDesktopSecuritySettings.tsx` | `inputCaret` | 1 | 空闲超时可用态 |
| `SharedTaskScreen.tsx` | `sharedTaskConfirmBackground` | 1 | 危险文字借用确认钮红 |
| `SessionUsageSummary.tsx` | `quotaBarWarn` / `quotaBarCrit` | 1 + 1 | 额度条专用色，规范写明不用于百分比文字 |
| `BotGroupChatScreen.tsx` | `threadUnreadDivider` | 1 | 规范写明「新回复」分隔线文字保持 text-primary |
| `SessionImportSheet.tsx` | `warningFg` | 1 | 警告文字，规范只登记了图标与皇冠 |
| `InteractionPanel.tsx` | `statusReady` | 1 | 就绪阶段文字用品牌 teal |
| `ContextSheetGoalView.tsx` | `statusRecording`（`textColor` prop） | 1 | 该 token 定义只供状态指示 |
| `ContextSheet.tsx`（占位字） | `textTertiary` | 1 | 应为 `textPlaceholder` |

扫描覆盖（最终版）：命名样式块（按是否实际用在 `<Text>` / `textStyle` 上判断，不靠样式名）、内联 `style` / `textStyle` 的对象 / 数组 / 条件分支与 `{ color }` 简写、`const`/`let` 局部别名（按词法作用域和使用位置解析，最多两层）、`textColor` / `labelColor` 等文字颜色 prop、占位字的条件与别名写法；SwiftUI `foregroundStyle` 统计所有非形状 / 图标的所有者（`Text`、`Button`、`TextField` 等，以及没有 JSX 标签的可复用修饰器），参数同样走别名解析；`colors.login.*` 只在登录画布文件放行。存量次数增加会报错，修掉后实际次数低于登记值会提示收紧。扫描器本身有单测，并做过反向验证（把 `nativeGlassButtonStyle.ios.ts` 的 `ctaText` 临时改成 `colors.border`，测试会报出该文件）。
