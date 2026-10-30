import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Personal media is provided only by the local test command, never committed.
const selfAvatar = process.env.CINDY_MASK_PREVIEW_AVATAR
  ? `data:image/jpeg;base64,${readFileSync(process.env.CINDY_MASK_PREVIEW_AVATAR).toString('base64')}` : null;
export default {
  name: 'group-mask', entry: './group-mask-fixture.tsx', viewport: { width: 1040, height: 800 },
  real: 'BotGroupChatView, BotGroupComposer, ChatThreadPanel, BotGroupSettingsDrawer, ChatGroupSettings, GroupMaskControls and GroupMaskSettings',
  notCovered: 'Server identity, real agent replies, persistence, private digest delivery and cross-device presence. All events are isolated fixture data.',
  stubs: { 'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => { throw new Error("Voice is outside this fixture"); };' },
  cases: Object.fromEntries(['default', 'paused', 'scheduled', 'manual', 'off', 'offline', 'unbound', 'error', 'loading'].map(name => [name, { about: `Personal stand-in: ${name}`, data: { selfAvatar } }])),
  async ready(page) { await page.getByTestId('group-mask-status').waitFor(); },
  async check(page, ui) {
    const indicator = page.getByTestId('group-mask-status');
    const expected = { default: 'enabled', paused: 'paused', scheduled: 'waiting', manual: 'waiting', off: 'off', offline: 'offline', unbound: 'unbound', error: 'enabled', loading: 'enabled' }[ui.case];
    assert.equal(await indicator.getAttribute('data-status'), expected);
    assert.equal(await indicator.evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), true);
    if (ui.case !== 'unbound') {
      assert.equal(await indicator.locator('span[aria-hidden]').first().evaluate(stack => {
        const frame = stack.getBoundingClientRect();
        const [owner, companion] = [...stack.children].map(e => e.getBoundingClientRect());
        return companion.bottom <= frame.bottom && companion.right <= frame.right
          && companion.left < owner.right && companion.top < owner.bottom;
      }), true, 'the companion must overlap the owner within the toolbar avatar frame');
    }
    const inbox = page.getByTestId('group-attention-hint');
    assert.equal(await inbox.getAttribute('data-count'), '2');
    await inbox.click();
    await ui.capture('unread-mentions');
    assert.equal(await page.locator('[data-mention-message]').count(), 2);
    assert.equal(await page.locator('[data-mention-reply][aria-expanded="true"]').count(), 0, 'show requests before stand-in replies');
    await page.locator('[data-mention-reply]').first().click();
    assert.equal(await inbox.getAttribute('data-count'), '2', 'expanding a reply does not read the request');
    await ui.capture('expanded-stand-in-reply');
    await page.keyboard.press('Escape');
    assert.equal(await inbox.getAttribute('data-count'), '2', 'opening catch-up does not read it');
    await indicator.click();
    await page.getByRole('button', { name: await ui.t('bots.groupChat.mask.settings'), exact: true }).click();
    await page.getByTestId('group-mask-settings').waitFor();
    await ui.capture('settings');
    if (ui.case === 'manual') {
      await page.getByRole('button', { name: await ui.t('bots.groupChat.mask.startManual'), exact: true }).click();
      await page.locator('[data-testid=group-mask-status][data-status=enabled]').waitFor();
      await page.getByRole('button', { name: await ui.t('bots.groupChat.mask.stop'), exact: true }).click();
      await page.locator('[data-testid=group-mask-status][data-status=waiting]').waitFor();
    }
    if (ui.case === 'scheduled') {
      assert.equal(await page.locator('input[type=time]').count(), 2);
      await page.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
      await page.getByRole('button', { name: '模拟离开 15 分钟', exact: true }).click();
      await page.getByRole('button', { name: '模拟离开 15 分钟', exact: true }).click();
      await page.locator('[data-testid=group-mask-status][data-status=enabled]').waitFor();
    }
    if (ui.case === 'error') {
      await page.getByRole('switch', { name: await ui.t('bots.groupChat.mask.enabled'), exact: true }).click();
      assert.equal(await indicator.getAttribute('data-status'), 'enabled', 'failed saving keeps previous settings');
      await page.getByRole('button', { name: await ui.t('bots.groupChat.mask.retry'), exact: true }).click();
      await page.locator('[data-testid=group-mask-status][data-status=off]').waitFor();
      assert.equal(await page.getByRole('alert').count(), 0);
    }
    if (ui.case === 'default') {
      await page.getByRole('button', { name: await ui.t('bots.groupChat.settings.title'), exact: true }).click();
      const name = page.getByRole('textbox', { name: await ui.t('bots.groupChat.server.settings.name'), exact: true });
      assert.equal(await name.isDisabled(), true, 'a member cannot edit shared settings');
      await page.getByTestId('group-mask-settings-entry').scrollIntoViewIfNeeded();
      await ui.capture('member-settings');
      await page.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
      const input = page.getByRole('textbox', { name: await ui.t('bots.groupChat.composer.label'), exact: true }); await input.fill('我来处理。');
      await page.locator('[data-testid=group-mask-status][data-status=paused]').waitFor();
      await page.getByRole('button', { name: '模拟离开 15 分钟', exact: true }).click();
      await page.locator('[data-testid=group-mask-status][data-status=enabled]').waitFor();
      assert.equal(await input.inputValue(), '我来处理。');
      await ui.capture('returned-and-resumed');
      // A human returning must cancel the queued stand-in reply, including after resumption.
      await page.clock.install();
      await page.getByRole('button', { name: '模拟 @ 我', exact: true }).click();
      await input.fill('我已回来，马上确认。');
      await page.locator('[data-testid=group-mask-status][data-status=paused]').waitFor();
      await page.clock.runFor(1500);
      assert.equal(await page.locator('[data-bot-group-message-id^="stand-in-"]').count(), 0);
      await page.getByRole('button', { name: '模拟离开 15 分钟', exact: true }).click();
      await page.locator('[data-testid=group-mask-status][data-status=enabled]').waitFor();
      await page.getByRole('button', { name: '模拟 @ 我', exact: true }).click();
      await page.clock.runFor(1500);
      await page.locator('[data-bot-group-message-id^="stand-in-"]').waitFor();
      assert.equal(await page.locator('[data-bot-group-message-id^="stand-in-"]').count(), 1);
      // Attribution is a content-sized tooltip, not a settings-sized popover.
      const avatar = page.locator('[data-bot-group-message-id^="stand-in-"] button[aria-label]').filter({ has: page.locator('span[aria-hidden]') }).last();
      await avatar.hover();
      await page.clock.runFor(600);
      const tooltip = page.getByRole('tooltip');
      await tooltip.waitFor();
      assert.equal((await tooltip.textContent()).trim(), await avatar.getAttribute('aria-label'));
      assert.equal(await tooltip.evaluate(element => {
        const rect = element.parentElement.getBoundingClientRect();
        return rect.width < 300 && rect.height < 50;
      }), true, 'short attribution must not create a large empty panel');
      assert.equal(await avatar.getAttribute('title'), null, 'avoid duplicate native tooltip');
      await ui.capture('attribution-tooltip');
      await page.mouse.move(0, 0);
      await page.clock.runFor(200);
      // The same member state and message attribution also appear inside a topic.
      await page.locator('[data-thread-preview=question]').click();
      const reply = page.getByRole('textbox', { name: await ui.t('bots.groupChat.server.replyPlaceholder'), exact: true });
      await reply.fill('话题里由我接着回复。');
      await page.locator('[data-testid=group-mask-status][data-status=paused]').first().waitFor();
      assert.equal(await page.locator('[data-testid=group-mask-status][data-status=paused]').count(), 2);
      await ui.capture('topic-takeover');
      assert.equal(await inbox.getAttribute('data-count'), '4', 'AI replies and thread loading preserve human unread mentions');
      await inbox.click();
      await ui.capture('unread-after-ai-reply');
      await page.locator('[data-mention-message=reply-2]').click();
      await page.locator('[data-bot-group-message-id=reply-2]').waitFor();
      await page.locator('[data-testid=group-attention-hint][data-count="3"]').waitFor();
      assert.equal(await inbox.getAttribute('data-count'), '3', 'reading the located topic acknowledges only that message');
      await inbox.click();
      await page.getByRole('button', { name: await ui.t('bots.groupChat.mask.catchup.markAll'), exact: true }).click();
      await page.locator('[data-testid=group-attention-hint][data-count="0"]').waitFor();
      await ui.capture('mentions-read-by-person');
    }
  },
};
