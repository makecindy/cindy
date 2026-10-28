import {
  formatRemoteError as formatRemoteErrorShared,
  isDeviceUnresponsiveRemoteError,
  isTransientRemoteError,
} from '@cindy/maker-shared/device-link-contract';
import type { DeviceLinkConnectionIssue, DeviceLinkConnectionIssueKind, DeviceLinkStatus } from '@cindy/device-link';
import type { LocalNetworkStatus } from '@/device-link/localNetworkStatus';
import { i18n } from '@/i18n';
import { parseAgentErrorCode } from '@cindy/maker-shared/error-redaction';

export {
  formatRemoteError,
  isPreconditionFailedRemoteError,
} from '@cindy/maker-shared/device-link-contract';

const AGENT_NOT_AUTHENTICATED_RE = /^(?:\[[A-Z_]+\] )?(claude-code|codex|pi) not authenticated: ?(.*)$/;

const CONNECTION_ISSUE_COPY_KEYS: Record<
  DeviceLinkConnectionIssueKind,
  { title: string; hint: string }
> = {
  'auth-failed': { title: 'deviceLink.authFailedTitle', hint: 'deviceLink.authFailedHint' },
  'device-removed': { title: 'deviceLink.deviceRemovedTitle', hint: 'deviceLink.deviceRemovedHint' },
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

/** Shared by Home and detail banners. Only native evidence blames the phone;
 * only an online service's device verdict blames the computer. */
export function connectionHealthCopy(input: {
  network: LocalNetworkStatus;
  status: DeviceLinkStatus;
  issue: DeviceLinkConnectionIssue | null;
  deviceDisconnected?: boolean;
  deviceUnresponsive?: boolean;
}): { title: string; hint: string } | null {
  if (input.network === 'unavailable') {
    return { title: i18n.t('deviceLink.localNetwork.title'), hint: i18n.t('deviceLink.localNetwork.hint') };
  }
  if (input.issue && (input.status !== 'online' || input.issue.kind === 'unstable')) {
    return { title: connectionIssueTitle(input.issue.kind), hint: connectionIssueHint(input.issue.kind) };
  }
  if (input.status !== 'online') {
    return { title: i18n.t('deviceLink.serviceConnection.title'), hint: i18n.t('deviceLink.serviceConnection.hint') };
  }
  if (input.deviceDisconnected) {
    return { title: i18n.t('deviceLink.cachedHistory.title'), hint: i18n.t('deviceLink.cachedHistory.hint') };
  }
  if (input.deviceUnresponsive) {
    return { title: i18n.t('deviceLink.deviceUnresponsiveTitle'), hint: i18n.t('deviceLink.deviceUnresponsiveHint') };
  }
  return null;
}

export function relayStatusLabel(status: DeviceLinkStatus): string {
  return i18n.t(`deviceLink.relay.label.${status}`);
}

export function relayStatusHint(status: DeviceLinkStatus, lastSyncedAt: number | null): string {
  if (status === 'online') {
    if (!lastSyncedAt) return i18n.t('deviceLink.relay.hint.online');
    const time = new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(lastSyncedAt));
    return i18n.t('deviceLink.relay.hint.lastSynced', { time });
  }
  return i18n.t(`deviceLink.relay.hint.${status}`);
}

export function describeAgentAuthError(error: string | null | undefined): string | null {
  if (!error) return null;
  const matched = AGENT_NOT_AUTHENTICATED_RE.exec(error.trim());
  if (!matched) return null;
  const agent = matched[1] === 'claude-code' ? 'Claude' : matched[1] === 'pi' ? 'Pi' : 'Codex';
  const reason = matched[2] || 'unknown';
  const reasonKey: Record<string, string> = {
    no_key: 'noKey',
    no_oauth: 'noOauth',
    no_credentials: 'noCredentials',
    no_encryption: 'noEncryption',
    proxy_not_ready: 'proxyNotReady',
  };
  return i18n.t(`deviceLink.agentAuth.${reasonKey[reason] ?? 'default'}`, {
    agent,
    reason,
  });
}

/** 结构化运行错误保留 marker 做状态分类，展示文案复用 Mobile i18n。 */
function localizedRuntimeErrorCopy(error: unknown): string | null {
  const formatted = typeof error === 'string' ? error : formatRemoteErrorShared(error);
  if (formatted.includes('[REMOTE_AGENT_MEMBER_BUDGET_PAUSED]')) return i18n.t('session.remoteError.REMOTE_AGENT_MEMBER_BUDGET_PAUSED');
  const agentCode = parseAgentErrorCode(formatted)?.code;
  if (agentCode && i18n.exists(`session.remoteError.${agentCode}`)) return i18n.t(`session.remoteError.${agentCode}`);
  if (formatted.includes('DEVICE_OFFLINE')) return i18n.t('session.menu.aiRenameOffline');
  if (formatted.includes('NOT_CONNECTED')) return i18n.t('session.screen.networkReconnecting');
  return null;
}

