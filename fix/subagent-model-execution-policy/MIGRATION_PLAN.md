# MIGRATION_PLAN — 落地与后续

> 状态:修复分支 `fix/subagent-model-execution-policy` 已就绪,待评审。
> 本计划不重启 Cindy、不改任何现有 API Key、不改六个在运行项目。

## 本次(已实现)

1. 执行策略核心 `model-execution-policy.ts` + 19 个单测(含 2026-11-07 事故复现场景)。
2. pi `subagent` 两道闸(扩展派发前 + runner spawn 前),失败关闭。
3. Orca `create_worker` 执行层同口径拒绝(`MODEL_EXECUTION_DENIED`)。
4. 审计三列落库(drizzle 迁移 `0149_subagent_model_execution_audit.sql`)。
5. Host 快照装配 + 用户审批存储(写入口暂无 UI,程序内可达)。

## 第二阶段(后续,需产品决策)

- [ ] 设置 UI:模式选择(local-only / development / approved-paid)+ approvals
      创建/撤销入口(目前只有 JSON 存储与内部读写)。
- [ ] Claude Code 原生 subagent 与 Codex `spawn_agent` 纳入同一策略
      (目前只有可用性层 deny,见 SECURITY_DESIGN.md 残留路径)。
- [ ] fallback/alias 显式回归:provider 轮换、模型别名、跨设备同名 provider
      的端到端测试(mock provider 断言无网络请求)。
- [ ] approval 费用上限(`maxCostUsd`)的执行层 enforcement
      (目前仅记录,建议下期与 `daily_model_usage` 对账)。

## 验证矩阵(回归)

| 场景 | 期望 |
|---|---|
| local Qwen 在 allow-list,Agent 请求 OpenRouter 付费模型 | 拒绝,无网络请求 |
| 未被快照列出的 DeepSeek(OpenRouter 已连接、目录已列出) | 拒绝,`is not in this session …` |
| 链上 paid 模型 + development 模式 | 拒绝;approved-paid 或新 approval 后放行 |
| 链上 free 模型 + development 模式 | 放行 |
| free 路由 + local-only 模式 | 拒绝(免费 ≠ 授权) |
| 同名模型 id 经另一个 provider id 申请 | 拒绝(alias/跨设备不作数) |
| 用户说“用其他模型协作”但快照无 approval | 拒绝,无 approvalId |
| Orca `create_worker` 显式指定未授权路由 | Host 侧 `MODEL_EXECUTION_DENIED`,不建会话 |

## 发布建议

1. Draft PR → 独立安全评审(建议含 Host 快照装配 review)。
2. 评审通过后再排期随下个桌面版本发布;不单独部署。
3. 发布后观察 `policy-denials.jsonl` 与 `subagent_runs.authorization_decision`
   审计列,确认无误拒后再考虑开放 mode 设置 UI。
