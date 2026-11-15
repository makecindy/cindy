# 伙伴设置动作 `management:settings`（Remote Resource，2026-10-22）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

桌面控制另一台电脑上的伙伴时，设置页的读写经现有 `maker:remote-resources:invoke`，不新增 device-link 通道，也不改 allowlist。契约正本是
`apps/desktop/src/shared/botRemoteSettings.ts`，字段只追加：

2026-11-03 修正主模型远程来源的保存：`profile.update` / `profile.acceptModelSelection`
接收可选的 `capabilities.agentDeviceId`（合法位置字符串或 null），与模型链首项镜像一致；
回到本机或恢复本机默认时明确清空，备用项保留各自位置。此字段不授予远程执行权限，
保存仍经原有模型路由校验；同账号授权、伙伴可见性及 `permissions` 拒绝规则不变。
旧控制端的请求继续有效；新控制端在提交完整模型链时省去顶层派生位置字段，链内各项的
位置原样保留，因此旧主机的严格白名单也能接收切换远程来源、切回本机和恢复默认的请求。
新主机从模型链生成或清空自己的位置镜像；不可丢弃链内位置而把远程选择改成本机来源。
只有未更新的控制端仍发送顶层字段时，才需更新伙伴所在电脑以接收该字段。
无新帧、通道或 relay 行为，官方与自建中转无需适配。
回归见 `remoteBotSettingsTarget.test.ts`（旧主机字段边界）、`botRemoteSettingsHost.test.ts`、
`botSettings.test.tsx` 与 `botModelChain.test.ts`。

- **声明**：主机在 `teammates` 集合描述里增加集合动作 `{ id: "management:settings" }`（手机只检查 `open-create`，不显示该动作）。
- **请求**：`collectionId: "teammates"`、`actionId: "management:settings"`、`input: { v: 1, op, args? }`；需要伙伴的操作带
  `resourceRef: { collectionId: "teammates", kind: "bot", id }`，主机级操作（`caps`、`models.default`、`autonomy.*`、`routines.sources`、
  `voice.models`、`voice.voices`、`channels.im.listAdoptable`）不带。`input` 受 64 KiB 上限约束，控制端把超长文本补丁拆成多次请求。
- **响应**：`{ effects: [], result: { ok: true, value } | { ok: false, code, message } }`。失败以数据返回（`PRECONDITION_FAILED`、
  `INVALID_PARAMS`、`NOT_FOUND`、`ALREADY_EXISTS`、`UNSUPPORTED_CAPABILITY`），因为注册表适配层会把其它异常折叠成泛化 `INTERNAL`，
  会让页面看不到 revision 冲突；`message` 去掉 `[CODE] ` 前缀，非白名单异常仍抛 `INTERNAL`，不带原文。
- **能力协商**：`caps` 返回 `{ version, ops[] }`；控制端按操作决定显示哪些页（缺操作的页不出现），主机没有声明动作时整页回退到
  通用表单页。新增操作只追加到 `BOT_SETTINGS_OPS`，旧控制端不识别的操作不会被调用。
  2026-11-08 起 `autonomy.*` 与 `routines.*` 不再列入 `caps`，仅为旧控制端稳定应答（见[「伙伴 V1 其余远程入口退役」](teammate-v1-remote-entry-retirement.md)）。
- **安全边界**：主机检查「允许同账号设备控制本机」、撤权、共享任务 / 供应商分享对端与伙伴可见性，并在返回前复核账号 owner；
  凭证、本机路径、运行时快照、最近消息预览不出现在任何结果里；`profile.update` 白名单字段且拒绝 `permissions`；消息平台操作只触达该伙伴自己的连接。
