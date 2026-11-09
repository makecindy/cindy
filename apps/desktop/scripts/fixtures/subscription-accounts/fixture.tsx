import { mountPage, subscription } from '../../ui-page/harness';
import { SubscriptionAccountsSection } from '../../../src/renderer/components/settings/SubscriptionAccountsSection';
import type {
  SubscriptionAccountCommand,
  SubscriptionPoolView,
} from '../../../src/shared/subscriptionAccounts';

void mountPage({
  host: (ctx) => {
    const providerId = ctx.case === 'codex' ? 'openai' : 'anthropic';
    let view: SubscriptionPoolView = {
      providerId,
      configured: true,
      strategy: ctx.case === 'codex' ? 'weight' : 'least',
      accounts: [
        {
          id: 'default',
          identity: 'alex@example.com',
          plan: 'Max',
          directory: '/Users/alex/.claude',
          status: 'ready',
          running: 2,
          limit: 4,
          weight: 1,
          paused: false,
          quota: { usedPercent: 28, resetAtMs: 1794096000000, windowMs: 604800000 },
        },
        {
          id: 'second',
          identity: 'long.work.account@research.example.com',
          plan: 'Pro',
          directory: '/Users/alex/.claude-cindy-opaque-id',
          status: 'limited',
          running: 0,
          limit: 2,
          weight: 3,
          paused: false,
          quota: { usedPercent: 100, resetAtMs: 1794096000000, windowMs: 18000000 },
        },
        {
          id: 'third',
          identity: 'personal@example.com',
          plan: 'Max',
          directory: '/Users/alex/.claude-cindy-another-id',
          status: 'ready',
          running: 0,
          limit: 4,
          weight: 1,
          paused: true,
          quota: { usedPercent: 62, resetAtMs: 1794096000000, windowMs: 604800000 },
        },
      ],
    };
    return {
      subscriptionAccounts: {
        onChanged: subscription('subscriptionAccounts'),
        command: async (command: SubscriptionAccountCommand) => {
          if (ctx.case === 'error') throw new Error('Fixture read failure');
          if (command.action === 'configure')
            view = {
              ...view,
              strategy: command.strategy ?? view.strategy,
              accounts: view.accounts.map((a) =>
                a.id === command.accountId
                  ? { ...a, ...(command.paused !== undefined ? { paused: command.paused } : {}) }
                  : a,
              ),
            };
          else if (command.action !== 'read')
            throw new Error('Fixture does not authenticate real accounts');
          return view;
        },
      },
    };
  },
  render: (ctx) => (
    <main className="mx-auto w-full max-w-[680px] min-w-0" style={ctx.case === 'narrow' ? { maxWidth: 320 } : undefined}>
      <SubscriptionAccountsSection providerId={ctx.case === 'codex' ? 'openai' : 'anthropic'} />
    </main>
  ),
});
