import {
  describeRemoteError as describeRemoteErrorShared,
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

/**
 * mobile 侧的 humanizeRemoteError / describeRemoteError:熔断快速失败
 * (DEVICE_UNRESPONSIVE)先走四语言 i18n(与 ConnectionBanner 同一组文案),
 * 其余委托 maker-shared 原实现。共享层的文案是中文硬编码(历史现状),直接
 * 透出会让 en/ja/ko 用户在 Alert / banner 里看到中文(review P1 两轮)——
 * 本 PR 新增的错误码不再走那条老路。mobile 代码一律从本文件 import,
 * 不要直接 import 共享层的这两个函数。
 */
export function humanizeRemoteError(error: unknown): string {
  if (isDeviceUnresponsiveRemoteError(error)) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
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
    || isTransientRemoteError(error)
    || isDeviceUnresponsiveRemoteError(error);
}

export function describeRemoteError(error: string | null): string | null {
  if (error?.includes('DEVICE_UNRESPONSIVE')) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
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
