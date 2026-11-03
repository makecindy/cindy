# 套餐对比改动与验收

当前状态：相关单测、类型检查与 ESLint 通过；已复核 macOS 浅色界面截图。截图拍摄后统一了套餐购买与变更弹窗标题区，并补齐 FREE 说明行高度；这两处微调尚未重新截图。真实支付联调和最新深色、窄窗实机验证待完成。

## 交付范围

| 分组 | 文件范围 | 目的 |
| --- | --- | --- |
| 客户端套餐页面（12 个文件） | `apps/desktop/src/renderer/features/billing/` 下 4 个组件、2 个测试文件，五种语言 `common.json`，本文档 | 套餐比较、渠道价格展示及状态适配 |
| 服务端支付宝修复（独立服务端仓，7 个文件） | `planChangeService.ts`、`planChangeRepository.ts`、`alipaySubscriptionRepository.ts`、3 个测试文件及订阅文档 | 取消续费后仍可升级并重新签约 |
| 本地运行包缓存（2 个文件） | `scripts/ensure-agent-binaries.mjs` 及其测试 | 校验并复用同版本的完整运行包，减少下载 |

客户端界面与启动缓存分别组织提交。服务端支付宝修复已通过独立 PR #701 合并，不包含在客户端 PR 中；此前已合并的 Stripe 取消状态与退款账单关联修复也不包含在客户端 PR 中。启动缓存改动不属于套餐页面逻辑。

## 最终界面与交互

- 首次订阅与更改套餐共用 `PlanComparison`：横向列出 FREE 和服务端套餐。无推荐标签、价格下拉框或套餐按钮选中态。
- FREE 展示完整 Agent 功能、自带 API key、接入已有订阅、本地模型和基础模型；付费套餐包含共有能力并展示高级模型权限。不列具体模型型号。
- 付费价格、币种、周期、点数和剩余点数上限均来自服务端，FREE 固定为 0。同币种、同周期的可用报价同价直接显示，异价显示最低价加“起”；权益跟随对应报价。不同币种或周期分开展示。
- 升降级目标只汇总当前可切换的报价；当前套餐使用合同快照。当前套餐标签与按钮一致，同级切换沿用服务端不支持的约定。
- 点击套餐后复用已有购买或变更流程。购买步骤同时列出渠道与对应价格，提交实际选择的 `offerCode` 和 `purchaseOptionId`。
- FREE 按钮打开原充值流程；取消续费仍位于订阅管理菜单。购买套餐页保留敬请期待和无渠道报价，状态直接放到禁用按钮；升降级页按旧规则隐藏不可购买、不同周期或不同支付渠道的报价。保留加载失败、报价过期和支付结果状态。
- 弹窗外部点击不关闭。矮窗口正文可滚动，二维码保持可扫尺寸；窄窗口仅套餐区域横向滚动。
- 颜色使用既有主题 token；沿用应用字体、标准支付按钮和图标。容器为 12px 圆角，套餐操作为胶囊按钮。
- 余额用量采用两行布局，剩余金额右对齐；深色表示剩余余额并靠右，浅色表示已用，不显示百分比。
- 订单状态使用纯文字，申请开票使用标准描边按钮，两者居中对齐并保留间距。

## 支付宝行为边界

- 取消续费但本期仍有效时，允许新发起升级，通过现有补差价和签约流程重新开通自动续费。
- 升级付款和新协议签约均成功后才恢复续费；未付款、未签约或失败保持原取消状态。报价创建后再次取消，旧报价不能恢复续费。
- 客户端复用已有弹窗；套餐按钮上方不再展示升级、降级及续费说明。服务端修复需先可用，再验收客户端取消后的升级流程。
- 原未付款升级单阻止直接更换目标套餐的限制保留；取消状态下的降级、Stripe 变更和期末限制不变。
- 未新增 API、数据库字段、自动退款、待付款状态投影或“继续支付”流程。

## 验证记录

| 项目 | 状态 |
| --- | --- |
| 最新行为代码静态检查 | Desktop 与服务端 typecheck、相关 TSX ESLint 通过 |
| 本次整理 | 仅删除未使用文案并整理本文档；JSON 结构、多语言和术语检查通过，仅有既有非阻断提醒 |
| diff 检查 | 两仓在整体 review 时通过；整理后客户端复查通过 |
| 历史组件测试 | 曾完成 139 项及后续支付页 109 项回归；之后代码已有变化，不作为最新通过证据 |
| 最新回归测试 | `pnpm test:unit:related` 通过；套餐组件定向测试 116 项通过。文件监听与跨进程锁测试在沙箱内超时，系统权限下完整相关门禁通过 |
| 最新视觉复核 | 已复核以下五张 macOS 浅色截图；最后两处对齐微调未重新截图，真实支付联调未执行 |

已更新的用例覆盖价格汇总、渠道提交一致性、不可用套餐、当前套餐身份、取消后升级，以及支付宝旧报价、新取消、未付款和未签约边界。发布前需执行相关测试，并验证支付宝重新签约链路。

## 本次视觉证据

平台：macOS Desktop，浅色主题。金额为开发环境报价，不代表正式售价。截图未验证支付结果、深色主题或窄窗口。

| 页面 | 截图 |
| --- | --- |
| 套餐购买 | [plans-light.png](docs/assets/billing-subscription/plans-light.png) |
| 支付渠道与价格 | [payment-channels-light.png](docs/assets/billing-subscription/payment-channels-light.png) |
| 套餐升降级 | [change-plan-light.png](docs/assets/billing-subscription/change-plan-light.png) |
| 余额用量 | [balance-usage-light.png](docs/assets/billing-subscription/balance-usage-light.png) |
| 订单状态与开票 | [order-history-light.png](docs/assets/billing-subscription/order-history-light.png) |

套餐购买与升降级截图拍摄后，标题区域统一为左右 24px、上下 16px，正文顶部分隔线保持一致；FREE 说明行补齐与付费套餐相同的最小高度。

## 历史视觉证据

- 设计依据：已确认的 subscription-v10 套餐对比及后续支付确认页设计。
- 本地证据目录：`/Users/liugaowei/.codex/visualizations/2026/09/14/01a09efc-7345-7480-bf7d-aa5ed5926d0e/implementation/`。
- 套餐：`change-light.png`、`change-dark-current.png`、`subscription-narrow-current.png`。窄窗 640px，套餐滚动容器 542px、内容 880px，无页面级横向溢出。
- 支付：`checkout-cindy-light.png`、`checkout-cindy-dark.png`、`checkout-github-dark.png`、`checkout-solarized-light.png`、`checkout-cindy-dark-large.png`；`checkout-light-comparison.png` 为设计与实现对照。
- 上述截图使用实际 React 组件、Tailwind 和主题 token 静态渲染；示例数据未进入产品代码。没有操作用户窗口或执行支付写接口，不等同于 Electron 端到端、任意自定义主题或最新版本验收。
