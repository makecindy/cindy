import assert from 'node:assert/strict';

export default {
  name: 'mcp-inline-form',
  entry: './mcp-inline-form-fixture.tsx',
  viewport: { width: 600, height: 1000 },
  real: 'Existing McpServerDialog and save helper, McpSetupPrompt, production MessageStream footer',
  notCovered: 'OS safeStorage, real account switching, MCP network connections and vendor model calls use separate checks; host APIs here return fixture results.',
  // No plugin tool card is rendered here; its iframe CSS imports require Vite's ?inline loader.
  stubs: { 'src/renderer/components/chat/GhostToolCard': 'export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle"; export const GhostToolCard = () => null; export const MailCardEditor = () => null;' },
  cases: {
    default: { about: 'The existing Settings form expanded in the message flow' },
    narrow: { about: 'Inline form at 320 px', viewport: { width: 320, height: 1100 } },
    invalid: { about: 'Original validation and focus in the embedded form' },
    'result-error': { about: 'Saved configuration remains saved when result delivery fails; retry and cancel remain available' },
    settings: { about: 'Original modal remains a modal' },
    layout: { about: 'Production message scrollport carries the entire form; composer stays fixed', viewport: { width: 600, height: 600 } },
  },
  async ready(page) { await page.getByRole('button', { name: /./ }).first().waitFor(); },
  async check(page, ui) {
    const title = await ui.t('settings.mcp.dialog.createTitle');
    const region = ui.case === 'settings' ? page.getByRole('dialog') : page.getByRole('region', { name: title });
    await region.waitFor();
    if (ui.case === 'settings') return;
    assert.equal(await page.getByRole('dialog').count(), 0);
    if (ui.case === 'result-error') {
      await page.getByLabel(await ui.t('settings.mcp.fields.name'), { exact: true }).fill('Example');
      await page.getByLabel(await ui.t('settings.mcp.fields.url'), { exact: true }).fill('https://example.test/mcp');
      await page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true }).click();
      await page.getByRole('alert').filter({ hasText: await ui.t('settings.mcp.toast.created') }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('commonUi.retry'), exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.mcp.cancel'), exact: true }).isEnabled(), true);
      return;
    }
    if (ui.case === 'invalid') {
      await page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true }).click();
      await page.getByText(await ui.t('settings.mcp.errors.nameRequired'), { exact: true }).waitFor();
      assert.equal(await page.getByLabel(await ui.t('settings.mcp.fields.name'), { exact: true }).evaluate(el => el === document.activeElement), true);
    }
    if (ui.case === 'narrow') assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (ui.case === 'layout') {
      const scroll = page.locator('[data-scroll-container]');
      const composer = page.locator('[data-ui-composer]');
      const beforeComposer = await composer.boundingBox();
      const input = page.getByLabel(await ui.t('settings.mcp.fields.token'), { exact: true });
      await input.fill('test-invalid-token');
      await scroll.evaluate(el => { el.scrollTop = 0; });
      const before = await region.boundingBox();
      await scroll.hover({ position: { x: 20, y: 100 } });
      await page.mouse.wheel(0, 300);
      await page.waitForFunction(() => document.querySelector('[data-scroll-container]').scrollTop > 0);
      assert.ok((await region.boundingBox()).y < before.y);
      assert.equal((await composer.boundingBox()).y, beforeComposer.y);
      assert.equal(await input.inputValue(), 'test-invalid-token');
      assert.equal(await region.evaluate(el => el.scrollHeight <= el.clientHeight + 1), true);
      await ui.capture('scrolled');
    }
  },
};
