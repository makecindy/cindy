import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { ProvidersSection } from '../../../src/renderer/components/settings/ProvidersSection';
import { mountPage, subscription, forbid } from '../../ui-page/harness';
import type { SubscriptionAccountCommand } from '../../../src/shared/subscriptionAccounts';

// The isolated HTTP fixture lacks secure-context randomUUID. These are only
// correlation IDs for mock login/cancel commands; no credential is generated.
if (!crypto.randomUUID) {
  let sequence = 0;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
}

const provider = (id: string, name?: string) => ({
  ...BUNDLED_CATALOG.providers.find(item => item.id === id)!,
  connected: true, remoteInvocationEnabled: true,
  ...(name ? { name } : {}),
});
const providers = [provider('openai'), provider('anthropic')];
const group = {
  strategy: 'least', autoSwitch: true,
  members: [{ kind: 'local' }, { kind: 'device', agentDeviceId: 'fixture-executor', providerId: 'anthropic' }],
};
const entries = [provider('anthropic', 'Team Anthropic'), provider('openai', 'Private OpenAI')];
entries[0] = { ...entries[0], group } as typeof entries[0];
const snapshot = {
  providers, providerOrder: providers.map(item => item.id), ownerGeneration: 1,
  loading: false, error: null, refetch: () => {
    if (!refreshControl.defer) return Promise.resolve();
    refreshControl.pending = true;
    return new Promise<void>(resolve => { refreshControl.release = () => { refreshControl.pending = false; resolve(); }; });
  },
};
const refreshControl = { defer: false, pending: false, release: (): void => {} };
const keySaveControl = { pending: false, release: (): void => {} };
// Example quota snapshots in the host's own formats: 5 hours, weekly and one model-specific window.
const accountUsage = (providerId: string, [session, week, model]: number[]) => {
  const now = Date.now();
  const window = (utilization: number, hours: number) => ({ utilization, resetsAt: Math.floor(now / 1000) + hours * 3600 });
  if (providerId === 'anthropic') return { claude: {
    source: 'oauth-endpoint' as const, updatedAt: now, fiveHour: window(session, 4), sevenDay: window(week, 121),
    scoped: [{ modelId: 'claude-fable', modelDisplayName: 'Fable', ...window(model, 121) }],
  } };
  const bucket = (usedPercent: number, windowMinutes: number, hours: number) =>
    ({ usedPercent, windowMinutes, resetsAt: Math.floor(now / 1000) + hours * 3600 });
  return { codex: {
    buckets: { codex: { limitId: 'codex', limitName: null, updatedAt: now, primary: bucket(session, 300, 4), secondary: bucket(week, 10_080, 121) } },
    credits: null,
  } };
};
const subscriptionControl = { connected: false, commands: [] as { action?: string; providerId: string; loginKey?: string }[], cancel: (): void => {} };
const unusedReceived = [{
  shareId: 'fixture-received', memberId: 'fixture-member', providerId: 'anthropic',
  providerLabel: 'Anthropic', hostDeviceId: 'fixture-share-host', deviceName: 'Example computer',
  owner: { displayName: 'Alex', avatarUrl: null, region: 'global' },
  status: 'paused', hostOnline: true, hostCapable: true,
}];
Object.assign(window, { providerSourcesFixture: {
  snapshot,
  refreshControl,
  keySaveControl,
  subscriptionControl,
  devices: [] as { deviceId: string; name: string; platform: string }[],
  catalogs: new Map<string, { providers: typeof entries; loading: boolean; error: null }>(),
  received: { received: [] as typeof unusedReceived, loaded: true },
} });

