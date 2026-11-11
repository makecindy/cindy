const V2_ON = { 'remoteConnection.v2': 'on' };

export default {
  name: 'remote-connection-v2',
  entry: './fixture.tsx',
  viewport: { width: 1180, height: 1100 },
  real: 'RemoteControlSection with the Agent-Net (Beta) switch on: RemoteConnectionV2Section, RemoteConnectionTopology, TopologyFlow, PlatformGlyph, DeviceNodePopover, with only the MyDevicesPanel card of this computer above it, then RelayServicePanel',
  notCovered:
    'Live device-link IPC, real RTT and traffic sampling (send/receive times are fixture values), relay switching, SSH hosts, remote desktop launch; the legacy list page is covered by remoteControlDevicesDeepLink.test.tsx',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial: 'export function useAuth() { return { deviceId: "self", user: null, mode: "cloud" }; }',
    },
  },
  cases: {
    default: {
      about: 'Eight other devices: direct (one exchanging messages), relay (receiving), not linked, needs attention and two folded offline',
      storage: V2_ON,
    },
    fleet: { about: 'Same shape as a real account: 3 direct, 7 via relay, 15 folded offline; two links carrying messages', storage: V2_ON },
    many: { about: 'Twenty other devices: dense rows, split direct group, folded offline', storage: V2_ON },
    empty: { about: 'Only this computer, master switch off', storage: V2_ON },
    'legacy-off': { about: 'Agent-Net off: no topology; 我的设备 and the relay route are unchanged' },
  },
  async check(page, ui) {
    await page.getByRole('switch', { name: await ui.t('settings.remoteControl.v2.switch.title') }).waitFor();
    if (ui.case === 'legacy-off') {
      await page.getByRole('button', { name: new RegExp(`^${await ui.t('settings.remoteControl.sections.myDevices')}`) }).waitFor();
      return;
    }
    await page.getByRole('button', { name: 'Studio Mac', exact: true }).waitFor();
    if (ui.case === 'default' || ui.case === 'fleet') {
      // 默认截图是减弱动效(在用的线是略粗的绿色实线);这里放开动效,有消息的线变成流动的绿色虚线。
      // 隔半节虚线的时间再截一帧(flow-later),两帧的空隙应整体往消息方向挪了一点。
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.waitForTimeout(600);
      await ui.capture('flow');
      await page.waitForTimeout(375);
      await ui.capture('flow-later');
      await page.emulateMedia({ reducedMotion: 'reduce' });
    }
    if (ui.case === 'fleet') {
      await page.getByRole('button', { name: /^Build Server/ }).hover();
      await ui.capture('hover');
      await page.mouse.move(0, 0);
    }
    if (ui.case === 'default') {
      // Mixed real routes: both protocols share the topology, independently of direct/relay grouping.
      await page.getByText(await ui.t('settings.remoteControl.v2.protocol.deviceLink'), { exact: true }).waitFor();
      await page.getByText(await ui.t('settings.remoteControl.v2.protocol.agentNet'), { exact: true }).first().waitFor();
      // 拓扑卡片只展示连接信息(本机的配置在上方「我的设备」的本机卡片,其它设备不再列出)。
      await page.getByRole('button', { name: /^Work PC/ }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('popover');
      await page.keyboard.press('Escape');
      // 这台电脑的卡:与中转的连接和「管理设备…」(定位到本机卡片)。
      await page.getByRole('button', { name: 'Studio Mac', exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.remoteControl.v2.popover.manage') }).waitFor();
      await ui.capture('hub-card');
      await page.keyboard.press('Escape');
      // 要处理的设备:点开卡片,「状态」用红字写原因(没有单独的「需要处理」卡片)。
      await page.getByRole('button', { name: /^MacBook Air/ }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('attention-card');
      await page.keyboard.press('Escape');
      // 最近活动:拓扑右上角的图标,点开是弹出层。
      await page.getByRole('button', { name: await ui.t('settings.remoteControl.v2.recent.title') }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('recent');
      await page.keyboard.press('Escape');
    }
  },
};
