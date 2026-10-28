import assert from 'node:assert/strict';
export default {
  name: 'conversation-mcp-setup',
  entry: './conversation-mcp-setup-fixture.tsx',
  viewport: { width: 600, height: 1000 },
  real: 'McpSetupPrompt and shared McpServerDialog with production inputs, buttons, themes and translations',
  notCovered:
    'Main IPC origin checks, OS encryption, database, actual MCP network and native harness execution. Host replies are fixture metadata; Main behavior has separate integration tests.',
  cases: {
    default: {
      about:
        'Review target, clear credentials on target change, then save through local-only host calls',
    },
    narrow: { about: 'The same full form at 320 px', viewport: { width: 320, height: 1100 } },
    verifying: { about: 'Verification progress with cancellation' },
    failed: { about: 'Safe failure and fresh empty credential fields' },
    saved: { about: 'Saved receipt and accurate next Agent session scope' },
    'activation-pending': { about: 'Retry runtime refresh without creating another server' },
    'activation-deferred': { about: 'Automatic idle refresh updates the receipt without a manual retry' },
    'activation-refreshing': { about: 'Applying saved configuration has no retry button' },
    layout: { about: 'Fully expanded host form scrolls with messages while composer stays fixed', viewport: { width: 600, height: 600 } },
    'layout-narrow': { about: 'The full inline form uses the message scrollport at a narrow desktop width', viewport: { width: 400, height: 600 } },
    settings: {
      about: 'Existing Settings modal keeps saved credentials without reading them back',
    },
  },
  async ready(page) {
    await page.locator('[data-ui-mcp]').waitFor({ state: 'attached' });
  },
  async check(page, ui) {
    if (ui.case.startsWith('layout')) {
      const card = page.locator('[data-ui-mcp] section');
      const composer = page.locator('[data-ui-composer]');
      const messages = page.locator('[data-ui-messages]');
      await messages.evaluate(el => { el.scrollTop = 400; });
      const cardBox = await card.boundingBox();
      const composerBox = await composer.boundingBox();
      const columnBox = await page.locator('[data-ui-timeline-column]').boundingBox();
      assert.ok(cardBox && composerBox);
      assert.ok(columnBox && Math.abs(cardBox.x - columnBox.x) < 1 && Math.abs(cardBox.width - columnBox.width) < 1, 'inline card edges must match the message column');
      const form = card.locator('fieldset').first();
      assert.ok(await form.evaluate(el => el.scrollHeight <= el.clientHeight + 1), 'the whole form must expand without an inner scrollport');
      await page.mouse.move(cardBox.x + 20, Math.max(80, cardBox.y + 30));
      const before = await messages.evaluate(el => el.scrollTop);
      await page.mouse.wheel(0, 200);
      await page.waitForFunction(value => document.querySelector('[data-ui-messages]').scrollTop > value, before);
      const afterBox = await card.boundingBox();
      const composerAfter = await composer.boundingBox();
      assert.ok(afterBox.y < cardBox.y, 'the card must move with the message history');
      assert.equal(composerAfter.y, composerBox.y, 'the composer must stay fixed while the form scrolls');
      assert.equal(await form.evaluate(el => el.scrollTop), 0, 'wheel input must not scroll inside the form');
      await ui.capture('scrolled');
      return;
    }
    if (ui.case === 'activation-deferred' || ui.case === 'activation-refreshing') {
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.mcp.setup.retryActivation') }).count(), 0);
      if (ui.case === 'activation-deferred') {
        await page.getByText(await ui.t('settings.mcp.setup.activationDeferred'), { exact: true }).waitFor();
        await page.evaluate(() => window.dispatchEvent(new Event('fixture-mcp-applied')));
        await page.getByText(await ui.t('settings.mcp.setup.nextTask'), { exact: true }).waitFor();
      }
      return;
    }
    if (ui.case === 'narrow') {
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
      );
      const save = page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true });
      const bounds = await save.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320);
      return;
    }
    if (ui.case === 'failed') {
      assert.ok(await page.getByRole('alert').isVisible());
      return;
    }
    if (ui.case === 'activation-pending') {
      await page
        .getByRole('button', { name: await ui.t('settings.mcp.setup.retryActivation') })
        .click();
      await page.getByText(await ui.t('settings.mcp.setup.nextTask'), { exact: true }).waitFor();
      return;
    }
    if (ui.case !== 'default') return;
    const token = page.getByLabel(await ui.t('settings.mcp.fields.token'), { exact: true });
    const url = page.getByLabel(await ui.t('settings.mcp.fields.url'), { exact: false });
    const headerName = page.getByPlaceholder(
      await ui.t('settings.mcp.fields.headerNamePlaceholder'),
    );
    const headerValue = page.getByPlaceholder(
      await ui.t('settings.mcp.fields.headerValuePlaceholder'),
    );
    await token.fill('test-invalid-token');
    await headerValue.fill('test-invalid-header');
    await url.fill('https://another.test/mcp');
    assert.equal(await token.inputValue(), '');
    assert.equal(await headerValue.inputValue(), '');
    await url.fill('https://example.test/mcp');
    await headerName.fill('X-Test-Key');
    await token.fill('test-invalid-token');
    await headerValue.fill('test-invalid-header');
    await ui.capture('reviewed');
    await page.getByRole('button', { name: await ui.t('settings.mcp.save'), exact: true }).click();
    await page.getByText(await ui.t('settings.mcp.setup.nextTask'), { exact: true }).waitFor();
    await page.getByText('Example MCP', { exact: true }).waitFor();
    await page.getByText('https://example.test/mcp', { exact: true }).waitFor();
    assert.equal(await page.locator('input[type=password]').count(), 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.fixtureMcpSubmitted),
      'true',
    );
  },
};
