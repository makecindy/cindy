import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mountPage } from '../../ui-page/harness';
import { BotLifecycleSettings } from '../../../src/renderer/features/bots/BotLifecycleSettings';
import { botRouteForOwnedSession } from '../../../src/renderer/features/bots/botSessionOwners';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';

// Persisted roster-shaped input, not a transcript or an in-memory thread summary.
const stored = JSON.stringify({
  id: 'fixture-buddy', name: 'Aster', status: 'active', sessions: [
    { id: 'main-now', title: 'Main', kind: 'chat', role: 'canonical', status: 'active', updatedAt: 1794850200000 },
    { id: 'saved-launch', title: 'Launch plan · 发布计划', kind: 'thread', role: 'thread', status: 'archived', updatedAt: 1794756600000,
      threadRoot: { rootSessionId: 'main-before-upgrade', rootClientId: 'bot-opening:1' } },
    { id: 'saved-review', title: 'Review notes · 复核记录', kind: 'thread', role: 'thread', status: 'active', updatedAt: 1794843000000,
      threadRoot: { rootSessionId: 'main-now', rootClientId: 'bot-opening:1' } },
    { id: 'saved-unresolved', title: 'Original discussion · 原话题记录', kind: 'thread', role: 'thread', status: 'active', updatedAt: 1794846600000 },
    { id: 'deleted-topic', title: 'Deleted topic', kind: 'thread', role: 'thread', status: 'deleted', updatedAt: 1794846600000 },
    { id: 'im-lane', title: 'IM lane', kind: 'channel', role: 'channel', status: 'active', updatedAt: 1794846600000 },
  ],
});

function Fixture() {
  const [generation, reload] = useState(0);
  const location = useLocation();
  const navigate = useNavigate();
  const bot = JSON.parse(stored) as BotProfile;
  return <main className="h-screen overflow-y-auto bg-[var(--surface)] text-[var(--text-primary)]">
    <div className="mx-auto max-w-xl p-6">
      <div data-ui-page-control className="flex gap-4">
        <button onClick={() => reload(value => value + 1)}>Reload saved profile</button>
        <button onClick={() => navigate('/bots/fixture-buddy?settings=1&settingsPage=history')}>Back to history</button>
        <output data-destination>{location.pathname}</output>
      </div>
      <BotLifecycleSettings key={generation} bot={bot} mode="history" onOpenSession={id => {
        const target = botRouteForOwnedSession([bot], id);
        if (!target) throw new Error('Unowned fixture task');
        navigate(target.route);
      }} />
    </div>
  </main>;
}

void mountPage({
  route: '/bots/fixture-buddy?settings=1&settingsPage=history',
  render: () => <Fixture />,
});
