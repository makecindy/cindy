import assert from 'node:assert/strict';

export default {
  name: 'remote-terminal',
  entry: './fixture.tsx',
  viewport: { width: 360, height: 480 },
  real: 'RemoteTerminalSetup, TerminalTabBody, xterm, shared form controls and localized overlays',
  notCovered: 'Real SSH, credentials, PTY lifecycle, persistence and cross-window handoff',
  cases: {
    default: { about: 'SSH connection form at the detached sidebar minimum width' },
    invalid: { about: 'Invalid host focuses the field and shows its localized error' },
    exited: { about: 'Exit message and both recovery actions fit a narrow sidebar' },
    error: { about: 'Long remote error remains contained with recovery actions' },
    connecting: { about: 'Connection progress uses the themed status surface' },
    'expired-reference': { about: 'Expired SSH configuration explains reselection and prevents repeated connection failure' },
  },
  async ready(page) {
    // --compare renders this same task fixture against upstream source, whose
    // remote-unavailable view has no form or buttons. Use that version's copy.
    const unavailable = await page.evaluate(() => window.__uiPage.t('rightSidebar.terminal.remoteUnavailableTitle'));
    await page.locator('form, [role="status"], button').or(page.getByText(unavailable, { exact: true })).first().waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'invalid') {
      const host = page.getByLabel(await ui.t('rightSidebar.terminal.remote.host'), { exact: true });
      await host.fill('-invalid');
      await page.getByRole('button', { name: await ui.t('rightSidebar.terminal.remote.connect'), exact: true }).click();
      assert.equal(await host.getAttribute('aria-invalid'), 'true');
      assert.equal(await host.evaluate(element => element === document.activeElement), true);
      await page.getByText(await ui.t('rightSidebar.terminal.remote.hostInvalid'), { exact: true }).waitFor();
    }
    if (ui.case === 'expired-reference') {
      await page.getByText(await ui.t('rightSidebar.terminal.remote.selectAgain'), { exact: true }).waitFor();
      const connect = page.getByRole('button', { name: await ui.t('rightSidebar.terminal.remote.connect'), exact: true });
      assert.equal(await connect.isDisabled(), true, 'An expired credential reference must not be submitted');
    }
    if (ui.case === 'exited' || ui.case === 'error') {
      // Layout regression through the real component: both recovery actions must
      // remain inside the 360px host, even with long translations/error details.
      const buttons = await page.getByRole('button').all();
      assert.equal(buttons.length, 2, 'Both recovery actions must be present after attach');
      for (const button of buttons) {
        const box = await button.boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= ui.viewport.width, 'Recovery action overflows the terminal');
      }
    }
  },
};
