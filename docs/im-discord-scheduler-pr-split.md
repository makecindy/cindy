# Discord 单 ingress PR 拆分计划

> 状态：执行计划（2026-08-07）
>
> 原始 PR：[#1861](https://github.com/makecindy/cindy/pull/1861)
>
> 原始需求：[#187](https://github.com/makecindy/cindy/issues/187)

## 为什么拆分

PR #1861 已经累积了大量 review 轮次和增量修复，导致调度基础、Discord Gateway 接入、
交接排空和离线补偿无法在一个 diff 中被整体复核。本计划把已有结论按依赖顺序拆成小 PR，
不重新设计产品行为，也不把跨 Cindy 账号的唯一绑定带入客户端。

拆分的硬边界：

- 只处理同一 Cindy 账号、多台 Desktop 的 Discord 个人 Bot 单 ingress。
- 不修改 Telegram、飞书、钉钉、企业微信、个人微信等其他 IM 的调度行为。
- 不修改服务端，不实现跨 Cindy 账号 registry/CAS；#187 的跨账号唯一绑定另行处理。
- 不修改用户本地已有的 `cindy-protocol` submodule 工作区改动。
- 从最新 `origin/main` 新建分支；不携带原 PR 的 37 个历史提交。
- PR-A 合入前不创建或推进 PR-B；PR-C 只有在补偿消费侧能够干净解耦时才创建。

## PR-A：调度基础层（先合）

建议标题：`feat(desktop): add dormant Discord ingress scheduler foundation`

目标：新增可测试的调度基础设施，但不启动任何 IM、不创建 Discord Gateway、不改变现有运行
行为。调度器依赖本地 `SchedulerTransport` 抽象，Discord 适配留给 PR-B。

### 文件边界

保留或新增：

- `apps/desktop/src/main/im/scheduler/transport.ts`
- `apps/desktop/src/main/im/scheduler/protocol.ts`
- `apps/desktop/src/main/im/scheduler/state.ts`
- `apps/desktop/src/main/im/scheduler/deviceSnapshot.ts`
- `apps/desktop/src/main/im/scheduler/runtimeGaps.ts`
- `apps/desktop/src/main/im/scheduler/manager.ts`
- `apps/desktop/src/main/im/scheduler/__tests__/protocol.test.ts`
- `apps/desktop/src/main/im/scheduler/__tests__/state.test.ts`
- `apps/desktop/src/main/im/scheduler/__tests__/deviceSnapshot.test.ts`
- `apps/desktop/src/main/im/scheduler/__tests__/runtimeGaps.test.ts`
- `apps/desktop/src/main/im/scheduler/__tests__/manager.test.ts`

Device Link 的具体 host/client 接线全部延后到 PR-B。PR-A 只在
`scheduler/transport.ts` 定义适配接口和事件形状，不修改现有 Device Link host、client 或 wire
协议；这样 PR-A 可以在不启动任何 IM 的前提下独立审查和测试。

### PR-A 必须覆盖的状态不变量

- relay 不在线、ownership 不成立、self Desktop 不在权威快照中时 fail-closed。
- peer presence 必须有当前 discovery round 的确认，不能把空视图当作完整视图。
- discovery probe 使用 nonce 绑定的有界 retry/refresh；完成、停止、重置或快照世代变化时取消旧轮。
- 选主必须是确定性的，同一 `(channel, non-secret identity)` 同一时刻最多一个赢家。
- 所有选主、快照和 gap 裁剪排序使用 locale-independent comparator；设备成员变化、时钟回拨、账号切换会使旧 discovery/runtime 视图失效。
- 只有当前权威 Desktop 快照中的 peer 能参与 probe/advertisement；binding 变化会在下一轮 probe 中传播当前非敏感 identity。
- runtime gap 以 identity 归属、generation 去重并有确定性上限；不携带 token 或 secret。
- PR-A 的 manager 不被任何现有 IM 启动路径调用。

### PR-A 不包含

- `packages/lizi-im/src/discord/**`
- `apps/desktop/src/main/im/index.ts`
- `apps/desktop/src/main/bootstrap-electron.ts`
- `apps/desktop/src/main/im/shared/**`
- `packages/lizi-im/src/channelIM.ts`、全局 `IMStatus` 扩展
- preload、renderer、设置页和 i18n
- 其他 IM provider 文件
- Discord Gateway 生命周期、handoff drain 和 offline notice 消费

## PR-B：Discord Gateway 接入

建议标题：`fix(discord): 避免同一 Cindy 账号的多台 Desktop 同时连接 Bot`

依赖：PR-A 已合入 main。

目标：把 Discord Gateway 接到 PR-A 的 transport adapter，闭合 active/standby、ingress 开关、
reconnecting Client 复用、首次激活失败让位、ownership/relay 失效时立即关 ingress，以及必要的
handoff drain。只修改 Discord provider 和必要的 Desktop 接线。

### 候选文件

- `packages/lizi-im/src/discord/gateway.ts`
- `packages/lizi-im/src/discord/index.ts`
- `packages/lizi-im/src/discord/outbound.ts`
- `packages/lizi-im/src/discord/__tests__/**`
- `apps/desktop/src/main/im/index.ts`
- `apps/desktop/src/main/im/scheduler/manager.ts`（仅接入 PR-A 的 transport，不把其他 IM 纳入调度）
- `apps/desktop/src/main/im/discordQuitOrdering.ts`
- `apps/desktop/src/main/im/__tests__/discordQuitOrdering.test.ts`
- `apps/desktop/src/main/bootstrap-electron.ts`（仅保留 Discord 关闭顺序所需改动）
- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/renderer/components/settings/DiscordBotSection.tsx`
- Discord 设置页相关四语言 i18n 与 renderer 类型镜像

PR-B 不得借机修改公共 IM runner、其他 provider 或服务端。

## PR-C：离线补偿消费侧（可选）

只有在 PR-B 的 active/standby/handoff 可以不依赖它独立成立时才创建。

建议标题：`fix(discord): preserve offline compensation across ingress handoff`

候选文件：

- `apps/desktop/src/main/im/scheduler/runtimeCompensation.ts`
- `apps/desktop/src/main/im/scheduler/__tests__/runtimeCompensation.test.ts`
- manager 中的 clean/dirty runtime 消费、pending clean handoff、predecessor 责任转移
- Discord lifecycle offline marker 与对应测试

PR-C 不包含新的选举协议、不扩大到其他 IM、不做服务端 CAS、不做快照退避或 UI 重构。
如果消费侧无法从 PR-B 清晰解耦，则并入 PR-B 的一个明确小 commit，不再继续增加新的补偿
语义。

## 执行顺序与交付

1. 从最新 `origin/main` 建立 PR-A 分支，先提交本计划文档和基础层代码。
2. PR-A 只在自身范围内运行定向测试、`pnpm test:unit`、受影响 package typecheck、DCO。
3. PR-A review/approve/merge 后，基于合入后的 main 建立 PR-B。
4. PR-B review/approve/merge 后，再判断是否需要 PR-C。
5. 原 PR #1861 在拆分期间保持 OPEN，不继续追加实现。新 PR 创建后再在原 PR 留言附链接；
   PR-A/B 合入后再关闭原 PR，保留历史可追溯性。

## 拆分验收

- 每个新 PR 都只有少量语义化 commit，所有 commit 使用 DCO sign-off。
- PR-A 不触发 IM 行为变化；PR-B 不修改其他 IM；PR-C 不改变选举结论。
- 每个 PR 的正文准确列出“怎么验证的”、风险、回滚方式和不包含范围。
- 任何超出上述边界的 review 建议另开 Issue，不回流当前 PR。
