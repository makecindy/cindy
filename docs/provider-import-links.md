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

只接受精确路径、v1、一个 `v` 和一个 `data` 参数；未知字段、重复参数、非法值整条拒绝。解析上限约 32 KiB URL / 24 KiB 解码数据、8 个端点、每端点 256 个模型 / 24 个 Header、自定义 Key 4 KiB、内置 Key 1 KiB。浏览器/操作系统可能有更低长度限制，供应商应优先生成短链接并省略模型清单。

端点必须为 HTTP(S)，不得含用户名、密码、query 或 fragment；OAuth 端点必须 HTTPS。API Key 放在专用字段，不能放在端点 URL。`requestPath` 必须以单个 `/` 开头（如 `/responses`），不能带 query/fragment 或指定另一主机。自定义 Header 会进入凭证存储，不在预览显示值。

用上面的假 Key 和 `example.invalid` 测试即可，不要使用真实用户 Key。开发版 UI/自动测试不能证明操作系统的安装协议注册；发布前还需 packaged macOS/Windows 的冷启动与运行中唤起冒烟。
