export default {
  name: 'crash-diagnosis', entry: './fixture.tsx', viewport: { width: 900, height: 650 },
  real: 'StartupRecoveryDialogs, InterruptedTasksResumeDialog, themed ConfirmDialog and translated copy',
  notCovered: 'Main IPC, native crash capture, task execution and issue submission; tested separately.',
  stubs: {
    'src/renderer/contexts/AppShellCoverContext': 'export const useAppShellCover = () => ({ coverHeld: false, localDbGateStatus: "ready" });',
    'src/renderer/contexts/LoginHandoffContext': 'export const useLoginHandoff = () => ({ brandStageMounted: false });',
    'src/renderer/contexts/AuthContext': 'export const useAuth = () => ({ dataOwnerId: "fixture-owner" });',
    'src/renderer/lib/makerChatStore': 'export const makerChatStore = { sendUiTrigger: async () => {} };',
    'src/renderer/lib/errorDiagnosisPrompt': 'export const prefillErrorDiagnosisDraft = () => {}; export const buildErrorDiagnosisPrompt = () => "";',
  },
  cases: {
    default: { about: 'Unexpected exit notice with no interrupted tasks' },
    resume: { about: 'Continue interrupted tasks before diagnosis', data: { recovery: 'continue' } },
    later: { about: 'Defer interrupted tasks before diagnosis', data: { recovery: 'later' } },
    narrow: { about: 'Notice and actions at 320px', viewport: { width: 320, height: 640 } },
  },
  async ready(page) { await page.getByRole('alertdialog').waitFor(); },
  async check(page, ui) {
    if (!ui.data.recovery) return;
    if (await page.getByRole('button', { name: await ui.t('crashDiagnosis.diagnose'), exact: true }).count()) {
      throw new Error('Diagnosis appeared before the recovery choice');
    }
    const action = ui.data.recovery === 'continue'
      ? await ui.t('chat.interruptedResumeDialog.continueSelected', { count: 1 })
      : await ui.t('chat.interruptedResumeDialog.later');
    await page.getByRole('button', { name: action, exact: true }).click();
    await page.getByRole('button', { name: await ui.t('crashDiagnosis.diagnose'), exact: true }).waitFor();
    await page.getByText('Example unfinished task', { exact: true }).waitFor({ state: 'hidden' });
  },
};
