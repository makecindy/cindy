import { AwayFromComputerSection } from '../../../src/renderer/components/settings/AwayFromComputerSection';
import type { AwayGuardState } from '../../../src/shared/awayGuard';
import { mountPage, subscription } from '../../ui-page/harness';

const state: AwayGuardState = {
  available: true,
  enabled: false,
  delaySeconds: null,
  permission: 'missing',
  permissionAppPath: '/Applications/Cindy Personal.app',
};

// Simulate the owner's separate decision in System Settings. Opening the pane
// alone must leave the preview failure visible, even with the preference off.
subscription('systemGrant')(() => { state.permission = 'granted'; });

void mountPage({
  host: {
    platform: 'darwin',
    osRelease: '27.3.0',
    deviceLink: { getState: async () => ({ keepAwake: false }) },
    windowBehavior: {
      getAwayGuardState: async () => ({ ...state }),
      previewAwayGuard: async () => ({ ok: false, reason: 'permission' }),
    },
    remoteDesktop: {
      openPermission: async (permission: string) => {
        document.documentElement.dataset.openedPermission = permission;
      },
    },
  },
  render: () => <main className="p-6"><AwayFromComputerSection /></main>,
});
