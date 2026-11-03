import { mountPage, subscription } from '../../ui-page/harness';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';

void mountPage({
  host: {
    ghosts: {
      onInstallConsentRequest: subscription('installConsent'),
      onInstallConsentDismissed: subscription('installDismissed'),
      resolveInstallConsent: async () => ({ handled: true }),
    },
  },
  render: () => <GhostInstallConsentHost />,
});
