import { mountPage } from '../../ui-page/harness';
import { RemotePluginUiEnablePrompt } from '../../../src/renderer/components/new-chat/RemotePluginUiEnablePrompt';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
// Isolated screenshot origin is HTTP, unlike Cindy's secure production origin.
if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => '00000000-0000-4000-8000-000000000001' });
setDataOwnerGeneration('fixture-owner');
mountPage({ host: { deviceLink: { onRemotePush: () => () => {} } }, render: () =>
  <main className="p-4"><RemotePluginUiEnablePrompt deviceId="computer" /></main> });
