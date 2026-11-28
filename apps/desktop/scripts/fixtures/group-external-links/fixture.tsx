import { EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES } from '@/cindy-brain/PluginUiContributions';
import { mountPage } from '../../ui-page/harness';
import { PrRefsProvider } from '../../../src/renderer/contexts/PrRefsContext';
import { BotGroupTimelineItem } from '../../../src/renderer/features/bots/BotGroupTimelineItem';

/** Synthetic group messages: the link shapes people paste into feedback groups. */
const MESSAGES: Array<{ id: string; authorKind: 'user' | 'bot'; isSelf?: boolean; authorName: string; content: string }> = [
  {
    id: 'prs',
    authorKind: 'user',
    isSelf: false,
    authorName: '王悦',
    content: '这两个修好了吗 https://github.com/makecindy/cindy/pull/13638 还有 https://github.com/makecindy/cindy/pull/7671 ，另外 https://github.com/makecindy/cindy/pull/99001 还没人看',
  },
  {
    id: 'kinds',
    authorKind: 'user',
    authorName: '我',
    content: [
      '相关的 issue https://github.com/makecindy/cindy/issues/12001',
      '提交 https://github.com/makecindy/cindy/commit/59acc54cbf7d088fa348f39ca8daca745fb65466',
      '代码在 https://github.com/makecindy/cindy/blob/main/apps/desktop/src/renderer/components/chat/PrLinkHoverPopover.tsx#L50-L60',
      '仓库 https://github.com/makecindy/cindy',
    ].join('\n'),
  },
  {
    id: 'web',
    authorKind: 'bot',
    authorName: 'Aster',
    content: '可以参考 https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews?tool=webui#about-pull-request-reviews ，以及[设计规范](https://example.com/design) 和 https://www.example.com/',
  },
];

function Timeline() {
  return (
    <main style={{ padding: 16, width: '100%', maxWidth: 800, margin: '0 auto' }}>
      {MESSAGES.map((message, index) => (
        <BotGroupTimelineItem
          key={message.id}
          pluginUi={EMPTY_PLUGIN_UI_MESSAGE_CANDIDATES}
          message={{
            id: message.id, sequence: index + 1, kind: 'message', authorKind: message.authorKind, isSelf: message.isSelf,
            authorBotId: message.authorKind === 'bot' ? 'aster' : null, authorName: message.authorName,
            content: message.content, mentions: { all: false, botIds: [] }, noticeCode: null, planId: null,
            files: [], attachments: [], createdAt: 1700000000000 + index * 60_000,
          }}
          continued={false}
          authorName={message.authorName}
          avatar={{ name: message.authorName, avatar: null, avatarColor: null }}
          members={[]}
          mentionLabels={[]}
          locale="zh-CN"
          shareScope="group-external-links"
          sharing={false}
          showActions={false}
          onChanged={() => {}}
        />
      ))}
    </main>
  );
}

const status = (prNumber: number, state: string, title: string) => ({
  ok: true, provider: 'github', host: 'github.com', owner: 'makecindy', repo: 'cindy', prNumber,
  status: state, title, htmlUrl: `https://github.com/makecindy/cindy/pull/${prNumber}`,
  branch: 'fixture', unresolvedCount: 0, conflicts: false,
});
/** Synthetic status rows; the real IPC is local-only and cached in main. */
const STATUSES = [
  status(13638, 'open', 'feat(desktop): 群聊外链卡片显示仓库、编号与状态'),
  status(7671, 'merged', 'fix(mobile): 修复长链接在窄屏消息气泡里撑出横向滚动'),
];

mountPage({
  host: () => ({
    gitContext: {
      getPrStatuses: async (queries: Array<{ prNumber: number }>) =>
        STATUSES.filter((row) => queries.some((query) => query.prNumber === row.prNumber)),
      onPrStatusChanged: () => () => {},
      onPrRefsChanged: () => () => {},
      onGithubConnected: () => () => {},
      listAllPrRefs: async () => [],
      listPrRefs: async () => [],
    },
  }),
  render: () => <PrRefsProvider><Timeline /></PrRefsProvider>,
});
