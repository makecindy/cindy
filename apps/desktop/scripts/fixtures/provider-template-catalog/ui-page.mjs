import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
// Load the same production catalog in Node and in the browser, without a stale ID snapshot.
const bundled = await build({ entryPoints: [fileURLToPath(new URL('./cases.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', write: false });
const { cases, presets, bindInput } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
export default {
  name: 'provider-template-catalog', entry: './fixture.tsx', viewport: { width: 1000, height: 900 },
  real: 'Every bundled preset, real custom dialog and wizard, simulated clicks through identification and save',
  notCovered: 'Discovery and saving are fake host interfaces. No real keys, OAuth, network, disk persistence or model generation.',
  cases: { default: { about: 'Catalog completeness smoke' }, ...Object.fromEntries(cases.map(c => [c.id, { about: `${c.kind}: ${c.providerId} ${c.address}` }])) },
  async ready(page) { await page.getByRole('dialog').waitFor(); },
  async check(page, ui) {
    assert.deepEqual(await page.evaluate(() => window.templateIds), presets.map(p => p.id));
    const item = cases.find(c => c.id === ui.case) ?? cases[0];
    const preset = presets.find(p => p.id === item.providerId);
    if (item.kind === 'address') {
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill(`Review ${item.providerId}`);
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill(item.address);
      if (item.expectedIds.length !== 1) {
        await page.getByText(await ui.t('settings.providers.detection.ambiguous'), { exact: true }).waitFor();
        await page.waitForTimeout(1400);
        assert.equal(await page.getByRole('button', { name: await ui.t('settings.providers.detection.configure'), exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => window.templateEvidence.handoff), undefined);
        await ui.capture('ambiguous-stayed-custom');
        return;
      }
      const configure = page.getByRole('button', { name: await ui.t('settings.providers.detection.configure'), exact: true });
      await configure.waitFor();
      await page.waitForTimeout(1500);
      assert.equal(await page.evaluate(() => window.templateEvidence.handoff), undefined, 'Recognition alone must not navigate');
      await configure.click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.templateEvidence.handoff.preset.id), item.providerId);
    }
    const apiKeyChoice = page.getByRole('button', { name: await ui.t('settings.providers.wizard.useApiKey'), exact: true });
    if (await apiKeyChoice.count()) await apiKeyChoice.click();
    // Direct wizard cases cover each template even when its address is shared by plans.
    const key = page.locator('input[type=password]');
    if (await key.count()) await key.fill(preset.id.startsWith('xiaomi') && preset.id.includes('token-plan') ? 'tp-ui-fixture' : 'fake-ui-key');
    for (const runtime of Object.values(preset.runtimes)) {
      if (!runtime?.baseUrl.includes('{')) continue;
      const inputs = page.locator('input');
      for (let i = 0; i < await inputs.count(); i++) if (await inputs.nth(i).inputValue() === runtime.baseUrl) await inputs.nth(i).fill(bindInput(runtime.baseUrl));
    }
    await ui.capture('connection');
    await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).click();
    const finish = page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true });
    await finish.waitFor();
    // The catalog response is fixed; selecting it uses the real model picker, not state injection.
    let selectedModelId = 'ui-catalog-probe';
    if (item.kind === 'wizard' && preset.id === 'opencode-go') {
      // Go retains its curated plan members; arbitrary discovered IDs are not plan models.
      const model = preset.runtimes.pi.models.find(m => Object.values(preset.runtimes).every(rt => rt.models.some(row => row.id === m.id)));
      assert.ok(model);
      selectedModelId = model.id;
      const row = page.getByText(model.name, { exact: true });
      await row.click(); await row.click(); // Exercise selection, then restore the recommended row.
    } else if (item.kind === 'wizard') await page.getByText('UI catalog probe', { exact: true }).click();
    await ui.capture('models');
    await finish.click();
    await page.waitForFunction(() => window.templateEvidence.saved);
    const saved = await page.evaluate(() => window.templateEvidence.saved);
    assert.deepEqual(Object.keys(saved.runtimes).sort(), Object.keys(preset.runtimes).sort());
    for (const [agent, runtime] of Object.entries(saved.runtimes)) {
      assert.ok(preset.runtimes[agent], `unexpected engine ${agent}`);
      assert.equal(runtime.catalogPresetId, preset.id);
      assert.ok(runtime.baseUrl && !runtime.baseUrl.includes('{'));
      for (const [header, value] of Object.entries(preset.runtimes[agent].headers ?? {})) assert.equal(runtime.headers?.[header], value);
      if (item.kind === 'address') {
        const handed = await page.evaluate(agent => window.templateEvidence.handoff.preset.runtimes[agent], agent);
        assert.equal(runtime.baseUrl, handed.baseUrl);
        if (handed.wireProtocol) assert.equal(runtime.wireProtocol, handed.wireProtocol);
      }
      assert.ok(runtime.models.some(m => m.id === selectedModelId), `missing selected model ${agent}`);
    }
    assert.ok(Object.keys(saved.runtimes).length);
  },
};
