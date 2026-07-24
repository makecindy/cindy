// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LegacyMigrationDialog } from '../LegacyMigrationDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

type LegacyMigrationPhase = 'confirm' | 'running' | 'done' | 'failed' | null;

function installLegacyMigrationApi(phase: LegacyMigrationPhase) {
  const api = {
    legacyMigration: {
      getState: vi.fn().mockResolvedValue({ phase }),
      onState: vi.fn().mockReturnValue(() => {}),
      confirm: vi.fn().mockResolvedValue(undefined),
    },
  };
  (window as unknown as { electronAPI: typeof api }).electronAPI = api;
  return api.legacyMigration;
}

describe('LegacyMigrationDialog states', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('legacy-confirm:确认态显示说明与唯一确认按钮', async () => {
    const api = installLegacyMigrationApi('confirm');
    render(<LegacyMigrationDialog />);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    const button = await screen.findByRole('button', {
      name: 'legacyMigration.confirm',
    });
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('legacyMigration.title')).toBeTruthy();
    expect(screen.getByText('legacyMigration.description')).toBeTruthy();
    expect(api.onState).toHaveBeenCalled();
  });

  it('legacy-confirm:点击容器不关闭(仅 failed 态可解除)', async () => {
    const api = installLegacyMigrationApi('confirm');
    render(<LegacyMigrationDialog />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('legacy-running:运行态说明保留,按钮进禁用 loading', async () => {
    installLegacyMigrationApi('running');
    render(<LegacyMigrationDialog />);

    expect(await screen.findByRole('dialog')).toBeTruthy();
    const button = await screen.findByRole('button', {
      name: /legacyMigration.migrating/,
    });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    // figma 567:802:running 期间说明文案保留不变,只有按钮切 loading。
    expect(screen.getByText('legacyMigration.description')).toBeTruthy();
  });

  it('legacy-failed:失败态无按钮,点击任意处关闭并清 main 态', async () => {
    const api = installLegacyMigrationApi('failed');
    render(<LegacyMigrationDialog />);

    const dialog = await screen.findByRole('dialog');
    // figma 567:819/567:776:失败卡没有按钮。
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('legacyMigration.failedTitle')).toBeTruthy();
    expect(screen.getByText('legacyMigration.failedDescription')).toBeTruthy();

    fireEvent.click(dialog);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('legacy-failed:Escape 关闭并清 main 态', async () => {
    const api = installLegacyMigrationApi('failed');
    render(<LegacyMigrationDialog />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('legacy-failed:Enter 关闭并清 main 态', async () => {
    const api = installLegacyMigrationApi('failed');
    render(<LegacyMigrationDialog />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('legacy-failed:Space 关闭并清 main 态', async () => {
    const api = installLegacyMigrationApi('failed');
    render(<LegacyMigrationDialog />);

    const dialog = await screen.findByRole('dialog');
    fireEvent.keyDown(dialog, { key: ' ' });
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
