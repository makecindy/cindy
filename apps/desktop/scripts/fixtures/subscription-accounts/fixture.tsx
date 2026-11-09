import { useTranslation } from 'react-i18next';
import { mountPage, subscription } from '../../ui-page/harness';
import { SubscriptionAccountsSection } from '../../../src/renderer/components/settings/SubscriptionAccountsSection';
import { QuotaHoverCard } from '../../../src/renderer/components/status/QuotaHoverCard';
import { buildClaudeUsageCard } from '../../../src/renderer/components/status/usageCardModel';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../src/shared/claudeSubscriptionUsage';
import type {
  SubscriptionAccountCommand,
  SubscriptionAccountUsage,
  SubscriptionPoolView,
} from '../../../src/shared/subscriptionAccounts';

const now = Date.now();
const hours = (value: number) => Math.round(now / 1000 + value * 3600);
const claude = (
  fiveHour: number,
  sevenDay: number,
  fable: number | null,
  resets: [number, number],
): ClaudeSubscriptionUsageSnapshot => ({
  source: 'oauth-endpoint',
  updatedAt: now,
  subscriptionType: 'max',
  fiveHour: { utilization: fiveHour, resetsAt: hours(resets[0]) },
  sevenDay: { utilization: sevenDay, resetsAt: hours(resets[1]) },
  scoped:
    fable === null
      ? []
      : [
          {
            modelId: 'claude-fable',
            modelDisplayName: 'Fable',
            utilization: fable,
            resetsAt: hours(resets[1]),
          },
        ],
});
// The default account's card comes from the provider (ProvidersSection); added accounts carry their own.
const defaultSnapshot = claude(2, 92, 16, [3.6, 76]);
const usage = (snapshot: ClaudeSubscriptionUsageSnapshot): SubscriptionAccountUsage => ({
  claude: snapshot,
});
const codex = (primary: number, secondary: number): SubscriptionAccountUsage => ({
  codex: {
    buckets: {
      codex: {
        limitId: 'codex',
        limitName: null,
        updatedAt: now,
        primary: { usedPercent: primary, windowMinutes: 300, resetsAt: hours(2.2) },
        secondary: { usedPercent: secondary, windowMinutes: 10_080, resetsAt: hours(98) },
      },
    },
    credits: null,
  },
});

/** Mirrors ProvidersSection: the provider card sits in the default row, the usage page in the header. */
function Section({ codexPool }: { codexPool: boolean }) {
  const { t } = useTranslation();
  if (codexPool) return <SubscriptionAccountsSection providerId="openai" />;
  return (
    <SubscriptionAccountsSection
      providerId="anthropic"
      defaultUsage={
        <QuotaHoverCard
          variant="embedded"
          hideIdentity
          account={buildClaudeUsageCard(defaultSnapshot, t)}
        />
      }
      dashboard={{ label: t('settings.providers.usage.openClaudeUsage'), onOpen: () => undefined }}
    />
  );
}

void mountPage({
  host: (ctx) => {
    const isCodex = ctx.case === 'codex' || ctx.case === 'narrow-weight';
    let view: SubscriptionPoolView = {
      providerId: isCodex ? 'openai' : 'anthropic',
      configured: true,
      strategy: isCodex ? 'weight' : 'least',
      accounts: [
        {
          id: 'default',
          identity: 'alex@example.com',
          plan: isCodex ? 'pro' : 'max',
          directory: isCodex ? '/Users/alex/.codex' : '/Users/alex/.claude',
          status: 'ready',
          running: 2,
          limit: 10,
          weight: 1,
          paused: false,
          ...(isCodex ? { usage: codex(18, 41) } : {}),
        },
        {
          id: 'second',
          identity: 'long.work.account@research.example.com',
          plan: isCodex ? 'plus' : 'max',
          directory: '/Users/alex/.claude-cindy-opaque-id',
          status: 'ready',
          running: 0,
          limit: 10,
          weight: 3,
          paused: false,
          usage: isCodex ? codex(100, 64) : usage(claude(16, 24, 0, [2.8, 121])),
        },
        {
          id: 'third',
          identity: 'personal@example.com',
          plan: 'pro',
          directory: '/Users/alex/.claude-cindy-another-id',
          status: 'limited',
          running: 1,
          limit: 4,
          weight: 1,
          paused: true,
          usage: isCodex ? codex(7, 12) : usage(claude(100, 61, null, [0.4, 30])),
        },
      ],
    };
    return {
      openPath: async () => ({ success: true }),
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
    <main
      className="mx-auto w-full max-w-[680px] min-w-0"
      style={ctx.case === 'narrow' || ctx.case === 'narrow-weight' ? { maxWidth: 320 } : undefined}
    >
      <Section codexPool={ctx.case === 'codex' || ctx.case === 'narrow-weight'} />
    </main>
  ),
});
