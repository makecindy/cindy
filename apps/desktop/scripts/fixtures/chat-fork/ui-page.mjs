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
    companion: { about: 'Completed companion replies retain read-aloud and stop in the persistent message footer' },
    'companion-narrow': { about: 'Reply, read-aloud and more remain accessible below a long reply at 320 px', viewport: { width: 320, height: 520 } },
    'companion-thread': { about: '2026-10-29: native private reply in a 320px topic retains full width and accessible actions below', viewport: { width: 640, height: 520 } },
  },
  async check(page, ui) {
    if (ui.case.startsWith('companion')) {
      const read = page.getByRole('button', { name: await ui.t('bots.voiceMode.readAloud'), exact: true });
      assert.equal(await read.count(), 1);
      if (ui.case === 'companion-thread') {
        // Private-message actions now live below the bubble, not inside the
        // group-chat floating toolbar. Locate the real footer by its accessible action.
        const layout = await read.evaluate(button => {
          const footer = button.parentElement;
          const message = footer.parentElement;
          const bubble = message.querySelector('[data-bot-reply-bubble]').getBoundingClientRect();
          const row = message.getBoundingClientRect(), actions = footer.getBoundingClientRect();
          return {
            unused: row.width - bubble.width,
            below: actions.top >= bubble.bottom,
            inside: actions.left >= row.left && actions.right <= row.right,
            inViewport: actions.left >= 0 && actions.right <= window.innerWidth && actions.bottom <= window.innerHeight,
          };
        });
        assert.ok(layout.unused < 10 && layout.inside && layout.below && layout.inViewport,
          'private topic uses its column with accessible message actions below the bubble');
      }
      await page.locator('[data-bot-reply-bubble]').hover();
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
