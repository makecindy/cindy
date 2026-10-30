import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { ProvidersSection } from '../../../src/renderer/components/settings/ProvidersSection';
import { setScenario } from './state';

void mountPage({
  route: '/settings?tab=providers',
  host: {
    maker: {
      scanLocalCli: async () => ({ detections: [] }),
      requestProviderModelsAutoRefresh: async () => ({ ok: true }),
      onProvidersChanged: subscription('providersChanged'),
      getModelContextLimit: async () => ({ limit: 272000, isCustomized: false }),
      getCapabilities: async () => ({ availableModels: [], effortLevels: [], permissionModes: [] }),
      setProviderOrder: forbid('setProviderOrder'),
    },
    modelAccess: { retry: forbid('retry'), rotate: forbid('rotate') },
  },
  render: ctx => {
    setScenario(ctx.case);
    return <main className="h-screen p-4"><ProvidersSection /></main>;
  },
});
