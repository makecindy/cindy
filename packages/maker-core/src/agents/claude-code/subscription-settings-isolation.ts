/**
 * Claude 订阅链路不加载用户级 Claude Code 设置。
 *
 * 终端里的 `claude` 常在 `~/.claude/settings.json` 配 `apiKeyHelper`、`env.ANTHROPIC_BASE_URL`
 * 与自定义模型名走第三方网关。CLI 加载用户级设置后,这些配置在 CLI 里优先于 Claude.ai 订阅
 * 登录:`auth status` 报 `api_key_helper`(判为非订阅、登录前就被拒),`get_usage` 读不到套餐,
 * `supportedModels` 返回网关的模型名,订阅会话的请求也可能发往网关。
 *
 * 所以 Cindy 的订阅链路(登录态检查、登录、余量查询、模型探测、本机订阅会话)不加载用户级
 * 设置,只按 CLI 自己的订阅登录作答。只作用于 Cindy 拉起的子进程:不改用户的设置文件,
 * 终端里的 `claude` 与 Cindy 的 API 路由照旧使用用户设置;订阅判定标准不变。flag settings
 * 层再把 `apiKeyHelper` 置空,兜住仍会加载的其它来源。
 */

/** 订阅链路的 flag settings(`--settings` / SDK `options.settings`)。 */
export const CLAUDE_SUBSCRIPTION_FLAG_SETTINGS: { readonly apiKeyHelper: '' } = Object.freeze({ apiKeyHelper: '' });

/** 订阅链路直接拉起 CLI(`auth status` / `auth login` / `get_usage`)时放在最前面的参数:不加载任何文件层设置。 */
export const CLAUDE_SUBSCRIPTION_CLI_ISOLATION_ARGS: readonly string[] = Object.freeze([
  '--setting-sources', '',
  '--settings', JSON.stringify(CLAUDE_SUBSCRIPTION_FLAG_SETTINGS),
]);
