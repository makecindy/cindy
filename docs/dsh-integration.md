# DSH 集成沉淀：DeepSeek Harness 来源链路

更新日期：2026-08-18
状态：task #3 实现完成（Settings 配置入口沿用内置 API-key 体系）；task #4 验证中，见本文末尾「当前卡点与待办」。

## 背景与目标

用户选择 DSH 基底后模型无法选择、来源栏为空。根因：DSH 是内置 agent，固定直连 DeepSeek
官方 runtime（`https://api.deepseek.com`，openai-chat 协议），会话启动要求本机已配置
DeepSeek API Key（`providerSecretStore.get('deepseek')` → 存储键 `provider_key_deepseek`），
但此前模型选择器与来源判定都没有 DSH/DeepSeek 分支，且 Settings 没有对应配置入口。

目标：配置 DeepSeek API Key 后，DSH 出现在来源栏、`deepseek-v4-flash`/`deepseek-v4-pro` 可选，
且能正确发送消息。不改变 DSH 固定单模型设计，不把 DSH 并入通用 custom-provider 表单。

## 已落地改动

### 1. model-providers 内置 DeepSeek 供应商（packages/model-providers/src/builtin.ts）

新增 `DEEPSEEK_PROVIDER`：
- `id: 'deepseek'`，`source: 'builtin'`，`agents: ['dsh']`；
- `auth.method: 'apiKey'`，`access.kind: 'api'`；
- `routing.dsh = { upstream: 'https://api.deepseek.com', wireProtocol: 'openai-chat', authStrategy: 'api-key-header' }`；
- `models.dsh`：`deepseek-v4-flash`（contextWindow 1M，`newSessionDefault: ['dsh']`，efforts 空）、
  `deepseek-v4-pro`（contextWindow 1M，efforts 空）。DSH 不支持档位切换，defaultEffort 为 null。

追加到 `BUILTIN_PROVIDERS` 末尾（顺序契约：gemini/deepseek 只可追加在 xd 之后，勿插入中间）。

### 2. 内置 API-key 白名单（apps/desktop/src/main/secrets/builtinApiKeyBridge.ts）

`BUILTIN_API_KEY_PROVIDER_IDS` 追加 `'deepseek'`，使 renderer 可经 `builtinApiKey*` 专用 IPC 读写该密钥。

### 3. provider 连接态判定（apps/desktop/src/main/maker-host/createDesktopProviderService.ts）

`builtinApiKeyConnected` 三级判定：`gemini` → `deepseek`（`Boolean(providerSecretStore.get('deepseek')?.trim())`）→ 其余 false。

### 4. 密钥存储登记（apps/desktop/src/shared/providerSecrets.ts，此前已含）

`ProviderSecretId` 含 `'deepseek'`，`STORAGE_KEYS.deepseek = 'provider_key_deepseek'`。注意：
`MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS` 目前**不含** deepseek，需按下方待办确认是否要加（决定 renderer
能否经通用 safeStorage IPC 访问该键）。

### 5. 模型选择器：DSH 走 capabilities 而非通用供应商目录

- `apps/desktop/src/renderer/lib/providerModels.ts`：`selectVisibleModels` 新增 `deviceDshModels` 参数，
  `agentKind === 'dsh'` 时直接返回 capabilities 派生的 DSH 模型列表（不依赖通用 provider 目录/连接态）；
- `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx`：增加 `dsh` capabilities 拉取；
  `resolveRemoteModelListStatus` 支持 dsh；空态卡片按 `currentAgentKind === 'dsh'` 切换文案键；
  触发来源门禁对 dsh 豁免（`currentAgentKind !== 'dsh'` 条件），避免未连接通用供应商时误禁用 DSH；
- `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`：`useAgentCapabilities('dsh')` 接入；
  `activeAgentKind` 解析、`hasConnectedSendSource` 对 dsh 恒 true、发送门禁豁免 dsh。

### 6. i18n 空态文案（5 个 locale 的 common.json）

`newChat.modelSelector.source` 段新增 `dshEmptyTitle`/`dshEmptyDesc`（zh-CN/zh-TW/en/ja/ko 全同步）：
- zh-CN：需要配置 DeepSeek API Key / 在设置中配置 DeepSeek API Key 后，DSH 即可作为来源选择模型；
- en：DeepSeek API Key required；ja：DeepSeek API キーが必要です；ko：DeepSeek API 키가 필요합니다。

## 配置入口现状

Settings「模型供应商」页已有内置 API-key 通道组件：`ProvidersSection.tsx` 的 `BuiltinApiKeyHeader`
（L1075 起）与 `AddProviderWizard.tsx` 的 `builtinApiKey` 分支（L388 起）。其可见条件为：
provider 属于 `PROVIDER_SECRET_IDS`（已含 deepseek）且 `p.auth.method === 'apiKey'`（DSH 满足）。
**因此 deepseek 会出现在供应商列表中并可配置 Key；wizard 中 `builtinApiKeyChoices` 额外要求
`imageModels/videoModels 非空`（图像/视频能力面），DSH 无媒体能力故不会出现在添加向导中——这是预期的。**

## 验证现状

- 已跑：`i18nCompleteness`、`modelSelectorTriggerVariant`、`selectVisibleModels`、`catalogDerivedModels`
  定向单测（均通过）；
- `pnpm --filter desktop run --if-present typecheck` 在补 `authStrategy` 前失败（TS2741），
  补后**尚未重跑确认**；
- 未做端到端手动验收（需启动隔离客户端真实发一条消息）。

## 当前卡点与待办（交接给后续 agent）

1. **重跑 `pnpm --filter desktop run --if-present typecheck`**：`authStrategy: 'api-key-header'` 已补进
   `builtin.ts`，需确认类型通过（`RoutingDescriptor` 必填 `upstream` + `authStrategy`）。
2. **确认 `providerSecrets.ts` 的 MAIN_ONLY 集合**：若 `provider_key_deepseek` 需要走 main-only 专用桥
   （`builtinApiKey*` 已支持），把 `STORAGE_KEYS['deepseek']` 加入 `MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS`；
   若确认 renderer 通用桥可安全访问则可不动，但需在文档注明判定。
3. **补 Settings 可见性验证**：确认供应商列表出现 DeepSeek 行、配置 Key 后连接态翻转、断开/重配正常；
4. **跑全量相关门禁**：`pnpm test:unit:related` + `pnpm --filter @cindy/model-providers run --if-present typecheck`；
5. **手动验收（可执行则做）**：`pnpm restart:desktop:remote --region=global --isolated=dsh-test` → 新建任务选 DSH →
   选 `deepseek-v4-flash` → 发一条短消息验证流式回复。DeepSeek 不支持图片，不要发图。

## 维护注意

- DSH 是上游 developer preview：升级打包运行时或 JSON-RPC 协议前，必须重验事件翻译、取消/关闭、远程安装；
- 改模型选择/凭证/SSH 桥接时至少跑相关单测 + desktop typecheck + `pnpm test:unit:related`；
- i18n 新键必须 5 locale 全同步（`i18nCompleteness.test.ts` 只认静态 `t('完整路径')` 字面量）；
- 文件 CRLF、无 BOM：写文件用 `[System.IO.File]::WriteAllText` + `UTF8Encoding::new($false)`。
