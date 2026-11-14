/**
 * Desktop 端 anthropic-compat-proxy 生命周期管理 ——
 *
 * 负责在 splash 阶段(getMaker() 之前)启动一个本地 loopback 代理,把
 * Claude Code 子进程的 ANTHROPIC_BASE_URL 指向这个代理。代理在转发到真上游
 * 前会:
 *   - Claude 自家模型(claude-*)请求字节透传,延迟 0
 *   - 非 Claude 模型(gpt-5.4 / kimi / glm 等)的请求,strip Anthropic-only
 *     字段(output_config / thinking / cache_control / betas),避免 litellm
 *     转发到 Azure backend 时返回 "Unknown parameter" 400
 *
 * 失败兜底: 代理起不来时(端口冲突 / OS 异常),fallback 直接返回真上游 URL
 * +打 ERROR 日志。Claude Code 仍能跑(只是非 Anthropic 模型会报 400),不阻塞
 * 整个 app 启动。
 *
 * dispose: 由 bootstrap-electron.ts 的 onQuit 注册器在退出阶段调用。
 */

// The proxy itself lives in anthropicCompatProxyHostCore.ts (shared with the Node Host).
// This module builds the single Desktop instance. Its ports resolve the Desktop modules
// when called, never when this module loads.
import type { RoutingTransform } from '@cindy/anthropic-compat-proxy';
import { createAttachmentRecovery } from './oversized-attachment-recovery.js';
import { outboundFetch } from './outbound-fetch.desktop.js';
import { isOpenAiSubscriptionProviderId } from './codex-account-auth.desktop.js';
import { createPiWebSocketRequestPreparer, resolvePiWebSocketUpstream, piWebSocketTransforms } from './pi-subscription-websocket.js';
import { isClaudeSubscriptionProviderId, isXaiSubscriptionProviderId } from './subscription-account-auth.js';
import { getPiNativeSubscriptionHandler, getResponsesBridgeHandler } from './anthropic-responses-bridge-host.js';
import { subscriptionRequestAllowsFast, withSubscriptionFastRequestPolicy } from './subscription-fast-request-policy.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { claudeUpstreamEndpoint } from './runtime-configs.js';
import { readSilentEncryptedRetrySettings } from './silent-encrypted-retry-store.js';
import { createAnthropicCompatProxyHost } from './anthropicCompatProxyHostCore.js';

const desktopProxy = createAnthropicCompatProxyHost({
  createAttachmentRecovery: (...args) => createAttachmentRecovery(...args),
  outboundFetch: (...args) => outboundFetch(...args),
  isOpenAiSubscriptionProviderId: (...args) => isOpenAiSubscriptionProviderId(...args),
  createPiWebSocketRequestPreparer: (...args) => createPiWebSocketRequestPreparer(...args),
  resolvePiWebSocketUpstream: (...args) => resolvePiWebSocketUpstream(...args),
  piWebSocketTransforms: (...args) => piWebSocketTransforms(...args),
  isClaudeSubscriptionProviderId: (...args) => isClaudeSubscriptionProviderId(...args),
  isXaiSubscriptionProviderId: (...args) => isXaiSubscriptionProviderId(...args),
  getPiNativeSubscriptionHandler: (...args) => getPiNativeSubscriptionHandler(...args),
  getResponsesBridgeHandler: (...args) => getResponsesBridgeHandler(...args),
  subscriptionRequestAllowsFast: (...args) => subscriptionRequestAllowsFast(...args),
  withSubscriptionFastRequestPolicy: (...args) => withSubscriptionFastRequestPolicy(...args),
  resolveDesktopOutboundProxy: (...args) => resolveDesktopOutboundProxy(...args),
  claudeUpstreamEndpoint: (...args) => claudeUpstreamEndpoint(...args),
  readSilentEncryptedRetrySettings: (...args) => readSilentEncryptedRetrySettings(...args),
});

export function setClaudeProxyGatewayKeyReader(fn: () => string | null): void {
  desktopProxy.setClaudeProxyGatewayKeyReader(fn);
}

export function setClaudeProxyOAuthSpawnChecker(fn: () => boolean): void {
  desktopProxy.setClaudeProxyOAuthSpawnChecker(fn);
}

export function setClaudeProxySessionIdResolver(
  fn: (sdkSessionId: string) => string | null,
): void {
  desktopProxy.setClaudeProxySessionIdResolver(fn);
}

export function setClaudeProxyOwnerBoundaryPendingChecker(fn: () => boolean): void {
  desktopProxy.setClaudeProxyOwnerBoundaryPendingChecker(fn);
}

export function setClaudeProxyOwnerScopeKeyReader(fn: () => string): void {
  desktopProxy.setClaudeProxyOwnerScopeKeyReader(fn);
}

export function piGatewayRequestAgent(
  requestUrl: string,
): 'claude-code' | 'codex' {
  return desktopProxy.piGatewayRequestAgent(requestUrl);
}

export function createModelRoutingTransform(): RoutingTransform {
  return desktopProxy.createModelRoutingTransform();
}

export async function ensureAnthropicCompatProxyReady(): Promise<void> {
  return await desktopProxy.ensureAnthropicCompatProxyReady();
}

export function isAnthropicCompatProxyHandleReady(): boolean {
  return desktopProxy.isAnthropicCompatProxyHandleReady();
}

export function getClaudeEndpoint(): string {
  return desktopProxy.getClaudeEndpoint();
}

export async function disposeAnthropicCompatProxy(): Promise<void> {
  return await desktopProxy.disposeAnthropicCompatProxy();
}
