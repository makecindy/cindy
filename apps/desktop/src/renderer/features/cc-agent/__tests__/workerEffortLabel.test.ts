// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown, WorkerListToolbar } from '../RolePillDropdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useAppShortcut', () => ({
  useAppShortcutDisplay: () => '',
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => false) }),
}));

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-a',
    sessionId: 'session-a',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    label: null,
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

describe('RolePillDropdown worker effort label', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('shows the localized effort word instead of signal bars', () => {
    const current = worker();
    render(
      createElement(RolePillDropdown, {
        worker: current,
        workers: [current],
        selectedWorkerId: current.workerId,
        activeWorkerCount: 1,
        onSwitchFocus: vi.fn(),
        onArchiveWorker: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /developer/ }));

    const modelName = screen.getByText('gpt-5.6-sol');
    const effort = screen.getByText('· effortLevels.xhigh');
    expect(modelName.classList.contains('truncate')).toBe(true);
    expect(effort.classList.contains('shrink-0')).toBe(true);
    expect(modelName.parentElement?.classList.contains('text-12')).toBe(true);
    expect(modelName.parentElement?.classList.contains('text-[var(--text-secondary)]')).toBe(true);
    expect(modelName.parentElement?.classList.contains('mr-7')).toBe(true);
    expect(screen.queryByLabelText(/^effort /)).toBeNull();
  });

  it.each(
    ['summary', 'tabs menu', 'dropdown list'].flatMap((surface) =>
      ['local', 'remote', 'offline remote'].map((kind) => ({ surface, kind })),
    ),
  )('shows a consistent model line for a $kind worker in the $surface', async ({ surface, kind }) => {
    const current = worker({
      executionDevice:
        kind === 'local'
          ? undefined
          : {
              deviceId: 'mac-mini',
              remoteSessionId: 'remote-a',
              deviceName: 'Mac mini',
              reachable: kind !== 'offline remote',
              workingDir: null,
            },
    });
    const props = {
      worker: current,
      workers: [current],
      selectedWorkerId: current.workerId,
      activeWorkerCount: 1,
      onSwitchFocus: vi.fn(),
      onArchiveWorker: vi.fn(),
    };
    render(
      surface === 'dropdown list'
        ? createElement(RolePillDropdown, props)
        : createElement(WorkerListToolbar, {
            ...props,
            softLimit: 5,
            hardLimit: 8,
            onOpenCreate: vi.fn(),
            onOpenSettings: vi.fn(),
          }),
    );

    if (surface === 'tabs menu') {
      fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutMenuLabel' }));
    } else if (surface === 'summary') {
      fireEvent.focus(screen.getByRole('button', { name: /developer/ }));
    } else {
      fireEvent.click(screen.getByRole('button', { name: /developer/ }));
    }

    if (kind === 'offline remote') {
      await screen.findAllByText('orca.rolePill.deviceUnreachable');
      expect(screen.queryByText('gpt-5.6-sol')).toBeNull();
      expect(screen.queryByText('· effortLevels.xhigh')).toBeNull();
    } else {
      const models = await screen.findAllByText('gpt-5.6-sol');
      const efforts = screen.getAllByText('· effortLevels.xhigh');
      expect(models).toHaveLength(efforts.length);
      models.forEach((model, index) => {
        expect(model.parentElement).toBe(efforts[index]!.parentElement);
        expect(model.classList.contains('truncate')).toBe(true);
        expect(efforts[index]!.classList.contains('shrink-0')).toBe(true);
        expect(model.parentElement?.classList.contains('text-12')).toBe(true);
        expect(model.parentElement?.classList.contains('text-[var(--text-secondary)]')).toBe(true);
      });
      expect(screen.queryByText('orca.rolePill.deviceUnreachable')).toBeNull();
    }
    if (kind !== 'local') {
      expect(screen.getAllByText('Mac mini').length).toBeGreaterThan(0);
    } else {
      expect(screen.queryByText('Mac mini')).toBeNull();
    }
    expect(screen.queryByLabelText(/^effort /)).toBeNull();
  });

  it('hides unknown or missing effort instead of falling back to medium', () => {
    const current = worker({ effort: null });
    render(
      createElement(RolePillDropdown, {
        worker: current,
        workers: [
          current,
          worker({ workerId: 'worker-b', sessionId: 'session-b', effort: 'unknown' }),
        ],
        selectedWorkerId: current.workerId,
        activeWorkerCount: 2,
        onSwitchFocus: vi.fn(),
        onArchiveWorker: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /developer/ }));

    expect(screen.queryByText('effortLevels.medium')).toBeNull();
    expect(screen.queryByText('effortLevels.unknown')).toBeNull();
    expect(screen.queryByLabelText(/^effort /)).toBeNull();
  });

  it('uses the secondary tone for an unselected row', () => {
    const current = worker({ focused: false });
    render(
      createElement(RolePillDropdown, {
        worker: current,
        workers: [current],
        selectedWorkerId: null,
        activeWorkerCount: 1,
        onSwitchFocus: vi.fn(),
        onArchiveWorker: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /developer/ }));

    const modelName = screen.getByText('gpt-5.6-sol');
    expect(modelName.parentElement?.classList.contains('text-12')).toBe(true);
    expect(modelName.parentElement?.classList.contains('text-[var(--text-secondary)]')).toBe(true);
    expect(modelName.parentElement?.classList.contains('opacity-80')).toBe(false);
    expect(screen.getByText('· effortLevels.xhigh').classList.contains('shrink-0')).toBe(true);
  });

  it('keeps a long model name truncatable so the effort suffix stays visible', () => {
    const current = worker({
      model: 'custom-provider/an-unreasonably-long-model-identifier-that-would-overflow',
    });
    render(
      createElement(RolePillDropdown, {
        worker: current,
        workers: [current],
        selectedWorkerId: current.workerId,
        activeWorkerCount: 1,
        onSwitchFocus: vi.fn(),
        onArchiveWorker: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: /developer/ }));

    expect(screen.getByText('an-unreasonably-long-model-identifier-that-would-overflow').classList.contains('truncate')).toBe(true);
    expect(screen.getByText('· effortLevels.xhigh').classList.contains('shrink-0')).toBe(true);
  });
});
