import assert from 'node:assert/strict';

export default {
  name: 'island-voice',
  entry: './island-voice-fixture.tsx',
  viewport: { width: 600, height: 360 },
  real: 'VoiceInputOverlay, voice waveform, transcript, send and retry controls, Cindy Light and Dark tokens',
  notCovered: 'Physical microphone, ASR network, native island hit testing and delivery to a running task',
  stubs: {
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "/fixture-worklet.js";',
    'src/renderer/voice-input/audioContextPool': { partial: 'export const prewarmVoiceInputAudio = async () => {};' },
    'src/renderer/voice-input/captureSession': 'export async function startVoiceInputCaptureSession(options) { options.setEngine({ stop: async () => {}, drainBufferedAudio: async () => {} }); if (window.__uiPage.ctx.case === "batch-listening") options.onSoundDetected?.(); return { ok: true, drainPendingChunks() {} }; }',
    'src/renderer/hooks/useCodexAuth': 'export function useCodexAuth() { return { state: { kind: "disconnected" }, refresh() {}, triggerLogin() {} }; } export const isChatGptConnectionConnected = () => false;',
    'src/renderer/hooks/useCodexSessionExpiredPrompt': 'export const isCodexSessionExpiredError = () => false; export function useCodexSessionExpiredPrompt() { return () => false; }',
  },
  cases: {
    default: { about: 'Voice reply with live waveform and transcript' },
    'batch-listening': { about: 'Batch ASR can send from recorded audio before text arrives' },
    'recording-error-retained': { about: 'Recognition failure keeps task text sendable' },
    'send-failed': { about: 'Failed delivery retains recognized text and offers retry' },
    'global-after-reply': { about: 'A global shortcut after cancelling a reply returns to paste mode' },
  },
  async check(page, ui) {
    await ui.emit('session-prompt', { requestId: 'voice-reply-1', sessionId: 'task-1', title: '整理本周开发进展' });
    await page.waitForFunction(() => document.querySelector('[data-voice-mic-active="true"]'));
    const send = page.getByRole('button', { name: await ui.t('voiceInputOverlay.sessionPrompt.submit'), exact: true });
    if (ui.case === 'batch-listening') {
      await page.waitForFunction(() => !document.querySelector('button[aria-label="' + window.__uiPage.t('voiceInputOverlay.sessionPrompt.submit') + '"]')?.disabled);
      assert.equal(await send.isEnabled(), true);
      return;
    }
    await ui.emit('voice', { type: 'draft', runId: 'fixture-run', text: '请把结果整理成一份简短的周报。' });
    await page.getByText('请把结果整理成一份简短的周报。', { exact: true }).waitFor();
    assert.equal(await send.isEnabled(), true);
    if (ui.case === 'recording-error-retained') {
      await send.click();
      await page.getByText('请把结果整理成一份简短的周报。', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: await ui.t('voiceInputOverlay.sessionPrompt.submit'), exact: true }).isEnabled(), true);
    }
    if (ui.case === 'send-failed') {
      await send.click();
      await page.getByText(await ui.t('voiceInputOverlay.sessionPrompt.sendFailed'), { exact: true }).waitFor();
      assert.equal(await page.getByText('请把结果整理成一份简短的周报。', { exact: true }).isVisible(), true);
      assert.equal(await page.getByRole('button', { name: await ui.t('voiceInputOverlay.retry'), exact: true }).isEnabled(), true);
    }
    if (ui.case === 'global-after-reply') {
      await ui.emit('overlay-command', { type: 'cancel' });
      await page.waitForFunction(() => !document.querySelector('[data-voice-mic-active="true"]'));
      await ui.emit('overlay-command', { type: 'start' });
      await page.getByText(await ui.t('voiceInputOverlay.status.listening'), { exact: true }).waitFor();
      assert.equal(await send.count(), 0);
    }
  },
};
