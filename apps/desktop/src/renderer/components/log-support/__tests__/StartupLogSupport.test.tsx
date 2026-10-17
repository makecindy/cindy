// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from '../../../i18n/locales/zh-CN/common.json';

const mocks = vi.hoisted(() => ({
  auth: { canEnterApp: false, isInitializing: false },
  db: { localDbGateStatus: 'pending' },
  env: { status: 'passed' },
  handoff: { brandStageMounted: false },
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
  mocks.db.localDbGateStatus = 'pending';
  mocks.env.status = 'passed';
  mocks.handoff.brandStageMounted = false;
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
