/**
 * codex-gateway-config —— Codex "API 模式"(走 AI Gateway)的 provider 配置 single source。
 *
 * 背景:Codex 默认走 OAuth 订阅(ChatGPT 后端)。开启 API 模式后,我们要让内嵌的
 * codex app-server 改走 AI Gateway —— 等价于给独立 Codex CLI 写的 config.toml
 * 自定义 model_provider,只是我们用 codex 二进制的 `-c key=value` 顶层 override
 * 注入(免动用户 ~/.codex/config.toml,且天然可逆:关掉 API 模式下次 spawn
 * 不带这些 flag 即可)。
 *
 * 等价的 config.toml:
 *   model_provider = "cindy_gateway"
 *   [model_providers.cindy_gateway]
 *   name     = "Cindy Gateway"
 *   base_url = "<网关 endpoint>/v1"   # 登录随凭据下发,非硬编码
 *   wire_api = "responses"
 *   env_key  = "XDT_CODEX_API_KEY"
 *
 * key 值本身不进 `-c`(命令行可被 ps 看到),只通过 env_key 指向的环境变量注入
 * (见 auth-adapters.ts getAuthEnv 的 API 模式分支)。
 */

import { claudeUpstreamEndpoint } from './runtime-configs.js';

/** 内部 provider id(codex config 里的 key)。仅 codex 子进程配置的本地标签,不外发。 */
export const CODEX_GATEWAY_PROVIDER_ID = 'cindy_gateway';

/**
 * OpenAI 身份 provider id(仅 oauth-bearer spawn 定义)。base_url 同样指向本地
 * loopback proxy,但 `name` 必须逐字等于 "OpenAI" —— codex 的
 * `ModelProviderInfo::supports_remote_compaction()` 按 name 判定,命中后订阅会话
 * 才走 OpenAI 远端压缩(remote compaction v2,经普通 /responses 由服务端压缩),
 * 否则只有低保真的本地 summarization fallback。
 *
 * 只允许「ChatGPT 订阅直连路由」的 thread 用它(thread/start|resume 的
 * modelProvider 覆盖):网关 / xAI / 自定义供应商的上游不实现远端压缩语义,
 * 远端压缩失败在 codex 侧是硬失败(无本地回退),错配会打断长会话。
 */
export const CODEX_OPENAI_COMPACT_PROVIDER_ID = 'cindy_openai';

/**
 * 注入 codex 子进程的环境变量名 —— codex 通过 config 的 `env_key` 来这里读 API key。
 * 用专名避免撞用户机器上已有的同名变量。
 */
export const CODEX_GATEWAY_ENV_KEY = 'XDT_CODEX_API_KEY';
export const CODEX_PROVIDER_OAUTH_PLACEHOLDER_KEY = 'xdt-provider-oauth-placeholder-key';
export type CodexProxySpawnAuthMode = 'oauth-bearer' | 'env-key' | 'provider-oauth';

// AI Gateway 的 OpenAI 兼容入口不再提供模块级常量(会把远程端点清单钉死在烘焙值),
// 统一走 buildCodexGatewayBaseUrl() 现取。

/**
 * Codex ChatGPT 订阅后端(从 codex 二进制确认: codex 订阅模式默认打这里)。
 * proxy 路线下「普通模型 + oauth 模式」时, routingTransform 把上游 override 到这里,
 * 透传 codex 带的 OAuth token + chatgpt-account-id(等价 codex 原生订阅直连, 只多一跳 loopback)。
 */
export const CODEX_OAUTH_UPSTREAM = 'https://chatgpt.com/backend-api/codex';

export function buildCodexGatewayBaseUrl(upstream = claudeUpstreamEndpoint()): string {
  return `${upstream.replace(/\/+$/, '')}/v1`;
}

/**
 * 构造 spawn codex app-server 要追加的 provider override `-c key=value` 参数。
 * 形态与 codexEnvironment.ts 注入 MCP server 配置时一致(每条是 '-c' + 'key="value"' 两个数组项)。
 *
 * proxy 路线下**始终**调用(不分 oauth/api 全局开关): codex 的出口 provider 永远指向本地 loopback
 * proxy(baseUrl), 由 proxy 按 model / 模式分流。鉴权按用户凭证分两路:
 *   - oauth-bearer (有 OAuth 登录): requires_openai_auth → codex 带 auth.json 的 OAuth token
 *     + chatgpt-account-id, 忽略 env_key。普通模型 oauth 时 proxy 透传到 ChatGPT, 否则换 gateway key。
 *   - env-key (纯 api key, 无 OAuth): env_key=XDT_CODEX_API_KEY → codex 带 gateway key,
 *     proxy 直转 gateway(不破坏现有纯 key 用户)。
 *   - provider-oauth (如 xAI): env_key=XDT_CODEX_API_KEY → codex 带占位 key,
 *     proxy 按会话用供应商 OAuth token 覆盖 Authorization。
 * cindy_gateway 显式冻成 false；仅 oauth-bearer 额外定义的 cindy_openai 打开 WS。
 * 后者的 upgrade 由 loopback proxy 按 thread 转发，任何建连不兼容都会用 426 回到旧 HTTP。
 */
