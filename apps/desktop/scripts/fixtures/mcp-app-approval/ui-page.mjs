import assert from 'node:assert/strict';
export default {
  name: 'mcp-app-approval', entry: './fixture.tsx', viewport: { width: 560, height: 650 },
  real: 'McpAppPermissionPrompt, Button, product theme and typography. Exact same absolute overlay used by the task composer.',
  notCovered: 'Agent runtime and device-link. Store supplies two pending Host requests; production event routing has unit coverage.',
  stubs: { 'src/renderer/lib/makerChatStore': './store.ts' },
  cases: { default: { about: 'Page approval never changes the conversation or composer height' }, narrow: { about: 'Two approvals at phone-column width', viewport: { width: 360, height: 650 } } },
  async check(page, ui) {
    const before = await page.locator('[data-conversation]').boundingBox();
    const composer = await page.locator('[data-composer]').boundingBox();
    await page.getByText('Request page tool', { exact: true }).click();
    const panel = page.locator('[data-mcp-app-permission]'); await panel.waitFor();
    assert.deepEqual(await page.locator('[data-conversation]').boundingBox(), before, 'approval must not shrink the conversation');
    assert.deepEqual(await page.locator('[data-composer]').boundingBox(), composer, 'approval must not move or cover the composer');
    const box = await panel.boundingBox(); assert.ok(box.y + box.height <= composer.y);
    await panel.locator('summary').first().click();
    assert.deepEqual(await page.locator('[data-conversation]').boundingBox(), before, 'expanded parameters must not shrink conversation');
    await ui.capture('approval');
    // The plugin-page policy now offers the same session-only page grant. Check
    // the actual button response, not just that the panel disappears.
    await panel.getByRole('button', { name: await ui.t('agentIsland.native.alwaysAllowForSession'), exact: true }).first().click();
    assert.deepEqual(await page.evaluate(() => window.pageApprovalAnswer), {
      requestId: 'first', decision: { behavior: 'allow', updatedPermissions: [{ destination: 'session' }] },
    });
    assert.equal(await panel.locator('summary').count(), 1);
    await panel.getByRole('button', { name: await ui.t('agentIsland.native.deny'), exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.deepEqual(await page.locator('[data-conversation]').boundingBox(), before);
  },
};
