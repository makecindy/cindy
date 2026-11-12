/**
 * 后台链路(DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1)的控制端判据。
 *
 * 只有会话实时流(或 legacy wildcard)代表前台控制。任务列表和文件监听是后台订阅，
 * 不能因它们建立链路就让被控端显示接入提示。此时建的链路声明后台能力,新被控端
 * 不装 legacy `'*'`(横幅 / 全量推送 / 挡无人值守更新)。openRemoteLink 的所有入口(用户打开、
 * 订阅前建链、transport-timeout 重开、熔断恢复、后台读取)共用这一处判据。
 */
import {
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
  type LinkAcceptPayload,
} from '@cindy/device-link';

export function linkOpenCapabilities(
  base: readonly string[],
  outboundTopics: readonly string[],
): string[] {
  return hasControlSubscription(outboundTopics)
    ? [...base]
    : [...base, DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1];
}

export function hasControlSubscription(topics: readonly string[]): boolean {
  return topics.some((topic) => topic === '*' || topic.startsWith('session:'));
}

/**
 * 后台只读请求新建链路后的确认:旧被控端不认后台能力、已装上 legacy `'*'`。本机仍无控制
 * 意图时关掉这条链路(撤掉对方的受控状态),并以 UNSUPPORTED_CAPABILITY 失败,不发请求;
 * 期间用户已开始控制(有了实时订阅或前台调用)时保留链路,只让这次后台请求失败。
 */
export function assertBackgroundLinkAccepted(
  accepted: Pick<LinkAcceptPayload, 'capabilities'>,
  deps: { hasOutboundControlSubscription(): boolean; hasForegroundInvoke?(): boolean; closeLink(): void },
): void {
  if (accepted.capabilities?.includes(DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1)) return;
  if (!deps.hasOutboundControlSubscription() && !deps.hasForegroundInvoke?.()) deps.closeLink();
  throw new Error('[UNSUPPORTED_CAPABILITY] remote device does not support background links');
}

/** A foreground subscription may share an in-flight background open with an old peer. */
export function assertSubscriptionLinkAccepted(
  accepted: Pick<LinkAcceptPayload, 'capabilities'>,
  deps: { hasOutboundControlSubscription(): boolean; hasForegroundInvoke?(): boolean; closeLink(): void },
): void {
  if (deps.hasOutboundControlSubscription() || deps.hasForegroundInvoke?.()) return;
  assertBackgroundLinkAccepted(accepted, deps);
}
