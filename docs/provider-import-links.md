# 供应商配置导入链接（v1）

供应商可以在已登录用户的 Key 管理页面提供「导入到 Cindy」按钮，无需登记 Cindy 预设、实现 OAuth 或部署新的服务。

```text
cindy://provider/import?v=1&data=<base64url(UTF-8 JSON)>
```

历史 `xdt-maker://` scheme 接受同一格式。`data` 使用 URL-safe Base64，不带 `=` 填充；它是编码，不是加密。不要在公开文档、共享链接、分析事件或服务端日志中放真实 Key；应在用户主动点击时用该用户的 Key 生成链接。链接经过浏览器和操作系统，Cindy 无法消除这些环节的泄露风险。建议使用可撤销、有限额的专用 Key。

## 最简单的自定义供应商

```json
{
  "kind": "custom",
  "name": "Example AI",
  "auth": { "method": "apiKey", "apiKey": "FAKE-EXAMPLE-KEY" },
  "endpoints": [
    { "protocol": "openai-chat", "baseUrl": "https://example.invalid/v1" }
  ]
}
```

无需模型清单。用户确认后 Cindy 获取模型；获取失败仍保存连接和 Key，并提示去供应商设置重试。可提供 `models: ["model-id"]` 避免获取，或使用 `{ "id": "model-id", "name": "Display name" }`。

导入确认中的 API Key / 免鉴权模型获取不跟随 HTTP 重定向，请提供最终端点。每次成功响应最多读取 1 MiB，错误响应最多 16 KiB；模型发现最多保留 10,000 个模型，ID 和名称各最多 256 字符。响应超限或模型校验失败时，仍保留已确认的连接和 Key，提示在设置中重试。后续手动刷新与 OAuth 登录复用原有流程，不属于此导入获取限制的覆盖范围。

自动获取只能补充供应商接口实际返回的模型资料，不能保证恢复自定义分组、输出上限或其他用户覆盖值。传入非空 `models`（包括只有 ID 的数组）会跳过这次自动获取；需要完整保留配置时使用下面的文件导入。

## 大配置文件导入

在 Desktop「设置 → 模型供应商」点击「从文件导入」，先查看导入说明。可点击「下载示例」取得 `cindy-provider-example.json`，按自己的供应商资料替换地址、API Key 和模型 ID；「格式说明」可离线查看字段、限制与完整 JSON 示例。其他客户端导出的文件需先转换为此结构。

示例使用不会提供服务的 `example.invalid` 地址与占位 Key，包含模型分组、上下文、输出上限和推理强度；这些数值仅演示写法，应按实际模型填写。下载文件和界面中的 JSON 预览使用同一份固定内容，不读取用户已保存的配置或凭证。

准备好后点击「选择 JSON 文件」，选择 UTF-8 `.json` 文件，再在原有导入弹窗核对端点、模型数量与导入目标并确认。取消系统文件选择或文件校验失败时保留说明窗口，便于重新选择。文件正文就是本文的 v1 JSON 对象（`custom` / `preset` / `builtin`），不需要 Base64、URL 或额外包裹层；接受 UTF-8 BOM。

- 文件最多 **4 MiB（4,194,304 字节）**；每个供应商最多 8 个端点，每端点最多 **10,000 个模型**，同时受文件字节上限约束。其余字段、凭证和端点校验与深链接一致。
- 模型的 `group`、`maxOutputTokens`、上下文和推理配置等受支持字段完整经过同一校验和保存流程，不为适配链接长度裁剪。
- 系统文件选择框和有界读取在 Main 执行，Renderer 只收到短期草稿 ID 与脱敏预览，不收到文件路径、正文、Key 或 Header 值。解析错误也不回显文件内容。
- 选择文件不会写入连接、凭证或访问供应商；确认、取消、过期、同目标只换 Key、OAuth 和运行中 Codex 重载的语义与下节相同。草稿从选择文件时的账号代次开始绑定，选择期间切换账号必须重新选择。
- JSON 文件可能包含明文 Key，请仅选择可信文件并自行妥善保管。Cindy 不复制、修改或删除源文件；这不是加密备份或批量导出格式。
- 此入口管理使用该设置页的本机供应商，不读取 SSH 工作区或另一台电脑的路径。文件选择 IPC 不开放给 device-link / Mobile，与既有本机导入确认边界一致；不增加远程传输或中转要求。

