import assert from 'node:assert/strict';
import group from '../group-control/ui-page.mjs';

export default {
  ...group,
  name: 'group-jump-bottom',
  entry: '../group-control/group-control-fixture.tsx',
  stubs: {
    ...group.stubs,
    // Unrelated ?url asset imports are unsupported by the single-page builder.
    'src/renderer/features/cc-agent/workdir-browse/DrawioPreview': 'export const DrawioPreview = () => null;',
    'src/renderer/features/cc-agent/workdir-browse/PdfPreview': 'export const PdfPreview = () => null;',
  },
  notCovered: 'PDF/Drawio previews, real network, sending and native input; actual group layout and wheel navigation use synthetic host data.',
  cases: {
    default: { about: 'History navigation temporarily replaces topic hints without changing scroll geometry',
      data: { ...group.cases['long-thread'].data, sidebar: false, threadUnread: true } },
    'with-control': { about: 'Navigation replaces both topic and connection bubbles; idle/return restores them unchanged',
      data: { ...group.cases['long-thread'].data, sidebar: false, threadUnread: true, controlled: true } },
  },
  async ready(page) {
    await group.ready(page);
    if (await page.evaluate(() => window.__uiPage.ctx.data.controlled)) {
      await page.evaluate(() => window.__uiPage.emit('controlledState', {
        controllers: [{ deviceId: 'fixture', name: 'Mac Studio' }],
      }));
      await page.locator('[data-controlled-banner-chip]').waitFor();
    }
  },
  async check(page, ui) {
    const timeline = page.getByTestId('bot-group-timeline');
    const composer = page.locator('[data-chat-composer-stack]');
    const bubbles = page.locator('[data-group-bottom-bubbles]');
    const hint = page.locator('[data-thread-hint]');
    const banner = page.locator('[data-controlled-banner-chip]');
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el && el.scrollHeight > el.clientHeight && el.scrollTop > 0;
    });
    const initialTimeline = await timeline.boundingBox();
    const initialComposer = await composer.boundingBox();
    const sameGeometry = async () => {
      assert.deepEqual(await timeline.boundingBox(), initialTimeline, 'navigation must not resize the timeline');
      assert.deepEqual(await composer.boundingBox(), initialComposer, 'navigation must not move the composer');
    };
    await page.mouse.move(initialTimeline.x + initialTimeline.width / 2, initialTimeline.y + initialTimeline.height / 2);
    await page.mouse.wheel(0, -1000);
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight > 500;
    });
    await page.mouse.wheel(0, 150);
    const jump = page.getByRole('button', { name: await ui.t('chat.jumpToBottom'), exact: true });
    await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
    assert.equal(await hint.isVisible(), false, 'topic yields to navigation');
    if (ui.data.controlled) assert.equal(await banner.isVisible(), false, 'connection bubble also yields');
    assert.equal(await bubbles.getAttribute('inert'), '', 'hidden bubble actions cannot receive input');
    await sameGeometry();
    await ui.capture('navigation-replaces-bubbles');
    await hint.waitFor({ state: 'visible', timeout: 3500 });
    if (ui.data.controlled) assert.equal(await banner.isVisible(), true, 'connection bubble returns on idle');
    await sameGeometry();
    await ui.capture('bubbles-restored-after-idle');
    await page.mouse.wheel(0, 80);
    await page.waitForFunction(() => document.querySelector('[data-group-bottom-bubbles]').hasAttribute('inert'));
    await jump.click();
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-testid="bot-group-timeline"]');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    });
    await hint.waitFor({ state: 'visible' });
    if (ui.data.controlled) assert.equal(await banner.isVisible(), true, 'connection bubble returns at the tail');
    await sameGeometry();
    await ui.capture('returned-to-bottom');
  },
};
