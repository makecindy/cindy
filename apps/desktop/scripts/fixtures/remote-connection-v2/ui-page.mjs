import assert from 'node:assert/strict';
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
    'model-access-off': { about: '「让我的其他电脑用本机模型」 under the master switch, off by default; turning it on' },
    'model-access-on': { about: 'Already turned on by the user' },
    'remote-switch': {
      about: 'Prototype: switch another computer between Device Link and Agent-Net from its topology card (switching, reverted, outdated, phone, control off, already Agent-Net)',
      storage: V2_ON,
    },
    'remote-switch-batch': {
      about: 'Prototype: batch switch to Agent-Net (first computer first, then the rest; one goes back) and the switch-back list',
      storage: V2_ON,
    },
    'switched-here': {
      about: 'Prototype: this computer was switched to Agent-Net remotely; the switch hint says by whom and when',
      storage: V2_ON,
    },
    'remote-switch-controller-strict': {
      about: 'Controller requires Agent-Net: card and batch explain why it cannot switch a peer to Device Link',
      storage: V2_ON,
    },
  },
  async check(page, ui) {
    await page.getByRole('switch', { name: await ui.t('settings.remoteControl.v2.switch.title') }).waitFor();
    if (ui.case === 'model-access-off' || ui.case === 'model-access-on') {
      const card = page.getByTestId('own-computer-model-access');
      await card.waitFor();
      const toggle = card.getByRole('switch');
      assert.equal(await toggle.getAttribute('aria-checked'), ui.case === 'model-access-on' ? 'true' : 'false');
      await ui.capture('card');
      if (ui.case === 'model-access-off') {
        await toggle.click();
        await page.waitForFunction(() => document.querySelector('[data-testid="own-computer-model-access"] [role="switch"]')?.getAttribute('aria-checked') === 'true');
        await ui.capture('turned-on');
      }
      return;
    }
    if (ui.case === 'switched-here') {
      await page.getByText('MacBook Pro', { exact: false }).first().waitFor();
      return;
    }
    if (ui.case.startsWith('remote-switch')) {
      const t = (key) => ui.t(`settings.remoteControl.v2.peerSwitch.${key}`);
      await page.getByRole('button', { name: /^Work PC/ }).waitFor();
      if (ui.case === 'remote-switch-controller-strict') {
        await page.getByRole('button', { name: /^Build Server/ }).click();
        await page.getByText(await t('disableBlocked.controller-encryption-required'), { exact: true }).waitFor();
        if (await page.getByRole('button', { name: await t('toDeviceLink'), exact: true }).count()) throw new Error('strict controller offers an unreachable switch-back');
        await ui.capture('card-controller-encryption-required');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: await t('batch.toDeviceLink'), exact: true }).click();
        await page.getByText(await t('batch.skipReason.controller-encryption-required'), { exact: true }).waitFor();
        if (!(await page.getByRole('dialog').getByRole('button').last().isDisabled())) throw new Error('strict controller can start a switch-back batch');
        await ui.capture('batch-controller-encryption-required');
        await page.keyboard.press('Escape');
        return;
      }
      if (ui.case === 'remote-switch') {
        const open = async (name, shot, { wait = 1000 } = {}) => {
          await page.getByRole('button', { name: new RegExp(`^${name}`) }).click();
          await page.getByRole('dialog').waitFor();
          if (wait) await page.waitForTimeout(wait);
          await ui.capture(shot);
          await page.keyboard.press('Escape');
        };
        // 打开卡片先问对方：问的时候写「正在确认」，问完才给按钮或原因。
        await open('Work PC', 'card-checking', { wait: 0 });
        await open('Work PC', 'card-switchable');
        await open('MacBook Air', 'card-outdated');
        await open('Spare PC', 'card-not-ready');
        await page.getByRole('button', { name: /^Build Server/ }).click();
        await page.getByText(await t('encryptionRequired'), { exact: true }).waitFor();
        if (await page.getByRole('button', { name: await t('toDeviceLink'), exact: true }).count()) throw new Error('encrypted-only target offers a remote downgrade');
        await ui.capture('card-encryption-required');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: /^Archive Server/ }).click();
        await page.getByText(await t('disableBlocked.agent-net-only-relay'), { exact: true }).waitFor();
        if (await page.getByRole('button', { name: await t('toDeviceLink'), exact: true }).count()) throw new Error('V2-only relay offers a Device Link switch-back');
        await ui.capture('card-agent-net-only-relay');
        await page.keyboard.press('Escape');
        // 单台切换：点了先列三步；Home PC 的 Agent-Net 不通，期限过后显示已退回。
        await page.getByRole('button', { name: /^Home PC/ }).click();
        await page.getByRole('dialog').waitFor();
        await page.waitForTimeout(1000);
        await page.getByRole('button', { name: await t('toAgentNet'), exact: true }).click();
        await page.waitForTimeout(1200);
        await ui.capture('card-switching');
        await page.getByText(await t('reverted'), { exact: true }).waitFor();
        await ui.capture('card-reverted');
        await page.keyboard.press('Escape');
        return;
      }
      // 批量：先逐台确认，再先切一台、其余随后；之后可以全部切回。
      await page.getByRole('button', { name: await t('batch.toAgentNet'), exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await ui.capture('batch-checking');
      await page.waitForTimeout(1000);
      await ui.capture('batch-confirm');
      // 面板里最后一个按钮就是「切换 N 台」。
      await page.getByRole('dialog').getByRole('button').last().click();
      await page.waitForTimeout(1200);
      await ui.capture('batch-canary');
      await page.getByRole('dialog').locator('button:enabled').waitFor();
      await ui.capture('batch-done');
      await page.getByRole('button', { name: await t('batch.close'), exact: true }).click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: await t('batch.toDeviceLink'), exact: true }).click();
      await page.getByRole('dialog').waitFor();
      await page.getByText(await t('batch.skipReason.encryption-required'), { exact: true }).waitFor();
      await page.getByText(await t('batch.skipReason.agent-net-only-relay'), { exact: true }).waitFor();
      await page.getByRole('dialog').locator('button:enabled').nth(1).waitFor();
      await ui.capture('rollback-confirm');
      await page.keyboard.press('Escape');
      return;
    }
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
      // 这台电脑的卡只展示连接信息;本机设置直接使用同页上方的卡片。
      await page.getByRole('button', { name: 'Studio Mac', exact: true }).click();
      const hubCard = page.getByRole('dialog');
      await hubCard.getByText(await ui.t('settings.devices.linkStatus.online')).waitFor();
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
