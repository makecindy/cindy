// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInfo } from '../hooks/useWorkers';
import { RolePillDropdown, WorkerListToolbar } from '../RolePillDropdown';

const source = readFileSync(resolve(__dirname, '..', 'RolePillDropdown.tsx'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

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

  it('uses the same model line in the summary, tabs menu, and dropdown list', () => {
    const current = worker();
    render(
      createElement(WorkerListToolbar, {
        worker: current,
        workers: [current],
        selectedWorkerId: current.workerId,
        activeWorkerCount: 1,
        softLimit: 5,
        hardLimit: 8,
        onSwitchFocus: vi.fn(),
        onOpenCreate: vi.fn(),
        onOpenSettings: vi.fn(),
        onArchiveWorker: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'orca.rolePill.layoutMenuLabel' }));
    expect(screen.getByText('gpt-5.6-sol')).toBeTruthy();
    expect(screen.getByText('· effortLevels.xhigh')).toBeTruthy();
    expect(screen.queryByLabelText(/^effort /)).toBeNull();

    expect(source.match(/<WorkerModelLine\b/g)).toHaveLength(3);
    expect(source).toContain('<WorkerModelLine model={worker.model} effort={worker.effort} />');
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
