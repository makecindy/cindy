import { encodeQrLoginUrl } from '@cindy/auth-client';
import { useRef } from 'react';
import { MobileDownloadDialog } from '../../../src/renderer/components/sidebar/MobileDownloadDialog';
import { forbid, mountPage, subscription } from '../../ui-page/harness';

/** 示例登录码：内容不可用于登录，只用来渲染二维码。 */
const payload = encodeQrLoginUrl('https://cindy.example/download/', {
  kind: 'handoff',
  region: 'global',
  id: 'fixture-handoff-0001',
  scanToken: 'fixture-scan-token-00000000000001',
  deviceName: 'MacBook Pro',
  platform: 'darwin',
});

function Page() {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <MobileDownloadDialog
      open
      onOpenChange={() => {}}
      remoteAvailable
      onOpenRemoteSettings={() => {}}
      onOpenDevices={() => {}}
      triggerRef={triggerRef}
    />
  );
}

void mountPage({
  host: (ctx) => {
    const claimed = (ctx.data as { claimed?: boolean }).claimed === true;
    const expiresAt = () => new Date(Date.now() + 110_000).toISOString();
    return {
      clientEndpoints: { websiteUrl: 'https://cindy.example' },
      openExternal: forbid('openExternal'),
      deviceLink: {
        getState: async () => ({
          remoteControlEnabled: true,
          keepAwake: false,
          linkStatus: 'online',
          connectionIssue: null,
          standby: false,
          controlledBy: [],
          revokedControllers: [],
          disabledControlDeviceIds: [],
          unresponsiveDeviceIds: [],
        }),
        listDevices: async () => ({
          devices: [
            {
              deviceId: 'desktop-device-1', name: 'MacBook Pro', platform: 'darwin', appVersion: '1.0.0',
              lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: true,
            },
          ],
        }),
        onPresenceChanged: subscription('presenceChanged'),
        onStatusChanged: subscription('statusChanged'),
        onConnectionIssue: subscription('connectionIssue'),
      },
      authQrHandoffCreate: async () => ({ success: true, handoffId: 'fixture-handoff-0001', payload, expiresAt: expiresAt() }),
      authQrHandoffState: async () => (claimed
        ? { success: true, status: 'claimed', expiresAt: expiresAt(), requester: { clientType: 'mobile', deviceName: 'iPhone', platform: 'ios' } }
        : { success: true, status: 'pending', expiresAt: expiresAt() }),
      // 允许 / 拒绝会改变登录态，截图场景不点。
      authQrHandoffDecide: forbid('authQrHandoffDecide'),
    };
  },
  render: () => <Page />,
});