/**
 * Mobile display copy stays in the interface language. Known markers use
 * deviceLink.remoteError; anything else uses the localized unclassified
 * summary. Do not fall through to maker-shared Chinese strings.
 */
export function humanizeRemoteError(error: unknown): string {
  if (isDeviceUnresponsiveRemoteError(error)) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  const recoveryCopy = localizedRuntimeErrorCopy(error);
  if (recoveryCopy) return recoveryCopy;
  const formatted = typeof error === 'string' ? error : formatRemoteErrorShared(error);
  const localized = localizedStableRemoteError(formatted);
  if (localized) return localized;
  return i18n.t('deviceLink.remoteError.unclassified');
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
 * 被控端因任务仍在运行而拒绝操作（如删除消息）。handler 的 `[SESSION_RUNNING]`
 * 前缀随隧道放在 message 里（外层 code 为 IPC_ERROR），code 与 message 两种形态都认。
 */
export function isSessionRunningRemoteError(error: unknown): boolean {
  return formatRemoteErrorShared(error).includes('SESSION_RUNNING');
}

/**
 * 权威同步的一轮内置瞬态重试耗尽后，页面继续自动恢复所用的外层退避。
 * 900ms 尽快吃掉短抖动，随后指数放缓并封顶 30s，避免电脑长期离线时形成请求风暴。
 */
export function connectionRecoverySyncRetryDelayMs(attempt: number): number {
  return Math.min(900 * 2 ** Math.max(0, Math.floor(attempt)), 30_000);
}

export function describeRemoteError(error: string | null): string | null {
  if (!error) return null;
  if (error.includes('DEVICE_UNRESPONSIVE')) {
    return i18n.t('deviceLink.deviceUnresponsiveHint');
  }
  const recoveryCopy = localizedRuntimeErrorCopy(error);
  if (recoveryCopy) return recoveryCopy;
  const agentAuth = describeAgentAuthError(error);
  if (agentAuth) return agentAuth;
  const localized = localizedStableRemoteError(error);
  if (localized) return localized;
  return i18n.t('deviceLink.remoteError.unclassified');
}

function localizedStableRemoteError(error: string): string | null {
  const simpleMarkers: Array<[string, string]> = [
    ['MODEL_VISIBILITY_NOT_READY', 'transient'],
    ['REMOTE_DISABLED', 'remoteDisabled'],
    ['CHANNEL_NOT_ALLOWED', 'channelNotAllowed'],
    ['ACCESS_REVOKED', 'accessRevoked'],
    ['DEVICE_UNRESPONSIVE', 'deviceUnresponsive'],
    ['VERSION_MISMATCH', 'versionMismatch'],
    ['PAYLOAD_TOO_LARGE', 'payloadTooLarge'],
    ['MEDIA_FETCH_FAILED', 'mediaFetchFailed'],
    ['VOICE_TRANSCRIBE_FAILED', 'voiceTranscribeFailed'],
    ['LINK_NOT_OPEN', 'linkNotOpen'],
  ];
  for (const [marker, key] of simpleMarkers) {
    if (error.includes(marker)) return i18n.t(`deviceLink.remoteError.${key}`);
  }
  if (error.includes('PRECONDITION_FAILED')) {
    if (error.includes('ACCOUNT_CHANGED')) return i18n.t('deviceLink.remoteError.accountChanged');
    if (error.includes('OFFER_EXPIRED')) return i18n.t('deviceLink.remoteError.offerExpired');
    return i18n.t('deviceLink.remoteError.preconditionFailed');
  }
  if (isTransientRemoteError(error)) return i18n.t('deviceLink.remoteError.transient');
  if (/(^|\[|\s)NOT_FOUND(\]|\s|:|$)/.test(error)) return i18n.t('deviceLink.remoteError.notFound');
  if (error.includes('BAD_REQUEST') || error.includes('INTERNAL')) {
    return i18n.t('deviceLink.remoteError.callFailed', { error });
  }
  return null;
}

/**
 * 只有确定性远端错误才锁 composer；断线、弱网、超时与熔断由本地 outbox 接住，
 * 恢复后自动派发。返回 null 表示 composer 可以继续收消息。
 */
const COMPOSER_BLOCKING_MARKERS = [
  'ACCESS_REVOKED',
  'REMOTE_DISABLED',
  'CHANNEL_NOT_ALLOWED',
  'VERSION_MISMATCH',
] as const;

export function describeRemoteComposerBlockingError(error: string | null): string | null {
  if (!error || isAutoRecoveringRemoteError(error)) return null;
  const agentAuth = describeAgentAuthError(error);
  if (agentAuth) return agentAuth;
  if (!COMPOSER_BLOCKING_MARKERS.some((marker) => error.includes(marker))) return null;
  return localizedStableRemoteError(error);
}
