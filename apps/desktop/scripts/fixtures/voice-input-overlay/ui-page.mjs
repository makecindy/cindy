import assert from 'node:assert/strict';

export default {
  name: 'voice-input-overlay',
  entry: './voice-input-overlay-fixture.tsx',
  viewport: { width: 600, height: 320 },
  real: 'VoiceInputOverlay: refinement, original-text handoff, cancel and late-event isolation',
  notCovered: 'Native microphone, ASR/model network, native paste target and macOS window focus',
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export function getVoiceInputWorkletUrl() { return "data:application/javascript,"; }',
    'src/renderer/voice-input/captureSession': `export async function startVoiceInputCaptureSession(options) {
      options.setEngine({ drainBufferedAudio: async () => {}, stop: async () => {} });
      options.onCaptureReady?.(); options.onSoundDetected?.();
      return { ok: true, drainPendingChunks: () => {} };
    }`,
  },
  cases: {
    default: { about: 'Use original text once while refinement is pending' },
    close: { about: 'Close while refinement is pending without any paste' },
    escape: { about: 'Escape while refinement is pending without any paste' },
  },
  async ready(page) {
    await page.waitForFunction(() => window.__uiPage.emit('command', { type: 'start' }) > 0);
    await page.waitForFunction(() => document.querySelector('button') && !document.querySelector('button').disabled);
    await page.getByRole('button').first().click();
    await page.getByText(await page.evaluate(() => window.__uiPage.t('voiceInputOverlay.status.refining')), { exact: true }).waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'default') {
      const useOriginal = page.getByRole('button', { name: await ui.t('voiceInputOverlay.useOriginal') });
      assert.equal(await useOriginal.count(), 1, 'Pending refinement must offer original-text recovery');
      await useOriginal.click();
      await page.waitForFunction(() => window.__uiPage.ctx.data.pastes.length === 1);
      const pastes = await page.evaluate(() => window.__uiPage.ctx.data.pastes);
      assert.equal(pastes[0].text, 'Keep these original words.');
    } else {
      if (ui.case === 'escape') await page.keyboard.press('Escape');
      else await page.getByRole('button').last().click();
      await page.waitForFunction(() => window.__uiPage.ctx.data.closes.length > 0);
      assert.deepEqual(await page.evaluate(() => window.__uiPage.ctx.data.pastes), []);
    }
  },
};
