import assert from 'node:assert/strict';
import composer from '../companion-composer/ui-page.mjs';
const stubs = { ...composer.stubs };
delete stubs['src/renderer/components/new-chat/ExtraDirsButton'];
export default {
  name: 'companion-message-actions',
  entry: './fixture.tsx',
  viewport: { width: 1000, height: 650 },
  real: 'AssistantMessage, UserMessage, MessageActionBar, BotDmThreadPreview/Panel, BotChatQuoteComposerPreview, ChatInput, original menus and themes',
  notCovered:
    'Live model/server persistence and OS clipboard. The isolated host denies clipboard; a recorder verifies requested text and feedback. Topic panel uses real failed state with sample data; native mobile tested separately.',
  stubs: {
    ...stubs,
    'src/renderer/components/chat/GhostToolCard':
      'export const GhostToolCard=()=>{throw new Error("No plugin cards in this fixture")};',

    'src/renderer/features/cc-agent/CCAgentSessionView':
      'export const CCAgentSessionView=()=>{throw new Error("No ready runtime in this fixture")};',
    'src/renderer/lib/makerChatStore': {
      partial:
        'export const makerChatStore={subscribe:()=>()=>{},getSnapshot:()=>window.__threadRoot,getAgentSwitchIntent:()=>null,getAgentSwitchIntentRev:()=>0};',
    },
    'src/renderer/voice-input/workletUrl':
      'export const getVoiceInputWorkletUrl=()=>{throw new Error("not covered")};',
  },
  cases: {
    default: { about: 'No topic: quote/copy always visible, create topic in More' },
    read: { about: 'Original topic entry with count/time' },
    unread: { about: 'Original topic entry with unread indicator' },
  },
  async ready(page) {
    await page.locator('[contenteditable=true]').waitFor();
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copiedText = text;
          },
        },
      }),
    );
  },
  async check(page, ui) {
    const reply = page
      .locator('[data-answer]')
      .getByRole('button', { name: await ui.t('chat.messageActionBar.reply'), exact: true });
    assert(await reply.isVisible());
    const before = await reply.boundingBox();
    assert.equal(before.width, 32);
    assert.equal(before.height, 32);
    const editor = page.locator('[contenteditable=true]');
    await editor.fill('Keep this draft');
    await reply.click();
    await page.getByTestId('bot-group-quote-preview').waitFor();
    assert((await editor.innerText()).includes('Keep this draft'));
    await ui.capture('quote');
    await page
      .getByRole('button', { name: await ui.t('bots.groupChat.quote.remove'), exact: true })
      .click();
    assert((await editor.innerText()).includes('Keep this draft'));
    assert.equal(await page.getByTestId('bot-group-quote-preview').count(), 0);
    const copy = page
      .locator('[data-answer]')
      .getByRole('button', { name: await ui.t('chat.messageActionBar.copy'), exact: true });
    // Let the existing hover-enter reset commit before testing the next copy feedback.
    await copy.hover();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await copy.click();
    await page.locator('[data-answer] .lucide-check').waitFor({ timeout: 3000 });
    assert.equal(
      await page.evaluate(() => window.__copiedText),
      '已沿用现有组件。正文可以直接选择，引用后也可以继续编辑草稿。',
    );
    const more = page
      .locator('[data-answer]')
      .getByRole('button', { name: await ui.t('chat.messageActionBar.moreActions'), exact: true });
    await more.click();
    const label = await ui.t(
      ui.case === 'default'
        ? 'bots.groupChat.server.startTopic'
        : 'bots.groupChat.server.openTopic',
      { count: 3 },
    );
    await page.getByRole('menuitem', { name: label, exact: true }).waitFor();
    await ui.capture('more');
    await page.getByRole('menuitem', { name: label, exact: true }).click();
    await page.locator('[data-dm-thread-panel]').waitFor();
    assert.equal(await page.getByRole('menu').count(), 0);
    await ui.capture('topic');
    await page.getByRole('button', { name: await ui.t('bots.close'), exact: true }).click();
    await page.locator('[data-dm-thread-panel]').waitFor({ state: 'detached' });
    assert.equal(
      await page.locator('[data-dm-thread-preview]').count(),
      ui.case === 'default' ? 0 : 1,
    );
    const p = page.locator('[data-answer] [data-bot-reply-bubble] p').first();
    await p.evaluate((el) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      getSelection().removeAllRanges();
      getSelection().addRange(r);
    });
    assert((await page.evaluate(() => getSelection().toString())).length > 5);
  },
};