错误文件、超过上限或无法读取时会显示对应提示，用户可重新选择。文件导入复用深链接的草稿、预览和确认流程；链接仍保留原来的紧凑传输限制。

### 多供应商批量导入

单供应商文件继续兼容。批量文件使用下面的外层结构，每项仍是本文的单供应商配置；说明窗口的「下载批量示例」提供两个自定义供应商的完整占位示例。

```json
{
  "providers": [
    { "kind": "builtin", "provider": "gemini", "apiKey": "FAKE-GEMINI-KEY" },
    { "kind": "builtin", "provider": "openai-images", "apiKey": "FAKE-OPENAI-KEY" }
  ]
}
```

- 一个文件最多 50 个供应商，总大小仍限制为 4 MiB；每项的接口、模型和凭证校验保持不变。批量外层只接受 `providers`，不接受裸数组或混合单项字段。
- 任一项结构校验失败时释放本批次全部草稿，不保存任何配置。内置 Key 槽位或显式 `id` 在同一批次中不可重复；无显式 ID 的同名自定义供应商可以作为独立连接导入。
- 预览列表展示每项的保存行为、端点、模型数量和凭证存在状态；默认勾选可以直接导入的条目。OAuth 通过「单独确认」复用原有授权流程，运行中 Codex 的中断确认也不会被批量操作自动同意。
- 勾选后按顺序调用原有确认入口。已保存项保留，失败项可重试；重试不重复提交成功项。这是逐项提交，不是跨供应商事务，不回滚已保存凭证。关闭列表会释放尚未确认的草稿。
- 「单独确认」仍可选择兼容的已有连接，仅更新 Key；取消此项会跳过并释放其草稿。OAuth 连接已创建但授权未完成时明确显示待授权，可在供应商设置继续。
- 离开页面或切换账号会释放未执行项，并在当前确认返回后停止后续调用。已确认的单项写入保持现有语义。

批量扩展仅用于本机文件入口，不改变深链接或 device-link / Mobile 的协议与准入范围。

浏览器 JavaScript（`payload` 为上面的对象）：

```js
function cindyImportUrl(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const data = btoa(
    Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `cindy://provider/import?v=1&data=${data}`;
}
// 在用户点击自己的 Key 页面按钮时执行；不要把链接发给统计系统。
importButton.addEventListener("click", () => {
  window.location.href = cindyImportUrl(payload);
});
```

PHP 也只需 JSON + Base64：

```php
$json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
$data = rtrim(strtr(base64_encode($json), '+/', '-_'), '=');
$url = 'cindy://provider/import?v=1&data=' . $data;
// 输出 HTML 属性时使用 htmlspecialchars($url, ENT_QUOTES, 'UTF-8')。
```

## 已有渠道与内置 Key

使用 Cindy 当前目录里的预设时，可以省去端点和模型配置：

```json
{ "kind": "preset", "preset": "openrouter", "apiKey": "FAKE-EXAMPLE-KEY" }
```

`preset` 必须是当前目录中的 API Key 预设 ID；不存在或无鉴权的预设会被拒绝。Cindy 复用添加向导的映射，保留 `catalogPresetId`，不把目录模型默认值误存为用户覆盖值。

内置独立 API Key 槽位使用：

```json
{ "kind": "builtin", "provider": "gemini", "apiKey": "FAKE-EXAMPLE-KEY" }
```

当前允许 `gemini` 和 `openai-images`；OpenAI / Anthropic / xAI 的原生订阅登录不是这些 Key 槽位，不能借此导入登录令牌。

## 多引擎和特殊端点

`endpoints` 可放多个不同协议的入口，每个入口可选 `targets`、独立 `apiKey`、`headers`、`models`、`modelsUrl` 和 `requestPath`。`headers` 只允许用于 API Key 鉴权；无鉴权/OAuth 携带 Header（即使为空对象）会被拒绝。`requestPath` 仅用于 Claude Code/Codex，Pi 会忽略该字段：

```json
{
  "kind": "custom",
  "name": "Example multi-runtime",
  "auth": { "method": "apiKey", "apiKey": "FAKE-SHARED-KEY" },
  "endpoints": [
    {
      "protocol": "anthropic-messages",
      "baseUrl": "https://example.invalid/anthropic",
      "targets": ["claude-code"],
      "models": ["example-claude"]
    },
    {
      "protocol": "openai-responses",
      "baseUrl": "https://example.invalid/v1",
      "targets": ["codex"],
      "apiKey": "FAKE-CODEX-KEY",
      "models": ["example-codex"]
    },
    {
      "protocol": "openai-chat",
      "baseUrl": "https://example.invalid/v1",
      "targets": ["pi"],
      "models": ["example-chat"],
      "headers": { "X-Tenant": "example" }
    }
  ]
}
```

省略 `targets` 时，Messages 可供三个引擎选择，Chat/Responses 可供 Codex 和 Pi 选择；Codex 优先 Responses，Pi 优先 Chat，Claude Code 只选 Messages。同一引擎出现同等优先级的多个入口时整条拒绝，供应商应显式指定 `targets`。无需鉴权使用 `auth: { "method": "none" }`，不要携带 Key；该模式仅支持本机回环服务（如 `http://127.0.0.1:4000/v1`），所有端点及可选 `modelsUrl` 都必须是回环地址，远程免鉴权链接在解析阶段即被拒绝。

