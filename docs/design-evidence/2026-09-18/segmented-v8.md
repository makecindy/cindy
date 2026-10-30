# Desktop Segmented v8 实施与验证

2026-09-18，macOS arm64。基点 `6f56e4cd78aec8947ec4c621cd60fe115e2a072e` + 本次工作区改动；未提交。依据：用户确认的 Design Lab v8 与 DESIGN.md §4 Desktop segmented controls。按用户要求，仅自审，不做本地双审。

## 实施范围

共享入口为 `apps/desktop/src/renderer/components/ui/segmented-control.tsx` 与同名 CSS。旧 SettingsSegmentedControl 删除；VendorSegmentedSwitcher 仅适配品牌条目、密度和 composer 焦点。共享组件覆盖原有设置、表单、筛选和 Agent 选择场景，并补齐插件与 SkillHub 页面中遗漏的来源筛选、目录切换、分类筛选、市场可见范围。

| 场景 | 消费者（renderer 下） | 数量 |
| --- | --- | --- |
| 侧栏卡片、任务列表、插件恢复入口 | components/settings/AppearanceSection.tsx | 3 |
| 网页、本地链接 | components/settings/LinkOpenSection.tsx | 2 |
| 浏览器目标 | components/settings/BrowserBackendSubsection.tsx | 1 |
| MCP 传输 | components/settings/McpServerDialog.tsx | 1 |
| 资源档位、优先级 | components/settings/AgentResourceSection.tsx | 2 |
| 关闭窗口行为 | components/settings/WindowBehaviorSection.tsx | 1 |
| 表情、群引用、私聊引用、群激活 | components/settings/TelegramBehaviorSettings.tsx | 4 |
| 空白/模板、执行方式、触发、运行任务 | features/scheduler/components/ScheduleFormDialog.tsx | 4 |
| 飞书 / Lark | components/settings/FeishuBotSection.tsx | 1 |
| Creator 键盘任务/动作 | components/settings/WorkLouderCodexSettings.tsx | 1 |
| 推理档位 | components/settings/ModelAdvancedDrawer.tsx | 1 |
| 鉴权、OAuth 流程、Runtime | components/settings/ProviderConnectionDialog.tsx | 3 |
| 远端 Worker、兼容模型菜单 Agent | components/new-chat/VendorSegmentedSwitcher.tsx | 2 |
| 价格覆盖 Agent | components/settings/ModelPriceOverrideDialog.tsx | 1 |
| 词典来源与数量 | components/settings/VoiceInputSection.tsx | 1 |
| 模型类型 | components/settings/UnifiedModelList.tsx | 1 |
| 导入来源、位置 | components/settings/SessionImportSection.tsx | 2 |
| Diff 模式 | features/right-sidebar/plugins/review/ReviewTabBody.tsx | 1 |
| 插件 / 技能导航 | features/plugin/PluginManagementLayout.tsx | 1 |
| 插件推荐来源筛选 | features/plugin/GhostPluginPage.tsx | 1 |
| SkillHub 目录切换 | features/skillhub/SkillhubHomeView.tsx | 1 |
| SkillHub 分类筛选 | features/skillhub/components/SkillCategoryFilterBar.tsx | 1 |
| SkillHub 市场可见范围 | features/skillhub/SkillhubMarketListView.tsx | 1 |
| 远程项目：已有项目 / 浏览文件夹 | components/new-chat/AddRemoteProjectDialog.tsx | 1 |
| 通讯录：全部 / 人物 / 组织 / 待确认 | components/settings/contacts/ContactsListPane.tsx | 1 |
| Issue 确认卡：Bug / 功能建议 | features/cc-agent/IssueConfirmCard.tsx | 1 |

保留各场景密度与回调；等分选项不足宽时换行，避免标签重叠。六个局部颜色/阴影角色进入 DTCG。旧主题 ID 不删除，不改用户主题文件。

分离式 API 协议、提交身份、状态弹出筛选、模拟器实例、子 Agent 导航仍保留各自语义，不强行并入。Mobile / iOS 不在本轮范围。

## 自动检查