mountPage({
  route: '/settings?tab=providers&connect=openai',
  host: ctx => {
    const fixture = (window as unknown as { providerSourcesFixture: { devices: unknown[]; catalogs: Map<string, unknown> } }).providerSourcesFixture;
    if (ctx.case !== 'single-computer') {
      const remote = [provider('openai'), provider('anthropic')];
      fixture.devices.push({ deviceId: 'mbp', name: 'MBP-M5', platform: 'darwin' }, { deviceId: 'mini', name: 'Chris的Mac mini', platform: 'darwin' });
      for (const id of ['mbp', 'mini']) fixture.catalogs.set(id, { providers: remote, loading: false, error: null });
    }
    if (ctx.case === 'borrowing') snapshot.providers[0] = { ...snapshot.providers[0], connected: false };
    // Anthropic was never signed in here (no removed flag): it must still be listed, borrowed from another computer.
    if (ctx.case === 'never-signed-in') snapshot.providers[1] = { ...snapshot.providers[1], connected: false };
    if (ctx.case === 'pinned') snapshot.providers[0] = { ...snapshot.providers[0], runLocation: 'mbp' } as typeof snapshot.providers[0];
    refreshControl.defer = ctx.case === 'wizard-reopen';
    if (ctx.case === 'builtin-save-guard') snapshot.providers.push({
      ...provider('anthropic'), id: 'gemini', name: 'Gemini', connected: false,
      agents: [], auth: { method: 'apiKey' }, audioModels: [{ id: 'fixture-media', name: 'Fixture' }],
    });
    return {
      subscriptionAccounts: {
        command: async (command: SubscriptionAccountCommand) => {
          subscriptionControl.commands.push(command);
          if (command.action === 'cancel') subscriptionControl.cancel();
          if (command.action === 'add' || command.action === 'connect') {
            if (ctx.case === 'subscription-cancel') await new Promise<void>((_resolve, reject) => {
              subscriptionControl.cancel = () => reject(new Error('SUBSCRIPTION_LOGIN_CANCELLED'));
            });
            subscriptionControl.connected = true;
          }
          const configured = ctx.case !== 'borrowing' && !(ctx.case === 'never-signed-in' && command.providerId === 'anthropic');
          const directory = command.providerId === 'anthropic' ? '/Users/alex/.claude' : '/Users/alex/.codex';
          const defaultAccount = { id: 'default', identity: 'alex@example.com',
            plan: command.providerId === 'anthropic' ? 'Max' : 'Plus', status: 'ready', directory,
            running: 0, paused: false, limit: 4, weight: 1 };
          return { providerId: command.providerId, configured, strategy: 'least', accounts: configured ? [
            { ...defaultAccount, usage: accountUsage(command.providerId, [12, 34, 8]) },
          ] : command.action === 'preview' ? [defaultAccount] : [] };
        },
        onChanged: subscription('subscriptionAccountsChanged'),
      },
      builtinApiKeyStore: async () => {
        keySaveControl.pending = true;
        await new Promise<void>(resolve => { keySaveControl.release = () => { keySaveControl.pending = false; resolve(); }; });
      },
      maker: {
        listProviders: async () => snapshot,
        scanLocalCli: async () => ({ detections: [] }),
        requestProviderModelsAutoRefresh: async () => ({ ok: true }),
        setProviderOrder: forbid('setProviderOrder'),
        setProviderRunLocation: async () => ({ ok: true }),
        listProviderPresets: async () => ({ presets: BUNDLED_CATALOG.presets ?? [] }),
        localModelList: async () => ({ status: { kind: 'ready' }, models: [], memoryGb: 0 }),
        localModelStatus: async () => ({ kind: 'ready' }),
        localModelEnsure: async () => ({ ok: true }),
        onLocalModelStatus: subscription('localModelStatus'),
        onProviderOAuthProgress: subscription('providerOAuthProgress'),
      },
      deviceLink: { getState: async () => ({ remoteControlEnabled: true }) },
      providerShare: {
        command: async () => ({ ready: true, providerIds: [] }),
        onOwnedChanged: subscription('ownedChanged'),
      },
      providerGroup: {
        command: async (command: { action: string }) => command.action === 'list' ? {}
          : { ready: true, providerIds: [] },
        onChanged: subscription('groupChanged'),
      },
    };
  },
  render: () => <div className="h-screen p-5"><ProvidersSection /></div>,
});
