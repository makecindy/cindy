import { ComputerUseSection } from '../../../src/renderer/components/settings/ComputerUseSection';
import { mountPage, subscription } from '../../ui-page/harness';

void mountPage({
  // The section links to the plugin page, so it renders inside the app router.
  route: '/settings',
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
        status: async () => {
          // driver-rate-limited 需要一个已安装的 macOS driver:更新行只在装上后渲染。
          if (ctx.case === 'driver-rate-limited') {
            return {
              installed: true,
              executablePath: '/Applications/CuaDriver.app',
              version: '0.28.2',
              daemonRunning: true,
              installCommand: 'noop',
              docsUrl: 'https://example.invalid/docs',
              permissionState: {
                platform: 'macos',
                required: true,
                canGrant: true,
                status: 'granted',
                accessibility: 'granted',
                screenRecording: 'granted',
                screenRecordingCapturable: 'granted',
              },
            };
          }
          return {
            installed: false,
            executablePath: null,
            version: null,
            daemonRunning: false,
          };
        },
        // issue #8916:GitHub 匿名限额打满时 main 下发 checkError,面板要说「限流」而不是「检查失败」。
        checkUpdate: async () =>
          ctx.case === 'driver-rate-limited'
            ? {
                currentVersion: '0.28.2',
                latestVersion: null,
                updateAvailable: false,
                updating: false,
                checkStatus: 'error',
                checkError: { kind: 'rate_limited' },
                checkedAt: Date.now(),
              }
            : {
                currentVersion: null,
                latestVersion: null,
                updateAvailable: false,
                updating: false,
              },
        updateDriver: async () => {
          throw new Error('updateDriver is not wired in the automation-settings fixture');
        },
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
        return (ctx.case.startsWith('my-browser') || ['browser-updating', 'browser-selection'].includes(ctx.case))
          ? { active: 'user-browser', useRealProfile: true }
          : { active: 'external', useRealProfile: false };
      },
      getHealth: async () => ({
        active: (ctx.case.startsWith('my-browser') || ['browser-updating', 'browser-selection'].includes(ctx.case)) ? 'user-browser' : 'external',
        status: ctx.case.startsWith('browser-') || ['my-browser-disconnected', 'my-browser-probe-failed'].includes(ctx.case) ? 'error' : 'ready',
        ...(ctx.case === 'my-browser-disconnected' ? { reason: 'extension-disconnected' } : {}),
        ...(ctx.case === 'my-browser-probe-failed' ? { reason: 'status-failed' } : {}),
        ...(ctx.case === 'browser-updating' ? { reason: 'plugin-updating' } : {}),
        ...(ctx.case === 'browser-selection' ? { reason: 'plugin-selection-required' } : {}),
        canRecover: false,
      }),
    },
  }),
  render: () => (
    <div className="p-4">
      <ComputerUseSection workingDir="/project" />
    </div>
  ),
});
