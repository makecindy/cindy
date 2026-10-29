import { AppFrame, mountPage } from '../../ui-page/harness';
import { MenuButton } from '../../../src/renderer/components/title-bar/MenuButton';
import { ApprovalsInbox } from '../../../src/renderer/features/approvals/ApprovalsInbox';

mountPage({
  route: '/approvals',
  host: {
    localDb: {
      orcaWorkflows: {
        projectLabel: async (sessionId: string) => {
          const name = sessionId.startsWith('s-a11y')
            ? 'customer-portal-localization-monorepo-2026-q4'
            : sessionId === 's-backend' ? 'billing-service' : 'cindy-desktop';
          return { name, path: '/Users/example/projects/' + name };
        },
      },
    },
  },
  render: () => (
    <AppFrame>
      {/* The real MenuButton, placed like ChromeActions (collapse, menu, history) so the count badge
          can be judged next to its neighbours; the neighbours are inert 28 px stand-ins. */}
      <div className="pointer-events-none absolute left-2 top-0 z-20 flex h-[46px] items-center gap-1">
        <span className="h-7 w-7 rounded-md border border-[var(--border-default)]" />
        <span className="pointer-events-auto"><MenuButton /></span>
        <span className="h-7 w-7 rounded-md border border-[var(--border-default)]" />
        <span className="h-7 w-7 rounded-md border border-[var(--border-default)]" />
      </div>
      <ApprovalsInbox />
    </AppFrame>
  ),
});
