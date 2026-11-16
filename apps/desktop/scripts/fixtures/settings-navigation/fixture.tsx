import { mountPage, subscription } from '../../ui-page/harness';
import { SettingsLinkChip } from '../../../src/renderer/components/chat/SettingsLinkChip';

void mountPage({
  route: '/cc-agent/fixture',
  host: { deviceLink: {
    getState: async () => ({ linkStatus: 'online' }),
    listDevices: async () => ({ devices: [{ deviceId: 'studio', name: 'Mac Studio', platform: 'darwin', online: true, remoteControlEnabled: true, controlEnabled: true, isSelf: true }] }),
    onPresenceChanged: subscription('presence'), onStatusChanged: subscription('status'),
    onControlTargetChanged: subscription('control'), onDeviceDirectoryInvalidated: subscription('directory'),
  } },
  render: () => <div className="p-4 space-y-4 text-14 text-[var(--text-primary)]" data-ui-page-subject>
    <div><SettingsLinkChip target={{ tab: 'appearance', deviceId: 'studio', query: '字体' }} /></div>
    <div><SettingsLinkChip target={{ tab: 'builtin-tools', deviceId: 'studio' }} /></div>
  </div>,
});
