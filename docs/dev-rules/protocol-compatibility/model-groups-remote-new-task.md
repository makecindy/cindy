# 模型组：在另一台电脑上开的新任务（2026-11-16）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

产品规则见 [`model-groups.md`](../../product-rules/model-groups.md) §3.2。同账号电脑 C 在被控电脑 H 上开新任务时，
用 H 自己的模式：H 选路、H 提交，C 只显示与传递模式 id。

- **新 channel `model-groups:remote`**（`packages/device-link/src/modelGroups.ts`），登记在同账号 invoke allowlist；
  Desktop `dispatch.ts` 拦截，非同账号调用方（供应商分享受邀者、共享任务访客）回 `CHANNEL_NOT_ALLOWED`。
  请求与回包结构在 `apps/desktop/src/shared/modelGroupsRemote.ts`，两端都是 Desktop。
  - `{ action: 'list' }` → `{ config }`：H 当前账号的 `model-groups.json` 内容（只有用户建的路线，不含额度与凭证）。
  - `{ action: 'resolve', selection, context?: { hasImages: true } }` → 与本机 `model-groups:resolve` 同一结果结构，
    带 H 发出的 `decisionId`。H 不接受 `dryRun` 与运行位置限定（多余字段丢弃），每次都是真正的选路；路线里的
    `agentDeviceId` 是 H 视角的运行位置（省略 = H 自己），C 原样放进 `maker:create-session` 的 `agentDeviceId`。
  - `{ action: 'commit', decisionId, note? }` → `{ committed }`：只有 H 自己发出、未过期（1 小时）、同账号的凭据才提交；
    `note` 为 `{ sessionId, pluginName, outcome: 'routed'|'kept', modelName, effort?, reason?, why?: 'unavailable-route' }`，
    名称 ≤ 200、原因 ≤ 600、推理强度 ≤ 32、任务 id ≤ 256 个 UTF-16 单元。凭据有效时 H 把它写成该任务第一条用户消息后的
    `agentMeta.pluginModelRoute`（`source: 'model-group'`，与本机写的同一结构）；任务不在 H 上时不写。
  - 结构不对：H 回 `[INVALID_PARAMS] invalid model group request`；其它异常统一 `[INTERNAL] model group request failed`，
    不带出路径或请求内容。C 收到结构不对的回包按读不到处理，不当成「没有模式」。
- **读取次数与时限**：进入 H 的草稿时 `list` 一次；之后每次打开模型选择器、H 重新上线（重连代次）、这次没读到而发送被挡下时
  各再 `list` 一次（旧端不支持或上一次还在读时不发），不轮询；`resolve` 只在发送那一刻一次，
  `commit` 在任务建成交出后一次。均用默认 30 秒 invoke 时限，不进断线重放集合（`resolve` 会登记凭据，`commit` 推进「轮流」）。
- **旧端**：旧 H 的 allowlist 没有这个 channel，隧道回 `DEVICE_LINK_CHANNEL_NOT_ALLOWED`，C 不显示「模型组」，
  不改用 C 的模式；旧 C 不发这个请求，H 不受影响。不需要能力协商字段。
- **自建中转**：只是 `ipc-invoke` 里多一个 channel 名，官方与自建 relay 都按原有通用 invoke 帧透传，不解析 channel、
  没有新帧类型或顶层字段，因此无需修改或升级 `packages/device-link-relay`。allowlist 由两端 Desktop 各自校验。

回归：`packages/device-link/src/__tests__/remoteAgent.test.ts`（allowlist、不重放）、
`apps/desktop/src/main/device-link/__tests__/providerShareDispatch.test.ts`（只放行同账号、错误不外泄）、
`apps/desktop/src/main/model-groups/__tests__/remoteHandler.test.ts`（真实选路实例经协议往返、凭据、结构校验）、
`apps/desktop/src/renderer/features/model-groups/__tests__/remoteModelGroups.test.tsx`（旧端隐藏、暂时读不到、提交）。
