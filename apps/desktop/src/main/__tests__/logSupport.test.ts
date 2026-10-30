import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  mkdir: vi.fn(),
  openPath: vi.fn(),
  getLogDir: vi.fn(),
  getPath: vi.fn(),
  showMessageBox: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }));
vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  shell: { openPath: mocks.openPath },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock('../logger', () => ({
  getLogDir: mocks.getLogDir,
  createLogger: () => ({ warn: mocks.warn }),
}));
vi.mock('../i18n', () => ({ t: (key: string) => key }));

import { createOpenLogsMenuItem, openLogsDirectory } from '../logSupport';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getLogDir.mockReturnValue(path.join('active-instance', 'logs'));
  mocks.getPath.mockReturnValue('user-data');
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.openPath.mockResolvedValue('');
  mocks.showMessageBox.mockResolvedValue({ response: 0 });
});

describe('local log support', () => {
  it('opens the active logger directory without reading user data or auth', async () => {
    expect(await openLogsDirectory()).toEqual({ success: true });
    expect(mocks.openPath).toHaveBeenCalledWith(path.join('active-instance', 'logs'));
    expect(mocks.getPath).not.toHaveBeenCalled();
  });

  it('creates the profile logs directory if the logger has not initialized', async () => {
    mocks.getLogDir.mockReturnValue('');
    await openLogsDirectory();
    expect(mocks.getPath).toHaveBeenCalledWith('userData');
    expect(mocks.mkdir).toHaveBeenCalledWith(path.join('user-data', 'logs'), { recursive: true });
  });

  it.each(['mkdir', 'openPath'] as const)(
    'contains %s failures without returning paths',
    async (method) => {
      mocks[method].mockRejectedValue(new Error('private path'));
      expect(await openLogsDirectory()).toEqual({ success: false });
    },
  );

  it('handles shell error strings as failures', async () => {
    mocks.openPath.mockResolvedValue('private shell detail');
    expect(await openLogsDirectory()).toEqual({ success: false });
  });

  it('the native menu opens logs directly without a renderer', async () => {
    createOpenLogsMenuItem().click?.(
      {} as Electron.MenuItem,
      undefined,
      {} as Electron.KeyboardEvent,
    );
    await vi.waitFor(() => expect(mocks.openPath).toHaveBeenCalledOnce());
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('the native menu reports failures through a native dialog', async () => {
    mocks.openPath.mockResolvedValue('private shell detail');
    createOpenLogsMenuItem().click?.(
      {} as Electron.MenuItem,
      undefined,
      {} as Electron.KeyboardEvent,
    );
    await vi.waitFor(() =>
      expect(mocks.showMessageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'settings.about.openLogsDirError',
        }),
      ),
    );
  });
});