export function buildCodexProxySpawnArgs(baseUrl: string, authMode: CodexProxySpawnAuthMode): string[] {
  const p = CODEX_GATEWAY_PROVIDER_ID;
  const authArg = authMode === 'oauth-bearer'
    ? `model_providers.${p}.requires_openai_auth=true`
    : `model_providers.${p}.env_key="${CODEX_GATEWAY_ENV_KEY}"`;
  const args = [
    '-c', `model_provider="${p}"`,
    '-c', `model_providers.${p}.name="Cindy Gateway"`,
    '-c', `model_providers.${p}.base_url="${baseUrl}"`,
    '-c', `model_providers.${p}.wire_api="responses"`,
    '-c', authArg,
    // cindy_gateway 必须留在 HTTP:proxy 要整段 JSON.parse 请求体做 instructions 注入、
    // 按 model 分流改写与 recoveryRules,这些能力在 WS 帧上不存在(proxy 的 WS 通道只做
    // socket 级透传)。网关 / xAI / 自定义供应商都走这个 provider,因此一律不发 upgrade。
    // 只有不依赖请求体改写的订阅直连 provider(下面的 cindy_openai)才放开 WS。
    '-c', `model_providers.${p}.supports_websockets=false`,
  ];
  if (authMode === 'oauth-bearer') {
    // OpenAI 身份 provider(见 CODEX_OPENAI_COMPACT_PROVIDER_ID):默认 model_provider
    // 仍是 cindy_gateway(本地压缩,安全缺省),订阅直连 thread 由 maker-core 在
    // thread/start|resume 用 modelProvider 显式选它。仅 oauth spawn 定义 —— env-key
    // 进程没有 OAuth token,误选时宁可 thread/start 报 unknown provider 也不能静默降级。
    const o = CODEX_OPENAI_COMPACT_PROVIDER_ID;
    args.push(
      '-c', `model_providers.${o}.name="OpenAI"`,
      '-c', `model_providers.${o}.base_url="${baseUrl}"`,
      '-c', `model_providers.${o}.wire_api="responses"`,
      '-c', `model_providers.${o}.requires_openai_auth=true`,
      // 订阅直连走 bundled codex 原生的 Responses WebSocket:Codex 自己执行
      // startup prewarm、连接复用、重试与 HTTP fallback；Cindy 只把 loopback upgrade
      // 原样隧道到同一个 ChatGPT endpoint。这样 at-capacity / 重连语义由同版本 Codex
      // 和上游决定，不在宿主侧另造一套传输策略。
      //
      // 字段是 boolean(实测传字符串报 `expected a boolean`),没有「只开通道不开预热」
      // 的中间档,true 即含 prewarm。因此灰度只能由外层控制(proxy 侧
      // resolveWebSocketUpstream 返回 null → 426 → codex 退回 HTTP),不能靠这个字段分档。
      //
      // 前提:proxy 必须支持 upgrade 转发(见 anthropic-compat-proxy 的
      // resolveWebSocketUpstream),否则 codex 的 WS 会打在一个不认 upgrade 的 loopback 上。
      //
      // 代价(WS 上 proxy 看不到请求体,以下能力对订阅直连失效):
      //  - recoveryRules(encrypted_content / image-id 修复):app-server 报错后由
      //    maker-core 通知 host 按同一套 rule 判定，逐出该 thread 的预热 WS；
      //    下一次 upgrade 返回 426，codex 降到 HTTP 后由原 recoveryRules 接管。
      //  - responseObserver 的限流 header 观测:订阅直连已由 app-server 的
      //    `account/rateLimits/updated` 原生通道覆盖(不经 body,不受 WS 影响)。
      //  - prompt 改走原生 developerInstructions:Codex 0.145 自动 compact 会把当前
      //    session 的 canonical developer context 重新注入 replacement history(中途
      //    compact)或下一次正常采样(pre-turn compact),无需 proxy 逐请求重复注入。
      '-c', `model_providers.${o}.supports_websockets=true`,
      // is_openai + codex-backend OAuth 命中时 codex 默认对 /responses 请求体做 zstd
      // 压缩(enable_request_compression 默认开);loopback proxy 要整段 JSON.parse
      // 改写请求体,无法解 zstd,必须显式关掉(仅少传输优化,无功能损失)。
      '-c', 'features.enable_request_compression=false',
    );
  }
  return args;
}
