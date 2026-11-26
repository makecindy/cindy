import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Personal media is provided only by the local test command, never committed.
const selfAvatar = process.env.CINDY_MASK_PREVIEW_AVATAR
  ? `data:image/jpeg;base64,${readFileSync(process.env.CINDY_MASK_PREVIEW_AVATAR).toString('base64')}` : null;
export default {
  name: 'group-mask', entry: './group-mask-fixture.tsx', viewport: { width: 1040, height: 800 },
  real: 'BotGroupChatView, BotGroupComposer, ChatThreadPanel, BotGroupSettingsDrawer, ChatGroupSettings, GroupMaskControls and GroupMaskSettings',
  notCovered: 'Audio capture, native voice shortcuts, server identity, real agent replies, persistence, private digest delivery and cross-device presence. All events are isolated fixture data.',
  stubs: { 'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";' },
  cases: Object.fromEntries(['default', 'thread', 'paused', 'scheduled', 'manual', 'off', 'offline', 'unbound', 'error', 'loading'].map(name => [name, { about: `Personal stand-in: ${name}`, data: { selfAvatar } }])),
  async ready(page) { await page.getByTestId('group-attention-hint').waitFor(); },
  async check(page, ui) {
    assert.equal(await page.getByTestId('group-mask-status').count(), 0);
    const inbox = page.getByTestId('group-attention-hint');
    assert.equal(await inbox.getAttribute('data-count'), '2');
    await inbox.click();
    assert.equal(await page.locator('[data-mention-message]').count(), 2);
    await page.locator('[data-mention-reply]').first().click();
    assert.equal(await inbox.getAttribute('data-count'), '2', 'expanding a historical reply keeps the original unread');
    await ui.capture('mention-history');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: await ui.t('bots.groupChat.settings.open'), exact: true }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByTestId('group-mask-settings-entry').count(), 0);
    assert.equal(await page.getByTestId('group-mask-settings').count(), 0);
    await ui.capture('member-settings');
    await page.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
    await page.locator('[data-thread-preview=question]').click();
    const reply = page.getByRole('textbox', { name: await ui.t('bots.groupChat.server.replyPlaceholder'), exact: true });
    await reply.fill('话题回复仍然可以编辑。');
    assert.equal(await reply.inputValue(), '话题回复仍然可以编辑。');
    assert.equal(await page.getByTestId('group-mask-status').count(), 0);
    await inbox.click();
    await page.locator('[data-mention-message=reply-2]').click();
    await page.locator('[data-testid=group-attention-hint][data-count="1"]').waitFor();
    await inbox.click();
    await page.getByRole('button', { name: await ui.t('bots.groupChat.mask.catchup.markAll'), exact: true }).click();
    await page.locator('[data-testid=group-attention-hint][data-count="0"]').waitFor();
  },
};
