/* global document, innerWidth, getComputedStyle -- callbacks run in the fixture browser. */
import assert from 'node:assert/strict';

export default {
  name: 'mcp-inline-form',
  entry: './mcp-inline-form-fixture.tsx',
  viewport: { width: 600, height: 1000 },
  real: 'Existing McpServerDialog and save helper, McpServersSection, McpSetupPrompt, production MessageStream footer',
  notCovered: 'OS safeStorage, real account switching, MCP network connections and vendor model calls use separate checks; host APIs here return fixture results.',
  // No plugin tool card is rendered here; its iframe CSS imports require Vite's ?inline loader.
  stubs: { 'src/renderer/components/chat/GhostToolCard': 'export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle"; export const GhostToolCard = () => null; export const MailCardEditor = () => null;' },
  cases: {
    'settings-unreadable': { about: 'Healthy settings stay editable; unreadable credential records retain their identity and delete action' },
    'settings-unreadable-narrow': { about: 'Unreadable settings wrap without hiding actions at 320 px', viewport: { width: 320, height: 900 } },
    'settings-load-error': { about: 'Storage failure is explicit and retryable, not an empty successful list' },
    stdio: { about: 'Local stdio form with public Grafana suggestions and empty secret values' },
    'stdio-narrow': { about: 'stdio environment rows at 320 px', viewport: { width: 320, height: 1200 } },
    'stdio-edit': { about: 'Editing a local server keeps saved env write-only' },
    'stdio-invalid': { about: 'stdio validation error and focus' },
    'stdio-settings': { about: 'Real stdio modal without scrolling; content and Save align', viewport: { width: 900, height: 1100 } },
    'stdio-settings-scroll': { about: 'Real stdio modal scrolls without moving Save or changing alignment', viewport: { width: 900, height: 600 } },
    'stdio-settings-narrow': { about: 'Real stdio modal groups environment pairs at 320 px', viewport: { width: 320, height: 900 } },
    default: { about: 'The existing Settings form expanded in the message flow' },
    narrow: { about: 'Inline form at 320 px', viewport: { width: 320, height: 1100 } },
    invalid: { about: 'Original validation and focus in the embedded form' },
    'result-error': { about: 'Saved configuration remains saved when result delivery fails; retry and cancel remain available' },
    settings: { about: 'Original modal remains a modal' },
    layout: { about: 'Production message scrollport carries the entire form; composer stays fixed', viewport: { width: 600, height: 600 } },
  },
  async ready(page) { await page.getByRole('button', { name: /./ }).first().waitFor(); },
  async check(page, ui) {
    if (ui.case.startsWith('settings-unreadable')) {
      await page.getByRole('group', { name: 'Grafana', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.mcp.editAria'), exact: true }).count(), 1);
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.mcp.deleteAria'), exact: true }).count(), 3);
      assert.equal(await page.getByText(await ui.t('settings.mcp.unreadable'), { exact: true }).count(), 2);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      return;
    }
    if (ui.case === 'settings-load-error') {
      await page.getByRole('alert').filter({ hasText: await ui.t('settings.mcp.loadFailed') }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('commonUi.retry'), exact: true }).isEnabled(), true);
      return;
    }
    const title = await ui.t('settings.mcp.dialog.createTitle');
    const modal = ['settings', 'stdio-edit'].includes(ui.case) || ui.case.startsWith('stdio-settings');
    const region = modal ? page.getByRole('dialog') : page.getByRole('region', { name: title });
    await region.waitFor();
    if (ui.case === 'stdio-edit') {
      const value = page.getByLabel(`${await ui.t('settings.mcp.fields.envValue')} 1`, { exact: true });
      assert.equal(await value.inputValue(), '');
      assert.equal(await value.getAttribute('placeholder'), await ui.t('settings.mcp.fields.envSaved'));
      return;
    }
    if (ui.case === 'settings') return;
    if (ui.case.startsWith('stdio')) {
      assert.equal(await page.getByLabel(await ui.t('settings.mcp.fields.command'), { exact: true }).inputValue(), 'uvx');
      if (ui.case !== 'stdio-invalid') {
        const name = page.getByLabel(`${await ui.t('settings.mcp.fields.envName')} 1`, { exact: true });
        const value = page.getByLabel(`${await ui.t('settings.mcp.fields.envValue')} 1`, { exact: true });
        const remove = page.getByRole('button', { name: `${await ui.t('settings.mcp.fields.removeEnv')} 1`, exact: true });
        const environment = page.getByRole('group', { name: await ui.t('settings.mcp.fields.env'), exact: true });
        const panel = environment.locator('..');
        const save = page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true });
        const beforeSave = await save.boundingBox();
        const panelBox = await panel.boundingBox();
        if (modal) {
          assert.ok(Math.abs(panelBox.x + panelBox.width - beforeSave.x - beforeSave.width) <= 1,
            'Transport panel and Save must share their outer right edge');
          const command = page.getByLabel(await ui.t('settings.mcp.fields.command'), { exact: true });
          const scroll = await command.evaluate(input => {
            for (let node = input.parentElement; node; node = node.parentElement) {
              if (getComputedStyle(node).overflowY === 'auto') {
                const overflow = node.scrollHeight > node.clientHeight + 1;
                node.scrollTop = node.scrollHeight;
                return { overflow, scrollTop: node.scrollTop };
              }
            }
            throw new Error('Missing modal scrollport');
          });
          if (ui.case === 'stdio-settings') assert.equal(scroll.overflow, false);
          else assert.ok(scroll.overflow && scroll.scrollTop > 0, 'Short modal must scroll');
          const afterSave = await save.boundingBox();
          assert.ok(Math.abs(afterSave.y - beforeSave.y) <= 1, 'Save stays fixed while the body scrolls');
          assert.ok(afterSave.y >= 0 && afterSave.y + afterSave.height <= ui.viewport.height);
        }
        const [nameBox, valueBox, removeBox, groupBox] = await Promise.all([
          name.boundingBox(), value.boundingBox(), remove.boundingBox(), environment.boundingBox(),
        ]);
        if (groupBox.width >= 400) {
          assert.ok(Math.abs(nameBox.y - valueBox.y) <= 1, 'Desktop variable name and value stay side by side');
          assert.ok(valueBox.x >= nameBox.x + nameBox.width);
          assert.ok(removeBox.x >= valueBox.x + valueBox.width);
          assert.ok(Math.abs(removeBox.y - nameBox.y) <= 1);
        } else {
          assert.ok(valueBox.y >= nameBox.y + nameBox.height, 'Narrow variable value stays below its name');
          assert.ok(Math.abs(nameBox.x - valueBox.x) <= 1);
          assert.ok(removeBox.x >= nameBox.x + nameBox.width);
          assert.ok(Math.abs(removeBox.y + removeBox.height / 2 - (nameBox.y + valueBox.y + valueBox.height) / 2) <= 1,
            'Delete remains centred beside its name/value pair');
        }
        const nextName = await page.getByLabel(`${await ui.t('settings.mcp.fields.envName')} 2`, { exact: true }).boundingBox();
        assert.ok(nextName.y > valueBox.y + valueBox.height, 'Adjacent variables remain distinct groups');
        if (modal && ui.case !== 'stdio-settings') await ui.capture('scrolled');
      }
      if (ui.case === 'stdio-invalid') {
        await page.getByLabel(await ui.t('settings.mcp.fields.command'), { exact: true }).fill('');
        await page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true }).click();
        await page.getByText(await ui.t('settings.mcp.errors.commandRequired'), { exact: true }).waitFor();
      }
      if (ui.case === 'stdio-narrow') assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      return;
    }
    assert.equal(await page.getByRole('dialog').count(), 0);
    if (ui.case === 'result-error') {
      await page.getByLabel(await ui.t('settings.mcp.fields.name'), { exact: true }).fill('Example');
      await page.getByLabel(await ui.t('settings.mcp.fields.url'), { exact: true }).fill('https://example.test/mcp');
      await page.getByLabel(await ui.t('settings.mcp.fields.token'), { exact: true }).fill('test-invalid-token');
      await page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true }).click();
      await page.getByRole('alert').filter({ hasText: await ui.t('settings.mcp.toast.created') }).waitFor();
      assert.deepEqual(await page.evaluate(() => JSON.parse(document.documentElement.dataset.uiMcpSave)),
        { method: 'create', transport: 'http', tokenAction: 'set', count: 1 });
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
