/**
 * Desktop 端 anthropic-chat-bridge 装配 —— Claude Code 自定义供应商
 * (`wireProtocol: 'openai-chat'`)的本地协议翻译 handler。
 *
 * 与 anthropic-responses-bridge-host 同构:compat-proxy 的 routingTransform 在会话显式
 * 选了 Chat-Completions wire 的自定义供应商时,把请求经 `RoutingDecision.localHandler`
 * 直接交给本 handler(Anthropic Messages ↔ Chat Completions 双向翻译在
 * @cindy/anthropic-chat-bridge 内完成),消息流不多跳、无独立进程内服务。
 *
 * 失败兜底:装配抛错 → 返回 null,routingTransform 回落原转发逻辑(自定义供应商的
 * anthropic-messages 直连语义);摘掉本分支即整体退回旧行为。
 */

import { createAnthropicChatHandler, type AnthropicChatBridgeHandler } from '@cindy/anthropic-chat-bridge';

import { createMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';
import { getActiveCatalog } from './active-catalog.js';
import { buildLocalHandlerHeaders, type ResolvedSessionRoute } from './provider-route.js';
import { reportProviderUpstreamError } from './provider-upstream-error-observer.js';

const log = createMakerLogger('cc-chat-bridge');

/**
 * 为一条已解析的 Claude Code 会话路由装配 Chat Completions 桥接决策。
 * `route.routing.wireProtocol !== 'openai-chat'` 时返回 null(调用方回落原逻辑)。
 *
 * 按 codex-proxy-host 的 createChatBridgeDecision 同构实现:每请求装配(handler 是
 * 轻量闭包,无 IO;目录/凭证变化天然即时生效,无需缓存失效)。
 */
export function createClaudeChatBridgeDecision(
  route: NonNullable<ResolvedSessionRoute>,
): {
  handler: AnthropicChatBridgeHandler;
} | null {
  if (route.routing.wireProtocol !== 'openai-chat') return null;

  // host 构造的 outbound headers(含自定义供应商 API key 注入;与透明转发分支同源,
  // 见 buildLocalHandlerHeaders 的 api-key-header 分支)。
  const { headers } = buildLocalHandlerHeaders(route, 'claude-code');

  const providerId = route.providerId;
  const providerName =
    getActiveCatalog().providers.find((p) => p.id === providerId)?.name ?? providerId;

  // localHandler 绕过 proxy 的 responseObserver,自定义(user)供应商的上游错误不会被
  // createProviderUpstreamErrorObserver 看到。显式把非 2xx 上游错误喂回同一广播通道,
  // 让 Chat 桥接会话与透明自定义供应商一样弹结构化 providerError.* 提示。
  const onUpstreamError = route.providerSource === 'user'
    ? ({ status, body }: { status: number; body: string }): void => {
        reportProviderUpstreamError({
          agent: 'claude-code',
          providerId,
          providerName,
          status,
          bodyText: body,
        });
      }
    : undefined;

  const handler = createAnthropicChatHandler({
    providers: [
      {
        // 自定义供应商的模型 id 无统一前缀:空前缀 = 匹配该 route 的所有请求
        // (进入 localHandler 的请求已经过路由 scope 门,即该供应商的模型)。
        prefix: '',
        upstreamBase: route.routing.upstream,
        ...(route.routing.requestPath
          ? { chatCompletionsPath: route.routing.requestPath }
          : {}),
        buildHeaders: async () => headers,
        ...(onUpstreamError ? { onUpstreamError } : {}),
      },
    ],
    logger: log,
    // localHandler 分支的上游请求由 chat bridge 自己发,绕开了 compat-proxy 转发层的
    // 出站代理;显式注入代理感知 fetch(见 outbound-fetch.ts)。
    fetchImpl: outboundFetch,
  });
  return { handler };
}
