import { forbid, mountPage, subscription } from '../../ui-page/harness';
import {
  SearchResultsBody,
  type SearchResultTaskMenuActions,
} from '../../../src/renderer/features/cc-agent/sidebar/ConversationSearchBox';
import {
  buildFallbackSessionFromSearchSummary,
  createSearchResultTaskMenuActions,
} from '../../../src/renderer/features/cc-agent/sidebar/SearchResultTaskMenu';
import type { ConversationSearchResultItem } from '../../../src/shared/conversationSearch';

const tags = [
  { id: 'important', name: 'Important', nameCustomized: true, color: 'red' as const, favoriteOrder: null, revision: 1 },
  { id: 'later', name: 'Later', nameCustomized: true, color: 'blue' as const, favoriteOrder: null, revision: 1 },
];
const results: ConversationSearchResultItem[] = [
  { title: 'Search labels', tags },
  { title: 'Search a very long task title that should truncate before hiding its labels', tags },
  { title: 'Search without labels', tags: [] },
  { title: 'Search from an older host' },
].map((row, index) => ({
  session: {
    id: `fixture-${index}`, ...row,
    workingDir: null, workspaceKind: 'dialogue', agentKind: 'cc', status: 'active',
    userSendAt: null, updatedAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z',
    _count: { messages: 2 },
  },
  matchKind: 'title', titleMatchIndices: [0, 1, 2, 3, 4, 5], titleScore: 1,
  contentHit: null, contentHits: [], rankScore: 1,
}));

const companionResult: ConversationSearchResultItem = {
  session: {
    id: 'fixture-companion',
    title: 'Search teammate private chat',
    workingDir: null,
    workspaceKind: 'dialogue',
    agentKind: 'pi',
    status: 'active',
    source: 'bot',
    userSendAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    _count: { messages: 2 },
    companion: { id: 'bot-1', name: 'Melody', role: 'canonical', readOnly: false },
  },
  matchKind: 'title',
  titleMatchIndices: [0, 1, 2, 3, 4, 5],
  titleScore: 1,
  contentHit: null,
  contentHits: [],
  rankScore: 0.9,
};

const contextMenuResults: ConversationSearchResultItem[] = [...results, companionResult];
const liveById = new Map(
  contextMenuResults.map((row) => [
    row.session.id,
    buildFallbackSessionFromSearchSummary(row.session),
  ]),
);

const fixtureTaskMenu: SearchResultTaskMenuActions = createSearchResultTaskMenuActions({
  resolveSession: (summary) => liveById.get(summary.id) ?? null,
  onAction: forbid('taskMenu.onAction'),
  onRename: forbid('taskMenu.onRename'),
  onTogglePin: forbid('taskMenu.onTogglePin'),
  onMoveSession: forbid('taskMenu.onMoveSession'),
  projectOptions: [],
});

mountPage({
  route: '/',
  host: {
    ghosts: {
      listSync: () => ({ ghosts: [] }),
      onChanged: subscription('installedGhosts'),
      runtimePlugins: async () => ({}),
      listControlPointCandidates: async () => [],
    },
    sharedTask: {
      host: async () => ({ available: false, detail: null }),
    },
    localDb: {
      taskTags: {
        execute: async () => ({
          tags,
          sessions: results.map((row) => ({
            sessionId: row.session.id,
            tags: row.session.tags ?? [],
          })),
        }),
      },
    },
    worktreeRemovalPreview: async () => ({ hasWorktree: false, dirty: false }),
    maker: {
      openSessionInNewWindow: forbid('maker.openSessionInNewWindow'),
    },
  },
  render: (ctx) => (
    <SearchResultsBody
      trimmed="Search"
      status="done"
      results={
        ctx.case === 'many-tags'
          ? results.map((row) => ({
              ...row,
              session: {
                ...row.session,
                tags: Array.from({ length: 32 }, (_, index) => ({
                  ...tags[index % 2],
                  id: `tag-${index}`,
                  name: `Tag ${index}`,
                })),
              },
            }))
          : ctx.case === 'context-menu'
            ? contextMenuResults
            : results
      }
      taskMenu={ctx.case === 'context-menu' ? fixtureTaskMenu : undefined}
      onSelect={(item) => {
        document.body.dataset.selectedSession = item.session.id;
      }}
    />
  ),
});
