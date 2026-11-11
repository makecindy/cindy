# Cindy Bots 工程完成矩阵

> 工程验收正本：把《Cindy 伙伴运行时》契约映射到实现、自动验证和真实结果。
> 2026-09-05，Chris 已明确授权 agent 自行启动隔离沙盒调试；该授权适用于本次验收。
> 发布判断依据实际证据，未连接的远程设备和未覆盖的长期运行场景必须明确列出。

北极星用例：创建一个伙伴，日常对话中它用自己的记忆与技能直接帮忙；遇到大活时它用
`send_to_session` 新建一条普通 Cindy 任务（V1 专用后台任务已于 2026-11-08 移除，见
[伙伴运行时](cindy-bots-runtime.md) §6.1）；需要与其他伙伴交流时用 `list_agents` 拿到对方主对话的
`session_id`，再用 `send_to_session` 发消息（`send_to_agent` 已于 2026-11-08 移除）。
需要结果时在消息里请对方做完用 `send_to_session` 发回，回来的是带来源标签的普通消息（2026-11-09 起宿主不再代为回传）。

## 产品完成线

| 能力                           | 生产实现                                                                                                     | 自动证据                                                                                  | 当前结论                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Profile、SOUL、USER context    | `botProfileVersioning.ts`、`botProfileRuntime.ts`、`botProfileFolder.ts`                                     | `botProfileVersioning.test.ts`、`botProfileRuntime.test.ts`、`botProfileFolder.test.ts`   | Profile 版本化；身份源和用户上下文分槽；运行任务固定使用已选版本；档案摊成 Home 文件并对账派生新版本。     |
| 三 Harness runtime 注入        | Claude、Codex、Pi 的 Bot runtime 接线                                                                        | `bot-profile-prompt.test.ts`、`capability-routing.test.ts`、`bot-skill-policy.test.ts`    | 三种 Harness 消费同一份 Bot runtime snapshot，不由 UI 拼 prompt。                                          |
| 上下文隔离                     | pi `--no-context-files` + subagent 扩展对 Bot 关闭；codex `project_doc_max_bytes=0`；cc `settingSources: []` | `pi-auto-review-dispatch.test.ts` 的 Bot 隔离用例、`bot-runtime-policy.test.ts`           | Bot 会话没有项目/全局 AGENTS.md、没有 harness 原生 subagent 面、没有 Cindy 产品提示词。V2（2026-11-08）：主人在伙伴项目里的对话按普通项目任务加载该项目的说明文件、技能、MCP 与宿主提示词，只多一层伙伴身份；IM 与群专线保持原隔离。 |
| Skills、MCP、Toolset、Memory   | `botProfileRuntime.ts` 与 maker-core 原生能力策略                                                            | `botCanonicalSession.test.ts` 资源冻结用例、`bot-runtime-policy.test.ts`                  | 能力必须来自真实 catalog；显式挂载 docs 工具集时 `cindy_docs` 进入 allowlist，提示词与工具面同进同退。     |
| canonical、历史与异常恢复    | `localDb/ipc/bots.ts`、`botCanonicalSessionRegistry.ts`、`botLifecycleService.ts`                                  | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts`                         | 一个伙伴长期沿用同一条主任务；模型上下文原地压缩；只在记录丢失或被删除时恢复替代任务。                       |
| 模型候选链                     | `bot-model-chain-settings-store.ts`、register.ts 的 fallback 路由                                            | `botModelChainSettingsStore.test.ts`、`botModelChain.test.ts`                             | 1–5 项有序候选；只有候选不可用错误才推进；不暗改 Profile。                                                 |
| 旧伙伴私信（只读）             | `botDirectMessageService.ts`、`bot_direct_messages`                                                          | `botDirectMessageService.test.ts`、消息流投影用例                                         | `send_to_agent` / `check_agent_message` 已于 2026-11-08 移除；旧往来只读可查，旧电脑再发来返回 `UNSUPPORTED_CAPABILITY`。 |
| 开任务（send_to_session）       | `mcp-providers.ts` 的 `sendToSession`、`botTaskCreation.ts`；旧委派只读 `botDelegationHistory.ts` | `botTaskCreationResponsibility.test.ts`、`botCanonicalSession.test.ts` 的旧后台任务只读用例 | 旧任务卡、产出与「由谁开的」只读保留 |
| 旧任务卡（只读）               | `BotCollaborationCard.tsx`、`botDelegationHistory.ts`（renderer）                                            | `BotCollaborationCard.test.tsx`                                                           | 不再有停止、补一句与完成唤醒 |
| 统一通知                       | `useSessionRunningStatus.ts`、`sessionEventNotification.ts`、两个任务侧栏                                   | 侧栏与通知入口测试                                                                        | 任务侧栏是唯一观察者（伙伴路由共用该侧栏，正在看的伙伴会话视为注视中）；沿用全局通道与聚焦去重，通知点击回到伙伴路由。                     |
| 自有技能学习                   | `botSkillStore.ts`、`botSkillService.ts`、`save_teammate_skill`                                                   | `botSkillStore.test.ts`、`botSkillService.test.ts`、`bot-own-skills-mount.test.ts`        | 沉淀真技能、同一聊天安全轮次加载、设置页可见可删。                                                                   |
| Desktop UI                     | `renderer/features/bots/**`                                                                                  | renderer store 与视图测试、typecheck                                                      | 名册、聊天、最小设置（成长/模型/维护）；无工程概念暴露。                                                   |

## 并发与故障矩阵

| 事件                  | 约束后的行为                                                            | 证据入口                                                         |
| --------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 重复创建 / 异常恢复   | 数据库唯一约束 + CAS 只允许一个 winner；健康主任务不会被替换。        | `botTx.test.ts`、`botCanonicalSession.test.ts`                   |
| 重复启动 / 消息循环   | 后台任务受并发事务限制；伙伴消息受每轮 12 条、同方连续 2 条与冷却限制。 | `botCanonicalSession.test.ts`、`botDirectMessageService.test.ts` |
| 用户取消 / 父任务关闭 | 后台任务进入明确终态并中止活动回合；历史任务保持可读。                  | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts`     |
| 超时                  | 后台任务持久保存 deadline；等待用户的墙钟时间补回期限。                 | `botCanonicalSession.test.ts`                                    |
| Host 崩溃 / 重启      | 活动任务、等待摘要和未送达完成信号从数据库恢复；运行句柄重新建立。      | recovery 系列测试                                                |
| 父任务记录丢失并恢复  | 活动子任务改绑当前主任务并补卡片锚点；完成信号改投当前主任务。          | canonical 恢复与后台任务完成用例                                 |
| 跨窗口操作            | main/数据库拥有状态；renderer 只订阅广播。                              | `botCanonicalSession.test.ts`                                    |

（2026-11-08 起 V2 不再适用：表中后台任务的并发、取消、deadline、完成信号补投与改绑，以及伙伴消息的条数上限，随委派与 `send_to_agent` 移除；伙伴开的任务是普通任务，按普通任务的队列与恢复规则处理。）

## 真实验收范围

1. 创建伙伴并日常对话一轮，确认主对话加载的是伙伴项目自己的 `AGENTS.md`、记忆与技能（V2），没有其它项目或全局的 AGENTS.md。
2. 让一个伙伴用 `list_agents` 找到另一个伙伴的主对话，用 `send_to_session` 发消息并请它回复，
   确认对方在自己的主对话处理、用 `send_to_session` 发回答复；旧私信往来只读可见。
3. 让伙伴用 `send_to_session` 新建任务并请它做完回传，确认任务出现在主任务列表、
   带「由这位伙伴开的」标记、权限门照常工作、结果由任务自己发回；旧后台任务卡只读可见。
4. 给伙伴挂载 docs 工具集，确认它能真的做出文档（而不是回答“做不了”）。
5. Desktop 在 Light/Dark 下目检创建、列表、聊天、设置、历史、错误和空态。

任何真实失败都回到对应矩阵行修复，不用 UI 绕过数据或运行时约束。Ready 使用仓库统一发布门禁；不得把未验证场景标为通过。

2026-09-05 隔离沙盒记录：Claude、Codex、Pi 均真实回复并完成后台任务回传；同一任务追加第二轮、主动停止、Pi 提问等待跨重启与回答恢复通过。伙伴私聊双方留痕且自动确认不增加未读。Pi 独立记忆保存、搜索、读回及重启后读取通过；HTML 从消息打开到内嵌预览、SVG 图片加载、Word 工具生成并解包核对正文均通过。Light/Dark 已目检主聊天与任务卡，Light 创建页已目检。远程设备端到端、长周期压缩和完整文档格式生成不在已通过证据中。


## 2026-09-06 手机与另一台电脑的补齐范围

- 多设备名册：来源电脑与伙伴身份共同定位；保存账号隔离的名册缓存，冷启动先显示加载中，首轮权威同步完成后再显示最新名册；relay 启动等待超时则回退到缓存并显示可重试的错误；已完成首轮同步后断线才按缓存展示。单个来源失败只影响该来源，重新连接后重新读取，旧请求不能覆盖停连或换账号后的状态。
- 后台任务（2026-11-08 起只读：停止随委派移除）：手机与另一台 Desktop 均可从伙伴时间线读取任务状态、打开来源电脑的子任务、停止任务；状态推送沿父任务订阅回流。远端只得到任务卡所需字段，不输出数据库行或冻结的权限配置。
- 伙伴私聊：两端从原消息入口打开来源电脑的只读私聊，收到更新或重连时刷新；不会以控制端本机的同名伙伴替换远端身份。
- 手机呈现：解析与 Desktop 共用的持久任务/私聊标记，显示预设和托管图片头像，恢复成果文件入口与运行模型展示。主任务记录发生恢复替换时，聚焦/重连/资源更新重新解析伙伴身份。
- 未读：控制端各自保存已读位置，使用来源电脑的最后可见回复时间，避免电脑时钟差异；用户发送、内部私聊、回撤和清除边界不会伪造新回复。
- 身份创建、Profile 设置与长期技能维护仍由托管电脑负责；没有新增自主跨电脑调度，也没有让手机成为被控主机。

自动证据：`remoteBots.test.tsx`、`remoteBotSession.test.tsx`、`BotCollaborationCard.test.tsx`、`BotDirectMessageView.test.tsx`、手机 `CompanionMessageCard.test.tsx` / `remoteResourceCache.test.ts` / `messageNormalize.test.ts`、`botCanonicalSession.test.ts` 与 device-link topic/allowlist 用例。
本批未启动 Desktop DEV、Mobile DEV 或 Metro；未把模拟传输的集成测试称为两台安装版联网或 iPhone Light/Dark 实机通过。发布时仍需先合入 Desktop 依赖，再交付包含对应通道的电脑与手机版本。
