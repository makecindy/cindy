import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { ProvidersSection } from '../../../src/renderer/components/settings/ProvidersSection';
import { mountPage, subscription, forbid } from '../../ui-page/harness';

const provider = (id: string, name?: string) => ({
  ...BUNDLED_CATALOG.providers.find(item => item.id === id)!,
  connected: true, remoteInvocationEnabled: true,
  ...(name ? { name } : {}),
});
const providers = [provider('anthropic'), provider('openai')];
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
const received = [{
  shareId: 'fixture-received', memberId: 'fixture-member', providerId: 'anthropic',
  providerLabel: 'Anthropic', hostDeviceId: 'fixture-share-host', deviceName: 'Example computer',
  owner: { displayName: 'Alex', avatarUrl: null, region: 'global' },
  status: 'paused', hostOnline: true, hostCapable: true,
}];
Object.assign(window, { providerSourcesFixture: {
  snapshot,
  refreshControl,
  devices: [{ deviceId: 'fixture-host', name: 'Studio', platform: 'darwin' }],
  catalogs: new Map([['fixture-host', { providers: entries, loading: false, error: null }]]),
  received: { received, loaded: true },
} });

mountPage({
  route: '/settings?tab=providers&connect=anthropic',
  host: ctx => {
    refreshControl.defer = ctx.case === 'wizard-reopen';
    return {
      maker: {
        listProviders: async () => snapshot,
        scanLocalCli: async () => ({ detections: [] }),
        requestProviderModelsAutoRefresh: async () => ({ ok: true }),
        setProviderOrder: forbid('setProviderOrder'),
        listProviderPresets: async () => ({ presets: BUNDLED_CATALOG.presets ?? [] }),
        localModelList: async () => ({ status: { kind: 'ready' }, models: [], memoryGb: 0 }),
        localModelStatus: async () => ({ kind: 'ready' }),
        localModelEnsure: async () => ({ ok: true }),
        onLocalModelStatus: subscription('localModelStatus'),
        onProviderOAuthProgress: subscription('providerOAuthProgress'),
      },
      deviceLink: { getState: async () => ({ remoteControlEnabled: true }) },
      providerShare: {
        command: async () => ({ ready: true, providerIds: ctx.case === 'no-outgoing-shares' ? [] : ['openai'] }),
        onOwnedChanged: subscription('ownedChanged'),
      },
      providerGroup: {
        command: async (command: { action: string }) => command.action === 'list' ? {}
          : { ready: true, providerIds: ctx.case === 'no-outgoing-shares' ? [] : ['anthropic'] },
        onChanged: subscription('groupChanged'),
      },
    };
  },
  render: () => <div className="h-screen p-5"><ProvidersSection /></div>,
});
