import { useLocation } from 'react-router-dom';

import { SessionContentHeaderRegistration } from '@/features/cc-agent/SessionContentHeader';
import type { Session } from '@/lib/ccAgent.types';
import { AppFrame, mountPage, subscription } from '../../ui-page/harness';

function SwitcherHeader({ sessions }: { sessions: readonly Session[] }) {
  const route = useLocation();
  const current = sessions.find((session) => `/cc-agent/${session.id}` === route.pathname);
  return <>
    {current && <SessionContentHeaderRegistration session={current} />}
    <output hidden data-testid="fixture-route">{route.pathname}</output>
  </>;
}

void mountPage({
  route: '/cc-agent/current-task',
  host: {
    deviceLink: {
      getState: async () => ({ linkStatus: 'disconnected' }),
      onStatusChanged: subscription('device-status'),
    },
  },
  render: ({ data }) => (
    <AppFrame>
      <SwitcherHeader sessions={data.sessions as Session[]} />
      <div className="min-h-0 flex-1" data-ui-page-subject />
    </AppFrame>
  ),
});
