/**
 * Claude Code 子进程行为开关(per-spawn 求值)。
 *
 * CLAUDE_CODE_ATTRIBUTION_HEADER 不是无条件 '0',按本次 spawn 的凭证形态决定
 * (issue #758):
 *
 * - `gateway-key` spawn(显式选 XD source、SSH remote 恒为此形态,或未连订阅的
 *   fallback):请求全部携带网关 key,compat proxy 恒 passthrough 到网关,不存在
 *   订阅直连路径。禁用归因块(CC 会把 `x-anthropic-billing-header: ...` 作为
 *   system 数组第一个 text block 注入 body)能提升网关按完整 body 缓存的命中率
 *   → 保持 '0'(与 remote-ssh/claude-env.ts 一致)。**此分支不读钥匙串**。
 *
 * - 其余形态(oauth-bearer / provider-oauth / 未显式指定)且连了 Claude.ai 订阅:
 *   claude-* 请求(含 Auto 分类器的 scope-gate 回落)可能被 compat proxy 路由到
 *   api.anthropic.com 直连,Anthropic 一方 API 会对**无归因**的 Auto 权限分类器
 *   子请求回 429 —— 分类器 100% 失败,auto 模式所有写操作 fail-closed,用户无法
 *   自救。保持 CLI 默认(带归因);代价只是该 spawn 中路由到网关的请求丢缓存归一化
 *   (慢一点,功能无损)。未连订阅时不存在直连路径,回到 '0'。
 *
 * oauth 判据与 compat proxy 的 oauth-spawn 判定同源(hasClaudeAiOAuth,见
 * anthropic-compat-proxy-host.ts setClaudeProxyOAuthSpawnChecker),经 `oauthConnected`
 * 回调惰性注入 —— 只在非 gateway-key 分支才求值,每次 spawn 至多一次钥匙串读
 * (与 spawn 期 auth gate 的既有读取同级,非 per-request 路径)。本模块保持零依赖,
 * 便于单测。
 */

const STATIC_CLAUDE_BEHAVIOR_FLAGS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
};

/**
 * ToolSearch 依赖上游接受 deferred tools / tool_reference。仅对已知支持该协议的
 * XD 网关与 Anthropic 原生路由开启；其它显式来源默认关闭，避免兼容供应商返回 400。
 */
export function claudeToolSearchMode(
  providerId: string | null | undefined,
  credentialMode?: string,
): 'auto' | 'false' {
  const provider = providerId?.trim() || null;
  if (provider) return provider === 'xd' || provider === 'anthropic' ? 'auto' : 'false';
  return credentialMode === 'provider-oauth' ? 'false' : 'auto';
}

export interface ClaudeSpawnFlagsContext {
  /** 本次 spawn 的凭证形态(maker-core AgentCredentialMode;undefined = adapter fallback)。 */
  credentialMode?: string;
  /** 本次 spawn 的会话来源。null/undefined = 隐式默认路由。 */
  providerId?: string | null;
  /** 是否连了 Claude.ai 订阅。惰性回调:gateway-key 分支不调用、不产生钥匙串读。 */
  oauthConnected: () => boolean;
}

export function claudeBehaviorFlagsForSpawn(ctx: ClaudeSpawnFlagsContext): Record<string, string> {
  const keepAttribution = ctx.credentialMode !== 'gateway-key' && ctx.oauthConnected();
  // 保留归因也要**显式**写 '1',不能只是不设置:local spawn 继承宿主 process.env
  // (env-builder cleanProcessEnv),用户 shell 若 export 过 CLAUDE_CODE_ATTRIBUTION_HEADER=0,
  // 缺席的 key 压不住继承值,#758 会原样复现。CLI 判定(cli.js c5):仅
  // '0'/'false'/'no'/'off' 视为禁用,'1' = 保留归因,与未设置同义。
  return {
    ...STATIC_CLAUDE_BEHAVIOR_FLAGS,
    ENABLE_TOOL_SEARCH: claudeToolSearchMode(ctx.providerId, ctx.credentialMode),
    CLAUDE_CODE_ATTRIBUTION_HEADER: keepAttribution ? '1' : '0',
  };
}