- Desktop 定向单测 25 文件 / 439 项通过：共享控件、Telegram 写入排队/失败/绑定切换、推理档位、供应商表单、价格覆盖禁用、MCP、窗口行为、Agent 入口及完整主题守卫。新的 radio 断言保留原业务断言。
- Token 包 5 文件 / 47 项通过（`--pool=threads --maxWorkers=1`）：DTCG 生成、独立冻结、兼容、重复生成与负向反例。默认 fork 并发曾出现测试/RPC 超时；未调整阈值或门禁，按仓库 runner 的 threads 模式重跑通过。
- 根 `pnpm test:unit:related` 已执行。测试运行器 543 项通过、2 项跳过。Desktop 当次全量 37501 项通过；本次角色迁移造成的 4 个失败已修正并在上述定向检查通过。仍有 5 个未改动文件内的 12 个失败：claudeOrphanReaper、ghostAccountBoundaryOrdering、windowBackdropAcrylic、accountProviderReadinessWiring、codexAuthIsolatedSandbox。maker-core 另有 5 个超时；其它工作区通过。不能报告全仓绿色；未扩大到本次无关的进程/账号逻辑修复。

## Electron E2E

安全包装启动 `--region=global --isolated=segmented-v8 --passive`。启动与 whoami 均返回 `DESKTOP_DEV_VERDICT=ready`，CDP 9333 对应本工作区进程。

实际页面已验证：

- 设置 → 通用 → 外观：三组选择点击、状态更新及恢复原选项。
- 设置 → 模型供应商 → 添加 → 自定义端点：鉴权切 OAuth、选择设备码、Runtime 切换、切无鉴权后隐藏 OAuth 字段。未保存或发起登录。
- 自动化 → 新建：空白/新手帮助、AI/脚本、自动/手动、运行任务；脚本模式正确隐藏运行任务选择。未创建任务。
- 插件 / 技能：真实路由切换后选中项一致。

实际 Electron renderer 内另外挂载生产 SegmentedControl 与 VendorSegmentedSwitcher，使用合成选项和真实主题/样式。11 种密度/布局 × Light/Dark = 22 组合通过：点击、方向键/Home/End、跳过禁用选项、整体禁用、尺寸/标签变化后的底板定位、长标签不重叠及 reduced motion。

这部分是生产组件级 E2E，不等于 33 个业务入口逐一实机验收；有条件的远端/设备/账号入口由源码迁移核对和业务单测覆盖。Light/Dark 截图均已目检。临时证据 `/tmp/cindy-segmented-v8-e2e/` 包含脚本、JSON 数值和两主题 PNG；图片不入 Git、不发布到 Design Lab。未测试 Windows/Linux 实机，未宣称完整用户验收。

## 自审

已修复样式级联造成的默认 padding 丢失、等分长标签溢出和旧角色断言。核对禁用、无匹配预设、受控状态、RTL、composer 焦点、菜单/路由及回调；删除旧绘制实现与无消费者的 Agent 视觉分支，保留旧 token 兼容。工作区原有 Switch 等改动保留，未纳入本次实施结论。

Desktop 与 Token 包 typecheck、共享组件定向 ESLint、设计台账生成检查和 git diff --check 均通过。

源码 SHA-256：

- `apps/desktop/src/renderer/components/ui/segmented-control.tsx`: `7616ffd9e9e9f25c4c923a5cff34672c4bd3bcabea1874a6edb592b5b1aee5f7`
- `apps/desktop/src/renderer/components/ui/segmented-control.css`: `a07220c25f51a9f2d6d11c01ba4a3494c6f847bd22eb11514ab1cc22cb758613`

## 2026-09-19 最终自审补充

用户已实测若干页面确认正常；本轮继续做源码覆盖核查与自审，没有本地双审。表中合计 40 个桌面场景，包含业务薄适配器的多个使用位置，不等同于 40 个独立实现或逐页人工验收。

- 通过共享组件调用、radio/tab/pressed 语义搜索，以及手写按钮 className/style 选择条件核查，补齐添加远程项目、通讯录固定筛选、Issue 类型选择三处。保持回调、计数、远程操作边界及提交确认流程。
- 保留 VendorSegmentedSwitcher、Telegram 的 SegmentedRow、导入的 SegmentedFilter：它们只适配图标、标签或业务数据，实际绘制统一交给 SegmentedControl。旧 SettingsSegmentedControl 与测试、旧插件 TabButton、市场 FilterChip 已删除；本轮额外删除无消费者的 plugin-motion-selected、plugin-selection-settle 和配套两个动画变量。
- 分离式 API 协议、发布身份卡、Issue 提交身份、Worker 自定义角色建议、主题/远端行为卡片、动态对象导航、弹出菜单、多选和普通页签仍保留，不属于共轨道分段选择。Mobile / iOS 原生不在范围。
- Chromium 布局验证发现分类滚动行仍受 max-width 与 flex shrink 限制，12 个分类被压成约 26px。修正 nowrap 变体为内容宽度，选项不压缩：相同测试下分类宽度至少 87px，252px 可视区对应 1150px 内容，保留横向滚动；删除无用途的场景 class。

