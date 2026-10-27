import assert from 'node:assert/strict';
export default {
  name: 'provider-speech-setup',
  entry: './provider-speech-setup-fixture.tsx',
  viewport: { width: 1120, height: 820 },
  real: 'AddProviderWizard, UnifiedModelList toolbar, AddSpeechModelsDialog, SpeechModelChoices, model Registry resolution, translations and themes',
  notCovered:
    'Live credentials, manual refresh orchestration (covered by ProvidersSection unit tests), provider network calls, OS safe storage, Settings owner changes, OAuth login and actual synthesis; host catalog/save responses are scenario data',
  cases: {
    default: { about: 'Existing API-key connection adds speech without replacing its chat model' },
    empty: { about: 'An empty API-key connection keeps manual speech addition in Management' },
    minimax: {
      about:
        'Single add-provider flow: MiniMax API key, grouped chat/speech, recommended speech default',
    },
    elevenlabs: { about: 'ElevenLabs catalog discovery, TTS-only connection' },
    bailian: {
      about: 'Alibaba Cloud speech recommendations visible above 100 discovered chat models',
    },
    'bailian-fallback': { about: 'An empty mixed preset with failed discovery keeps manual chat entry beside speech suggestions' },
    'bailian-existing': {
      about: 'Existing Beijing workspace recommends CosyVoice and preserves its chat model',
    },
    'token-plan': { about: 'Token Plan recommends Qwen-Audio instead of workspace CosyVoice' },
    'token-plan-existing': { about: 'Existing Token Plan uses the same Qwen-Audio recommendation' },
    'speech-visibility': { about: 'Previously hidden speech can be shown and hidden through model management' },
    subscription: { about: 'Existing OpenAI subscription has no speech-add button or menu item' },
  },
  async ready(page) {
    await page.getByTestId('provider-model-toolbar').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'speech-visibility') {
      const toggle = page.getByRole('switch', { name: 'MiniMax Speech 2.8 HD', exact: true });
      await toggle.waitFor();
      assert.equal(await toggle.isEnabled(), true);
      assert.equal(await toggle.getAttribute('aria-checked'), 'false');
      await ui.capture('hidden-speech');
      await toggle.click();
      await page.getByTestId('speech-visible').filter({ hasText: 'true' }).waitFor({ state: 'attached' });
      assert.equal(await toggle.getAttribute('aria-checked'), 'true');
      await ui.capture('shown-speech');
      await toggle.click();
      await page.getByTestId('speech-visible').filter({ hasText: 'false' }).waitFor({ state: 'attached' });
      return;
    }
    const existing = ['default', 'empty', 'bailian-existing', 'token-plan-existing'].includes(ui.case);
    if (existing || ui.case === 'subscription') {
      assert.equal(await page.getByRole('button', { name: await ui.t('settings.providers.speechSetup.add'), exact: true }).count(), 0);
      await ui.capture('toolbar');
      await page
        .getByRole('button', {
          name: await ui.t('settings.providers.models.manage.menu'),
          exact: true,
        })
        .click();
      await page.getByRole('menu').waitFor();
      const manual = page.getByRole('menuitem', { name: await ui.t('settings.providers.speechSetup.add'), exact: true });
      await ui.capture('management');
      if (ui.case === 'subscription') {
        assert.equal(await manual.count(), 0);
        return;
      }
      await manual.click();
    } else {
      await page.getByTestId('add-provider').click();
      await ui.capture('single-add-entry');
      const name =
        ui.case === 'token-plan' ? /Token Plan/ : ui.case === 'minimax' ? /MiniMax/ : ui.case === 'elevenlabs' ? /ElevenLabs/ : ui.case === 'bailian-fallback' ? /Fallback API/ : /API/;
      const buttons = page.getByRole('dialog').getByRole('button').filter({ hasText: name });
      await buttons.first().click();
      if (ui.case === 'minimax')
        await page
          .getByRole('button', { name: await ui.t('settings.providers.wizard.useApiKey') })
          .click();
    }
    if (!existing) {
      await page.getByPlaceholder('sk-…').fill('fixture-key');
      await ui.capture('connection');
      await page
        .getByRole('button', { name: await ui.t('settings.providers.wizard.next'), exact: true })
        .click();
    }
    const recommendedId =
      ui.case === 'elevenlabs'
        ? 'eleven_flash_v2_5'
        : ui.case.startsWith('token-plan')
          ? 'qwen-audio-3.0-tts-plus'
        : ['bailian', 'bailian-fallback'].includes(ui.case)
          ? 'qwen3-tts-flash'
          : ui.case === 'bailian-existing'
            ? 'cosyvoice-v3-flash'
            : 'speech-2.8-turbo';
    const recommended = page.getByRole('checkbox', { name: new RegExp(recommendedId) });
    await recommended.waitFor();
    assert.equal(await recommended.getAttribute('aria-checked'), 'true');
    if (ui.case.startsWith('token-plan'))
      assert.equal(await page.getByRole('checkbox', { name: /cosyvoice/ }).count(), 0);
    if (ui.case === 'bailian') {
      // PR #6768: first-screen discoverability, before any test-induced scrolling.
      const box = await recommended.boundingBox();
      const height = await page.evaluate(() => globalThis.innerHeight);
      assert.ok(box && box.y >= 0 && box.y + box.height < height);
    }
    await recommended.scrollIntoViewIfNeeded();
    await ui.capture('models');
    if (ui.case === 'bailian-fallback') {
      const manual = page.getByPlaceholder(await ui.t('settings.providers.wizard.manualModelPlaceholder'));
      await manual.fill('my-new-chat-model');
      await page.getByRole('button', { name: await ui.t('settings.providers.wizard.addManualModel'), exact: true }).click();
      await manual.scrollIntoViewIfNeeded();
      await ui.capture('chat-fallback');
    }
    const finish = existing
      ? 'settings.providers.wizard.addManualModel'
      : 'settings.providers.wizard.finish';
    await page.getByRole('button', { name: await ui.t(finish), exact: true }).click();
    await page.getByTestId('saved').waitFor();
    assert.ok((await page.getByTestId('saved').textContent()).includes(recommendedId));
    if (ui.case === 'bailian-fallback')
      assert.ok((await page.getByTestId('saved').textContent()).includes('my-new-chat-model'));
    if (ui.case === 'default')
      assert.ok((await page.getByTestId('saved').textContent()).includes('MiniMax-M3'));
    if (ui.case === 'bailian-existing')
      assert.ok((await page.getByTestId('saved').textContent()).includes('qwen-plus'));
    await ui.capture('saved');
  },
};
