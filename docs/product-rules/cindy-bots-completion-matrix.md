# Cindy Bots 工程完成矩阵

> 状态：Draft 工程验收正本。它把《Cindy 伙伴运行时》契约的终点线映射到当前实现和自动
> 验证。真实委派、真实完成信号与双端视觉目检仍必须由 Chris 在场完成；在这些验收通过前
> 不得把 Draft 转为 Ready。

北极星用例：创建一个伙伴，日常对话中它用自己的记忆与技能直接帮忙；遇到大活时它用
`start_task` 开一条真正的 Cindy 任务（或用 `delegate` 找另一个伙伴），发起方对话里的
协作卡实时走到完成态，完成信号以用户不可见的内部指令叫醒它接手收尾。

## 产品完成线

| 能力 | 生产实现 | 自动证据 | 当前结论 |
|---|---|---|---|
| Profile、SOUL、USER context | `botProfileVersioning.ts`、`botProfileRuntime.ts`、`botProfileFolder.ts` | `botProfileVersioning.test.ts`、`botProfileRuntime.test.ts`、`botProfileFolder.test.ts` | Profile 版本化；身份源和用户上下文分槽；运行任务固定使用已选版本；档案摊成 Home 文件并对账派生新版本。 |
| 三 Harness runtime 注入 | Claude、Codex、Pi 的 Bot runtime 接线 | `bot-profile-prompt.test.ts`、`capability-routing.test.ts`、`bot-skill-policy.test.ts` | 三种 Harness 消费同一份 Bot runtime snapshot，不由 UI 拼 prompt。 |
| 上下文隔离 | pi `--no-context-files` + subagent 扩展对 Bot 关闭；codex `project_doc_max_bytes=0`；cc `settingSources: []` | `pi-auto-review-dispatch.test.ts` 的 Bot 隔离用例、`bot-runtime-policy.test.ts` | Bot 会话没有项目/全局 AGENTS.md、没有 harness 原生 subagent 面、没有 Cindy 产品提示词。 |
| Skills、MCP、Toolset、Memory | `botProfileRuntime.ts` 与 maker-core 原生能力策略 | `botCanonicalSession.test.ts` 资源冻结用例、`bot-runtime-policy.test.ts` | 能力必须来自真实 catalog；显式挂载 docs 工具集时 `cindy_docs` 进入 allowlist，提示词与工具面同进同退。 |
| canonical、历史、Renew、恢复 | `localDb/ipc/bots.ts`、`botRenewalService.ts`、`botLifecycleService.ts` | `botCanonicalSession.test.ts`、`botRenewalService.test.ts`、`botLifecycleService.test.ts` | 每日换卷 CAS；历史只读；删除后建新任务而不复活旧记录。 |
| 模型候选链 | `bot-model-chain-settings-store.ts`、register.ts 的 fallback 路由 | `botModelChainSettingsStore.test.ts`、`botModelChain.test.ts` | 1–5 项有序候选；只有候选不可用错误才推进；不暗改 Profile。 |
| Bot×Bot 委派 | `botDelegationService.ts`、`bot_delegation.ts` | `botCanonicalSession.test.ts` 委派用例、`botDelegationCapabilityTarget.test.ts` | 子 Bot 使用自己的 Profile 和 Home workspace；深度/循环/并发受限；结果回到发起方。 |
| Bot×Session 委派（start_task） | `botDelegationService.delegateToCindy`、`collaborate_with_bot` | delegation 测试的 null-target 用例 | 大活开成普通 Cindy 任务，出现在主任务列表、走自己的权限门；同卡同信号。 |
| 协作卡与完成信号 | `BotCollaborationCard.tsx`、`botDelegationLive.ts`、`deliverCompletion` | `BotCollaborationCard.test.tsx`、delegation 完成用例 | 卡片实时到终态；完成信号是 synthetic-trigger 隐藏行，用户不可见；父卷换代后投当前卷，不静默丢失。 |
| 自有技能学习 | `botSkillStore.ts`、`botSkillService.ts`、`save_bot_skill` | `botSkillStore.test.ts`、`botSkillService.test.ts`、`bot-own-skills-mount.test.ts` | 沉淀真技能、下会话挂载、设置页可见可删。 |
| Desktop UI | `renderer/features/bots/**` | renderer store 与视图测试、typecheck | 名册、聊天、最小设置（成长/模型/维护）；无工程概念暴露。 |

## 并发与故障矩阵

| 事件 | 约束后的行为 | 证据入口 |
|---|---|---|
| 重复创建 / Renew | 数据库唯一约束 + CAS 只允许一个 winner。 | `botTx.test.ts`、`botCanonicalSession.test.ts` |
| 重复委派 / 循环 | lineage、最大深度与并发数约束；数据库事务再次检查并发上限。 | `botCanonicalSession.test.ts` |
| 用户取消 / 父任务关闭 | 当前委派及后代进入明确终态并中止活动回合；历史任务保持可读。 | `botCanonicalSession.test.ts`、`botLifecycleService.test.ts` |
| 超时 | 委派持久保存 deadline；重启恢复先判超时，再决定是否继续。 | `botCanonicalSession.test.ts` |
| Host 崩溃 / 重启 | runtime、delegation 从数据库恢复，不信进程内 Map。 | recovery 系列测试 |
| 父卷被每日换卷替换 | 完成信号改投该伙伴当前 canonical 卷；卡片终态始终可见。 | delegation 完成用例 |
| 跨窗口操作 | main/数据库拥有状态；renderer 只订阅广播。 | `botCanonicalSession.test.ts` |

## 仍需 Chris 在场的真实验收

1. 创建伙伴并日常对话一轮，确认上下文里没有项目 AGENTS.md、没有 subagent 工具。
2. 让伙伴真实调用 `collaborate_with_bot(action=delegate)`，确认协作卡实时更新、完成后
   发起方自动接手、时间线里没有机读回执。
3. 让伙伴真实调用 `start_task`，确认子任务出现在主任务列表、权限门照常工作、结果回传。
4. 给伙伴挂载 docs 工具集，确认它能真的做出文档（而不是回答“做不了”）。
5. Desktop 在 Light/Dark 下目检创建、列表、聊天、设置、历史、错误和空态。

真实验收前保持 Draft；任何一项失败都回到对应矩阵行修复，不用 UI 绕过数据或运行时约束。
