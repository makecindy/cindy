import assert from 'node:assert/strict';

// #10713: use the real production composer in both entry modes, with isolated
// host responses; browser keyboard input must create a newline before sending.
export default {
  name: 'group-send-shortcut',
  entry: './fixture.tsx',
  viewport: { width: 680, height: 420 },
  real: 'BotGroupComposer group/topic modes, preference hook, keyboard resolver, browser textarea behavior, themes and translations',
  notCovered: 'Real accounts, server persistence, model execution, attachment IO and native IME',
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/components/new-chat/ComposerAttachments': 'export const AttachmentRejectionStrip = () => null; export const ThumbnailStrip = () => null;',
  },
  cases: {
    default: { about: 'Group composer obeys modifier-enter', data: { mode: 'group' } },
    thread: { about: 'Topic reply obeys modifier-enter', data: { mode: 'thread' } },
  },
  async check(page, ui) {
    const input = page.getByRole('textbox');
    const sent = page.getByRole('status', { name: 'Sent messages' });
    await input.fill('first');
    await input.press('End');
    await input.press('Enter');
    await input.press('s');
    assert.equal(await input.inputValue(), 'first\ns');
    assert.equal(await sent.textContent(), '[]');
    await ui.capture('newline-not-sent');
    await input.press(ui.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '');
    assert.deepEqual(JSON.parse(await sent.textContent()), ['first\ns']);
    await ui.capture('modifier-sent');
  },
};
