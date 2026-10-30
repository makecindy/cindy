# DS-6 真实设置表单与普通确认验证

状态：工程候选可审阅，用户已授权提交 PR；目标尚未全部验收，公开附件尚未上传。日期：2026-09-08。

## 采集边界

- 开工与任务 HEAD：`a00ae8d464406f3092855f6fe9a5929553ceed37`；分支 `ds/6-forms-and-confirm`。原实机证据对应其上的 DS-6 补丁，已保全为 `6d4af6733a`；后续提交兼容检查与原实机证据分别记录。
- macOS arm64；Node 22.22.3、pnpm 10.33.2。frozen-lockfile 安装通过，安全启动器确认 Node/Electron native cache 匹配。未修改依赖、Token JSON、CI 或用户配置语义。
- Desktop 独立 `ds6` 沙箱，`--region=global --passive`；重启后安全包装明确 ready，数据库文件句柄核实均在 `CindyGlobal-dev2-ds6`。完整 Settings 使用真实路由/组件，服务边界在 renderer 内返回虚构 provider/MCP 与假密钥，不做真实配置/凭证写入、不绕鉴权。
- 自动化使用假数据/服务替身，不读取真实凭证。完整设置页、真实组件受控样例、静态效果稿、computed 和人工目检分别记录。

## 改前事实

| 消费者 | 字段与原校验 | 保存/关闭 | 主题消费 |
| --- | --- | --- | --- |
| CustomProviderDialog | 名称必填；Claude Code/Codex/Pi 各维护 URL、模型、key、请求头；至少一个 runtime；非 OAuth 至少一有效模型；请求路径/URL/窗口草稿保留原校验；OAuth 两种 flow 的 URL/clientId/scopes | 成功父级关闭；失败 Toast 保留草稿；Esc/遮罩已有层级管理和 saving 防护，Cancel 仍可关；测试连接/模型获取独立 | SettingsTextInput ivory；settings-input-* 局部 alias；按钮 confirm-btn-*；错误目前 Toast |
| McpServerDialog | 名称必填；URL 必须 http(s)；http/sse；token 可空；请求头 trim、忽略空名、同名后者覆盖 | 成功父级关闭；失败保留；原无 dialog 焦点/Esc/遮罩合同；× 与 Cancel 并存 | 私有 40px/10px TextInput，settings-input-*；按钮 confirm-btn-* |
| MCP token | 回填后 hasToken=true 且输入清空：clearToken=true；回填尚未完成且空：false | create(config, token) / update(config, token, clearToken) 不变 | 与供应商 key 空值含义不同，不统一 |
| ConfirmDialog | default/destructive；主→第三→Cancel；默认 Cancel 焦点，autoFocusConfirm 与 typed 分支保留 | AlertDialog 遮罩不关；Provider 取得选择即结算，不等待业务；队列/abort/checkbox/skip 不变 | confirm-bg/shadow/title/desc、confirm-btn-primary/secondary-*；未迁调用继续原分支 |
| 相邻模型入口 | ModelAdvancedDrawer 保留 Codex 上限编辑、未改不写入、恢复默认；ModelHarnessPicker/兼容/停用选择按 main | 回归对象，非第三消费者 | 不迁私有数字框 |

## 共享确认调用盘点

仅两处显式加入本批呈现：`ProvidersSection.handleDelete` 自定义供应商删除、`McpServersSection.handleDelete` 自定义 MCP 删除；均保留原 default，不替换删除回调。

以下是 2026-09-08 在任务基线搜索 `useConfirmDialog|<ConfirmDialog` 的生产调用/挂载清单（含 Provider 容器，不能把文件数当对话框数）。除以上两处，其余未参与迁移；尤其 ChatInput/FullAccessConfirmContent、ForgeOidcInstallConfirmHost、GhostConfirmDialogHost、插件安装、ControlledBanner 与 agent 切换包装保持旧默认。普通残余由 DS-9 复核，权限由 DS-11；负责人按批执行者认领，复查 2026-11-01 或对应批开工较早者。

