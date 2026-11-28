# 设计专题

视觉语言与具体选择在 [DESIGN.md](DESIGN.md) 维护。修改界面、布局、组件、样式、动效或文案前先读它开头的「阅读路由」，再按路由进入相关章节和下表的专题。参数、例外与兼容
边界只有一个正本，索引不复制数值。能由 Token 和组件统一表达的设计决定落在公共实现里，
新界面自然继承。

| 主题 | 正文 |
| --- | --- |
| 视觉、排版、组件、交互、动效、文案与 Light / Dark 实现 | [DESIGN.md](DESIGN.md)；根目录同名文件仅跳转 |
| 圆角分类与点击目标尺寸（含普通 UI 修改与审查） | DESIGN.md §5、[设计治理](design-governance.md) §13；间距例外与已登记的内容形状见 [布局例外登记](exceptions/layout.md) |
| Token、主题、标准组件、视觉门禁与迁移 | [设计治理](design-governance.md) |
| Mobile 文字角色、字号、行高、字重与字色 | [手机设计指南](../../apps/mobile/docs/mobile-design-guide.md) §3 |
| 产品术语与翻译 | [术语表](../../i18n/GLOSSARY.md)、[任务／对话／消息](../product-rules/task-and-conversation-naming.md)、[i18n 工程约定](../dev-rules/engineering-conventions.md) §5.1 |
| 登录域现行规则与色值；Token／尺寸决策记录 | [登录链路](login-flow.md)、[Token 决策表](token-decision-table.md) |
| 聊天正文的链接与可点性 | [可点性信号](message-link-clickability.md) |
| 输入框工具栏的容器形变 | [容器形变](container-transform.md) |
| 功能介绍：第一次用到某个功能时带小动画的一页引导 | [功能介绍](feature-introduction.md) |
| 新建任务页的内容位置与提示 | [新建任务页](new-task-home.md) |
| 任务侧栏、伙伴侧栏与任务筛选 | [任务侧栏](task-sidebar.md) |
| 模型供应商设置页的头部与折叠区 | [供应商设置页](provider-settings-ui.md) |
| 设置里的单页：设备访问、伙伴模型与能力、harness 版本 | [设置里的单页](settings-pages.md) |
| 「开启协同」「创建新 Worker」弹窗 | [Worker 创建弹窗](collaboration-worker.md) |
| 首次登录后的开始引导 | [开始引导](first-run-guide.md) |
| 聊天正文、群聊、频道与对话里的附件图片 | [聊天界面](chat-surfaces.md) |
| 远程连接 V2 的拓扑与状态 | [远程连接 V2](remote-connection-v2.md) |
| 输入框的发送 / 停止按钮与工作中光晕 | [输入框发送按钮](composer.md) |
| 例外登记：颜色、排版、间距与内容形状、动效、品牌界面 | [颜色](exceptions/color.md)、[排版](exceptions/typography.md)、[间距与内容形状](exceptions/layout.md)、[动效](exceptions/motion.md)、[品牌界面](exceptions/brand-surfaces.md) |
| 应用壁纸 | [壁纸](wallpaper.md) |
| macOS 菜单栏额度面板 | [菜单栏额度面板](macos-menu-bar-quota.md) |
| 附件预览的结构与交互 | [附件预览](attachment-preview.md) |
| 用量历史图表与日期选择 | [用量历史图表](usage-history-charts.md) |
| iOS 原生界面 | [iOS 原生界面](ios-native-design.md) |
| 设计文档导航、迁移与历史裁决 | [设计系统索引](cindy-design-system.md) |

## 往哪里写

- **单个功能的界面规格写进专题文件。** 某个弹窗、某个页面、某段动效长什么样，只对这一个功能适用的，写进对应的专题文件；没有合适的就新建一个，在上表、DESIGN.md「阅读路由」的专题表和[设计系统索引](cindy-design-system.md)的文档索引里各加一行，并在文件开头写明读取时机与适用路径（[开发工作流](../dev-rules/development-workflow.md) §4）。DESIGN.md 只在相关章节留一行入口：一句话说明，加一个链接。所有界面都适用的规则仍写进 DESIGN.md。
- **新标题不写日期和来源。** 写「### Worker creation dialog」，不写「### Worker creation dialog (owner-approved, 2026-11-10)」。
- **新规则不写来源括号。** 正文不写「(owner decision, 2026-11-28)」这类说明；谁在什么时候、为什么这样定，写进 [design-decision-log.md](design-decision-log.md)。
- **新例外写进登记文件。** 只对某个组件或某个位置成立的窄例外（颜色、排版、间距与内容形状、动效、品牌界面），写进 `exceptions/` 下对应领域的登记文件，DESIGN.md 不再直接加例外段落；还没有对应领域的，新建一份登记文件，在上表和[设计系统索引](cindy-design-system.md)的文档索引里各加一行，并在文件开头写明读取时机。
