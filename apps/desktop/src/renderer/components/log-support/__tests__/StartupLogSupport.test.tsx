// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../../../i18n/locales/zh-CN/common.json';

const mocks = vi.hoisted(() => ({
  auth: { canEnterApp: false, isInitializing: false, isAuthenticated: false, mode: 'signed-out' },
  db: { localDbGateStatus: 'pending', coverHeld: false },
  env: { status: 'passed' },
  handoff: {
    brandStageMounted: false,
    phase: 'done',
    branch: null as string | null,
    panelRevealed: true,
    startSignals: {
      brandAssetsReady: true,
      splashExited: true,
      splashExitCompleted: true,
      loginPanelMounted: false,
    },
  },
  reportStartupGateStall: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  openLogsDir: vi.fn(),
  uploadLogsNow: vi.fn(),
  getLogUploadSettings: vi.fn(),
  writeText: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mocks.auth }));
vi.mock('@/contexts/AppShellCoverContext', () => ({ useAppShellCover: () => mocks.db }));
vi.mock('@/contexts/EnvCheckContext', () => ({ useEnvCheck: () => mocks.env }));
vi.mock('@/contexts/LoginHandoffContext', () => ({ useLoginHandoff: () => mocks.handoff }));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.error, success: mocks.success } }));

import { StartupLogSupport } from '../StartupLogSupport';
import { parseStartupGateStallSnapshot } from '../../../../shared/startupGateStall';

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: 'zh-CN',
    resources: { 'zh-CN': { translation: zhCN } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.canEnterApp = false;
  mocks.auth.isInitializing = false;
  mocks.auth.isAuthenticated = false;
  mocks.auth.mode = 'signed-out';
  mocks.db.localDbGateStatus = 'pending';
  mocks.db.coverHeld = false;
  mocks.env.status = 'passed';
  mocks.handoff.brandStageMounted = false;
  mocks.handoff.phase = 'done';
  mocks.handoff.branch = null;
  mocks.handoff.panelRevealed = true;
  mocks.handoff.startSignals.loginPanelMounted = false;
  mocks.openLogsDir.mockResolvedValue({ success: true });
  mocks.uploadLogsNow.mockResolvedValue({ uploadCode: 'ABCD-EFGH', recordCount: 3 });
  mocks.writeText.mockResolvedValue(undefined);
  mocks.getLogUploadSettings.mockResolvedValue({
    targetConfigured: true,
    privacyConsentAccepted: true,
    manualUploadAvailable: true,
    crashAutoUploadEnabled: false,
    crashAutoUploadCustomized: false,
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openLogsDir: mocks.openLogsDir,
      uploadLogsNow: mocks.uploadLogsNow,
      getLogUploadSettings: mocks.getLogUploadSettings,
      onLogUploadSettingsChange: () => () => {},
      reportStartupGateStall: mocks.reportStartupGateStall,
    },
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});
afterEach(cleanup);

function openSupport() {
  render(<StartupLogSupport />);
  fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
}

