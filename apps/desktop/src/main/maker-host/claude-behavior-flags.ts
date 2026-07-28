/**
 * Claude Code 子进程行为开关(per-spawn 求值)。
 *
 * CLAUDE_CODE_ATTRIBUTION_HEADER 不是无条件 '0',按 spawn 凭证形态决定(issue #758):
 *
 * - gateway-spawn(未连 Claude.ai 订阅):请求恒走网关,禁用归因块(CC 会把
 *   `x-anthropic-billing-header: ...` 作为 system 数组第一个 text block 注入 body)
 *   能提升网关按完整 body 缓存的命中率 → 保持 '0'(与 remote-ssh/claude-env.ts 一致)。
 *
 * - oauth-spawn(连了 Claude.ai 订阅):claude-* 请求可能被 compat proxy 路由到
 *   api.anthropic.com 直连,Anthropic 一方 API 会对**无归因**的 Auto 权限分类器
 *   子请求回 429 —— 分类器 100% 失败,auto 模式所有写操作 fail-closed,用户无法自救。
 *   保持 CLI 默认(带归因);代价只是该 spawn 中路由到网关的请求丢缓存归一化(慢一点,
 *   功能无损)。
 *
 * 判据与 compat proxy 的 oauth-spawn 判定同源(hasClaudeAiOAuth,见
 * anthropic-compat-proxy-host.ts setClaudeProxyOAuthSpawnChecker),由 runtime-configs
 * 在每次 spawn 读取 behaviorFlags 时求值。本模块保持零依赖,便于单测。
 */

const STATIC_CLAUDE_BEHAVIOR_FLAGS: Readonly<Record<string, string>> = {
  CLAUDE_CODE_SKIP_FAST_MODE_NETWORK_ERRORS: '1',
  // 网关 upstream 透传 tool_reference 块, 显式开启 ToolSearch
  // 否则 CC 看到非 first-party host 默认 disable, 每次请求都全量塞工具定义。
  ENABLE_TOOL_SEARCH: 'auto',
};

export function claudeBehaviorFlagsForSpawn(oauthSpawn: boolean): Record<string, string> {
  return oauthSpawn
    ? { ...STATIC_CLAUDE_BEHAVIOR_FLAGS }
    : { ...STATIC_CLAUDE_BEHAVIOR_FLAGS, CLAUDE_CODE_ATTRIBUTION_HEADER: '0' };
}
