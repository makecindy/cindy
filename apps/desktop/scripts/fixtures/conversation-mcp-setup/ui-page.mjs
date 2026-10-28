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
    settings: {
      about: 'Existing Settings modal keeps saved credentials without reading them back',
    },
  },
  async ready(page) {
    await page.locator('[data-ui-mcp]').waitFor({ state: 'attached' });
  },
  async check(page, ui) {
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
