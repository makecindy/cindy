import assert from 'node:assert/strict';

export default {
  name: 'remote-model-access',
  entry: './remote-model-access-fixture.tsx',
  viewport: { width: 760, height: 700 },
  real: 'RemoteModelAccessSection, RemoteModelAccessDialog, product buttons, translations and themes',
  notCovered: 'Live IPC, persisted permissions and cross-device calls. Names and models are fixture data.',
  cases: {
    'alias-all': { about: 'Codex and Pi/Claude aliases display once and are toggled together' },
    'alias-partial': { about: 'Existing Codex-only permission remains mixed and unchanged on save' },
    'alias-pi-ceiling': { about: 'Personal selection cannot exceed a Pi-only provider ceiling' },
    'alias-pi-only': { about: 'Pi-only catalogs save the actual chatgpt/ ID without fabricating a Codex ID' },
    budget: { about: 'OpenAI single-model percentage limit' },
    'budget-claude': { about: 'Claude uses its own catalog and single-model percentage limit' },
    'budget-new-model': { about: 'A new catalog model can be selected without product code changes' },
    'budget-learning': { about: 'Unknown usage is not zero' },
    'budget-save-failure': { about: 'Retains a percentage change on save failure' },
    'budget-unsupported': { about: 'Provider group cannot add a percentage policy' },
    default: { about: 'Provider-wide model selection' },
    member: { about: 'Per-person model selection within the provider ceiling' },
  },
  async ready(page) {
    await page.getByRole('button', { name: /.+/ }).first().waitFor();
  },
  async check(page, ui) {
    if (ui.case.startsWith('alias-')) {
      const sol = page.getByRole('checkbox', { name: 'GPT-6.1-Sol', exact: true });
      await sol.waitFor();
      assert.equal(await sol.count(), 1);
      assert.equal(await page.getByRole('checkbox', { name: 'GPT-6-Astra', exact: true }).count(), 1);
      const save = page.getByRole('button', { name: await ui.t('settings.providers.custom.save'), exact: true });
      if (ui.case === 'alias-partial') {
        assert.equal(await sol.evaluate(input => input.indeterminate), true);
        await save.click();
        assert.deepEqual(await page.evaluate(() => window.modelAccessSaved.models), ['gpt-6.1-sol']);
        return;
      }
      await sol.click();
      await save.click();
      const removed = await page.evaluate(() => window.modelAccessSaved.models);
      assert.ok(!removed.includes('gpt-6.1-sol') && !removed.includes('chatgpt/gpt-6.1-sol'));
      await sol.click();
      await save.click();
      const saved = await page.evaluate(() => window.modelAccessSaved.models);
      assert.ok(saved.includes('chatgpt/gpt-6.1-sol'));
      assert.equal(saved.includes('gpt-6.1-sol'), ui.case === 'alias-all');
      if (ui.case === 'alias-pi-ceiling') assert.deepEqual(saved, ['chatgpt/gpt-6.1-sol']);
      await ui.capture('selected');
      return;
    }
    if (ui.case.startsWith('budget')) {
      const percent = page.getByRole('spinbutton', { name: await ui.t('providerShare.memberBudget.maxPercent'), exact: true });
      await percent.waitFor();
      assert.equal(await percent.inputValue(), '30');
      const recommended = page.getByRole('combobox', { name: await ui.t('providerShare.memberBudget.recommended'), exact: true });
      const claude = ui.case === 'budget-claude';
      const alternative = claude ? 'claude-haiku' : 'gpt-sol';
      await recommended.selectOption(alternative);
      assert.equal(await recommended.inputValue(), alternative);
      await recommended.selectOption(claude ? 'claude-sonnet' : 'gpt-terra');
      const selectedModel = page.getByRole('combobox', { name: await ui.t('providerShare.memberBudget.chooseModels'), exact: true });
      assert.equal(await selectedModel.inputValue(), claude ? 'claude-fable' : 'gpt-astra');
      if (claude) assert.equal(await selectedModel.locator('option[value="gpt-astra"]').count(), 0);
      else assert.equal(await selectedModel.locator('option[value="claude-fable"]').count(), 0);
      if (ui.case === 'budget-new-model') {
        await selectedModel.selectOption('catalog-new-model-42');
        await recommended.selectOption('catalog-new-model-42');
        assert.equal(await selectedModel.inputValue(), 'catalog-new-model-42');
      }
      if (ui.case === 'budget-unsupported') {
        assert.equal(await page.getByRole('button', { name: await ui.t('providerShare.memberBudget.addGroup'), exact: true }).isEnabled(), false);
      } else if (ui.case === 'budget-save-failure') {
        await percent.fill('25');
        await page.getByRole('button', { name: await ui.t('settings.providers.custom.save'), exact: true }).click();
        await page.getByRole('alert').waitFor();
        assert.equal(await percent.inputValue(), '25');
      }
      await page.getByRole('checkbox', { name: await ui.t('providerShare.memberBudget.enable'), exact: true }).scrollIntoViewIfNeeded();
      await ui.capture('budget');
      return;
    }
    if (ui.case === 'default') {
      await page.getByRole('button', { name: await ui.t('providerShare.modelAccess.choose'), exact: true }).click();
    }
    const small = page.getByRole('checkbox', { name: 'Claude Haiku', exact: true });
    await small.waitFor();
    if (ui.case === 'member') {
      assert.equal(await page.getByRole('checkbox', { name: 'Claude Opus', exact: true }).isEnabled(), false);
      assert.equal(await small.isChecked(), true);
    } else {
      await small.uncheck();
      assert.equal(await small.isChecked(), false);
    }
    await ui.capture('models');
  },
};
