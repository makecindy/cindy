import assert from 'node:assert/strict';

const WHO = 'Alexandria Montgomery-Featherstonehaugh 的工作号 · Personal assistant account (@alexandria_montgomery_featherstonehaugh)';

export default {
  name: 'teammate-telegram',
  entry: './teammate-telegram-fixture.tsx',
  viewport: { width: 720, height: 900 },
  real: 'BotChannelsPage add-platform dialog (Telegram), connection row status, OwnerPairingPanel, shared Input, Button, FormField and translations',
  notCovered: 'Live Telegram bot, the pairing code reply in Telegram, code verification and lockout in main, persisting the owner id, confirm dialog, remote device-link transport; host writes are forbidden',
  cases: {
    default: { about: 'Add-platform dialog with Telegram selected: owner ID is optional with the @userinfobot hint', data: {} },
    'add-optional-owner': { about: 'Add-platform dialog with Telegram selected: owner ID is optional with the @userinfobot hint', data: {} },
    'add-handle-error': { about: 'An @username typed as the owner ID shows the dedicated hint and nothing is saved', data: { handle: true } },
    'awaiting-pairing': { about: 'Token-only connection waits for pairing and tells the owner to message the bot', data: { connection: true } },
    'pending-request': { about: 'A private-chat request on this computer: long name, numeric ID on its own line, code input and confirm', data: { connection: true, request: true } },
    'remote-request': { about: 'Teammate on another computer: request is read-only and points to that computer', data: { connection: true, request: true, remote: true } },
    narrow: { about: '320px window keeps the pending request, ID and code input inside the page', data: { connection: true, request: true }, viewport: { width: 320, height: 900 } },
  },
  async check(page, ui) {
    if (!ui.data.connection) {
      await page.getByRole('button', { name: await ui.t('bots.channels.add.button'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: await ui.t('bots.channels.platform.telegram'), exact: true }).click();
      const owner = dialog.getByLabel(await ui.t('bots.channels.add.telegram.ownerOptionalLabel'), { exact: true });
      await owner.waitFor({ state: 'visible' });
      const hint = await ui.t('bots.channels.add.telegram.ownerOptionalHint', { name: 'Cindy' });
      assert.ok(hint.includes('@userinfobot'), 'hint names @userinfobot');
      await dialog.getByText(hint, { exact: true }).waitFor({ state: 'visible' });
      const submit = dialog.getByRole('button', { name: await ui.t('bots.channels.add.confirm'), exact: true });
      assert.equal(await submit.isDisabled(), true, 'nothing to save before a token');
      await dialog.getByLabel(await ui.t('bots.channels.add.telegram.tokenLabel'), { exact: true }).fill('123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      assert.equal(await submit.isDisabled(), false, 'a token alone is enough to save');
      if (ui.data.handle) {
        await owner.fill('@my_handle');
        await submit.click();
        const alert = dialog.getByRole('alert');
        await alert.waitFor({ state: 'visible' });
        assert.equal(await alert.textContent(), await ui.t('bots.channels.add.errors.ownerIsHandle'));
        await ui.capture('handle-error');
      } else {
        await ui.capture('optional-owner');
      }
      return;
    }

    await page.getByText(await ui.t('bots.channels.status.awaitingPairing'), { exact: true }).waitFor({ state: 'visible' });
    await page.getByText(await ui.t('bots.channels.pairing.hint', { bot: '@cindy_helper_bot', name: 'Cindy' }), { exact: true })
      .waitFor({ state: 'visible' });
    const codeInput = page.getByLabel(await ui.t('bots.channels.pairing.codeLabel'), { exact: true });
    const approve = page.getByRole('button', { name: await ui.t('bots.channels.pairing.approveAria', { who: WHO }), exact: true });

    if (!ui.data.request) {
      assert.equal(await page.getByRole('list', { name: await ui.t('bots.channels.pairing.listLabel') }).count(), 0, 'no requests yet');
      assert.equal(await codeInput.count(), 0);
      await ui.capture('awaiting');
      return;
    }

    await page.getByText(await ui.t('bots.channels.pairing.request', { who: WHO }), { exact: true }).waitFor({ state: 'visible' });
    // 数字 ID 单独一行且完整可见: 长显示名不能把它挤掉或截断。
    const idLine = page.getByText(await ui.t('bots.channels.pairing.userIdLine', { userId: '5839201746' }), { exact: true });
    await idLine.waitFor({ state: 'visible' });
    const idBox = await idLine.evaluate((el) => ({
      clipped: el.scrollWidth > el.clientWidth + 1,
      overflow: el.ownerDocument.defaultView.getComputedStyle(el).textOverflow,
    }));
    assert.equal(idBox.clipped, false, 'numeric ID is not clipped');
    assert.notEqual(idBox.overflow, 'ellipsis', 'numeric ID is not ellipsized');

    if (ui.data.remote) {
      assert.equal(await codeInput.count(), 0, 'remote target has no code input');
      assert.equal(await approve.count(), 0, 'remote target has no confirm button');
      await page.getByText(await ui.t('bots.channels.pairing.confirmOnHost', { device: 'Studio Mac mini' }), { exact: true })
        .waitFor({ state: 'visible' });
      await ui.capture('remote');
      return;
    }

    await codeInput.waitFor({ state: 'visible' });
    assert.equal(await approve.isDisabled(), true, 'confirm stays disabled until a code is typed');
    const panel = await codeInput.evaluate((el) => {
      const root = el.ownerDocument.documentElement;
      return { scroll: root.scrollWidth, client: root.clientWidth };
    });
    assert.ok(panel.scroll <= panel.client, 'no horizontal overflow');
    await ui.capture('pending');
    await codeInput.fill('K7MQ2P');
    assert.equal(await approve.isDisabled(), false, 'confirm enabled once a code is typed');
    await ui.capture('code-typed');
  },
};
