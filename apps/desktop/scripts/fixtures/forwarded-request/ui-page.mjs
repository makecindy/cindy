import assert from 'node:assert/strict';
export default {
  name: 'forwarded-request', entry: './forwarded-request-fixture.tsx', viewport: { width: 760, height: 860 },
  real: 'BotDirectMessageView/Card, UserMessage, BotChatQuote previews, SearchResultsBody and production display/search projections',
  notCovered: 'IPC transport, persistence, history reload and native mobile; historical API bodies are supplied by the fixture',
  stubs: {
    'src/renderer/lib/makerChatStore': { partial: "import { makerChatStore as real } from './src/renderer/lib/makerChatStore'; export const makerChatStore = { ...real, reloadMessages: () => {} };" },
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
    'src/renderer/features/bots/botStore': 'const profiles = []; export const useBotProfiles = () => profiles;',
    'src/renderer/components/chat/GhostToolCard': 'export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle"; export const GhostToolCard = () => null; export const MailCardEditor = () => null;',
  },
  cases: {
    default: { about: 'Historical private-thread body: paragraphs, lists, code and attribution' },
    task: { about: 'Attributed task input uses the same readable projection' },
    fork: { about: 'Fork restores the original forwarded envelope in the new draft' },
    rewind: { about: 'Rewind restores the original forwarded envelope in the current draft' },
    quote: { about: 'Reply snapshots and live quote previews use readable text' },
    search: { about: 'Real search results render projected previews and hit snippets' },
    card: { about: 'Expand a historical private-thread card' },
  },
  async check(page, ui) {
    if (ui.case === 'search') {
      await page.getByText('最后一段', { exact: true }).first().waitFor();
      const text = await page.locator('body').innerText();
      assert.ok(text.includes('只检查，不发布。'));
      assert.ok(!text.includes('\\n\\n'));
      return;
    }
    if (['task', 'fork', 'rewind', 'quote'].includes(ui.case)) {
      const expand = page.getByRole('button', { name: await ui.t('chat.userMessage.expandLongMessage'), exact: true });
      if (await expand.count()) await expand.click();
    }
    if (ui.case === 'card') await page.getByRole('button', { name: await ui.t('bots.directMessage.expandThread'), exact: true }).click();
    await page.getByText('最后一段：只检查，不发布。', { exact: false }).last().waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('第一段：消息现在正常换行。'));
    assert.ok(text.includes('const newline = "\\n";'));
    assert.ok(!text.includes('第一段：消息现在正常换行。\\n\\n'));
    if (ui.case === 'quote') {
      await page.getByRole('button', { name: await ui.t('chat.messageActionBar.reply'), exact: true }).click();
      const snapshot = await page.locator('[data-ui-quote-snapshot]').textContent();
      assert.ok(snapshot.includes('第一段：消息现在正常换行。'));
      assert.ok(!snapshot.includes('\\n\\n'));
      const preview = await page.locator('[data-ui-quote-preview]').innerText();
      assert.ok(preview.includes(snapshot));
      await page.locator('[data-ui-unload]').click();
      assert.equal(await page.locator('[data-ui-quote-preview]').innerText(), preview);
    }
    if (ui.case === 'fork' || ui.case === 'rewind') {
      const original = await page.locator('[data-ui-original]').textContent();
      const actionKey = ui.case === 'fork' ? 'chat.messageActionBar.fork' : 'chat.messageActionBar.rewind';
      if (ui.case === 'rewind') await page.getByRole('button', { name: await ui.t('chat.messageActionBar.moreActions'), exact: true }).click();
      await page.getByRole(ui.case === 'rewind' ? 'menuitem' : 'button', { name: await ui.t(actionKey), exact: true }).click();
      const confirmKey = ui.case === 'fork' ? 'chat.messageActionBar.forkConfirm' : 'chat.rewind.dialog.confirm';
      await page.getByRole('button', { name: await ui.t(confirmKey), exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-ui-draft]')?.textContent);
      const draft = JSON.parse(await page.locator('[data-ui-draft]').textContent());
      assert.equal(draft.content[0].content[0].text, original);
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    }
  },
};
