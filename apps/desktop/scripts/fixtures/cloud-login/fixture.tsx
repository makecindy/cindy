import { mountPage, forbid } from '../../ui-page/harness';
import { CloudLoginWindowLayout } from '../../../src/renderer/features/cloud-settings/CloudLoginWindowRoot';
import type { CloudInstanceLoginView } from '../../../src/shared/cloudInstanceLogin';

const deviceId = 'cloud-device-aaaaaaaaaaaaaaaaaaaaaaaa';
mountPage({
  route: `/cloud-login?deviceId=${deviceId}`,
  host: (ctx) => {
    const states: Record<string, CloudInstanceLoginView['state']> = {
      default: {
        step: 'identifier',
        providers: {
          region: 'cn',
          attribution: 'phone',
          phone: true,
          email: false,
          social: ['wechat', 'apple'],
        },
      },
      code: { step: 'verification-code', kind: 'phone', identifier: '+15555550123' },
      binding: { step: 'binding', bindType: 'phone', codeRequested: false },
      verification: {
        step: 'sso-verification',
        channel: 'sms',
        targetMasked: '***123',
        codeRequested: false,
      },
    };
    const view: CloudInstanceLoginView = {
      handle: '11111111-1111-4111-8111-111111111111',
      state: states[ctx.case] ?? states.default!,
      complete: false,
    };
    return {
      platform: ctx.data.platform ?? 'darwin',
      cloudLoginWindow: {
        getState: async () => ({ generation: 1, target: { deviceId, name: '云端 Cindy', nameSequence: 1 } }),
        rendererReady: async () => undefined,
        presentationReady: async () => undefined,
        onChanged: () => () => {},
        onLocaleChanged: () => () => {},
        close: async () => undefined,
        start: async () => view,
        poll: async () => view,
        end: async () => undefined,
        dispatch: forbid('real cloud login'),
      },
      authDispatch: forbid('local account mutation'),
      authInitialize: forbid('local account initialization'),
      acceptPrivacyConsent: async () => undefined,
    };
  },
  render: () => <CloudLoginWindowLayout />,
});
