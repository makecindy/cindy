import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { ComputerUseSection } from '../../../src/renderer/components/settings/ComputerUseSection';

// Real settings UI, deterministic IPC boundary; no native browser or user profile.
mountPage({
  host: ctx => {
    let failedOnce = false;
    const pending = () => new Promise<never>(() => {});
    return {
      maker: {
        plugins: {
          getState: async (id: string) => id === 'browser' && ctx.data.configPending
            ? pending() : { effectiveEnabled: id === 'browser' },
          setEnabled: forbid('maker.plugins.setEnabled'),
          setProjectEnabled: forbid('maker.plugins.setProjectEnabled'),
        },
        browser: {
          status: async () => {
            if (ctx.data.probePending) return pending();
            if (ctx.data.probeFailed && !failedOnce) {
              failedOnce = true;
              throw new Error('fixture status failure');
            }
            return { detected: false, browserKind: null, executablePath: null };
          },
          openForLogin: forbid('maker.browser.openForLogin'),
        },
        computer: {
          status: async () => ({ installed: false, executablePath: null, version: null,
            daemonRunning: false, installCommand: 'install cua-driver', docsUrl: 'https://cua.ai/docs/cua-driver' }),
          onPermissionGuideStatusChanged: subscription('computerPermission'),
          onPermissionGuideCancelled: subscription('computerCancelled'),
          onUpdateProgress: subscription('computerUpdate'),
          checkUpdate: forbid('maker.computer.checkUpdate'),
        },
        android: {
          getConfig: async () => ({ value: { defaultDeviceSerial: null, adbPathOverride: null },
            defaults: { defaultDeviceSerial: null, adbPathOverride: null }, isCustomized: false, customizedKeys: [] }),
          status: forbid('maker.android.status'),
          prepareAdb: forbid('maker.android.prepareAdb'),
        },
      },
      browserBackend: {
        getState: async () => ({ active: ctx.data.embedded ? 'rsb-webview' : 'external' }),
        getHealth: async () => null,
        setKind: forbid('browserBackend.setKind'),
        recover: forbid('browserBackend.recover'),
      },
    };
  },
  render: () => <div className="mx-auto w-full max-w-3xl p-5"><ComputerUseSection workingDir="/fixture/project" /></div>,
});