- `App.tsx`
- `contexts/AuthContext.tsx`
- `ghost-panel-window-entry.tsx`
- `hooks/useCodexSessionExpiredPrompt.ts`
- `cindy-brain/ForgeOidcInstallConfirmHost.tsx`
- `cindy-brain/ghostPanels.tsx`
- `cindy-brain/GhostConfirmDialogHost.tsx`
- `features/billing/BillingPage.tsx`
- `hooks/useVendorAuthGate.ts`
- `components/title-bar/WindowControls.tsx`
- `features/cc-agent/CCAgentSidebarUpper.tsx`
- `components/layout/GhostPanelWindowLayout.tsx`
- `features/cc-agent/RolePillDropdown.tsx`
- `components/layout/CredentialStoreBanner.tsx`
- `components/chat/ErrorBanner.tsx`
- `features/scheduler/components/RunHistoryPane.tsx`
- `features/cc-agent/hooks/useStopOrcaCollab.ts`
- `features/cc-agent/CCAgentSessionView.tsx`
- `features/scheduler/components/RunHistoryCard.tsx`
- `components/chat/useForkAtMessage.ts`
- `features/cc-agent/lib/sessionHardwareTaskActions.ts`
- `features/cc-agent/CreateWorkerPopover.tsx`
- `components/error/LocalDbFatalScreen.tsx`
- `features/scheduler/SchedulerPage.tsx`
- `components/resource-usage/ResourceUsageWindowLayout.tsx`
- `features/right-sidebar/plugins/ios-simulator/IOSSimulatorTabBody.tsx`
- `features/right-sidebar/plugins/review/ReviewTabBody.tsx`
- `components/settings/ProfileEditDialog.tsx`
- `components/chat/useDeleteMessage.ts`
- `features/plugin/GhostPluginPage.tsx`
- `features/right-sidebar/plugins/resource-usage/ResourceUsageBody.tsx`
- `features/plugin/MarketplaceSourcesDialog.tsx`
- `components/settings/DingTalkBotSection.tsx`
- `features/cc-agent/workdir-browse/hooks/useConfirmSwitchAwayIfDirty.ts`
- `features/cc-agent/workdir-browse/WorkdirBrowseRoute.tsx`
- `components/new-chat/ChatInput.tsx`
- `hooks/useLogout.ts`
- `features/remote-device/ControlledBanner.tsx`
- `features/plugin/GhostLibrarySection.tsx`
- `features/plugin/PluginPublisherConfirmHost.tsx`
- `components/settings/ProvidersSection.tsx`
- `features/skillhub/SkillhubDetailView.tsx`
- `features/cc-agent/workdir-browse/WorkdirBrowseSidebar.tsx`
- `components/settings/FeishuBotSection.tsx`
- `components/settings/RemoteHostDetail.tsx`
- `sidebar-window-entry.tsx`
- `components/ui/confirm-dialog-provider.tsx`
- `components/new-chat/AddRemoteProjectDialog.tsx`
- `components/settings/DiscordBotSection.tsx`
- `components/settings/WechatBotSection.tsx`
- `features/cc-agent/SessionContentHeader.tsx`
- `components/settings/AccountDeletionSection.tsx`
- `components/settings/McpServersSection.tsx`
- `components/settings/StorageManagementCard.tsx`
- `components/settings/HookConnectionsSection.tsx`
- `main-entry.tsx`
- `components/settings/BetaChannelCell.tsx`
- `components/settings/TelegramBotSection.tsx`
- `components/sidebar/UpdateBanner.tsx`
- `components/new-chat/FullAccessConfirmContent.tsx`
- `components/settings/contacts/ContactsManagerDialog.tsx`
- `components/settings/contacts/ContactDetailPane.tsx`
- `features/skillhub/hooks/useMarketManagement.tsx`
- `components/settings/MemorySection.tsx`
- `components/settings/WecomBotSection.tsx`
- `components/settings/UnifiedModelList.tsx`
- `features/skillhub/PublishDialog.tsx`
- `features/skillhub/components/InstallTargetPicker.tsx`

## DS-4 / DS-4b 历史证据处置

