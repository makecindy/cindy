import {
  describeRemoteError as describeRemoteErrorShared,
  formatRemoteError as formatRemoteErrorShared,
  humanizeRemoteError as humanizeRemoteErrorShared,
  isDeviceUnresponsiveRemoteError,
  isTransientRemoteError,
} from '@cindy/maker-shared/device-link-contract';
import type { DeviceLinkConnectionIssueKind } from '@cindy/device-link';
import { i18n } from '@/i18n';

export {
  describeAgentAuthError,
  formatRemoteError,
  isPreconditionFailedRemoteError,
  relayStatusHint,
  relayStatusLabel,
} from '@cindy/maker-shared/device-link-contract';

const CONNECTION_ISSUE_COPY_KEYS: Record<
  DeviceLinkConnectionIssueKind,
  { title: string; hint: string }
> = {
  'auth-failed': { title: 'deviceLink.authFailedTitle', hint: 'deviceLink.authFailedHint' },
  replaced: { title: 'deviceLink.replacedTitle', hint: 'deviceLink.replacedHint' },
  'too-many-connections': {
    title: 'deviceLink.tooManyConnectionsTitle',
    hint: 'deviceLink.tooManyConnectionsHint',
  },
  'version-mismatch': {
    title: 'deviceLink.versionMismatchTitle',
    hint: 'deviceLink.versionMismatchHint',
  },
  unstable: { title: 'deviceLink.unstableTitle', hint: 'deviceLink.unstableHint' },
};

/** Mobile 连接问题标题/提示统一走 i18n,避免同一 banner 混用本地化与中文硬编码。 */
export function connectionIssueTitle(kind: DeviceLinkConnectionIssueKind): string {
  return i18n.t(CONNECTION_ISSUE_COPY_KEYS[kind].title);
}

export function connectionIssueHint(kind: DeviceLinkConnectionIssueKind): string {
  return i18n.t(CONNECTION_ISSUE_COPY_KEYS[kind].hint);
}

/** 自动恢复类连接错误保留结构化 marker 做状态分类，展示文案则复用 Mobile i18n。 */
function localizedConnectionRecoveryCopy(error: unknown): string | null {
  const formatted = typeof error === 'string' ? error : formatRemoteErrorShared(error);
  if (formatted.includes('DEVICE_OFFLINE')) return i18n.t('session.menu.aiRenameOffline');
  if (formatted.includes('NOT_CONNECTED')) return i18n.t('session.screen.networkReconnecting');
  return null;
}

/**
 * mobile 侧的 humanizeRemoteError / describeRemoteError:熔断快速失败与 Stop
 * 会主动产生的自动恢复错误先走 Mobile i18n,其余委托 maker-shared 原实现。
 * 共享层的文案是中文硬编码(历史现状),新接入的错误出口不能直接透给其它语言
 * 用户。mobile 代码一律从本文件 import,不要直接 import 共享层的这两个函数。
 */
export function humanizeRemoteError(error: unknown): string {
  if (isDeviceUnresponsiveRemoteError(error)) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  const recoveryCopy = localizedConnectionRecoveryCopy(error);
  if (recoveryCopy) return recoveryCopy;
  return humanizeRemoteErrorShared(error);
}

/**
 * 连接恢复中的错误不会转成用户手动处理的失败态。
 *
 * DEVICE_UNRESPONSIVE 在通用 retry helper 里故意归为 permanent（避免熔断 open
 * 时原地重试风暴），但对消息 outbox 来说仍是自动探测可恢复状态，必须留在本地
 * 等熔断关闭，而不是让用户重发。
 */
export function isAutoRecoveringRemoteError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return code === 'SESSION_REFERENCE_OFFLINE'
    || message.includes('SESSION_REFERENCE_OFFLINE')
    // 桌面端 fail-closed：持久消息 / input coordinator 暂时无法完成 clientId
    // 去重核验。原消息必须留在 outbox 等状态恢复，不能让用户换 id 重发。
    || message.includes('REMOTE_OPTIMISTIC_SESSION_STATE_UNAVAILABLE')
    || isTransientRemoteError(error)
    || isDeviceUnresponsiveRemoteError(error);
}

/**
 * 权威同步的一轮内置瞬态重试耗尽后，页面继续自动恢复所用的外层退避。
 * 900ms 尽快吃掉短抖动，随后指数放缓并封顶 30s，避免电脑长期离线时形成请求风暴。
 */
export function connectionRecoverySyncRetryDelayMs(attempt: number): number {
  return Math.min(900 * 2 ** Math.max(0, Math.floor(attempt)), 30_000);
}

export function describeRemoteError(error: string | null): string | null {
  if (error?.includes('DEVICE_UNRESPONSIVE')) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  const recoveryCopy = localizedConnectionRecoveryCopy(error);
  if (recoveryCopy) return recoveryCopy;
  return describeRemoteErrorShared(error);
}

/**
 * 只有确定性远端错误才锁 composer；断线、弱网、超时与熔断由本地 outbox 接住，
 * 恢复后自动派发。返回 null 表示 composer 可以继续收消息。
 */
export function describeRemoteComposerBlockingError(error: string | null): string | null {
  if (!error || isAutoRecoveringRemoteError(error)) return null;
  return describeRemoteError(error);
}
