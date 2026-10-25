import assert from 'node:assert/strict';
export default {
  name: 'chat-fork', entry: './chat-fork-fixture.tsx', viewport: { width: 800, height: 480 },
  real: 'UserMessage, AssistantMessage, MessageActionBar, companion read-aloud actions and useForkAtMessage with native fork capabilities',
  notCovered: 'Native remote execution, database writes and real speech playback; plugin cards are absent from these messages',
  stubs: {
    'src/renderer/components/chat/GhostToolCard': 'export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle"; export const GhostToolCard = () => null; export const MailCardEditor = () => null;',
  },
  cases: {
    default: { about: 'Task using a shared model: fork from a user message or an assistant reply' },
    ssh: { about: 'SSH workspaces still hide the unsupported fork action' },
    companion: { about: 'Completed companion replies retain read-aloud and stop in the compact bubble toolbar' },
    'companion-narrow': { about: 'Reply, read-aloud and more fit beside a long reply at 320 px', viewport: { width: 320, height: 520 } },
  },
  async check(page, ui) {
    if (ui.case.startsWith('companion')) {
      await page.locator('[data-bot-reply-bubble]').hover();
      const read = page.getByRole('button', { name: await ui.t('bots.voiceMode.readAloud'), exact: true });
      assert.equal(await read.count(), 1);
      await read.click();
      const stop = page.getByRole('button', { name: await ui.t('bots.voiceMode.stopReadAloud'), exact: true });
      assert.equal(await stop.getAttribute('aria-pressed'), 'true');
      await ui.capture('reading');
      await stop.click();
      assert.equal(await read.count(), 1);
      return;
    }
    const forks = page.getByRole('button', { name: await ui.t('chat.messageActionBar.fork'), exact: true });
    assert.equal(await forks.count(), ui.case === 'ssh' ? 0 : 2);
    if (ui.case === 'ssh') return;
    await page.getByText('可以。分叉后会保留历史上下文，继续使用原来那台电脑上的共享模型。', { exact: true }).hover();
    await forks.last().click();
    await page.getByRole('alertdialog').waitFor();
    await ui.capture('fork-confirm');
    await page.getByRole('button', { name: await ui.t('chat.messageActionBar.forkCancel'), exact: true }).click();
    await page.getByText('技术上能想办法实现吗？', { exact: true }).hover();
    await forks.first().click();
    await page.getByRole('alertdialog').waitFor();
    await page.getByRole('button', { name: await ui.t('chat.messageActionBar.forkCancel'), exact: true }).click();
    await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  },
};
