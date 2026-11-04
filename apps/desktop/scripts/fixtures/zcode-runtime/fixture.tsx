import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { ProvidersSection } from '../../../src/renderer/components/settings/ProvidersSection';
import { setZCodeScenario } from './state';

void mountPage({
  route: '/settings?tab=providers',
  host: { maker: {
    scanLocalCli: async () => ({ detections: [] }),
    requestProviderModelsAutoRefresh: async () => ({ ok: true }),
    onProvidersChanged: subscription('providersChanged'),
    getModelContextLimit: async () => ({ limit: 1000000, isCustomized: false }),
    getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [] }),
    rediscoverModels: forbid('rediscoverModels'),
    auth: { logout: forbid('auth.logout') },
    setProviderOrder: forbid('setProviderOrder'),
  } },
  render: ctx => {
    setZCodeScenario(ctx.case === 'connected');
    return <main className="h-screen p-4"><ProvidersSection /></main>;
  },
});
