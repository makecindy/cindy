import '../../../src/renderer/features/remote-desktop/viewerWindow.css';
import { RemoteDesktopViewerWindow } from '../../../src/renderer/features/remote-desktop/RemoteDesktopViewerWindow';
import { mountPage } from '../../ui-page/harness';

const noop = async () => {};
const subscription = () => () => {};
void mountPage({
  host: (ctx) => ({
    remoteDesktopViewer: {
      state: async () => ({
        generation: 1,
        active: true,
        target: { deviceId: 'fixture', name: 'Linux computer' },
      }),
      onActive: subscription,
      onLocale: subscription,
      onCloseRequested: subscription,
      onHidden: subscription,
      onChannelRequest: undefined,
      preferences: async () => ({}),
      resolution: undefined,
      credential: undefined,
      ice: async () => [],
      rendererReady: noop,
      presentationReady: noop,
      inputFocus: noop,
      close: noop,
      fullscreen: noop,
      resize: noop,
      request: async (_generation: number, request: { op: string }) => {
        if (ctx.case === 'permission' && request.op === 'capabilities')
          throw new Error('[PRECONDITION_FAILED] DESKTOP_ACCESSIBILITY_REQUIRED');
        if (request.op === 'capabilities')
          return {
            version: 1,
            enabled: true,
            canControl: false,
            platform: 'linux',
            displays: [{ id: 'one', width: 800, height: 600 }],
          };
        if (request.op === 'start')
          return {
            lease: 'fixture',
            display: { id: 'one', width: 800, height: 600 },
            controlling: false,
          };
        return {};
      },
    },
  }),
  render: () => <RemoteDesktopViewerWindow />,
});
