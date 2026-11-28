export default {
  name: 'remote-response-status', entry: './fixture.tsx',
  viewport: { width: 720, height: 320 },
  stubs: {
    'src/renderer/components/chat/GhostToolCard': 'export const GhostToolCard = () => null; export const MailCardEditor = () => null; export const CARD_EXPAND_TOGGLE_EVENT = "xdt-card-expand-toggle";',
    'src/renderer/voice-input/workletUrl': 'export const getVoiceInputWorkletUrl = () => "";',
  },
  real: 'RunningStatusBar, remoteResponsePendingStatus, theme and i18n',
  notCovered: 'Remote transport, host startup, complete session view and starting-store lifecycle',
  cases: {
    default: { about: 'Remote supplier before its first response', data: { remote: true } },
    preparing: { about: 'Remote startup does not display the previous turn metrics', data: { remote: true, preparing: true } },
    background: { about: 'Background tasks can still be stopped during remote preparation', data: { remote: true, preparing: true, background: true } },
    'running-clock': { about: 'Open a remote task four minutes into its turn', data: { remote: true, response: true, clock: 'sampled' } },
    'legacy-clock': { about: 'An old host supplies usage alone', data: { remote: true, response: true, clock: 'legacy' } },
    local: { about: 'Local supplier retains the original thinking label' },
    responding: { about: 'Remote thinking content restores the original label', data: { remote: true, response: true } },
  },
  async check(page, ui) {
    if (!ui.data.background) await page.getByText(await ui.t(ui.data.remote && !ui.data.response
      ? 'ccAgent.agentStatus.waitingRemoteResponse' : 'ccAgent.agentStatus.thinking'), { exact: true }).waitFor();
    if (ui.data.preparing && !ui.data.background && await page.locator('[data-running-status-meta]').count()) {
      throw new Error('Preparation must not display stale runtime metrics');
    }
    if (ui.data.clock) {
      const meta = page.locator('[data-running-status-meta]');
      await meta.getByText(/85.9k/).waitFor();
      if (ui.data.clock === 'sampled') await meta.getByText(/^4m 1[2-9]s$/).waitFor();
      if (ui.data.clock === 'legacy' && /·|0s/.test(await meta.innerText())) throw new Error('Unexpected elapsed label');
    }
    if (ui.data.background) {
      await page.getByRole('button', { name: await ui.t('chat.backgroundActivity.stopAll'), exact: true }).click();
      await page.locator('[data-background-stopped="true"]').waitFor();
      if (await page.getByText('1,234', { exact: true }).count()) throw new Error('Preparation displayed stale tokens');
    }
  },
};
