/** Host-owned input provenance; shared by desktop and headless queue execution. */
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { MessageSourceDevice } from '@cindy/maker-shared/message-source';
import { extractPlainText } from './agentHandoff.js';
import { currentAutoReviewResourceIntent, readAutoReviewUserText } from './autoReviewUserIntent.js';

export const TRUSTED_DESKTOP_QUEUE_ORIGIN = Symbol('trusted-desktop-queue-origin');
export const TRUSTED_DESKTOP_PI_COMMAND_SNAPSHOT = 'trustedDesktopPiCommandAuthorization';
export interface TrustedDesktopQueueOriginReceipt {
  clientId: string;
  persistedContent: string;
  text: string;
}
interface TrustedDesktopPiCommandSnapshot extends TrustedDesktopQueueOriginReceipt {
  version: 1;
}
type QueuedMessageWithDesktopAuthorization = AgentInputQueuedMessage & {
  [TRUSTED_DESKTOP_PI_COMMAND_SNAPSHOT]?: TrustedDesktopPiCommandSnapshot;
};

function isExactPiPackageCommand(text: string): boolean {
  const original = text.trim();
  if (!original || /[\r\n\0]/.test(original)) return false;
  const match = original.match(/^\/?pi\s+(install|update|remove)\s+(.+)$/i);
  return Boolean(match?.[1] && match[2]);
}

function canTrustDesktopPiCommand(item: AgentInputQueuedMessage): boolean {
  const semanticOrigin = item.origin as { kind?: unknown } | undefined;
  return isExactPiPackageCommand(item.text)
    && extractPlainText(item.persistedContent) === item.text
    && (item.files?.length ?? 0) === 0
    && (item.mentions?.length ?? 0) === 0
    && (item.sessionRefs?.length ?? 0) === 0
    && (item.agentReferences?.length ?? 0) === 0
    && item.fromMobileClient !== true
    && item.autoResume !== true
    && item.originalSyntheticTrigger === undefined
    && (semanticOrigin === undefined || semanticOrigin.kind === 'desktop');
}

function withoutDesktopAuthorization(
  item: AgentInputQueuedMessage,
  preserveSemanticOrigin = false,
): QueuedMessageWithDesktopAuthorization {
  const explicitUserItem = { ...item } as QueuedMessageWithDesktopAuthorization;
  if (!preserveSemanticOrigin
    || (item.origin as { kind?: unknown } | undefined)?.kind === 'desktop') delete explicitUserItem.origin;
  delete explicitUserItem[TRUSTED_DESKTOP_PI_COMMAND_SNAPSHOT];
  return explicitUserItem;
}

export function stampTrustedDesktopQueuedOrigin(
  item: AgentInputQueuedMessage,
  deviceLinkInvoke: boolean,
  preserveSemanticOrigin = false,
): AgentInputQueuedMessage {
  const explicitUserItem = withoutDesktopAuthorization(item, preserveSemanticOrigin);
  // This function is called only after trusted input IPC validation, including queue edits.
  // Preserve the user's text independently of any later plugin rewrite, without granting
  // mobile inputs the separate Pi desktop-command privilege.
  delete explicitUserItem.autoReviewUserText;
  const ordinary = !item.autoResume && item.originalSyntheticTrigger === undefined
    && (!item.origin || (item.origin as { kind: string }).kind === 'desktop');
  // Keep the complete input until the shared atomic history budget is applied.
  // Pre-compacting a revocation would leave older grants beside an omission marker.
  if (ordinary) explicitUserItem.autoReviewUserText =
    readAutoReviewUserText(item.persistedContent, item.text) ?? currentAutoReviewResourceIntent(item.persistedContent, item.text);
  if (deviceLinkInvoke || !canTrustDesktopPiCommand(item)) return explicitUserItem;
  const receipt: TrustedDesktopPiCommandSnapshot = {
    version: 1,
    clientId: explicitUserItem.clientId,
    persistedContent: explicitUserItem.persistedContent,
    text: explicitUserItem.text,
  };
  explicitUserItem[TRUSTED_DESKTOP_PI_COMMAND_SNAPSHOT] = receipt;
  return {
    ...explicitUserItem,
    origin: {
      kind: 'desktop',
      [TRUSTED_DESKTOP_QUEUE_ORIGIN]: receipt,
    },
  } as unknown as AgentInputQueuedMessage;
}

/**
 * Stamp device-link provenance at the trusted input IPC boundary.  The queue
 * drains after that AsyncLocalStorage context has ended, so the marker must
 * travel with the main-owned item into the send transaction.
 *
 * 消息来源字段同样在这里无条件覆盖:wire 带来的 `sourceDevice` / `sourcePlugin` /
 * `agentOmitsTriggerPrefix` 一律剥掉,`sourceDevice` 只写入 main 从 invoke context
 * 读到的同账号控制端(共享任务访客、未知平台、本机输入都不写)。
 */
export function stampTrustedDeviceLinkQueuedOrigin(
  item: AgentInputQueuedMessage,
  deviceLinkInvoke: boolean,
  sourceDevice?: MessageSourceDevice,
): AgentInputQueuedMessage {
  const stamped = { ...item };
  if (deviceLinkInvoke) stamped.fromDeviceLinkClient = true;
  else delete stamped.fromDeviceLinkClient;
  // 跳过插件消息钩子只能由本机界面发起；手机/其它电脑的请求一律经执行电脑上的插件过一遍。
  if (deviceLinkInvoke) delete stamped.bypassGhostHooks;
  delete stamped.sourceDevice;
  delete stamped.sourcePlugin;
  delete stamped.agentOmitsTriggerPrefix;
  delete stamped.botTaskCoordination;
  if (deviceLinkInvoke && sourceDevice) stamped.sourceDevice = { ...sourceDevice };
  return stamped;
}

export function restoreTrustedDesktopQueuedOrigin(item: AgentInputQueuedMessage): AgentInputQueuedMessage {
  const queued = item as QueuedMessageWithDesktopAuthorization;
  const receipt = queued[TRUSTED_DESKTOP_PI_COMMAND_SNAPSHOT];
  if (receipt?.version !== 1
    || receipt.clientId !== item.clientId
    || receipt.persistedContent !== item.persistedContent
    || receipt.text !== item.text
    || !canTrustDesktopPiCommand(item)) return withoutDesktopAuthorization(item, true);
  return {
    ...item,
    origin: {
      kind: 'desktop',
      [TRUSTED_DESKTOP_QUEUE_ORIGIN]: receipt,
    },
  } as unknown as AgentInputQueuedMessage;
}

export function revokeTrustedDesktopQueuedOrigin(item: AgentInputQueuedMessage): void {
  const queued = item as QueuedMessageWithDesktopAuthorization;
  delete queued[TRUSTED_DESKTOP_PI_COMMAND_SNAPSHOT];
  if ((item.origin as { kind?: unknown } | undefined)?.kind === 'desktop') delete item.origin;
}

