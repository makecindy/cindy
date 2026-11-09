// @vitest-environment jsdom
/** Unit: real confirmation UI must stage diagnosis without sending, serialize startup
 * notices, preserve the retry action on failure, and never collect after dismissal. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
const mocks = vi.hoisted(() => ({
  auth: { dataOwnerId: '' }, candidates: vi.fn(), send: vi.fn(),
  get: vi.fn(), prepare: vi.fn(), dismiss: vi.fn(), prefill: vi.fn(), error: vi.fn(),
  db: { coverHeld: false, localDbGateStatus: 'ready' },
}));
vi.mock('@/contexts/AppShellCoverContext', () => ({ useAppShellCover: () => mocks.db }));
vi.mock('@/contexts/LoginHandoffContext', () => ({ useLoginHandoff: () => ({ brandStageMounted: false }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { sendUiTrigger: mocks.send } }));
// Draft persistence itself is covered by ErrorLocalization.test.tsx. Keep this
// modal test on the real prompt builder without loading unrelated composer stores.
vi.mock('@/lib/composerDraftStore', () => ({
  draftHasContent: vi.fn(), getDraft: vi.fn(), plainTextToTiptapDoc: vi.fn(), saveDraft: vi.fn(),
}));
vi.mock('@/state/newMakerDraft', () => ({ resetDraftWorkspaceTargets: vi.fn() }));
vi.mock('@/lib/errorDiagnosisPrompt', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/errorDiagnosisPrompt')>(), prefillErrorDiagnosisDraft: mocks.prefill,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error } }));
import { StartupRecoveryDialogs } from '../StartupRecoveryDialogs';
beforeAll(async () => {
  await i18next.use(initReactI18next).init({ lng: 'zh-CN', resources: { 'zh-CN': { translation: zhCN } }, interpolation: { escapeValue: false } });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.dataOwnerId = crypto.randomUUID();
  mocks.candidates.mockResolvedValue([]);
  mocks.send.mockResolvedValue(undefined);
  mocks.db.coverHeld = false;
  mocks.get.mockResolvedValue({ count: 1, details: 'exit summary' });
  mocks.prepare.mockResolvedValue({ count: 1, details: 'exit summary', logs: 'redacted evidence', logsUnavailable: false });
  mocks.dismiss.mockResolvedValue(undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { sessions: {
      interruptedResumeCandidates: mocks.candidates,
      getMany: async () => [{ id: 'unfinished', title: '未完成任务', source: 'desktop', agentKind: 'cc', workingDir: '/example', createdAt: new Date().toISOString() }],
    } },
    getCrashDiagnosis: mocks.get, prepareCrashDiagnosis: mocks.prepare, dismissCrashDiagnosis: mocks.dismiss,
  } });
});
afterEach(cleanup);
it('waits for release notes then prepares a reviewable diagnosis draft when no tasks need recovery', async () => {
  const view = render(<MemoryRouter><StartupRecoveryDialogs suspended /></MemoryRouter>);
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(mocks.prepare).not.toHaveBeenCalled();
  view.rerender(<MemoryRouter><StartupRecoveryDialogs /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '诊断问题' }));
  await waitFor(() => expect(mocks.prefill).toHaveBeenCalledTimes(1));
  expect(mocks.prefill.mock.calls[0][0]).toContain('redacted evidence');
  expect(mocks.prefill.mock.calls[0][0]).toContain('exit summary');
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);

});
it('dismisses without preparing evidence or a task', async () => {
  render(<MemoryRouter><StartupRecoveryDialogs /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '暂不处理' }));
  expect(mocks.dismiss).toHaveBeenCalledTimes(1);
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.prefill).not.toHaveBeenCalled();
});
it('keeps the dialog open for retry when preparation fails', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('IPC unavailable'));
  render(<MemoryRouter><StartupRecoveryDialogs /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '诊断问题' }));
  await waitFor(() => expect(mocks.error).toHaveBeenCalled());
  expect(mocks.dismiss).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '诊断问题' }));
  await waitFor(() => expect(mocks.prefill).toHaveBeenCalledTimes(1));
});

it('leaves ordinary startup alone when there is no unexpected exit', async () => {
  mocks.get.mockResolvedValue(null);
  render(<MemoryRouter><StartupRecoveryDialogs /></MemoryRouter>);
  await waitFor(() => expect(mocks.candidates).toHaveBeenCalled());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(mocks.prepare).not.toHaveBeenCalled();
});

it.each(['continue', 'later', 'escape'])('shows diagnosis only after the recovery choice: %s', async (action) => {
  mocks.candidates.mockResolvedValue([{ sessionId: 'unfinished', interruptedAt: Date.now(), activity: null }]);
  render(<MemoryRouter><StartupRecoveryDialogs /></MemoryRouter>);
  await screen.findByText('未完成任务');
  expect(screen.queryByRole('button', { name: '诊断问题' })).toBeNull();
  if (action === 'escape') fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: action === 'continue'
    ? i18next.t('chat.interruptedResumeDialog.continueSelected', { count: 1 })
    : i18next.t('chat.interruptedResumeDialog.later') }));
  await screen.findByRole('button', { name: '诊断问题' });
  await waitFor(() => expect(screen.queryByText('未完成任务')).toBeNull());
  if (action === 'continue') await waitFor(() => expect(mocks.send).toHaveBeenCalledTimes(1));
  else expect(mocks.send).not.toHaveBeenCalled();
});
it('waits for an unresolved task list before showing diagnosis', async () => {
  let finish!: (tasks: never[]) => void;
  mocks.candidates.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<MemoryRouter><StartupRecoveryDialogs /></MemoryRouter>);
  await waitFor(() => expect(mocks.get).toHaveBeenCalled());
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await act(async () => finish([]));
  await screen.findByRole('button', { name: '诊断问题' });
});
