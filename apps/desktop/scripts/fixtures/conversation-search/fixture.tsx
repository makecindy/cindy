import { mountPage } from '../../ui-page/harness';
import { SearchResultsBody } from '../../../src/renderer/features/cc-agent/sidebar/ConversationSearchBox';
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
    _count: { messages: 0 },
  },
  matchKind: 'title', titleMatchIndices: [0, 1, 2, 3, 4, 5], titleScore: 1,
  contentHit: null, contentHits: [], rankScore: 1,
}));

mountPage({
  render: (ctx) => <SearchResultsBody trimmed="Search" status="done" results={ctx.case === 'many-tags' ? results.map(row => ({ ...row, session: { ...row.session, tags: Array.from({ length: 32 }, (_, index) => ({ ...tags[index % 2], id: `tag-${index}`, name: `Tag ${index}` })) } })) : results}
    onSelect={(item) => { document.body.dataset.selectedSession = item.session.id; }} />,
});
