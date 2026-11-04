export default {
  name: 'local-agent-confirmation', entry: './fixture.tsx', viewport: { width: 900, height: 650 },
  real: 'LocalAgentConfirmationHost, ConfirmDialogProvider and themed ConfirmDialog',
  notCovered: 'Main IPC sender validation and actual API grants are verified separately in service and isolated Desktop checks.',
  cases: {
    default: { about: 'Approve through the shared themed confirmation', data: { action: 'allow' } },
    cancel: { about: 'Cancel returns a negative decision', data: { action: 'cancel' } },
    escape: { about: 'Escape dismisses without granting', data: { action: 'escape' } },
    revoke: { about: 'Confirm revocation with the existing localized copy', data: { action: 'revoke' } },
    abort: { about: 'Main dismissal cannot yield a late approval', data: { action: 'abort' } },
    queued: { about: 'Cancelling the first request preserves the second', data: { action: 'queued' } },
    narrow: { about: 'Long unverified identity wraps at 320px', viewport: { width: 320, height: 640 }, data: { action: 'allow', long: true } },
  },
  async check(page, ui) {
    const app = ui.data.long ? 'ApplicationWithAnUnbrokenLongName独立客户端'.repeat(3) : 'Notes';
    const revoke = ui.data.action === 'revoke';
    const request = {
      requestId: 'first',
      title: await ui.t(revoke ? 'localAgent.title' : 'localAgent.connectTitle'),
      message: await ui.t(revoke ? 'localAgent.revokeOneMessage' : 'localAgent.connectMessage', { app }),
      detail: await ui.t(revoke ? 'localAgent.revokeOneDetail' : 'localAgent.connectDetail'),
      confirmText: await ui.t(revoke ? 'localAgent.revoke' : 'localAgent.allow'),
      cancelText: await ui.t('localAgent.cancel'),
    };
    if (!revoke) request.detail += '\n\n' + await ui.t('localAgent.clientIdentity', { id: 'org.example.notes', version: '1.2' });
    const emit = (name, payload) => page.evaluate(({ name, payload }) => window.__uiPage.emit(name, payload), { name, payload });
    await emit('confirmation', request);
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    const cancel = dialog.getByRole('button', { name: request.cancelText, exact: true });
    await cancel.waitFor();
    if (!(await cancel.evaluate(el => el === document.activeElement))) throw new Error('Cancel must receive initial focus');
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Tab');
      if (!(await dialog.evaluate(el => el.contains(document.activeElement)))) throw new Error('Focus escaped modal');
    }
    if (!(await dialog.evaluate(el => {
      const b = el.getBoundingClientRect();
      return b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight && el.scrollWidth <= el.clientWidth;
    }))) throw new Error('Dialog overflows viewport');
    if (ui.data.action === 'queued') {
      await emit('confirmation', { ...request, requestId: 'second' });
      await emit('dismiss', 'first');
      await page.waitForFunction(() => document.querySelector('[role=alertdialog]')?.getAttribute('data-state') === 'open');
      // Wait for the shared provider's exit/next transition, not a second modal implementation.
      // real-wait: shared production modal exit animation finishes before the next queue item.
      await page.waitForTimeout(250);
      await dialog.getByRole('button', { name: request.confirmText, exact: true }).click();
    } else if (ui.data.action === 'abort') await emit('dismiss', 'first');
    else if (ui.data.action === 'escape') await page.keyboard.press('Escape');
    else if (ui.data.action === 'cancel') await cancel.click();
    else await dialog.getByRole('button', { name: request.confirmText, exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const answers = await page.evaluate(() => window.answers ?? []);
    const expected = ui.data.action === 'abort' ? [] : [{
      requestId: ui.data.action === 'queued' ? 'second' : 'first',
      confirmed: !['cancel', 'escape'].includes(ui.data.action),
    }];
    if (JSON.stringify(answers) !== JSON.stringify(expected)) throw new Error('Wrong/late confirmation reply');
    // Leave the production dialog visible for the theme/locale screenshot and audit.
    await emit('confirmation', { ...request, requestId: 'screenshot' });
    await dialog.waitFor();
  },
};
