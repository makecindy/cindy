import type {
  RemoteCollectionItem,
  RemoteLocalizedText,
  RemoteResource,
  RemoteResourceStatus,
} from '@cindy/device-link';

import type { BotRemoteResourceSource } from './bots.js';
import { isBotVisibleRemotely } from './botRemoteVisibility.js';
import { isManagedBotAvatarUrl } from '../../../shared/botAvatarValue.js';

export const TEAMMATES_REMOTE_COLLECTION_ID = 'teammates';
export const BOT_REMOTE_RESOURCE_KIND = 'bot';

export const TEAMMATES_TITLE: RemoteLocalizedText = {
  fallback: 'Teammates',
  translations: {
    'zh-CN': '所有伙伴',
    'zh-TW': '所有夥伴',
    ja: 'すべてのチームメイト',
    ko: '모든 팀원',
  },
};

const STATUS_COPY: Readonly<Record<string, RemoteResourceStatus>> = {
  active: {
    label: {
      fallback: 'Available',
      translations: { 'zh-CN': '可用', 'zh-TW': '可用', ja: '利用可能', ko: '사용 가능' },
    },
    tone: 'positive',
  },
  paused: {
    label: {
      fallback: 'Paused',
      translations: { 'zh-CN': '已暂停', 'zh-TW': '已暫停', ja: '一時停止中', ko: '일시 중지됨' },
    },
    tone: 'neutral',
  },
  archived: {
    label: {
      fallback: 'Archived',
      translations: { 'zh-CN': '已归档', 'zh-TW': '已封存', ja: 'アーカイブ済み', ko: '보관됨' },
    },
    tone: 'neutral',
  },
  error: {
    label: {
      fallback: 'Needs attention',
      translations: { 'zh-CN': '需要关注', 'zh-TW': '需要注意', ja: '確認が必要', ko: '확인 필요' },
    },
    tone: 'critical',
  },
  deleting: {
    label: {
      fallback: 'Deleting',
      translations: { 'zh-CN': '删除中', 'zh-TW': '刪除中', ja: '削除中', ko: '삭제 중' },
    },
    tone: 'neutral',
  },
};

const ATTENTION_COPY: RemoteLocalizedText = {
  fallback: 'Needs attention',
  translations: {
    'zh-CN': '需要关注',
    'zh-TW': '需要注意',
    ja: '確認が必要',
    ko: '확인 필요',
  },
};

function resourceRef(id: string) {
  return {
    collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
    kind: BOT_REMOTE_RESOURCE_KIND,
    id,
  } as const;
}

function sourceRevision(source: BotRemoteResourceSource): string {
  return [
    source.currentVersion,
    source.updatedAt,
    source.lastMessageAt ?? 0,
    source.hiddenAt ?? 0,
    source.pinnedAt ?? 0,
    source.activityAt,
    source.canonicalSessionId ?? '',
    source.needsAttention ? 1 : 0,
  ].join(':');
}

export function botRemoteCollectionItemFromSource(
  source: BotRemoteResourceSource,
): RemoteCollectionItem {
  const fallbackText = Array.from(source.name.trim())[0] ?? 'C';
  const status = source.needsAttention
    ? { label: ATTENTION_COPY, tone: 'warning' as const }
    : STATUS_COPY[source.status] ?? { label: source.status || 'Unknown', tone: 'neutral' };
  return {
    ref: resourceRef(source.id),
    display: {
      title: source.name,
      ...(source.description ? { subtitle: source.description } : {}),
      ...(source.lastMessagePreview ? { preview: source.lastMessagePreview } : {}),
      ...(source.activityAt ? { timestamp: source.activityAt } : {}),
      avatar: {
        kind: source.avatar.startsWith('cindy://avatar/')
          ? 'asset'
          : isManagedBotAvatarUrl(source.avatar)
            ? 'media'
            : source.avatar
              ? 'emoji'
              : 'text',
        value: source.avatar,
        fallbackText,
        color: source.avatarColor,
      },
      status,
      ...(source.needsAttention
        ? { badges: [{ accessibilityLabel: ATTENTION_COPY, tone: 'warning' as const }] }
        : {}),
    },
    links: source.canonicalSessionId
      ? [{
          rel: 'conversation',
          target: { kind: 'session', sessionId: source.canonicalSessionId },
        }]
      : [],
    revision: sourceRevision(source),
  };
}

/** Match the authoritative desktop roster: hidden rows stay recoverable on desktop only. */
export function visibleBotRemoteResourceSources(
  sources: readonly BotRemoteResourceSource[],
): BotRemoteResourceSource[] {
  return sources
    .filter(isBotVisibleRemotely)
    .sort((left, right) => {
      const pinned = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt));
      return pinned || right.activityAt - left.activityAt || left.id.localeCompare(right.id);
    });
}

export function botRemoteResourceFromSource(source: BotRemoteResourceSource): RemoteResource {
  const item = botRemoteCollectionItemFromSource(source);
  return {
    ...item,
    ...(source.description
      ? {
          blocks: [{
            id: 'about',
            primitive: 'markdown',
            fallbackMarkdown: source.description,
          }],
        }
      : {}),
  };
}
