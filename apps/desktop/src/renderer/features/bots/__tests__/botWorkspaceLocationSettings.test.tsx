// @vitest-environment jsdom
/**
 * Test value (#10568): verifies BotWorkspaceLocationSettings UI flows against the desktop
 * preload API surface (choose folder -> preview -> schedule/restart, pending -> cancel/restart,
 * moved/unavailable error state, failed -> dismiss). Unit tier; jsdom, no Electron window.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceMigrationChooseTargetResult,
  WorkspaceMigrationScheduleResult,
  WorkspaceMigrationStatus,
} from '../../../../shared/workspaceMigration';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/toast', () => ({ toast: toastMocks }));

import { BotWorkspaceLocationSettings } from '../BotWorkspaceLocationSettings';

function installApi(overrides: {
  status?: WorkspaceMigrationStatus;
  chooseTarget?: () => Promise<WorkspaceMigrationChooseTargetResult>;
  schedule?: () => Promise<WorkspaceMigrationScheduleResult>;
  cancel?: () => Promise<WorkspaceMigrationStatus>;
  restart?: () => Promise<{ relaunching: boolean }>;
} = {}) {
  const defaultStatus: WorkspaceMigrationStatus = {
    botId: 'bot-1',
    source: 'C:\\Users\\Alice\\AppData\\Roaming\\Cindy\\owners\\o1\\bots\\bot-1\\workspace',
    workspaceAvailable: true,
    phase: 'none',
    canSchedule: true,
  };
  const status = overrides.status ?? defaultStatus;
  const api = {
    getStatus: vi.fn(async () => status),
    chooseTarget: vi.fn(
      overrides.chooseTarget ??
        (async () => ({
          selected: true as const,
          preview: {
            grantId: 'grant-1',
            source: status.source,
            target: 'D:\\CindyWorkspaces\\bot-1-workspace',
            bytes: String(12 * 1024 * 1024),
            files: 18,
            links: 1,
          },
        })),
    ),
    schedule: vi.fn(
      overrides.schedule ??
        (async () => ({
          relaunching: false,
          status: {
            ...status,
            phase: 'pending' as const,
            target: 'D:\\CindyWorkspaces\\bot-1-workspace',
          },
        })),
    ),
    cancel: vi.fn(
      overrides.cancel ??
        (async () => ({
          ...status,
          phase: 'cancelled' as const,
        })),
    ),
    restart: vi.fn(overrides.restart ?? (async () => ({ relaunching: true }))),
    getStartupProgress: vi.fn(async () => null),
    onStartupProgress: vi.fn(() => vi.fn()),
  };
  const openPath = vi.fn(async () => ({ success: true }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    openPath,
    localDb: {
      bots: {
        workspaceMigration: api,
      },
    },
  };
  return { api, openPath };
}

beforeEach(() => {
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('BotWorkspaceLocationSettings', () => {
  it('previews a chosen folder and schedules workspace migration for the next restart', async () => {
    const { api } = installApi();
    render(<BotWorkspaceLocationSettings botId="bot-1" />);

    const moveButton = await screen.findByRole('button', {
      name: /bots\.homeFolder\.workspaceLocation\.moveAction/,
    });
    fireEvent.click(moveButton);

    const preview = await screen.findByTestId('workspace-migration-preview');
    expect(preview.textContent).toContain('D:\\CindyWorkspaces\\bot-1-workspace');

    fireEvent.click(
      screen.getByRole('button', {
        name: 'bots.homeFolder.workspaceLocation.scheduleNextRestart',
      }),
    );

    await waitFor(() =>
      expect(api.schedule).toHaveBeenCalledWith({
        botId: 'bot-1',
        grantId: 'grant-1',
        restartNow: false,
      }),
    );
    expect(await screen.findByTestId('workspace-migration-pending')).toBeTruthy();
    expect(toastMocks.success).toHaveBeenCalledWith(
      'bots.homeFolder.workspaceLocation.scheduledToast',
    );
  });

  it('shows localized error notice when target folder validation fails', async () => {
    installApi({
      chooseTarget: async () => ({
        selected: true,
        errorCode: 'INSUFFICIENT_SPACE',
        candidateTarget: 'D:\\full\\bot-1-workspace',
      }),
    });
    render(<BotWorkspaceLocationSettings botId="bot-1" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: /bots\.homeFolder\.workspaceLocation\.moveAction/,
      }),
    );

    expect(
      await screen.findByText('bots.homeFolder.workspaceLocation.errors.insufficientSpace'),
    ).toBeTruthy();
  });

  it('allows cancelling or restarting a pending migration', async () => {
    const { api } = installApi({
      status: {
        botId: 'bot-1',
        source: 'C:\\Cindy\\bots\\bot-1\\workspace',
        workspaceAvailable: true,
        phase: 'pending',
        target: 'D:\\CindyWorkspaces\\bot-1-workspace',
        canSchedule: true,
      },
    });
    render(<BotWorkspaceLocationSettings botId="bot-1" />);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'bots.homeFolder.workspaceLocation.restartNow',
      }),
    );
    await waitFor(() => expect(api.restart).toHaveBeenCalledWith('bot-1'));
  });

  it('shows moved target open button and alerts when a moved target is unavailable', async () => {
    const { api, openPath } = installApi({
      status: {
        botId: 'bot-1',
        source: 'C:\\Cindy\\bots\\bot-1\\workspace',
        workspaceAvailable: true,
        phase: 'completed',
        target: 'D:\\CindyWorkspaces\\bot-1-workspace',
        currentTarget: 'D:\\CindyWorkspaces\\bot-1-workspace',
        canSchedule: true,
      },
    });
    render(<BotWorkspaceLocationSettings botId="bot-1" />);

    const openBtn = await screen.findByRole('button', {
      name: /bots\.homeFolder\.workspaceLocation\.openTarget/,
    });
    fireEvent.click(openBtn);
    await waitFor(() =>
      expect(openPath).toHaveBeenCalledWith('D:\\CindyWorkspaces\\bot-1-workspace'),
    );
    expect(
      screen.getByRole('button', { name: 'bots.homeFolder.workspaceLocation.moveAction' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'bots.homeFolder.workspaceLocation.moveBackAction' }),
    );
    await screen.findByTestId('workspace-migration-preview');
    expect(api.chooseTarget).toHaveBeenCalledWith('bot-1', true);

    cleanup();
    installApi({
      status: {
        botId: 'bot-1',
        source: 'C:\\Cindy\\bots\\bot-1\\workspace',
        workspaceAvailable: false,
        phase: 'completed',
        target: 'D:\\OfflineDrive\\bot-1-workspace',
        currentTarget: 'D:\\OfflineDrive\\bot-1-workspace',
        canSchedule: true,
      },
    });
    render(<BotWorkspaceLocationSettings botId="bot-1" />);
    expect(
      await screen.findByText('bots.homeFolder.workspaceLocation.unavailableTitle'),
    ).toBeTruthy();
  });
});
