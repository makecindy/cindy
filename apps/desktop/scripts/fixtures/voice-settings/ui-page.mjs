import assert from 'node:assert/strict';

export default {
  name: 'voice-settings',
  entry: './voice-settings-fixture.tsx',
  viewport: { width: 460, height: 740 },
  real: 'CompanionVoiceSettings, SpeechVoicePicker, SpeechVoiceMenu, Slider, Select, FormField and theme tokens',
  notCovered:
    'Real preference persistence, provider requests, audio playback and microphone capture',
  stubs: {
    'src/renderer/lib/makerChatStore':
      'const empty = {}; export const EMPTY_LIGHT_STATE = empty; export const makerChatStore = { subscribeLight: () => () => {}, getLightSnapshot: () => empty };',
  },
  cases: {
    'realtime-my-voices': { about: 'Model-specific presets and refreshed private voices survive a failed refresh', data: { realtime: true, qwenRealtime: true }, viewport: { width: 320, height: 900 } },
    'realtime-without-tts': { about: 'A realtime call needs no TTS model; its empty state belongs to message read-aloud', data: { realtime: true, empty: true, noPreference: true }, viewport: { width: 320, height: 740 } },
    realtime: { about: 'Choose native realtime, save its voice, then return to TTS without altering the TTS preference', data: { realtime: true }, viewport: { width: 320, height: 900 } },
    'openrouter-auto-voice': {
      about: 'Switching to Qwen chooses its first returned voice; an explicit choice survives refresh',
      data: {
        autoVoice: true, openRouter: true, protocol: 'openai',
        modelId: 'elevenlabs/eleven-v3', voiceId: 'sarah',
        nextModelId: 'qwen/qwen-audio-3.0-tts-plus',
        nextVoices: [
          { id: 'longanlingxin', name: 'longanlingxin' },
          { id: 'longanlufeng', name: 'longanlufeng' },
        ],
      },
    },
    'minimax-auto-voice': {
      about: 'Native BYOK model switching follows the same automatic voice selection rule',
      viewport: { width: 320, height: 900 },
      data: {
        autoVoice: true, protocol: 'minimax', modelId: 'speech-2.8-turbo',
        voiceId: 'English_Graceful_Lady', nextModelId: 'speech-2.8-hd',
        nextVoices: [
          { id: 'English_Graceful_Lady', name: 'Graceful Lady' },
          { id: 'Chinese (Mandarin)_News_Anchor', name: 'News Anchor' },
        ],
      },
    },
    openrouter: {
      about: 'OpenRouter provider voice IDs and no unsupported speed slider',
      data: { openRouter: true, protocol: 'openai', modelId: 'elevenlabs/eleven-v3', voiceId: 'sarah', speed: 1.5 },
    },
    'openrouter-manual': {
      about: 'A saved OpenRouter manual voice keeps audition without carrying an old speed',
      viewport: { width: 320, height: 900 },
      data: { openRouter: true, protocol: 'openai', modelId: 'elevenlabs/eleven-v3', voiceId: 'sarah', manual: true, speed: 1.5 },
    },
    'gateway-elevenlabs': {
      about: 'Gateway replacement reference voices with separate selection and audition',
      data: {
        gatewayReference: true,
        protocol: 'openai',
        modelId: 'elevenlabs/eleven_v3',
        menu: true,
      },
    },
    'gateway-minimax': {
      about: 'Gateway MiniMax system candidates in a narrow drawer, still labeled as references',
      viewport: { width: 320, height: 900 },
      data: {
        gatewayReference: true,
        protocol: 'openai',
        modelId: 'minimax/speech-2.8-turbo',
        menu: true,
      },
    },
    'gateway-manual': {
      about: 'A saved manual Gateway voice survives a populated reference catalog and preview',
      viewport: { width: 320, height: 900 },
      data: {
        gatewayReference: true,
        protocol: 'openai',
        modelId: 'elevenlabs/eleven_multilingual_v2',
        manual: true,
        speed: 0.95,
      },
    },
    default: { about: 'ElevenLabs default 1× without an override', data: {} },
    narrow: {
      about: 'Saved speed in a narrow settings drawer',
      viewport: { width: 320, height: 820 },
      data: { speed: 0.95 },
    },
    minimax: {
      about: 'MiniMax native speed range',
      data: { protocol: 'minimax', modelId: 'speech-02-hd', speed: 1.5 },
    },
    openai: {
      about: 'OpenAI native speed range',
      data: { protocol: 'openai', modelId: 'gpt-4o-mini-tts', speed: 1.25 },
    },
    qwen: {
      about: 'Official Qwen3 HTTP reference voice, no unsupported speed control',
      data: { protocol: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry' },
    },
    'qwen-proxy': {
      about: 'Explicit Qwen HTTP proxy protocol in a narrow settings drawer',
      viewport: { width: 320, height: 900 },
      data: { protocol: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry', custom: true },
    },
    cosyvoice: {
      about: 'CosyVoice HTTP proxy, reference voice and native speed range',
      viewport: { width: 320, height: 900 },
      data: {
        protocol: 'dashscope-tts',
        modelId: 'cosyvoice-v3-flash',
        voiceId: 'longanyang',
        speed: 1.5,
        custom: true,
      },
    },
    unsupported: {
      about: 'Eleven v3 keeps voice and preview but does not offer a speed slider',
      data: { modelId: 'eleven_v3' },
    },
    hidden: { about: 'A saved hidden model remains displayed without offering other unchecked speech models', data: { hidden: true } },
    'hidden-empty': { about: 'Hidden models are not selected automatically without a saved preference', data: { hidden: true, noPreference: true } },
    'qwen-catalog': {
      about: 'Complete Qwen3 system catalog with official display names and keyboard navigation',
      data: {
        protocol: 'qwen-tts',
        modelId: 'qwen3-tts-flash',
        voiceId: 'Cherry',
        systemCatalog: true,
        menu: true,
      },
    },
    'cosy-catalog': {
      about: 'Complete CosyVoice system catalog plus a matching account voice in a narrow drawer',
      viewport: { width: 320, height: 900 },
      data: {
        protocol: 'dashscope-tts',
        modelId: 'cosyvoice-v3-flash',
        voiceId: 'longanyang',
        systemCatalog: true,
        customCatalog: true,
        menu: true,
      },
    },
    'cosy-custom-failure': {
      about: 'Account catalog failure preserves system choices, selected voice, and refresh',
      viewport: { width: 320, height: 900 },
      data: {
        protocol: 'dashscope-tts',
        modelId: 'cosyvoice-v3-flash',
        voiceId: 'longanyang',
        systemCatalog: true,
        customCatalogFailure: true,
      },
    },
    empty: {
      about: 'No models keeps only the existing setup introduction and provider link',
      data: { empty: true },
    },
    manual: {
      about: 'Custom voice keeps compact audition beside the input without a blur/save race',
      viewport: { width: 320, height: 900 },
      data: { manual: true, speed: 0.95 },
    },
    menu: {
      about: 'Preview an unselected voice without saving; keyboard and cancellation',
      data: { menu: true, speed: 0.95 },
    },
    'menu-narrow': {
      about: 'Long voice names and inline preview controls in a narrow drawer',
      viewport: { width: 320, height: 820 },
      data: { menu: true, speed: 0.95 },
    },
    'menu-error': {
      about: 'Failed preview stays in the menu without replacing the saved voice',
      data: { menu: true, previewFailure: true, speed: 0.95 },
    },
    'menu-timeout': {
      about: 'Preview timeout keeps the selected voice and reports only the known cause',
      data: { menu: true, previewTimeout: true, speed: 0.95 },
    },
    'manual-timeout': {
      about: 'Manual audition timeout stays beside the input without saving the draft',
      viewport: { width: 320, height: 900 },
      data: { manual: true, previewTimeout: true, speed: 0.95 },
    },
    'manual-error': {
      about: 'Unknown manual audition failure does not blame model or voice configuration',
      viewport: { width: 320, height: 900 },
      data: { manual: true, previewFailure: true, speed: 0.95 },
    },
  },
  async ready(page) {
    const empty = await page.evaluate(() => window.__uiPage.ctx.data.empty || window.__uiPage.ctx.data.noPreference);
    if (empty) await page.getByRole('button').first().waitFor();
    else if (await page.evaluate(() => window.__uiPage.ctx.data.manual)) {
      const label = await page.evaluate(() => window.__uiPage.t('bots.voiceMode.voiceId'));
      await page.getByRole('textbox', { name: label, exact: true }).waitFor();
    } else {
      const voice = await page.evaluate(
        () => window.__uiPage.ctx.data.voiceLabel ?? window.__uiPage.ctx.data.voiceId,
      );
      await page
        .getByText(voice ?? 'River — Relaxed, Neutral, Informative', { exact: true })
        .waitFor();
    }
    if (await page.evaluate(() => window.__uiPage.ctx.data.menu)) {
      const label = await page.evaluate(() => window.__uiPage.t('bots.voiceMode.voice'));
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('dialog', { name: label }).waitFor();
    }
  },
  async check(page, ui) {
    if (ui.data.qwenRealtime) {
      const callMode = page.getByRole('combobox', { name: await ui.t('bots.voiceMode.realtime.callMode') });
      await callMode.click();
      await page.getByRole('option', { name: /Qwen 3.1 Plus/ }).click();
      const refreshLabel = await ui.t('bots.voiceMode.realtime.refreshMyVoices');
      const refresh = page.getByRole('button', { name: refreshLabel });
      await page.waitForFunction(label => document.querySelector(`button[aria-label="${label}"]:enabled`), refreshLabel);
      const settings = page.getByRole('region', { name: await ui.t('bots.voiceMode.realtime.title') });
      assert.equal(await settings.getByRole('status').count(), 0);
      await ui.capture('empty-private-voices');
      const save = page.getByRole('button', { name: await ui.t('bots.save'), exact: true });
      assert.equal(await save.count(), 0);
      const picker = page.getByRole('button', { name: await ui.t('bots.voiceMode.realtime.callVoice'), exact: true });
      const myVoices = page.getByText(await ui.t('bots.voiceMode.realtime.myVoices'), { exact: true });
      await picker.click();
      await page.getByText(await ui.t('bots.voiceMode.realtime.systemVoices'), { exact: true }).waitFor();
      assert.equal(await myVoices.count(), 0);
      await page.keyboard.press('Escape');
      await refresh.click();
      await picker.click();
      await myVoices.waitFor();
      await page.getByRole('button', { name: 'Buddy', exact: true }).focus();
      const audition = page.getByRole('button', { name: await ui.t('bots.voiceMode.previewVoice', { voice: 'Buddy' }), exact: true });
      const menu = page.getByRole('dialog', { name: await ui.t('bots.voiceMode.realtime.callVoice') });
      const systemPreview = menu.getByRole('button', { name: await ui.t('bots.voiceMode.previewVoice', { voice: 'longanqian_v3.1' }), exact: true });
      const systemName = menu.getByRole('button', { name: 'longanqian_v3.1', exact: true });
      const opacity = (button) => button.evaluate((element) => getComputedStyle(element).opacity);
      await page.mouse.move(0, 0);
      assert.equal(await opacity(systemPreview), '0');
      assert.equal(await opacity(audition), '1'); // Buddy has keyboard focus.
      await systemName.hover();
      assert.equal(await opacity(systemPreview), '1');
      const before = await picker.getAttribute('value');
      await audition.click();
      await page.waitForFunction(() => window.__uiPage.ctx.data.previewRequests.some(r => r.mode === 'realtime' && r.voice === 'my-buddy'));
      assert.equal(await picker.getAttribute('value'), before);
      await systemName.focus();
      await systemName.hover();
      const stop = menu.getByRole('button', { name: await ui.t('bots.voiceMode.stopPreviewVoice', { voice: 'Buddy' }), exact: true });
      assert.equal(await opacity(stop), '1');
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedRealtime.voice), 'longanqian_v3.1');
      await ui.capture('private-voices');

      await page.getByRole('button', { name: 'Buddy', exact: true }).click();
      await page.waitForFunction(() => window.__uiPage.ctx.data.previewStops.includes(window.__uiPage.ctx.data.previewRequests[0].previewId));
      await refresh.click();
      await page.getByText(await ui.t('bots.voiceMode.voicesCustomError')).waitFor();
      await page.waitForFunction(() => window.__uiPage.ctx.data.savedRealtime?.voice === 'my-buddy');
      assert.equal(await picker.getAttribute('value'), 'voice:my-buddy');
      return;
    }
    if (ui.data.realtime) {
      const model = page.getByRole('combobox', { name: await ui.t('bots.voiceMode.realtime.callMode'), exact: true });
      await model.focus();
      await model.press('Enter');
      await page.getByRole('option', { name: 'gpt-realtime-2 · OpenAI API', exact: true }).press('Enter');
      await page.getByRole('button', { name: await ui.t('bots.voiceMode.realtime.callVoice'), exact: true }).click();
      await page.getByRole('button', { name: 'cedar', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: await ui.t('bots.save'), exact: true }).count(), 0);
      await page.waitForFunction(() => window.__uiPage.ctx.data.savedRealtime?.voice === 'cedar');
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), 'river');
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.saveCount), 0);
      const readAloud = page.getByRole('button', { name: await ui.t('bots.voiceMode.realtime.messageReadAloud'), exact: true });
      const synthesis = page.getByRole('combobox', { name: await ui.t('bots.voiceMode.model'), exact: true });
      const noModels = page.getByText(await ui.t('bots.voiceMode.noModels'), { exact: true });
      const bySentence = page.getByRole('switch', { name: await ui.t('bots.voiceMode.sentencePlayback'), exact: true });
      const scope = page.getByText(await ui.t('bots.voiceMode.preferenceHint'), { exact: true });
      const readingVoice = page.getByRole('button', { name: await ui.t('bots.voiceMode.realtime.readAloudVoice'), exact: true });
      assert.equal(await scope.isVisible(), true);
      assert.equal(await readingVoice.isVisible(), false);
      assert.equal(await readAloud.getAttribute('aria-expanded'), 'false');
      assert.equal(await synthesis.isVisible(), false);
      assert.equal(await noModels.isVisible(), false);
      await ui.capture('realtime-saved');
      await readAloud.focus();
      await readAloud.press('Space');
      assert.equal(await readAloud.getAttribute('aria-expanded'), 'true');
      await (ui.data.empty ? noModels : synthesis).waitFor();
      assert.equal(await bySentence.isVisible(), false);
      assert.equal(await readingVoice.isVisible(), !ui.data.empty);
      assert.equal(await scope.isVisible(), true);
      await ui.capture('message-read-aloud');
      await readAloud.press('Space');
      assert.equal(await readingVoice.isVisible(), false);
      assert.equal(await scope.isVisible(), true);
      await model.focus();
      await model.press('Enter');
      await page.getByRole('option', { name: await ui.t('bots.voiceMode.realtime.off'), exact: true }).press('Enter');
      await page.waitForFunction(() => window.__uiPage.ctx.data.savedRealtime === null);
      await (ui.data.empty ? noModels : bySentence).waitFor();
      assert.equal(await readAloud.count(), 0);
      await model.focus();
      await model.press('Enter');
      await page.getByRole('option', { name: 'gpt-realtime-2 · OpenAI API', exact: true }).press('Enter');
      assert.match(await page.getByRole('button', { name: await ui.t('bots.voiceMode.realtime.callVoice'), exact: true }).innerText(), /cedar/);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), 'river');
      return;
    }
    if (ui.data.autoVoice) {
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.saveCount), 0);
      const modelLabel = await ui.t('bots.voiceMode.model');
      await page.getByRole('combobox', { name: modelLabel, exact: true }).click();
      await page.getByRole('option', {
        name: `${ui.data.nextModelId} · ${ui.data.openRouter ? 'OpenRouter' : 'MiniMax'}`,
        exact: true,
      }).click();
      await page.waitForFunction(() => window.__uiPage.ctx.data.savedModelId === window.__uiPage.ctx.data.nextModelId);
      const voiceLabel = await ui.t('bots.voiceMode.voice');
      const voicePicker = page.getByRole('button', { name: voiceLabel, exact: true });
      assert.equal(await voicePicker.getAttribute('value'), `voice:${ui.data.nextVoices[0].id}`);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), ui.data.nextVoices[0].id);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.previewRequests.length), 0);
      await ui.capture('automatic-voice');
      await voicePicker.click();
      await page.getByRole('dialog', { name: voiceLabel }).getByRole('button', { name: ui.data.nextVoices[1].name, exact: true }).click();
      await page.waitForFunction(() => window.__uiPage.ctx.data.saveCount === 2);
      const refreshButton = page.getByRole('button', { name: await ui.t('bots.voiceMode.refreshVoices'), exact: true });
      await refreshButton.click();
      await page.waitForFunction(label => !document.querySelector(`button[aria-label="${label}"]`)?.disabled, await ui.t('bots.voiceMode.refreshVoices'));
      assert.equal(await voicePicker.getAttribute('value'), `voice:${ui.data.nextVoices[1].id}`);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), ui.data.nextVoices[1].id);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.saveCount), 2);
      await ui.capture('explicit-voice-after-refresh');
      return;
    }
    if (ui.data.openRouter) {
      assert.equal(await page.getByRole('slider').count(), 0);
      await page.getByText(await ui.t('bots.voiceMode.speedUnavailable'), { exact: true }).waitFor();
      assert.ok((await page.getByRole('combobox', { name: await ui.t('bots.voiceMode.model'), exact: true }).textContent()).includes('OpenRouter'));
      if (ui.data.manual) {
        await page.getByRole('button', { name: await ui.t('bots.voiceMode.preview'), exact: true }).click();
      } else {
        await page.getByRole('button', { name: await ui.t('bots.voiceMode.refreshVoices'), exact: true }).click();
        await page.getByRole('button', { name: await ui.t('bots.voiceMode.voice'), exact: true }).click();
        const menu = page.getByRole('dialog', { name: await ui.t('bots.voiceMode.voice') });
        await menu.getByRole('button', { name: 'george', exact: true }).waitFor();
        await ui.capture('provider-voices');
        await menu.getByRole('button', { name: 'george', exact: true }).hover();
        await menu.getByRole('button', { name: await ui.t('bots.voiceMode.previewVoice', { voice: 'george' }), exact: true }).click();
      }
      await page.waitForFunction(() => window.__uiPage.ctx.data.previewRequests.length === 1);
      const request = await page.evaluate(() => window.__uiPage.ctx.data.previewRequests[0]);
      assert.equal(request.voice, ui.data.manual ? 'custom-voice' : 'george');
      assert.equal(request.speed, undefined);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), ui.data.manual ? 'custom-voice' : 'sarah');
      await ui.capture('preview');
      if (ui.data.manual) await page.getByRole('button', { name: await ui.t('bots.voiceMode.stopPreview'), exact: true }).click();
      else await page.keyboard.press('Escape');
      return;
    }
    if (ui.data.gatewayReference) {
      // Use raw catalog names in the host fixture; localization belongs to the UI.
      if (ui.data.menu) await page.keyboard.press('Escape');
      const modelLabel = await ui.t('bots.voiceMode.model');
      await page.getByRole('combobox', { name: modelLabel, exact: true }).click();
      await page.getByRole('listbox').waitFor();
      await ui.capture('model-provider-name');
      assert.equal(
        await page
          .getByRole('option', {
            name: `${ui.data.modelId} · ${await ui.t('settings.providers.xd.title')}`,
            exact: true,
          })
          .count(),
        1,
      );
      await page.keyboard.press('Escape');
      // Radix restores focus after closing the model menu. Do not type the
      // manual draft until that transition completes: its late focus restore
      // would otherwise blur the input and correctly save the new draft.
      await page.getByRole('listbox').waitFor({ state: 'hidden' });
      await page.waitForFunction(
        (label) => document.activeElement?.getAttribute('aria-label') === label,
        modelLabel,
      );
      if (ui.data.menu)
        await page
          .getByRole('button', { name: await ui.t('bots.voiceMode.voice'), exact: true })
          .click();
    }
    const standalonePreview = page.getByRole('button', {
      name: await ui.t('bots.voiceMode.preview'),
      exact: true,
    });
    if (ui.data.manual) {
      const input = page.getByRole('textbox', {
        name: await ui.t('bots.voiceMode.voiceId'),
        exact: true,
      });
      const stop = page.getByRole('button', {
        name: await ui.t('bots.voiceMode.stopPreview'),
        exact: true,
      });
      const saved = () => page.evaluate(() => window.__uiPage.ctx.data.savedVoice);
      const preparing = page.getByText(await ui.t('bots.voiceMode.previewStatus.preparing'));
      await input.fill('custom-click');
      await standalonePreview.click();
      if (ui.data.previewTimeout || ui.data.previewFailure) {
        await page
          .getByText(
            await ui.t(
              ui.data.previewTimeout
                ? 'bots.voiceMode.errors.speechTimeout'
                : 'bots.voiceMode.previewStatus.error',
            ),
            { exact: true },
          )
          .waitFor();
        assert.equal(await saved(), 'custom-voice');
        assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.previewRequests.length), 1);
        await ui.capture('manual-preview-error');
        return;
      }
      await preparing.waitFor();
      assert.equal(await saved(), 'custom-voice');
      await ui.capture('manual-preview');
      await stop.click();
      await standalonePreview.waitFor();
      await input.fill('custom-keyboard');
      await page.keyboard.press('Tab');
      assert.equal(await standalonePreview.evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await preparing.waitFor();
      const requests = await page.evaluate(() => window.__uiPage.ctx.data.previewRequests);
      assert.deepEqual(
        requests.map(({ voice, speed }) => ({ voice, speed })),
        [
          { voice: 'custom-click', speed: 0.95 },
          { voice: 'custom-keyboard', speed: 0.95 },
        ],
      );
      assert.equal(await saved(), 'custom-voice');
      await page.keyboard.press('Space');
      await standalonePreview.waitFor();
      await page.getByRole('slider', { name: await ui.t('bots.voiceMode.speed') }).focus();
      await page.waitForFunction(() => window.__uiPage.ctx.data.savedVoice === 'custom-keyboard');
      return;
    }
    assert.equal(await standalonePreview.count(), 0);
    if (ui.data.hidden) {
      const model = page.getByRole('combobox', { name: await ui.t('bots.voiceMode.model'), exact: true });
      if (ui.data.noPreference) {
        assert.equal(await model.count(), 0);
        await page.getByText(await ui.t('bots.voiceMode.noModels'), { exact: true }).waitFor();
        await ui.capture('hidden-empty');
      } else {
        assert.ok((await model.textContent()).includes('eleven_flash_v2_5'));
        await model.focus();
      await model.press('Enter');
        await page.getByRole('option', { name: /Visible speech/ }).waitFor();
        assert.equal(await page.getByRole('option', { name: /Unchecked speech/ }).count(), 0);
        await ui.capture('hidden-selection');
        await page.keyboard.press('Escape');
      }
      return;
    }
    if (ui.data.gatewayReference) {
      const label = await ui.t('bots.voiceMode.voice');
      const trigger = page.getByRole('button', { name: label, exact: true });
      const menu = page.getByRole('dialog', { name: label });
      const voices = await page.evaluate(() => window.__uiPage.ctx.data.gatewayVoices);
      const choice = voices[1];
      await page.getByText(await ui.t('bots.voiceMode.voicesReference'), { exact: true }).waitFor();
      await menu.getByRole('button', { name: choice.name, exact: true }).focus();
      await page.keyboard.press('Tab');
      const preview = menu.getByRole('button', {
        name: await ui.t('bots.voiceMode.previewVoice', { voice: choice.name }),
        exact: true,
      });
      assert.equal(await preview.evaluate((el) => el === document.activeElement), true);
      await ui.capture('reference-menu');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => window.__uiPage.ctx.data.previewRequests.length === 1);
      const request = await page.evaluate(() => window.__uiPage.ctx.data.previewRequests[0]);
      assert.equal(request.providerId, 'xd');
      assert.equal(request.modelId, ui.data.modelId);
      assert.equal(request.voice, choice.id);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), voices[0].id);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      await page
        .getByRole('button', { name: await ui.t('bots.voiceMode.refreshVoices'), exact: true })
        .click();
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.previewRequests.length), 1);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), voices[0].id);
      await trigger.click();
      return;
    }
    if (ui.data.systemCatalog) {
      const label = await ui.t('bots.voiceMode.voice');
      const trigger = page.getByRole('button', { name: label, exact: true });
      const menu = page.getByRole('dialog', { name: label });
      if (ui.data.customCatalogFailure) {
        await page.getByText(await ui.t('bots.voiceMode.voicesCustomError')).waitFor();
        await page
          .getByRole('button', { name: await ui.t('bots.voiceMode.refreshVoices'), exact: true })
          .click();
        await trigger.click();
      }
      await menu.waitFor();
      const firstName = ui.data.protocol === 'qwen-tts' ? '芊悦' : '龙安洋';
      const lastName = ui.data.customCatalog
        ? 'My Custom Voice'
        : ui.data.protocol === 'qwen-tts'
          ? '粤语-阿清'
          : 'Bella3.0';
      await menu.getByRole('button', { name: firstName, exact: true }).focus();
      await page.keyboard.press('End');
      // Manual entry is the final action after all provider/system voices.
      await page.keyboard.press('ArrowUp');
      const last = menu.getByRole('button', { name: lastName, exact: true });
      assert.equal(await last.evaluate((el) => el === document.activeElement), true);
      await ui.capture('catalog-end');
      await page.keyboard.press('Home');
      await ui.capture('catalog-start');
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.savedVoice), ui.data.voiceId);
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.previewRequests.length), 0);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await trigger.evaluate((el) => el === document.activeElement), true);
      return;
    }
    if (ui.data.menu) {
      const label = await ui.t('bots.voiceMode.voice');
      const trigger = page.getByRole('button', { name: label, exact: true });
      const menu = page.getByRole('dialog', { name: label });
      const bella = 'Bella — Professional, Bright, Warm';
      const name = menu.getByRole('button', { name: bella, exact: true });
      const preview = menu.getByRole('button', {
        name: await ui.t('bots.voiceMode.previewVoice', { voice: bella }),
        exact: true,
      });
      const saved = () => page.evaluate(() => window.__uiPage.ctx.data.savedVoice);
      await name.hover();
      assert.equal(await preview.evaluate((el) => getComputedStyle(el).opacity), '1');
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.previewRequests.length), 0);
      assert.equal(
        Math.round((await menu.boundingBox()).width),
        Math.round((await trigger.boundingBox()).width),
      );
      await ui.capture('hover-preview');
      // Native Tab reaches the distinct audition action without selecting the name.
      await name.focus();
      await page.keyboard.press('Tab');
      assert.equal(await preview.evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await menu
        .getByText(
          await ui.t(
            ui.data.previewTimeout
              ? 'bots.voiceMode.errors.speechTimeout'
              : `bots.voiceMode.previewStatus.${ui.data.previewFailure ? 'error' : 'preparing'}`,
          ),
          { exact: true },
        )
        .waitFor();
      assert.equal(await saved(), 'river');
      const requests = await page.evaluate(() => window.__uiPage.ctx.data.previewRequests);
      assert.equal(requests[0].voice, 'bella');
      assert.equal(requests[0].speed, 0.95);
      await ui.capture(
        ui.data.previewFailure || ui.data.previewTimeout ? 'preview-error' : 'preparing-preview',
      );
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await saved(), 'river');
      await page.waitForFunction(() => window.__uiPage.ctx.data.previewStops.length > 0);
      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      await menu.waitFor();
      await name.click();
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await saved(), 'bella');
      return;
    }
    const slider = page.getByRole('slider', { name: await ui.t('bots.voiceMode.speed') });
    if (ui.data.empty || ui.case === 'unsupported' || ui.data.protocol === 'qwen-tts') {
      assert.equal(await slider.count(), 0);
      if (ui.case === 'unsupported' || ui.data.protocol === 'qwen-tts')
        await page.getByText(await ui.t('bots.voiceMode.speedUnavailable')).waitFor();
      return;
    }
    const initial = ui.data.speed ?? 1;
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), initial);
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), initial + 0.05);
    await ui.capture('adjusted');
    await page
      .getByRole('button', { name: await ui.t('bots.voiceMode.resetPreference'), exact: true })
      .click();
    if (ui.data.custom) {
      // Reset removes the proxy override. With no detected protocol, settings
      // correctly waits for an explicit interface choice before exposing speed.
      assert.equal(await slider.count(), 0);
    } else assert.equal(Number(await slider.getAttribute('aria-valuenow')), 1);
  },
};
