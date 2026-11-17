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
    local: { about: 'Local supplier retains the original thinking label' },
    responding: { about: 'Remote thinking content restores the original label', data: { remote: true, response: true } },
  },
  async check(page, ui) {
    await page.getByText(await ui.t(ui.data.remote && !ui.data.response
      ? 'ccAgent.agentStatus.waitingRemoteResponse' : 'ccAgent.agentStatus.thinking'), { exact: true }).waitFor();
    if (ui.data.preparing && await page.locator('[data-running-status-meta]').count()) {
      throw new Error('Preparation must not display stale runtime metrics');
    }
  },
};
