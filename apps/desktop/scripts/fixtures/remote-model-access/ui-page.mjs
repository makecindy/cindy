import assert from 'node:assert/strict';

export default {
  name: 'remote-model-access',
  entry: './remote-model-access-fixture.tsx',
  viewport: { width: 760, height: 700 },
  real: 'RemoteModelAccessSection, RemoteModelAccessDialog, product buttons, translations and themes',
  notCovered: 'Live IPC, persisted permissions and cross-device calls. Names and models are fixture data.',
  cases: {
    default: { about: 'Provider-wide model selection' },
    member: { about: 'Per-person model selection within the provider ceiling' },
  },
  async ready(page) {
    await page.getByRole('button', { name: /.+/ }).first().waitFor();
  },
  async check(page, ui) {
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