验证：

- Desktop 定向 7 文件 / 154 项通过：共享控件、分类筛选、插件导航、市场路由、Issue 草稿与提交保护、项目入口源码合同、通讯录设置。
- 插件样式合同 1 文件 / 2 项通过；加上远程项目回归，本轮共 9 文件 / 157 项通过（不重复计算重跑）。
- 新增远程项目交互回归 1 文件 / 1 项通过：等待目标初始化后，确认进入浏览才读取目录、返回已有项目清除路径、键盘切换及提交期间禁用。远端适配器使用 mock，未连接真实设备或创建目录。首次测试缺少等待目标初始化而失败，补齐测试等待后通过；未为测试修改业务逻辑。一次从根目录直接运行 Vitest 的 alias 配置错误不算业务失败，使用 desktop 配置重跑。
- 现有 Electron 隔离测试环境（CDP 9222）实际页面：插件来源、技能公开/组织/本地、技能分类、市场全部/我的管理，点击和 Home 切换选中状态通过；结束恢复原页面。
- 同一 Electron renderer 内挂载生产 SkillCategoryFilterBar 与 ContactsListPane，以合成列表验证 Light/Dark 点击、Home/End、待确认数量、横向滚动按钮、焦点滚入视区、选中底板定位和 reduced motion。两主题截图已目检。浅色轨道 rgba(0,0,0,0.06)，暗色 rgba(0,0,0,0.25)，无 pageerror；未改用户主题设置。临时脚本 /tmp/segmented-final-e2e.cjs、/tmp/segmented-routes-audit.cjs 与两主题 PNG 仅供本轮验证，不发布截图。
- Desktop typecheck 和 git diff --check 通过。历史全仓 related 测试的非本轮失败仍见上文；本轮未提交、未推送，也未宣称全仓测试通过或 40 个业务场景逐一实机验收。

前文源码 SHA-256 为首轮验证快照；最终自审修改了共享 CSS 的 nowrap 布局。

### 2026-09-19 远程项目弹框切换闪动修复

用户实测反馈「已有项目 / 浏览文件夹」切换时弹框闪动。生产组件配合延迟返回的合成远端目录复现：900px 高视区中，已有项目时弹框 top=276.25、height=347.5；进入浏览加载时 top=226.25、height=447.5；30 行目录加载完成后 top=120.25、height=659.5。高度变化导致居中弹框连续上移，是本次确认的跳动原因。

有远程目标时将弹框高度稳定为 660px，仍受 88vh 上限约束；标题、设备选择、分段切换和底部按钮不压缩，列表占据剩余空间并内部滚动。没有远程目标的说明空态保留内容自适应高度。未新增状态、缓存、请求或远端副作用。

Chromium 生产组件 E2E（仅远端数据与 hooks 使用测试替身）通过 Light/Dark × 1280×900、640×520 四组断言：已有项目、加载中、30 行目录、空目录反复切换，弹框 top/height、选择器 top 全部相等，底部不超出视区，无外壳内容溢出和 pageerror。900px 高视区固定 top=120、height=660；520px 高视区固定 top=31.203125、height=457.59375。浅色正常窗口与暗色矮窗口截图目检通过。脚本与结果在 /tmp/remote-dialog-layout.cjs、/tmp/remote-layout-results.json；未发布截图，未连接或操作真实远端目录。

相关单测 3 文件 / 99 项、Desktop typecheck、git diff --check 均通过。Renderer 通过现有 Vite 测试环境热更新，无需重启客户端。


## 2026-09-19 PR 分支提交前验证

本轮从 origin/main 0d046f16de 创建独立 ui/segmented-controls 分支，仅转移 Segmented 改动。保留上游已合入的 Slider / Switch；主题与设计文档的追加位置冲突已人工合并，DTCG 重新生成后校验一致。上文基于旧工作区的全仓失败属于历史记录，不能当作本 PR 分支的门禁结果。

独立分支上 pnpm test:unit:related 通过（runner 自测、Desktop 与 design-tokens 相关单测）；Desktop 和 design-tokens typecheck 均通过。设计颜色、台账、DTCG 生成、端点、i18n 结构、品牌术语、术语表及 git diff --check 通过。共享组件 TSX/CSS、远程项目弹框、技能分类条与此前生产组件 E2E 的源码逐字一致。按用户明确要求不做本地双审，保留自审和真实测试证据。
