import assert from 'node:assert/strict';
export default {
  name: 'provider-detection', entry: './provider-detection-fixture.tsx',
  viewport: { width: 900, height: 900 },
  real: 'ProviderConnectionDialog and AddProviderWizard, delayed handoff, model selection, translations and themes',
  notCovered: 'Network/IPC logic has separate injected production-unit tests. Live credentials, persistence integration and actual harness calls are not covered here. Windows platform is simulated when requested.',
  cases: {
    'loopback-identity': { about: 'HTTPS loopback address is not an official brand even if a catalog entry uses it' },
    'ambiguous-official': { about: 'Two official plans sharing an address do not choose a provider automatically' },
    ...Object.fromEntries(['gateway', 'workers'].flatMap(kind => ['scheme', 'host', 'port'].map(variant =>
      [`cloudflare-${kind}-${variant}`, { about: 'Normalized Cloudflare address enters its wizard and saves account-bound engine routes' }]))),
    'return-reenable': { about: 'Checked previously disabled model survives wizard back and custom save' },
    'custom-port': { about: 'Azure and Vertex custom ports stay custom and are saved unchanged' },
    'local-noauth': { about: 'Local empty key remains editable; key changes affect test auth and saving keeps no-auth' },
    reenable: { about: 'A checked model with an old disabled draft is enabled in the saved payload' },
    empty: { about: 'HTML design: one default connection, collapsed manual entry and bottom actions' },
    return: { about: 'Return from the identified wizard with inputs preserved and no automatic navigation' },
    default: { about: 'Official address matches DeepSeek and enters its existing connection step' },
    litellm: { about: 'LiteLLM maps to its existing provider connection' },
    'manual-fetch': { about: 'Unidentified endpoint has no cached list; user explicitly fetches models' },
    relay: { about: 'Identified Sub2API deployment keeps its own URL and key' },
    custom: { about: 'Unknown deployment retains discovered models and opens the full picker' },
    failed: { about: 'Unknown deployment with failed discovery permits manual addition' },
  },
  async ready(page) { await page.getByRole('dialog').waitFor(); },
  async check(page, ui) {
    if (['loopback-identity', 'ambiguous-official'].includes(ui.case)) {
      const address = ui.case === 'loopback-identity' ? 'https://localhost:1234/v1' : 'https://api.deepseek.com';
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill(address);
      await page.getByText(await ui.t(ui.case === 'loopback-identity' ? 'settings.providers.detection.custom' : 'settings.providers.detection.ambiguous'), { exact: true }).waitFor();
      await page.waitForTimeout(1500);
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.providers.detection.configure'), exact: true }).count(), 0);
      assert.equal(await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).inputValue(), address);
      await ui.capture('stayed-custom');
      return;
    }
    if (ui.case.startsWith('cloudflare-')) {
      const [, kind, variant] = ui.case.split('-');
      const canonical = kind === 'gateway' ? 'https://gateway.ai.cloudflare.com/v1/ReviewAccount/ReviewGateway/anthropic'
        : 'https://api.cloudflare.com/client/v4/accounts/ReviewAccount/ai/v1';
      const input = variant === 'scheme' ? canonical.replace('https:', 'HTTPS:')
        : variant === 'host' ? canonical.replace(/^(https:\/\/)([^/]+)/, (_, scheme, host) => scheme + host.toUpperCase())
        : canonical.replace(/^(https:\/\/)([^/]+)/, '$1$2:443');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill('Cloudflare review');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill(input);
      await page.getByRole('button', { name: await ui.t('settings.providers.detection.configure'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).waitFor();
      await ui.capture('normalized-handoff');
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true }).click();
      await page.waitForFunction(() => window.providerP1Evidence?.saved);
      const saved = await page.evaluate(() => window.providerP1Evidence.saved);
      assert.equal(saved.name, 'Cloudflare review');
      for (const agent of ['claude-code', 'codex', 'pi']) {
        const runtime = saved.runtimes[agent];
        assert.ok(runtime, agent);
        assert.equal(runtime.catalogPresetId, kind === 'gateway' ? 'cloudflare-ai-gateway' : 'cloudflare-workers-ai');
        assert.equal(new URL(runtime.baseUrl).hostname, new URL(canonical).hostname);
        assert.equal(new URL(runtime.baseUrl).port, '');
        assert.ok(runtime.baseUrl.includes('/ReviewAccount/'));
        if (kind === 'gateway') assert.ok(runtime.baseUrl.includes('/ReviewGateway/'));
        assert.ok(!runtime.baseUrl.includes('{'));
        assert.ok(runtime.models.some(model => model.id === 'example-chat'));
      }
      return;
    }
    if (['reenable', 'return-reenable'].includes(ui.case)) {
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).click();
      const finish = page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true });
      await finish.waitFor();
      await ui.capture('checked-previously-disabled');
      if (ui.case === 'return-reenable') {
        const back = page.getByRole('button', { name: await ui.t('settings.providers.wizard.back'), exact: true });
        await back.click(); await back.click();
        await page.getByRole('button', { name: await ui.t('settings.providers.connection.saveProvider'), exact: true }).click();
      } else await finish.click();
      await page.waitForFunction(() => window.providerP1Evidence?.saved);
      const saved = await page.evaluate(() => window.providerP1Evidence.saved);
      assert.notEqual(saved.runtimes.pi.models[0].defaultEnabled, false);
      return;
    }
    if (ui.case === 'custom-port') {
      const address = page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder'));
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill('Port fixture');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
      for (const input of ['https://reviewaccount.openai.azure.com:9443/openai/v1', 'https://us-central1-aiplatform.googleapis.com:9443']) {
        await address.fill(input);
        await page.getByText(await ui.t('settings.providers.detection.custom'), { exact: true }).waitFor();
        await page.waitForTimeout(1400);
        assert.equal(await address.inputValue(), input);
        assert.equal(await page.getByRole('button', { name: await ui.t('settings.providers.detection.configure'), exact: true }).count(), 0);
      }
      await ui.capture('custom-port-preserved');
      await page.getByRole('button', { name: await ui.t('settings.providers.connection.saveProvider'), exact: true }).click();
      await page.waitForFunction(() => window.providerP1Evidence?.saved);
      assert.equal(new URL(await page.evaluate(() => window.providerP1Evidence.saved.runtimes.pi.baseUrl)).port, '9443');
      return;
    }
    if (ui.case === 'local-noauth') {
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill('Local fixture');
      await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill('http://127.0.0.1:1234/v1');
      await page.getByText('example-chat', { exact: false }).first().waitFor();
      const key = page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder'));
      const test = page.getByRole('button', { name: await ui.t('settings.providers.custom.test.button'), exact: true });
      for (const [value, method] of [['', 'none'], ['fake-ui-key', 'apiKey'], ['', 'none']]) {
        await key.fill(value);
        const before = await page.evaluate(() => window.providerP1Evidence.tests.length);
        await test.click();
        await page.waitForFunction(count => window.providerP1Evidence.tests.length > count, before);
        assert.equal(await page.evaluate(() => window.providerP1Evidence.tests.at(-1).spec.authMethod), method);
      }
      await ui.capture('local-noauth-tested');
      await page.getByRole('button', { name: await ui.t('settings.providers.connection.saveProvider'), exact: true }).click();
      await page.waitForFunction(() => window.providerP1Evidence?.saved);
      assert.equal(await page.evaluate(() => window.providerP1Evidence.saved.auth.method), 'none');
      return;
    }
    if (ui.case === 'empty') {
      assert.equal(await page.getByRole('tablist').count(), 0);
      assert.equal(await page.getByLabel(await ui.t('settings.providers.connection.manualId'), { exact: true }).count(), 0);
      await ui.capture('empty-add', { locator: page.getByRole('dialog') });
      return;
    }
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.namePlaceholder')).fill('我的自定义供应商');
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.apiKeyPlaceholder')).fill('fake-ui-key');
    const address = ['default', 'return'].includes(ui.case) ? 'https://api.deepseek.com' : 'https://relay.example/team/v1';
    await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).fill(address);
    if (['default', 'return', 'relay', 'litellm'].includes(ui.case)) {
      await page.getByRole('button', { name: await ui.t('settings.providers.detection.keepCustom') }).waitFor();
      await ui.capture('identified', { locator: page.getByRole('dialog') });
      await page.waitForTimeout(1500);
      assert.equal(await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).inputValue(), address);
      await page.getByRole('button', { name: await ui.t('settings.providers.detection.configure'), exact: true }).click();
      await page.getByText(await ui.t('settings.providers.wizard.nameLabel'), { exact: true }).waitFor();
      assert.equal(await page.getByPlaceholder('sk-…').inputValue(), 'fake-ui-key');
      await ui.capture('provider-connection', { locator: page.getByRole('dialog') });
      if (ui.case === 'return') {
        await page.getByRole('button', { name: await ui.t('settings.providers.wizard.back'), exact: true }).click();
        await page.getByPlaceholder(await ui.t('settings.providers.custom.fields.baseUrlPlaceholder')).waitFor();
        await page.waitForTimeout(1800);
        await ui.capture('returned-custom', { locator: page.getByRole('dialog') });
        return;
      }
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.finish'), exact: true }).waitFor();
      await ui.capture('models', { locator: page.getByRole('dialog') });
    } else {
      // Authentication rejection has its own field error; generic fallback copy is intentionally absent.
      await page.getByText(await ui.t(ui.case === 'failed'
        ? 'settings.providers.detection.authRejected' : 'settings.providers.detection.custom'), { exact: true }).waitFor();
      if (['custom', 'manual-fetch'].includes(ui.case)) {
        await ui.capture('custom-model-list', { locator: page.getByRole('dialog') });
        await page.getByRole('button', { name: await ui.t('settings.providers.custom.fetch.button'), exact: true }).scrollIntoViewIfNeeded();
        await ui.capture('custom-bottom', { locator: page.getByRole('dialog') });
        await page.getByRole('button', { name: await ui.t('settings.providers.custom.fetch.button'), exact: true }).click();
        await page.getByText('example-chat', { exact: true }).last().waitFor();
        await ui.capture('model-picker');
      } else {
        await page.getByRole('button', { name: await ui.t('settings.providers.connection.manualAdd'), exact: true }).click();
        await page.getByLabel(await ui.t('settings.providers.connection.manualId'), { exact: true }).fill('private-model');
        await ui.capture('manual-fallback', { locator: page.getByRole('dialog') });
      }
    }
  },
};
