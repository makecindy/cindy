# 自定义供应商新增时的 Pi Runtime 初始化

## 背景

Pi 支持自定义供应商的原生 BYOM runtime，但供应商配置需要显式存在 `runtimes.pi`。现有
“新增供应商”向导是极简流程：用户选择预设、填写显示名称和 API Key，向导只展示预设声明
的模型与端点，不展开各个引擎的独立配置。

当前快捷预设主要声明 `claude-code` 与 `codex`，因此通过新增向导创建的供应商不会写入
`runtimes.pi`。编辑已有供应商时，编辑器提供 Pi Tab 和 runtime 一键填充，用户可以手动
完成相同配置，造成新增与编辑行为不一致。

## 目标

- 不改变新增向导的页面结构、步骤数量或用户输入项。
- 新增供应商保存后，若预设存在 Claude Code runtime，则自动生成对应的 Pi runtime。
- Pi runtime 初始使用 Claude Code 的端点、模型和凭证配置，并使用 `anthropic-messages`
  协议。
- 保持现有编辑页的一键填充能力，继续支持用户调整 Pi 端点、协议和模型。
- 对不具备可安全复用条件的预设不强行生成 Pi runtime。

## 非目标

- 不在新增向导中增加 Claude Code / Codex / Pi Tab。
- 不把所有 Codex runtime 无条件复制给 Pi。
- 不改变既有供应商的运行时配置，不做启动期全量数据迁移。
- 不因为模型 ID 在 Pi 对话列表出现，就宣称某个具体供应商来源支持 Pi。

## 方案

### 保存阶段生成 Pi runtime

新增向导继续按照预设声明的 runtime 拉取模型并收集用户选择。构造保存 payload 时：

1. 先按现有逻辑写入预设声明的 runtime。
2. 若预设有 `claude-code` runtime，且该 runtime 最终有至少一个选中模型，则基于保存后的
   Claude Code runtime 派生 `pi` runtime。
3. Pi runtime 使用相同的 `baseUrl`、模型发现端点和请求头；协议固定为
   `anthropic-messages`。模型按编辑页一键填充的保存语义，只复制通用字段
   `id`、`name`、`contextWindow` 和 `defaultEnabled`，不从 Claude runtime 猜测 Pi 专属能力。
4. 不复制 Claude Code 的 `requestPath`，因为 Pi 原生 runtime 不支持自定义推理请求路径。
5. API Key 同步写入 Pi runtime 对应的凭证槽，使新增后无需再次配置密钥。

### 兼容门槛

自动派生只允许从 Claude Code runtime 进行，且目标端点必须具备 Anthropic Messages 语义。
原因是 Pi 原生支持 `anthropic-messages`，而 Claude Code runtime 本身已经使用该协议。

没有 Claude Code runtime 的预设暂不自动补 Pi；这类预设后续应逐一验证协议、工具调用、流式
输出、thinking、图片输入、请求路径和计费元数据后再加入专门规则。

### 存量供应商

本次不做启动期自动迁移，避免未经用户确认改变既有供应商路由。存量供应商继续通过编辑页
的 Pi Tab 和 runtime 一键填充补齐；补齐后才会写入明确的 `runtimes.pi` 并参与 Pi 路由。

## 数据与路由不变量

- Pi host 只为存在 `runtimes.pi` 的自定义供应商生成原生 provider 配置。
- 新增保存时把同一 API Key 写入 Pi 独立凭证槽；Pi host 读取该槽并把密钥注入子进程环境，
  `models.json` 只持有环境变量名，不持有明文。
- Pi 模型选择器按 `provider ID + agent + model ID` 判断来源；跨供应商同名模型不能作为
  具体供应商已支持 Pi 的证据。
- 新增向导的模型发现仍按预设声明的 runtime 分开执行；自动派生 Pi 不额外发起第二次
  模型发现请求。
- Pi runtime 的模型条目只继承跨 runtime 通用字段；Pi 专属 reasoning 或图片能力必须由
  显式 Pi 配置声明，不能从 Claude Code runtime 猜测。

## 测试策略

- 新增向导保存测试：含 Claude Code + Codex 的预设会生成 Pi runtime。
- 保存测试：Pi runtime 复用 Claude Code 的端点、模型、headers 和 API Key，协议为
  `anthropic-messages`，且不带 `requestPath`。
- 保存测试：没有 Claude Code runtime 的预设不会凭空生成 Pi runtime。
- Pi host 装配测试：把新增流程派生的 runtime 和 Pi 凭证交给真实装配函数，断言最终原生
  provider 使用 `anthropic-messages`、正确端点、模型、请求头环境引用和 Pi 密钥环境变量。
- 回归测试：编辑页已有 Pi 一键填充行为不受影响。
- 运行相关 desktop 定向测试与 typecheck；提交前按仓库门禁运行完整 `pnpm test:unit`。

## 风险与后续

自动派生的前提是供应商的 Claude Code 端点确实兼容 Anthropic Messages。若某供应商只是对
Claude Code 做了特殊代理、请求路径或能力裁剪，后续应把它从自动派生名单中排除，或为其
增加显式的 Pi 兼容配置，而不是继续扩大通用复制规则。
