

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
 * Cindy Provider codex/* 的内部 transport identity。产品 Provider 和上游不变；
 * name="OpenAI" 只用于让 Codex 启用远程压缩，HTTP 与订阅 WS identity 分开冻结。
 */
export const CODEX_CINDY_COMPACT_PROVIDER_ID = 'cindy_codex';


/** Sticky per-thread native summary fallback; model and credential routing are unchanged. */
export const CODEX_SUMMARY_COMPACT_PROVIDER_ID = 'cindy_summary';


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
export type CodexProxyAuthInjection = CodexProxySpawnAuthMode;
