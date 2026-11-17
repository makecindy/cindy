# 插件任务设置的运行位置（2026-11-16）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

手机 `task-settings:get` 与远程 Desktop 的插件偏好快照返回的 `PluginTaskPreferences`（`packages/device-link/src/pluginPages.ts`）追加两项可选字段：`remoteRoutes: true` 表示这台宿主会保存并执行其他电脑或分享来的模型；`config.agentDeviceId` 是已保存的运行位置（同账号电脑 id 或 `share:<id>`；`null` 明确选宿主；缺字段保留历史默认与 errand 复用语义）。位置只随完整模型选择出现，不含连接方式或凭证，不迁移旧配置。写入沿用原 `task-settings:set` 与远程 Desktop `kind:'tasks'` 的 `patch.model`，对象里可选 `agentDeviceId`；字符串指定远程来源，`null` 将显式宿主选择原样保存，供 errand 区分切回本机与历史未选位置。宿主按那台电脑的目录核对，不可用时拒绝写入，不改用本机同名供应商。`model: null` 同时清除整个模型选择与位置。

旧端组合：新控制端只在读到 `remoteRoutes: true` 时列出远程来源并发送 `agentDeviceId`（选宿主时为 `null`），读不到时按旧行为只列宿主自己的模型（`remote` 为 undefined），不发送该字段。旧宿主不认该字段，即使收到也按原校验拒绝未知键，不会丢掉位置后按本机执行。旧 Desktop 控制端修改权限也会整组回传模型：省略位置、且 agentKind/providerId/model 三者与现存远程配置相同时，新宿主保留该位置，调优参数仍可更新；不会把权限修改当作切回本机。旧端选择不同模型组合仍按本机解析。`model:null` 可恢复默认；明确切到本机同名模型须用新控制端的 `agentDeviceId:null`，旧端的同名回传无法与权限编辑区分。不新增 channel、relay 帧或 allowlist 项，自建中转无需适配。实现与回归见 `mobileTaskSettings.ts`、`remotePluginPreferences.ts`、`PluginTaskPrefs.tsx`、`PluginTaskSettings.tsx` 与 `mobileTaskSettings.test.ts`。