describe('startup log support', () => {
  it('opens local logs while signed out even if upload settings never resolve', async () => {
    mocks.getLogUploadSettings.mockReturnValue(new Promise(() => {}));
    openSupport();
    fireEvent.click(screen.getByRole('button', { name: zhCN.settings.about.openLogsDir }));
    await waitFor(() => expect(mocks.openLogsDir).toHaveBeenCalledOnce());
    expect(mocks.uploadLogsNow).not.toHaveBeenCalled();
  });

  it.each([
    { targetConfigured: false, privacyConsentAccepted: true },
    { targetConfigured: true, privacyConsentAccepted: false },
  ])('keeps local logs usable with upload unavailable: %o', async (settings) => {
    mocks.getLogUploadSettings.mockResolvedValue({ ...settings, manualUploadAvailable: false });
    openSupport();
    await waitFor(() => expect(mocks.getLogUploadSettings).toHaveBeenCalledOnce());
    expect(
      (
        screen.getByRole('button', {
          name: zhCN.settings.about.logUpload.uploadButton,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: zhCN.settings.about.openLogsDir }));
    expect(mocks.openLogsDir).toHaveBeenCalledOnce();
  });

  it('shows a selectable upload code even when clipboard copying fails', async () => {
    mocks.writeText.mockRejectedValue(new Error('clipboard unavailable'));
    openSupport();
    const upload = screen.getByRole('button', { name: zhCN.settings.about.logUpload.uploadButton });
    await waitFor(() => expect((upload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('ABCD-EFGH'));
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('reports an upload error and leaves the local log action available', async () => {
    mocks.uploadLogsNow.mockRejectedValue(new Error('[LOG_UPLOAD_EMPTY] empty'));
    openSupport();
    const upload = screen.getByRole('button', { name: zhCN.settings.about.logUpload.uploadButton });
    await waitFor(() => expect((upload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(upload);
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(zhCN.settings.about.logUpload.errorEmpty),
    );
    fireEvent.click(screen.getByRole('button', { name: zhCN.settings.about.openLogsDir }));
    expect(mocks.openLogsDir).toHaveBeenCalledOnce();
  });

  it('retains the upload code after closing and reopening without a working clipboard', async () => {
    mocks.writeText.mockRejectedValue(new Error('clipboard unavailable'));
    openSupport();
    const upload = screen.getByRole('button', { name: zhCN.settings.about.logUpload.uploadButton });
    await waitFor(() => expect((upload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('ABCD-EFGH'));
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.close }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
    });
    expect(screen.getByRole('status').textContent).toContain('ABCD-EFGH');
  });

  it('keeps a pending upload and its eventual code across dialog dismissal', async () => {
    let finish!: (result: { uploadCode: string; recordCount: number }) => void;
    mocks.uploadLogsNow.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mocks.writeText.mockRejectedValue(new Error('clipboard unavailable'));
    openSupport();
    const upload = screen.getByRole('button', { name: zhCN.settings.about.logUpload.uploadButton });
    await waitFor(() => expect((upload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(upload);
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.close }));
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
    await waitFor(() => expect(mocks.getLogUploadSettings).toHaveBeenCalledTimes(2));
    expect(
      (
        screen.getByRole('button', {
          name: zhCN.settings.about.logUpload.uploadButton,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mocks.uploadLogsNow).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.close }));
    await act(async () => {
      finish({ uploadCode: 'LATE-CODE', recordCount: 1 });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
    });
    expect(screen.getByRole('status').textContent).toContain('LATE-CODE');
  });

  it('clears the previous upload code when a new attempt starts and fails', async () => {
    openSupport();
    const upload = screen.getByRole('button', { name: zhCN.settings.about.logUpload.uploadButton });
    await waitFor(() => expect((upload as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('ABCD-EFGH'));
    await waitFor(() => expect((upload as HTMLButtonElement).disabled).toBe(false));
    mocks.uploadLogsNow.mockRejectedValue(new Error('[LOG_UPLOAD_EMPTY] empty'));
    fireEvent.click(upload);
    expect(screen.queryByRole('status')).toBeNull();
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith(zhCN.settings.about.logUpload.errorEmpty),
    );
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('hides the startup entry but preserves a user-opened dialog when startup completes', () => {
    const view = render(<StartupLogSupport />);
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.title }));
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = 'ready';
    view.rerender(<StartupLogSupport />);
    expect(screen.queryByRole('button', { name: zhCN.logSupport.title })).toBeNull();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: zhCN.logSupport.close }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each(['pending', 'fatal'])('stays reachable when database state is %s', async (state) => {
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = state;
    openSupport();
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await waitFor(() =>
      expect(
        (
          screen.getByRole('button', {
            name: zhCN.settings.about.logUpload.uploadButton,
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
  });

  it('stays reachable through startup failure and disappears when the app is ready', () => {
    mocks.auth.canEnterApp = true;
    mocks.db.localDbGateStatus = 'ready';
    mocks.env.status = 'failed';
    const view = render(<StartupLogSupport />);
    expect(screen.getByRole('button', { name: zhCN.logSupport.title })).toBeTruthy();
    mocks.env.status = 'passed';
    view.rerender(<StartupLogSupport />);
    expect(screen.queryByRole('button', { name: zhCN.logSupport.title })).toBeNull();
  });
});

// 用户卡在开屏、主进程日志却显示已登录且数据库就绪时,原先无从判断是哪个门没放行;
// renderer 日志又不进上传。超时后经 main 记一份启动门快照。
describe('startup gate stall report', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function signedInWithBrandStageStuck() {
    mocks.auth.canEnterApp = true;
    mocks.auth.isAuthenticated = true;
    mocks.auth.mode = 'cloud';
    mocks.db.localDbGateStatus = 'ready';
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.phase = 'boot';
    mocks.handoff.panelRevealed = false;
  }

  it('reports the gate snapshot once when the startup cover stays past the threshold', () => {
    signedInWithBrandStageStuck();
    render(<StartupLogSupport />);

    act(() => vi.advanceTimersByTime(19_000));
    expect(mocks.reportStartupGateStall).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      authenticated: true,
      canEnterApp: true,
      envStatus: 'passed',
      localDbGate: 'ready',
      handoffPhase: 'boot',
      handoffBranch: 'none',
      brandStageMounted: true,
      loginPanelMounted: false,
    });
  });

  it('keeps the authenticated cover-release wait in the diagnostic snapshot', () => {
    signedInWithBrandStageStuck();
    mocks.db.coverHeld = true;
    mocks.handoff.phase = 'awaiting-cover-release';
    render(<StartupLogSupport />);

    act(() => vi.advanceTimersByTime(20_000));

    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      coverHeld: true,
      handoffPhase: 'awaiting-cover-release',
    });
  });

  it.each([
    [
      'the login panel is waiting for the user',
      () => {
        mocks.handoff.brandStageMounted = true;
        mocks.handoff.startSignals.loginPanelMounted = true;
      },
    ],
    ['startup finishes before the threshold', null],
  ])('does not report when %s', (_label, arrange) => {
    if (arrange) {
      arrange();
      render(<StartupLogSupport />);
    } else {
      signedInWithBrandStageStuck();
      const view = render(<StartupLogSupport />);
      act(() => vi.advanceTimersByTime(5_000));
      mocks.handoff.brandStageMounted = false;
      mocks.handoff.phase = 'done';
      view.rerender(<StartupLogSupport />);
    }

    act(() => vi.advanceTimersByTime(60_000));
    expect(mocks.reportStartupGateStall).not.toHaveBeenCalled();
  });

  // 未登录冷启动:登录页先挂在开屏底下,面板还没显示;开屏卡住时用户看到的仍是开屏。
  it('reports a stuck splash even while the login page is mounted underneath', () => {
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.phase = 'boot';
    mocks.handoff.panelRevealed = false;
    mocks.handoff.startSignals.loginPanelMounted = true;
    render(<StartupLogSupport />);

    act(() => vi.advanceTimersByTime(20_000));
    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      handoffPhase: 'boot',
      loginPanelMounted: true,
    });
  });

  // 在登录页停留超过阈值后再登录:数据库准备的那一小段不能立刻被算成卡住。
  it('times the threshold from when waiting begins, not from page load', () => {
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.startSignals.loginPanelMounted = true;
    const view = render(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(30_000));

    mocks.auth.canEnterApp = true;
    mocks.db.coverHeld = true;
    mocks.handoff.startSignals.loginPanelMounted = false;
    view.rerender(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(19_000));
    expect(mocks.reportStartupGateStall).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(1_000));
    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    expect(mocks.reportStartupGateStall.mock.calls[0][0]).toMatchObject({
      elapsedMs: 50_000,
      waitingMs: 20_000,
      localDbGate: 'pending',
    });
  });

  // 登录页停留(或休眠)跨过一天后再卡住:时长超出 main 的白名单上限会让整份快照被拒,
  // 而每次加载只报一次,诊断就此丢失。
  it('keeps a report from a day-long session within what main accepts', () => {
    mocks.handoff.brandStageMounted = true;
    mocks.handoff.startSignals.loginPanelMounted = true;
    const view = render(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(25 * 60 * 60 * 1000));

    mocks.auth.canEnterApp = true;
    mocks.db.coverHeld = true;
    mocks.handoff.startSignals.loginPanelMounted = false;
    view.rerender(<StartupLogSupport />);
    act(() => vi.advanceTimersByTime(20_000));

    expect(mocks.reportStartupGateStall).toHaveBeenCalledOnce();
    const payload = mocks.reportStartupGateStall.mock.calls[0][0];
    expect(parseStartupGateStallSnapshot(payload)).toMatchObject({
      elapsedMs: 24 * 60 * 60 * 1000,
      waitingMs: 20_000,
    });
  });
});
