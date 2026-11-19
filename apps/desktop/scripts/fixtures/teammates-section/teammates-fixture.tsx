import { AppFrame, ctx, mountPage } from '../../ui-page/harness';
import { useState } from 'react';
import { TeammatesSection } from '../../../src/renderer/features/bots/TeammatesSection';
import { sortPinnedSidebarEntries } from '../../../src/renderer/features/cc-agent/lib/pinnedSidebarOrder';
import { loadPinnedSortBy, persistPinnedSortBy, type PinnedSortBy } from '../../../src/renderer/features/cc-agent/hooks/helpers/sidebarFilterCore';

import { PinnedSection } from '../../../src/renderer/features/cc-agent/sidebar/sections/PinnedSection';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
const pinned = ['版本发布', '周报整理', '方案确认'].map((title, i) => ({
  id: `pinned-${i}`, title, preview: ['发布已完成', '本周工作汇总已生成', '等待你确认下一步'][i],
  status: 'active', workspaceKind: 'dialogue', pinnedAt: 1, createdAt: Date.now(), updatedAt: Date.now(),
  lastActivityAt: new Date(Date.now() - (3 - i) * 60000).toISOString(),
  agentType: 'claude',
} as Session));
import { addSessionAttention } from '../../../src/renderer/lib/sessionAttentionStore';
if (ctx.data.showPinned) addSessionAttention('pinned-2', 'awaiting');
const noop = () => {};
function Sections() {
  const [sortBy, setSortBy] = useState(loadPinnedSortBy);
  const [manualPins, setManualPins] = useState(pinned);
  const [reorderCount, setReorderCount] = useState(0);
  const changeSort = (next: PinnedSortBy) => { setSortBy(next); persistPinnedSortBy(next); };
  return <><TeammatesSection />{ctx.data.showPinned === true && <div data-pinned-reorder-count={reorderCount}><PinnedSection
    sortBy={sortBy} onSortByChange={changeSort}
    entries={sortPinnedSidebarEntries(manualPins.map(session => ({ kind: 'session', id: session.id, session })), sortBy)}
    allKnownProjects={[]} renderProject={() => null} runningSessionIds={new Set()}
    attachedSessionIds={new Set()} notifications={new Set(['pinned-1', 'pinned-2'])}
    onSessionClick={noop} onAction={noop} onRename={noop} onTogglePin={noop}
    onReorder={order => {
      setReorderCount(count => count + 1);
      setManualPins(previous => order.map(id => previous.find(session => session.id === id)!));
    }}
  /></div>}</>;
}
// The production sidebar lives in the shell, outside child route elements.
mountPage({
  route: ctx.data.route as string,
  // Pointer-down prefetch stays real; only its local database reads use fixture data.
  host: () => ({
    localDb: {
      sessions: { get: async (id: string) => pinned.find(session => session.id === id) },
      messages: { list: async () => [] },
    },
  }),
  render: () => <AppFrame header={false} sidebarWidth={Number(ctx.data.sidebarWidth) || 260} sidebar={<Sections />} />,
});
