# Cindy Bots 工程完成矩阵

> 工程验收正本：把《Cindy 伙伴运行时》契约映射到实现、自动验证和真实结果。
> 2026-09-05，Chris 已明确授权 agent 自行启动隔离沙盒调试；该授权适用于本次验收。
> 发布判断依据实际证据，未连接的远程设备和未覆盖的长期运行场景必须明确列出。

北极星用例：创建一个伙伴，日常对话中它用自己的记忆与技能直接帮忙；遇到大活时它用
`start_session_task` 开一条真正的 Cindy 任务；需要与其他伙伴交流时用 `send_to_agent`。
发起方对话里的任务卡实时走到完成态，完成信号以用户不可见的内部指令叫醒它接手收尾。

## 产品完成线

| 能力                           | 生产实现                                                                                                     | 自动证据                                                                                  | 当前结论                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Profile、SOUL、USER context    | `botProfileVersioning.ts`、`botProfileRuntime.ts`、`botProfileFolder.ts`                                     | `botProfileVersioning.test.ts`、`botProfileRuntime.test.ts`、`botProfileFolder.test.ts`   | Profile 版本化；身份源和用户上下文分槽；运行任务固定使用已选版本；档案摊成 Home 文件并对账派生新版本。     |
| 三 Harness runtime 注入        | Claude、Codex、Pi 的 Bot runtime 接线                                                                        | `bot-profile-prompt.test.ts`、`capability-routing.test.ts`、`bot-skill-policy.test.ts`    | 三种 Harness 消费同一份 Bot runtime snapshot，不由 UI 拼 prompt。                                          |
| 上下文隔离                     | pi `--no-context-files` + subagent 扩展对 Bot 关闭；codex `project_doc_max_bytes=0`；cc `settingSources: []` | `pi-auto-review-dispatch.test.ts` 的 Bot 隔离用例、`bot-runtime-policy.test.ts`           | Bot 会话没有项目/全局 AGENTS.md、没有 harness 原生 subagent 面、没有 Cindy 产品提示词。                    |
| Skills、MCP、Toolset、Memory   | `botProfileRuntime.ts` 与 maker-core 原生能力策略                                                            | `botCanonicalSession.test.ts` 资源冻结用例、`bot-runtime-policy.test.ts`                  | 能力必须来自真实 catalog；显式挂载 docs 工具集时 `cindy_docs` 进入 allowlist，提示词与工具面同进同退。     |
| canonical、历史与异常恢复    | `localDb/ipc/bots.ts`、`botCanonicalSessionRegistry.ts`、`botLifecycleService.ts`                                  | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts`                         | 一个伙伴长期沿用同一条主任务；模型上下文原地压缩；只在记录丢失或被删除时恢复替代任务。                       |
| 模型候选链                     | `bot-model-chain-settings-store.ts`、register.ts 的 fallback 路由                                            | `botModelChainSettingsStore.test.ts`、`botModelChain.test.ts`                             | 1–5 项有序候选；只有候选不可用错误才推进；不暗改 Profile。                                                 |
| 伙伴消息（send_to_agent）      | `botDirectMessageService.ts`、`bot_direct_messages`                                                          | `botDirectMessageService.test.ts`、消息流投影用例                                         | 单条异步消息进入双方时间线入口；不建立任务；12 条硬上限、同方连续 2 条上限与冷却共同阻止死循环。           |
| 后台任务（start_session_task） | `botDelegationService.ts`、`lizi_xdtHelperMcpServer.ts`                                                      | `botCanonicalSession.test.ts` 的 Session 任务用例                                         | 大活开成普通 Cindy 任务，出现在主任务列表、走自己的权限门；check/message/stop 控制同一任务。               |
| 任务卡与完成信号               | `BotCollaborationCard.tsx`、`botDelegationLive.ts`、`deliverCompletion`                                      | `BotCollaborationCard.test.tsx`、Session 任务完成与重启补投用例                           | 父时间线只有一张持久任务卡；完成信号是隐藏指令，带持久送达标记、幂等键、退避重试和重启补投。               |
| 统一通知                       | `useSessionRunningStatus.ts`、`sessionEventNotification.ts`、两个任务侧栏                                   | 侧栏与通知入口测试                                                                        | 伙伴页接手统一完成 / 失败 / 待回复观察；沿用全局通道与聚焦去重，通知点击回到伙伴路由。                     |
| 自有技能学习                   | `botSkillStore.ts`、`botSkillService.ts`、`save_bot_skill`                                                   | `botSkillStore.test.ts`、`botSkillService.test.ts`、`bot-own-skills-mount.test.ts`        | 沉淀真技能、下会话挂载、设置页可见可删。                                                                   |
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

## 真实验收范围

1. 创建伙伴并日常对话一轮，确认上下文里没有项目 AGENTS.md、没有 subagent 工具。
2. 让两个伙伴用 `send_to_agent` 往返，确认双方时间线有入口、不触发 NEW 或左栏未读，
   并且达到往来上限后会结束本轮。
3. 让伙伴真实调用 `start_session_task`，确认子任务出现在主任务列表、父时间线只有一张
   持久任务卡、权限门照常工作、结果自动回传；再验证 check/message/stop 控制同一任务。
4. 给伙伴挂载 docs 工具集，确认它能真的做出文档（而不是回答“做不了”）。
5. Desktop 在 Light/Dark 下目检创建、列表、聊天、设置、历史、错误和空态。

任何真实失败都回到对应矩阵行修复，不用 UI 绕过数据或运行时约束。Ready 使用仓库统一发布门禁；不得把未验证场景标为通过。

2026-09-05 隔离沙盒记录：Claude、Codex、Pi 均真实回复并完成后台任务回传；同一任务追加第二轮、主动停止、Pi 提问等待跨重启与回答恢复通过。伙伴私聊双方留痕且自动确认不增加未读。Pi 独立记忆保存、搜索、读回及重启后读取通过；HTML 从消息打开到内嵌预览。Light/Dark 已目检主聊天与任务卡，Light 创建页已目检。远程设备端到端、长周期压缩和完整文档格式生成不在已通过证据中。