通用 OAuth 也可预填公开描述：`auth.method: "oauth"`，共用 `tokenUrl`、`clientId`、`scopes`，授权码流带 `authorizeUrl`，设备码流带 `flow: "device-code"` 和 `deviceAuthorizationUrl`。确认后先保存连接，再运行 Cindy 现有授权流程；失败或取消授权不删除连接，可重试。OAuth 不支持 Pi 导入；不接受 access/refresh token 或 client secret。可选 OAuth 模型发现地址必须与所有运行入口同源。

## 用户确认与更新语义

- 所有写入都需要在 Cindy 点击确认。点击链接只创建短期草稿，不写凭证、不请求供应商。
- 导入不跨应用重启保留。若点击链接恰逢更新重启，请在重启完成后重新点击原链接；不会将含凭证的导入参数复制给更新后的进程。
- 自定义/预设导入默认新建唯一连接。相同站点的不同账号不会互相覆盖。
- 若存在相同 Key 目的地（引擎、协议、base URL、request path）的用户添加 API Key 连接，用户可在确认窗主动选择它；原生 OAuth 和托管本地连接不在候选中。此时**只更新携带的 API Key**，保留原名称、模型、路由、Header 和其他引擎配置。URL 无权指定覆盖目标；可选 `id` 只是新连接 ID 的前缀提示。
- 内置 Key 槽位固定，确认窗明确提示替换该 Key。
- 需要重新加载正在使用的本地 Codex 服务时，另行提示影响范围，用户再次确认才中断。
- Main 保管 Key/Header 值，设置页仅拿 opaque `importId` 和脱敏预览；消费后移除地址栏参数。草稿最多保存 10 分钟，绑定首次预览时的账号与代次；成功或取消后失效。这不是 Key 本身的过期时间。

## 边界与验证

深链接只接受精确路径、v1、一个 `v` 和一个 `data` 参数；未知字段、重复参数、非法值整条拒绝。解析上限为去掉 scheme 后 32,768 个字符 / 24 KiB UTF-8 解码字节、8 个端点、每端点 256 个模型 / 24 个 Header、自定义 Key 4 KiB、内置 Key 1 KiB。Base64 膨胀和路径、参数也占链接长度预算，因此通常写法实际最多容纳 24,557 字节 JSON。浏览器/操作系统可能有更低长度限制，供应商应优先生成短链接并省略模型清单；需要携带大量模型元数据时提供 JSON 文件，不建议删除字段来勉强塞入链接。

端点必须为 HTTP(S)，不得含用户名、密码、query 或 fragment；OAuth 端点必须 HTTPS。可选 `modelsUrl` 必须与对应 `baseUrl` 同源（协议、主机及端口一致），否则整条拒绝，避免运行时忽略该地址。API Key 放在专用字段，不能放在端点 URL。`requestPath` 必须以单个 `/` 开头（如 `/responses`），不能带 query/fragment 或指定另一主机。自定义 Header 会进入凭证存储，不在预览显示值。

用上面的假 Key 和 `example.invalid` 测试即可，不要使用真实用户 Key。未打包的开发版不注册系统 URL scheme，以免把正式版的链接交给临时 Electron 路径；URL/argv 解析与待处理导入仍可做定向测试。开发版 UI/自动测试不能证明操作系统的安装协议注册；发布前还需 packaged macOS/Windows 的冷启动与运行中唤起冒烟。旧开发版留下的错误关联按[开发深链与系统关联](dev-rules/desktop-development.md#开发深链与系统关联)恢复。
