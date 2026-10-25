import {
  REMOTE_RESOURCE_LIST_CHANNEL,
  REMOTE_RESOURCE_MANIFEST_CHANNEL,
  REMOTE_RESOURCE_PROTOCOL_VERSION,
  type RemoteCollectionItem,
  type RemoteCollectionListResponse,
  type RemoteResourceManifestResponse,
} from '@cindy/device-link';
import { UI_MOCK_ID_PREFIX } from '@cindy/maker-shared/ui-mock';

/**
 * `--mock` teammates (docs/dev-rules/ui-mock-data.md): the roster the teammate home and the task
 * home's teammate section read. Invented names and previews only; the three presets ship with the app.
 */
const TEAMMATES = 'teammates';
const MINUTE = 60_000;
const teammates: ReadonlyArray<{ id: string; name: string; preview: string; minutesAgo: number; avatar: RemoteCollectionItem['display']['avatar']; working?: boolean; following?: string[] }> = [
  { id: 'visual-bot-cindy', name: 'Cindy', preview: '登录页窄窗口的错位已经修好，截图放在任务里了。', minutesAgo: 2,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/cindy', fallbackText: 'C' }, working: true,
    // Task rows show the follow mark (`ui-mock` tasks): one shared with LiZi, so the mark picks by name.
    following: ['visual-running', `${UI_MOCK_ID_PREFIX}rich-answer`] },
  { id: 'visual-bot-dash', name: 'Dash', preview: 'Weekly numbers are in: sign-ups up 12%, churn flat.', minutesAgo: 25,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/dash', fallbackText: 'D' } },
  { id: 'visual-bot-lizi', name: 'LiZi', preview: '这个 PR 我看完了，留了两条建议。', minutesAgo: 90,
    avatar: { kind: 'asset', value: 'cindy://avatar/preset/lizi', fallbackText: 'L' },
    following: ['visual-running', `${UI_MOCK_ID_PREFIX}english`] },
  { id: 'visual-bot-xiaoman', name: '小满', preview: '明天上午十点的会已经帮你约好。', minutesAgo: 60 * 20,
    avatar: { kind: 'emoji', value: '🌾', fallbackText: '小' } },
  { id: 'visual-bot-research', name: 'Research Assistant', preview: 'Three sources disagree on the release date; details inside.', minutesAgo: 60 * 30,
    avatar: { kind: 'text', value: 'R', fallbackText: 'R' } },
  { id: 'visual-bot-tuantuan', name: '团团', preview: '开始对话', minutesAgo: 60 * 72,
    avatar: { kind: 'emoji', value: '🐼', fallbackText: '团' } },
];

// Fixed per process: a moving clock would make every row look unread again on each read.
const FIXTURE_NOW = Date.now();

export function teammateVisualFixture(channel: string, args: unknown[], now = FIXTURE_NOW): unknown {
  if (channel === REMOTE_RESOURCE_MANIFEST_CHANNEL) return {
    protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION,
    collections: [{ id: TEAMMATES, resourceKind: 'bot', title: 'Teammates', placement: 'home-scope',
      actions: [{ id: 'open-create', label: 'New teammate' }] }],
  } satisfies RemoteResourceManifestResponse;
  const request = args[0] as { collectionId?: string } | undefined;
  if (channel !== REMOTE_RESOURCE_LIST_CHANNEL || request?.collectionId !== TEAMMATES) return undefined;
  return {
    collectionId: TEAMMATES,
    revision: 'visual-teammates-1',
    items: teammates.map((bot) => ({
      ref: { collectionId: TEAMMATES, kind: 'bot', id: bot.id },
      display: {
        title: bot.name,
        preview: bot.preview,
        timestamp: now - bot.minutesAgo * MINUTE,
        lastReplyAt: now - bot.minutesAgo * MINUTE,
        avatar: bot.avatar,
        ...(bot.working ? { generation: { phase: 'replying', startedAt: now - MINUTE } } : {}),
      },
      links: (bot.following ?? []).map((sessionId) => ({ rel: 'following', target: { kind: 'session' as const, sessionId } })),
      revision: 'visual-1',
    })),
  } satisfies RemoteCollectionListResponse;
}
