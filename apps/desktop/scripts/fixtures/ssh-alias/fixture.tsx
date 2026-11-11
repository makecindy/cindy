import { mountPage, subscription } from '../../ui-page/harness';
import { RemoteSection } from '../../../src/renderer/components/settings/RemoteSection';

void mountPage({
  host: () => ({
    remoteSsh: {
      list: async () => ({ hosts: [] }),
      onStatusChanged: subscription('sshStatus'),
    },
  }),
  render: () => (
    <main className="h-full overflow-auto p-6" data-ui-page-subject>
      <RemoteSection />
    </main>
  ),
});
