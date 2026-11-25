import assert from 'node:assert/strict';

export default {
  name: 'session-device-indicator',
  entry: './fixture.tsx',
  viewport: { width: 400, height: 280 },
  real: 'SessionDeviceIndicator, peer topology and tooltip in a sample task header',
  notCovered: 'Live network, full session header and native window dragging',
  cases: {
    default: { about: 'Hover over a connected computer with a measured RTT' },
    relay: { about: 'Hover over an Agent-Net peer connected via a WebSocket relay' },
    offline: { about: 'Focus an offline computer and read its last seen time' },
  },
  async check(page, ui) {
    const trigger = page.getByRole('img', { name: '工作室的 Mac', exact: true });
    if (ui.case === 'offline') await trigger.focus();
    else await trigger.hover();
    const tip = page.getByRole('tooltip');
    const latency = await ui.t('settings.remoteControl.v2.popover.latency');
    if (ui.case === 'offline') {
      await tip.getByText(await ui.t('settings.remoteControl.v2.popover.lastSeen')).waitFor({ state: 'attached' });
      assert.equal(await tip.getByText(latency).count(), 0);
    } else {
      await tip.getByText('8 ms').waitFor({ state: 'attached' });
      assert.match(await tip.textContent(), ui.case === 'relay' ? /Agent-Net · WS/ : /Agent-Net · UDP/);
      const path = await ui.t(ui.case === 'relay' ? 'settings.remoteControl.v2.group.relay' : 'settings.remoteControl.v2.group.direct');
      assert.equal(await tip.getByText(path, { exact: true }).count(), 1);
    }
    await ui.capture('device');
    await page.keyboard.press('Escape');
    await tip.waitFor({ state: 'detached' });
  },
};
