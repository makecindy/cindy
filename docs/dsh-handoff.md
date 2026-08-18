# DSH 集成接手文档（Handoff）

更新时间：2026-08-18
交接对象：接手「cindy 测试版连接 DSH」的后续 agent（继续 task #4 验证与收尾）
分支：`dsh-integration`（本地工作区，未 commit 本次文档改动）

## 你要接手什么

让 cindy 测试版中：选择 DSH 来源 → 可选模型 → 能正确发送消息。
现状：实现已基本落地（task #1/#2/#3 完成），但 task #4 验证与收尾尚未完成，
部分门禁未重跑、端到端未验收。你的职责是把剩余验证跑完、修复暴露的问题、
并给出结论；不要重做已落地的实现。

## 当前工作区状态

- 分支 `dsh-integration`，基于 `afb1df5a7 feat(desktop): integrate DeepSeek Harness`（其上游为
  `04eb401f2 feat(maker-core): add dsh agent bridge`）。
- `git status`：13 个修改文件 + `.claw/`、`docs/dsh-integration.md`、`docs/dsh-handoff.md` 未跟踪。
- `catalog-to-descriptors.ts`、`catalogDerivedModels.test.ts` 两个文件只有 CRLF 差异，勿动。

## 已落地的改动（勿重做）

### 1. packages/model-providers/src/builtin.ts

新增 `DEEPSEEK_PROVIDER`：`id: 'deepseek'`、`source: 'builtin'`、`agents: ['dsh']`、
`auth.method: 'apiKey'`；`routing.dsh = { upstream: 'https://api.deepseek.com', wireProtocol: 'openai-chat', authStrategy: 'api-key-header' }`；
`models.dsh`：`deepseek-v4-flash`（contextWindow 1M，`newSessionDefault: ['dsh']`）+ `deepseek-v4-pro`（1M）。
追加在 `BUILTIN_PROVIDERS` 末尾（gemini/deepseek 只能追加在 xd 之后，勿插入中间）。

### 2. apps/desktop/src/main/secrets/builtinApiKeyBridge.ts

`BUILTIN_API_KEY_PROVIDER_IDS` 追加 `'deepseek'`，renderer 可经 `builtinApiKey*` 专用 IPC 读写密钥。

### 3. apps/desktop/src/main/maker-host/createDesktopProviderService.ts

`builtinApiKeyConnected` 三级判定：`gemini` → `deepseek`（`Boolean(providerSecretStore.get('deepseek')?.trim())`）→ 其余 false。

### 4. apps/desktop/src/shared/providerSecrets.ts（此前已含的改动）

`ProviderSecretId` 含 `'deepseek'`，`STORAGE_KEYS.deepseek = 'provider_key_deepseek'`。
注意：`MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS` 目前**不含** deepseek（见下方待办 #2）。

### 5. 模型选择器与发送门禁（DSH 走 capabilities）

- `apps/desktop/src/renderer/lib/providerModels.ts`：`selectVisibleModels` 新增 `deviceDshModels` 参数，
  `agentKind === 'dsh'` 直接返回 capabilities 派生模型列表；
- `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx`：拉取 dsh capabilities、
  `resolveRemoteModelListStatus` 支持 dsh、空态卡片按 `currentAgentKind === 'dsh'` 切文案、
  来源触发门禁对 dsh 豁免；
- `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`：`useAgentCapabilities('dsh')`、
  `hasConnectedSendSource` 对 dsh 恒 true、发送门禁豁免 dsh。

### 6. i18n 空态文案（5 locale 的 common.json）

`newChat.modelSelector.source` 新增 `dshEmptyTitle`/`dshEmptyDesc`（zh-CN/zh-TW/en/ja/ko 全同步）。

## 已验证

- 定向单测通过（4 文件）：`i18nCompleteness`、`modelSelectorTriggerVariant`、`selectVisibleModels`、`catalogDerivedModels`。

## 未验证 / 待办（按顺序执行）

1. **重跑 desktop typecheck**：
   `pnpm --filter desktop run --if-present typecheck`
   背景：补 `authStrategy: 'api-key-header'` 前 TS2741 失败，补后未重跑确认。
2. **判定 providerSecrets MAIN_ONLY 集合**：若 `provider_key_deepseek` 需要走 main-only 专用桥
   （`builtinApiKey*` 已支持 deepseek），把 `STORAGE_KEYS['deepseek']` 加入
   `MAIN_ONLY_PROVIDER_SECRET_STORAGE_KEYS`；确认 renderer 通用桥安全则不动，但需注明判定。
3. **跑全量相关门禁**：
   `pnpm test:unit:related`
   `pnpm --filter @cindy/model-providers run --if-present typecheck`
4. **Settings 可见性验证**：供应商列表应出现 DeepSeek 行（`BuiltinApiKeyHeader` 对 `PROVIDER_SECRET_IDS`
   中含 deepseek 且 `auth.method === 'apiKey'` 的行渲染）；配置 Key 后连接态翻转；断开/重配正常。
   wizard 的 `builtinApiKeyChoices` 要求 imageModels/videoModels 非空，DSH 无媒体能力故不在向导中——预期行为。
5. **手动端到端验收**：`pnpm restart:desktop:remote --region=global --isolated=dsh-test` →
   新建任务选 DSH → 选 `deepseek-v4-flash` → 发一条短消息验证流式回复。
   ⚠️ DeepSeek 不支持图片，不要发图（模型没有图像能力面）。
6. 收尾：按仓库规则提交 PR（DCO 签名 `git commit -s`、`pnpm check:dco`），PR-first，勿直推主干。

## 失败排查提示

- 来源栏仍为空 → 检查 provider 连接态判定（`builtinApiKeyConnected`）与 `provider_key_deepseek` 是否写入；
- 模型不可选 → 检查 `selectVisibleModels` 的 `deviceDshModels` 参数链路与 capabilities 拉取；
- 发消息失败 → 检查 `routing.dsh` 的 `upstream`/`wireProtocol`/`authStrategy` 与 DeepSeek 侧 Key 有效性。

## 约束与注意

- 文件 CRLF、无 BOM；写文件用 `[System.IO.File]::WriteAllText($abs, $content, [System.Text.UTF8Encoding]::new($false))`，勿用 apply_patch/管道。
- i18n 新键必须 5 locale 全同步（`i18nCompleteness.test.ts` 只认静态 `t('完整路径')` 字面量）。
- 涉及凭证/本地存储的改动先读 `docs/dev-rules/credentials-and-local-storage.md`；
  Settings/agent 开关改动先读 `docs/dev-rules/configuration-and-overrides.md`。
- 沉淀文档见 `docs/dsh-integration.md`（背景、根因、改动清单、维护注意）。
