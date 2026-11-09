# MIGRATION_PLAN — 落地与后续

> 状态:修复分支 `fix/subagent-model-execution-policy` 已就绪,待评审。
> 本计划不重启 Cindy、不改任何现有 API Key、不改六个在运行项目。

## 本次(已实现)

1. 执行策略核心 `model-execution-policy.ts` + 41 个单测(含 2026-11-07 事故复现场景、P0-A local-only 硬隔离、P0-B 伪造签名攻击、P1 各项)。
2. pi `subagent` 两道闸(扩展派发前 + runner spawn 前),失败关闭。
3. Orca `create_worker` 执行层同口径拒绝(`MODEL_EXECUTION_DENIED`),P0-3 fail-closed。
4. 审计三列落库(drizzle 迁移 `0149_subagent_model_execution_audit.sql`)。
5. Host 快照装配(Ed25519 签名;私钥只存 safeStorage 密文/内存,公钥以 env 字面量注入)+ 用户审批存储 + 执行模式设置(默认 development)+ 费用记账 v3(结算累计 + 在途预留 + TTL + 原子裁决)。
6. 并发预算原子裁决(P0-2):读账本→算剩余额度→预留→持久化在同一把锁内;预留失败/账本损坏/锁超时/持久化失败一律拒绝付费 spawn(不静默清零)。

## 第二阶段(后续,需产品决策)

- [x] 本轮 Phase A(已实现,待 CI 与独立复核):
      - P0-0 Host/Runner 账本读错严格化(ENOENT 仅可建新账,EACCES/ENOTDIR/EIO/损坏失败关闭,结算不可读不写入);
      - Claude Task/Agent 逐调用 Host 授权叠加(可用性保留,跨模型硬拒,固定执行保留);
      - Codex `expose_spawn_agent_model_overrides: false` 默认固定继承(动态跨模型禁用);
      - `trusted-lan` 三级分级(显式登记 Provider+Endpoint+模型,缺省空表,local-only 仍拒);
      - Host `parseModelExecutionPolicy` 缺失 import 补上(原 HEAD 构建即 fail-closed 全拒,已修)。
- [ ] 设置 UI:模式选择(local-only / development / approved-paid)+ trustedLan 登记/撤销入口
      + approvals 创建/撤销入口(目前只有 JSON 存储与内部读写)。
- [ ] Claude `subagent_type` frontmatter 声明模型的逐次核验:当前仅显式 `model` 参数在 hook 覆盖;
      frontmatter 路径为 BLOCKED 残留,本轮演示与发布文档不得宣称严格隔离。
- [ ] fallback/alias 显式回归:provider 轮换、模型别名、跨设备同名 provider
      的端到端测试(mock provider 断言无网络请求)。
- [ ] 真实 macOS 签名构建 safeStorage Keychain ACL 验证:当前仅 mock 覆盖,BLOCKED(见下方)。
- [ ] 上游 Actions 审批后合入 main 的 CI 全绿;Release Gate 通过前不得合并/部署。

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
| 伪造签名:Agent 自签 Ed25519 快照 | verifier 拒(公钥不匹配),无放行 |
| local-only + 合法 paid approval | 仍拒(approval 不能覆盖 local-only) |
| signing-key 文件被同 UID 读出 | 只有 safeStorage 密文,无可用私钥 |
| 攻击者在 env 中替换公钥 + 自签策略 | 验签失败 → 拒绝派发(自签永不通过) |
| pricedRow 存在但 amount=0 | 走参考估算路径记账(不再漏) |
| 两个 Worker 竞争最后一笔额度 | 第二个预留拒(锁内裁决),总预留不穿透 cap |
| 账本损坏(非空 JSON)/首个付费任务账本缺失 | 损坏拒(不覆盖);缺失视为可建新账并预留 |
| 账本读错 EACCES / ENOTDIR / EIO | Host+Runner 均拒放行,结算不写入,账本字节不变 |
| Claude 跨模型未在 allow-list(即使目录已列出) | Host 授权硬拒,固定模型不受影响 |
| Codex `spawn_agent` 带 model override | flag 关 → 子 thread 继承父模型,无跨模型执行 |
| Trusted LAN 未登记 endpoint 模型 | 按 paid(或 deny)处理,不当 local 放行 |
| Trusted LAN 已登记 + local-only | 仍拒(trusted-lan 非 local) |
| 崩溃遗留的过期预留 | TTL 读清(SW<=10min),新预留不被堵死 |
| Orca `create_worker` 显式指定未授权路由 | Host 侧 `MODEL_EXECUTION_DENIED`,不建会话 |

## 发布建议

1. Draft PR → 独立安全评审(建议含 Host 快照装配 review)。
2. 评审通过后再排期随下个桌面版本发布;不单独部署。
3. 发布后观察 `policy-denials.jsonl` 与 `subagent_runs.authorization_decision`
   审计列,确认无误拒后再考虑开放 mode 设置 UI。