2026-09-08 只读复核：[#3931 评论](https://github.com/makecindy/cindy/pull/3931#issuecomment-5544942109) 的 12 项仍待上传；[#4010 评论](https://github.com/makecindy/cindy/pull/4010#issuecomment-5559661374) 是 HTML 复刻与 computed 说明，不是原图已公开。

DS-4 12 张均已从 `ede0f7739` 恢复原字节到仓外附件目录；采集实际提交仍按旧索引 `0458af96d`，不重标为 DS-6。DS-4b 两张 2026-09-06 PNG 原文件仍在，未复制另一套。公开附件交接由 kirozeng 在授权发布时进行；复查 2026-09-10 / DS-7 开工前，以较早者为准。

| 文件 | 处置 | 证据种类/当前公开状态 |
| --- | --- | --- |
| `cindy-dark-secondary-disabled-hover.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-dark-secondary-hover.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-dark-secondary-pressed.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-dark-secondary-rest.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-light-secondary-disabled-hover.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-light-secondary-hover.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-light-secondary-pressed.png` | 原字节找回 | 原实机截图；未上传 |
| `cindy-light-secondary-rest.png` | 原字节找回 | 原实机截图；未上传 |
| `ds4-button-input-state-matrix.png` | 原字节找回 | 静态绘制；旧值，仅历史档案；未上传 |
| `ds4-g5-secondary-compare.png` | 原字节找回 | G5 对照，按原索引解释；未上传 |
| `live-add-provider-wizard.png` | 原字节找回 | 原实机截图；未上传 |
| `live-settings-providers.png` | 原字节找回 | 原实机截图；未上传 |
| `输入主题兼容-亮色.png` / `输入主题兼容-暗色.png` | 原文件保留 | DS-4b 真实 Desktop 受控组件；未上传 |

含真实账号的历史“设置→通用”图从未入仓，本批不取、不交接。primary/CTA 新证据按 DS-6 采集，不冒称历史原图。

## 实现与验证结果

- FormField 关联 label/hint/error，预留纠错空间；动态行身份仅留在 UI。供应商保持 runtime/鉴权/子层状态机，首错切页签/展开后定位；原上下文深链误指模型 ID，已移到上下文文本输入。
- MCP 去掉私有 TextInput 和重复 ×，复用 SettingsTextInput/FormField/Button 与 Radix 焦点管理。原 ID/transport/header 参数及 hasToken/clearToken 分支不变。
- Button loading 仅呈现调用方状态，保留名称与尺寸；相同文字实际宽度前后均 132.421875px，禁用与减少动效通过。Input 焦点为 soft/50%，error 环/边框优先，显隐按钮禁用一致。
- 两处普通删除显式选择 standard，其他 ConfirmDialog 调用继续原分支。保留主→第三→取消、默认取消焦点、显式主焦点、手输优先、default/destructive。
- 压力检查发现 standard 极长无空格按钮越窗：原宽 1907.664px、左边 -1083.664px；已修为可换行、限容器宽，复查宽 368px、左边 456px，取消仍 36px 高。修复仅作用 standard 分支，未改其他确认。

| 检查 | 实际结果 | 仓外原始日志 |
| --- | --- | --- |
| 当前依赖 | frozen lockfile 安装与安全 Desktop native 检查通过 | 开工记录；`desktop.log` 只本地保留，不入公开包 |
| 最终默认 related | 退出 0；runner 504 通过/1 存量跳过，Desktop related 通过（42.5s） | `related-delivery.log` |
| Desktop typecheck | 退出 0；仅本包受影响，无 Token/Mobile 包生产改动 | `typecheck-delivery.log` |
| 相邻模型 | 5 文件 / 97 项通过：抽屉、上下文、Picker、显隐/停用与推理偏好 | `adjacent-models.log` |
| 主题合同 | 6 文件 / 93 项通过：真实 loader→renderer 归一化、本地旧副本不变量、内置冻结、按钮对比度、CINDY 与 Input 兼容 | `theme-contracts.log` |
| 台账 | 两次生成 SHA-256 相同；check 通过，35 surface，人工状态保留 | `inventory-stability.log` |
| i18n/术语 | 通过；9091 key；保留 1128 存量语言警告、18 proposed 术语命中 | `i18n-delivery.log`、`glossary-delivery.log` |
| diff / 新样式 | diff --check 通过；新增生产颜色均引用语义变量；无依赖/CI/Token JSON/权限/存储/协议修改 | 最终范围清单与候选文件摘要 |

首轮台账扫描与生成时点不一致、机器高负载导致的测试超时均已被上述正常默认检查取代；没有改超时门禁。旧 Input opaque 断言按 D1 更新；新增深链测试用实际 placeholder 定位，不给支持分隔符的输入强加 numeric 假设。新增修改通过格式检查；三份基点已有格式差异未顺手重排。这是实现交付阶段的记录，当时尚未提交；提交阶段另核对实际 commit 范围的 DCO/裸色扫描，不以前一阶段结果冒充。

## 真实设置页与组件证据

采集设备为 macOS arm64 / Electron 41.10.3，默认 viewport 1280×800 CSS px / DPR 2；小窗口用 CDP 800×600 布局视口，最大字号直接调用生产 `useFontSettings.applyFontSettings` 的 24px 上限，不写偏好文件。交互由 Agent 通过 Electron CDP 执行；focus emulation 保持背景窗口 CSS 焦点，Tab/Esc/Space 用 CDP 键盘，IME 防关闭采用可取消的 composing 事件。这不是人工在实体键盘上的完整试用。

服务替身范围：useProviders 返回虚构列表，provider/MCP 增改删、safeStorage、模型获取/连接测试、上下文上限请求只在 renderer 内存完成。业务组件、父级列表/关闭、纯配置序列化、主题服务与 Tailwind 真实运行。没有复制正式 profile、写测试登录或触发真实授权。

| 层次 | 已验证与截图组 | 限制 |
| --- | --- | --- |
| 基线补采 | `baseline-*`：同一 a00ae8d464 原源码的 8 个变更文件经仓外编译与装载适配，在真实 Settings 运行，亮暗 provider/MCP/确认 | 中断后补采，不是开工前原时点照片；不是 HTML 复刻；依赖/全局样式与候选相同，业务服务同样虚构 |
| 完整 Settings provider | `provider-new-*`、`settings-provider-new-success-*`、`provider-edit-*`、`provider-error-*`、`provider-saving-*`、`provider-failure-*`、`settings-provider-success-*`、`provider-model-fetch-*` | 向导→新建成功；编辑→首错/忙碌拒绝重复与 Cancel/Esc/遮罩→失败保留→重试成功；模型获取子层 Esc 归还获取按钮，显隐通过 |
| 完整 Settings MCP | `mcp-new-*`、`mcp-edit-*`、`mcp-error-*`、`mcp-saving-*`、`mcp-failure-*`、`settings-mcp-success-*` | 新建成功/再编辑回填；动态行焦点；同样保存失败/恢复与关闭策略；Tab/反向 Tab 圈定、Space 显隐、Esc 归还；Enter 保留原不提交行为 |
| 真实生产确认入口 | `provider-confirm-*`、`mcp-confirm-*` | 两删除确认 default、初始 Cancel、Esc 取消保留列表；未删除真实资源 |
| 表单主题/适配 | `*-form-default-*`、`*-form-both-*`、`*-error-overrides-*`、`*-small-max-font-*`、`*-long-name-small-*` | 两表单 Light/Dark×默认/全局/局部/并存共 16 组 computed；局部文本/边框优先、error 再优先；800×600/长名称/24px 字号下正文滚动且操作区可达 |
| 原组件受控样例 | `components-*` | Button 三变体 rest/hover/pressed/disabled-hover/loading；CINDY 与 Default 双模式；Input 通用/设置与 elevated/ivory；旧缺 placeholder 主题亮暗；11 内置主题按真实 mode 各测代表输入 computed。hover/pressed 由 CDP 强制实际伪类，不是手绘颜色 |
| 确认受控样例 | `confirm-*` | 三动作/显式主焦点/typed 优先/destructive/局部与全局并存/hover 与 active/长正文/超长按钮修复；受控样例不是完整生产删除 |
| 相邻模型 | `model-advanced-*`、`model-picker-*` | 完整 Settings 自定义 Codex 抽屉实际未改不写、150K 编辑一次、恢复 null；Picker/兼容入口是实际组件受控样例，停用时点击不回调；内置 Codex与关联目标/已停用候选由 97 项自动回归覆盖，未冒充完整生产入口实测 |
| 静态效果稿 | 本批未新建 | 历史 DS-4 静态矩阵只归档，不代表当前 UI；截图目录/索引也不是另做的一套界面 |

执行者 Codex 已目检：CINDY 两模式正常/错误表单、MCP Light 表单、24px 小窗口两图、Dark 按钮状态、旧主题两模式焦点、destructive Dark、长按钮修复及基线 provider Light。soft/50% 与错误环在这些对照中清楚，D1 无需改方案。其余图片完成采集/computed 但不宣称每张已人工目检；用户于 2026-09-08 在撤除替身后的真实测试版手动试用，反馈“ok，测下来没什么问题”，本轮手动审核通过；未逐项声明的平台/状态仍保留待项。用于区分覆盖来源的绿/棕临时颜色不是推荐主题。

## 附件交接与未验收项

所有当前图片、分类索引、候选文件摘要及精选无凭证结果在仓外 `2026-09-08-DS6` 目录。`DS6-公开附件交接-未上传.zip` 供后续网页上传；历史另包 `DS4-DS4b-历史附件-待公开.zip`。本轮没有任何公开上传/评论；压缩包存在不等于公开。

| 缺口 | 负责人 / 复查日期 | 目标影响 |
| --- | --- | --- |
| G2 真实独立非设计师 | kirozeng 安排，Codex 集成修复；2026-09-10 或 DS-7 开工前较早者 | 未有参与者/用时/反馈；Agent 第二消费者实现不算 G2。MCP 已迁移，届时选真实后续小改动，不能照抄完成态 |
| 公开附件 | kirozeng；同上 | 两级证据已准备；用户测试版手动审核通过，公开访问仍待完成 |
| Windows、原生拖窗/no-drag、实体 IME、原生 200% 缩放 | kirozeng 安排平台，Codex 复查修复；同上 | 未验证；CDP 视口/焦点/事件不替代这些结果 |
| 完整设置更多页签及模型生产选择入口 | Codex；DS-7 开工前复查 | 本批实跑 providers/builtin-tools 与 Codex 抽屉；Picker 为实际受控样例，不能宣称整套设置所有区域已验收 |

本批已发现的产品缺陷均已修复。settings 仍为 pilot，未运行 DS-7 回放/扫描器，也未扩大成熟保护。回退为整批 renderer/说明补丁撤回；无数据迁移、无需回写用户配置。合入后如需回退，针对真实合并提交走 revert PR，禁止 reset main 或清用户数据。

## 提交阶段上游兼容核对

重新 fetch 已见 `f3203a7049`：#4072 可见层圆角登记与 #4076 图表已合入。按 DESIGN §5 两步分类与治理 §13 审查：本批单行输入/动作框仍属普通 pill，弹层属 12px 容器，Textarea 维持 8px；不把图元/快捷键按 DOM 标签改形状，不推广图表的登记交互。合并保留上游完整分类、组件条目和台账待项。ModelAdvancedDrawer 新增 displayEfforts 与不可用档位防写是相邻回归对象，本批不修改其产品逻辑。

原 macOS 人工验收属于上述实机候选；上游兼容后的检查在提交说明中另记，不把旧截图/实机记录当成新合并树已经逐项重验。G2、原生缩放/IME/Windows 及公开附件待项不因本次提交自动消除。

## Review 轮修复:模态内 Tooltip 层级(2026-09-08)

PR review(P2)指出:两张表单的密码显隐按钮与行删除按钮的 `Tip` 经 Portal 渲染,内容层默认 `z-[60]` 低于手写模态的 `z-[10000]`,悬停/聚焦时提示被宿主弹窗盖住。修复沿用仓内既有惯例(模态内 Popover/Dropdown `z-[10001]`):行删除 `Tip` 直接传 `contentClassName="z-[10001]"`;共享 `Input` 为 secret 眼睛按钮新增 `secretTipContentClassName` 透传,两张表单的密钥/Token 输入传 `z-[10001]`。规则回写 `DESIGN.md` Dialog & Modal 段。

后续 review(P1)补扫出 `AddProviderWizard` 内置供应商与预设 API Key 两个 `SettingsTextInput secret` 调用点同处 `z-[10000]` 向导遮罩内,已同批传入 `secretTipContentClassName="z-[10001]"`。仓内 secret 输入调用点至此全景:两表单与向导(模态内,均已抬层)加 `ProvidersSection` 的 `ImageApiKeyRow`(设置页行内,无模态遮罩,保持默认)。

回归验证:`McpServerDialog.test.tsx` 与 `CustomProviderDialogAccessibility.test.tsx` 各加一例,悬停触发后断言可见 tooltip 层经 tailwind-merge 后含 `z-[10001]`(Radix Tooltip 1.2 的 `role="tooltip"` 挂在 Content 内 sr-only 副本上,可见层取其父节点)。两文件 36 项全部通过;向导两处为同一机制的 prop 字面量传参,未另建组件级测试。本轮 jsdom 断言不替代实机目检,Light/Dark 实机双模式仍属上方待项范围,未新增验证。

## 代表原图的附件交接

四张代表原图 `ds6-provider-edit-light.png`、`ds6-provider-error-dark.png`、`ds6-mcp-new-light.png`、`ds6-mcp-edit-dark.png` 均来自上述 macOS 独立沙箱的真实设置路由，使用虚构数据和 renderer 服务替身；不是静态效果稿，不替代用户在测试版的手动审核。采集代码已保全为 `6d4af6733a`，本轮 main 合并未改变这两张表单的源码。

按治理合同 §6，所有栅格证据只在仓外附件包保管，本 PR 不新增图片入仓。DS-6 全部 55 张与 DS-4/4b 历史 14 张仍待公开交接，不能称已公开。原图与分类、摘要完整保留于 `DS6-公开附件交接-未上传.zip` 和 `DS4-DS4b-历史附件-待公开.zip`；负责人 kirozeng，复查 2026-09-10 或 DS-7 开始前，以较早者为准。上传后将实际 PR 评论的稳定链接回写此处。
