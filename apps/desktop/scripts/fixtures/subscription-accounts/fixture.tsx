import { useTranslation } from 'react-i18next';
import { mountPage, subscription } from '../../ui-page/harness';
import { SubscriptionAccountsSection } from '../../../src/renderer/components/settings/SubscriptionAccountsSection';
import { SubscriptionSignInChoices } from '../../../src/renderer/components/settings/SubscriptionSignInChoices';
import { ToastContainer } from '../../../src/renderer/components/ui/toast';
import { QuotaHoverCard } from '../../../src/renderer/components/status/QuotaHoverCard';
import { buildClaudeUsageCard } from '../../../src/renderer/components/status/usageCardModel';
import type { ClaudeSubscriptionUsageSnapshot } from '../../../src/shared/claudeSubscriptionUsage';
import type { MobileCodexRateLimitsResult } from '@cindy/maker-shared/device-link-contract';
import type {
  SubscriptionAccountCommand,
  SubscriptionAccountUsage,
  SubscriptionPoolView,
} from '../../../src/shared/subscriptionAccounts';

// The isolated HTTP fixture lacks secure-context UUIDs; these only correlate mock logins.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

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
function Section({ codexPool, signedOut }: { codexPool: boolean; signedOut: boolean }) {
  const { t } = useTranslation();
  if (codexPool) return <SubscriptionAccountsSection providerId="openai" />;
  return (
    <SubscriptionAccountsSection
      providerId="anthropic"
      // Signed out, the provider has no usage card to hand over.
      defaultUsage={
        signedOut ? undefined : (
          <QuotaHoverCard
            variant="embedded"
            hideIdentity
            account={buildClaudeUsageCard(defaultSnapshot, t)}
          />
        )
      }
      dashboard={{ label: t('settings.providers.usage.openClaudeUsage'), onOpen: () => undefined }}
    />
  );
}

void mountPage({
  host: (ctx) => {
    const isCodex = ctx.case.startsWith('codex') || ctx.case === 'narrow-weight' || ctx.case.startsWith('provider-auth');
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
          ...(isCodex ? { usage: codex(18, 41) } : { loginExpiresAt: new Date(now + 18 * 86_400_000).toISOString() }),
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
          ...(!isCodex ? { loginExpiresAt: new Date(now + 3 * 86_400_000).toISOString() } : {}),
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
    if (ctx.case.startsWith('codex-no-usage')) view.accounts[1].usage = undefined;
    if (ctx.case === 'expiry-past')
      view.accounts[1].loginExpiresAt = new Date(now - 86_400_000).toISOString();
    // Nothing signed in yet: the host lists only the unbound CLI default slot.
    if (ctx.case === 'empty')
      view = {
        providerId: 'anthropic',
        configured: false,
        strategy: 'least',
        accounts: [
          {
            id: 'default',
            directory: '/Users/alex/.claude',
            status: 'signed-out',
            running: 0,
            limit: 4,
            weight: 1,
            paused: false,
          },
        ],
      };
    return {
      openPath: async () => ({ success: true }),
      maker: { usage: {
        getCodexRateLimits: async (providerId = 'openai'): Promise<MobileCodexRateLimitsResult> => ({
          providerId, account: { email: 'ac***@example.com', accountId: '…account', planType: 'pro' },
          rateLimits: {}, rateLimitsByLimitId: null, resetOffer: null,
          rateLimitResetCredits: { availableCount: 1, credits: [{ status: 'available', resetType: 'codexRateLimits',
            grantedAt: 1, expiresAt: hours(24 * 30), title: null, description: null }] },
          autoUse: { accountKey: providerId, settings: { enabled: providerId === 'openai',
            lowQuota: true, minimumDays: 3, expiring: true, expiryMinutes: 60 }, customized: false, lastUsedAt: null },
        }),
      } },
      subscriptionAccounts: {
        onChanged: subscription('subscriptionAccounts'),
        command: async (command: SubscriptionAccountCommand) => {
          if (ctx.case === 'error') throw new Error('Fixture read failure');
          if (ctx.case === 'provider-auth-preview' && command.action === 'preview')
            return {
              ...view,
              configured: false,
              accounts: [{
                ...view.accounts[0],
                identity: undefined,
                plan: undefined,
                usage: undefined,
                status: 'signed-out',
                authIssue: 'codex-provider-managed-auth',
              }],
            };
          if (ctx.case === 'provider-auth' && command.action === 'add')
            throw new Error(
              '[SUBSCRIPTION_CODEX_PROVIDER_AUTH] The active Codex provider does not expose a ChatGPT account',
            );
          if (ctx.case === 'identity-unknown' && command.action === 'login')
            throw new Error('[SUBSCRIPTION_CLAUDE_IDENTITY_UNKNOWN] Account identity is unknown');
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
          else if (command.action === 'login') {
            view = { ...view, accounts: view.accounts.map(account => account.id === command.accountId
              ? { ...account, loginExpiresAt: new Date(now + 30 * 86_400_000).toISOString() } : account) };
          } else if (command.action !== 'read')
            throw new Error('Fixture does not authenticate real accounts');
          return view;
        },
      },
    };
  },
  render: (ctx) => (
    <main
      className="mx-auto w-full max-w-[680px] min-w-0"
      style={ctx.case === 'narrow' || ctx.case === 'narrow-weight' || ctx.case.endsWith('-narrow') ? { maxWidth: 320 } : undefined}
    >
      {ctx.case === 'provider-auth-preview' ? (
        <SubscriptionSignInChoices
          providerId="openai"
          busy={false}
          onConnect={() => undefined}
          onCancel={() => undefined}
        />
      ) : (
        <Section
          codexPool={ctx.case.startsWith('codex') || ctx.case === 'narrow-weight' || ctx.case === 'provider-auth'}
          signedOut={ctx.case === 'empty'}
        />
      )}
      <ToastContainer />
    </main>
  ),
});
