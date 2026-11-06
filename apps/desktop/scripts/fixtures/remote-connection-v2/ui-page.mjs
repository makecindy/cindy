const V2_ON = { 'remoteConnection.v2': 'on' };

export default {
  name: 'remote-connection-v2',
  entry: './fixture.tsx',
  viewport: { width: 1180, height: 1100 },
  real: 'RemoteControlSection with the 新版连接 switch on: RemoteConnectionV2Section, RemoteConnectionTopology, DeviceNodePopover, MyDevicesPanel, RelayServicePanel',
  notCovered:
    'Live device-link IPC, real RTT sampling, relay switching, SSH hosts, remote desktop launch; the legacy list page is covered by remoteControlDevicesDeepLink.test.tsx',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export function useAuth() { return { deviceId: "self", user: null, mode: "cloud" }; }',
    },
  },
  cases: {
    default: { about: 'Seven other devices: direct, relay, not linked, needs attention and two folded offline', storage: V2_ON },
    many: { about: 'Twenty other devices: dense rows, split direct group, folded offline', storage: V2_ON },
    empty: { about: 'Only this computer, master switch off', storage: V2_ON },
    'legacy-off': { about: 'Switch off: the original list page is unchanged' },
  },
  async check(page, ui) {
    await page.getByRole('switch', { name: await ui.t('settings.remoteControl.v2.switch.title') }).waitFor();
    if (ui.case === 'legacy-off') {
      await page.getByRole('button', { name: new RegExp(`^${await ui.t('settings.remoteControl.sections.myDevices')}`) }).waitFor();
      return;
    }
    await page.getByRole('button', { name: 'Studio Mac' }).waitFor();
    if (ui.case === 'default') {
      await page.getByRole('button', { name: /^Work PC/ }).click();
      await page.getByRole('button', { name: await ui.t('settings.remoteControl.v2.popover.manage') }).waitFor();
      await ui.capture('popover');
      await page.keyboard.press('Escape');
    }
  },
};
