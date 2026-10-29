import { ComputerUseSection } from '../../../src/renderer/components/settings/ComputerUseSection';
import { mountPage, subscription } from '../../ui-page/harness';

void mountPage({
  host: (ctx) => ({
    maker: {
      plugins: {
        getState: async (id: string) => {
          if (ctx.case === 'loading' && id === 'computer') return new Promise(() => {});
          return { effectiveEnabled: id === 'browser' };
        },
      },
      browser: {
        status: async () => {
          if (ctx.case === 'loading') return new Promise(() => {});
          return { detected: true, browserKind: 'chrome', executablePath: '/chrome' };
        },
      },
      computer: {
        status: async () => ({
          installed: false,
          executablePath: null,
          version: null,
          daemonRunning: false,
        }),
        onPermissionGuideStatusChanged: subscription('permissionStatus'),
        onPermissionGuideCancelled: subscription('permissionCancelled'),
        onUpdateProgress: subscription('updateProgress'),
      },
      android: {
        getConfig: async () => ({
          value: { defaultDeviceSerial: null, adbPathOverride: null },
        }),
      },
    },
    browserBackend: {
      getState: async () => {
        if (ctx.case === 'error') throw new Error('Configuration unavailable');
        return { active: 'external', useRealProfile: false };
      },
      getHealth: async () => ({ active: 'external', status: 'ready', canRecover: false }),
    },
  }),
  render: () => (
    <div className="p-4">
      <ComputerUseSection workingDir="/project" />
    </div>
  ),
});
