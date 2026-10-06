// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EditWorkerPopover } from '../EditWorkerPopover';
import type { WorkerInfo } from '../hooks/useWorkers';

function worker(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    workerId: 'worker-1',
    sessionId: 'worker-session-1',
    role: 'developer',
    agent: 'codex',
    model: 'gpt-5.5',
    effort: 'high',
    label: 'developer-2',
    status: 'idle',
    focused: true,
    idleSince: null,
    ...overrides,
  };
}

describe('EditWorkerPopover', () => {
  afterEach(() => {
    cleanup();
  });

  it('prefills the current role and label and saves them unchanged', async () => {
    const onSave = vi.fn(async () => true);
    render(
      <EditWorkerPopover open worker={worker()} onClose={vi.fn()} onSave={onSave} />,
    );

    const labelInput = screen.getByPlaceholderText('orca.editWorker.labelPlaceholder');
    expect((labelInput as HTMLInputElement).value).toBe('developer-2');

    fireEvent.click(screen.getByRole('button', { name: 'orca.editWorker.submit' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({ role: 'developer', label: 'developer-2' });
    });
  });

  it('accepts a predefined role switch and a custom role', async () => {
    const onSave = vi.fn(async () => true);
    const { rerender } = render(
      <EditWorkerPopover open worker={worker()} onClose={vi.fn()} onSave={onSave} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'reviewer' }));
    fireEvent.click(screen.getByRole('button', { name: 'orca.editWorker.submit' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenLastCalledWith({ role: 'reviewer', label: 'developer-2' });
    });

    rerender(
      <EditWorkerPopover
        open
        worker={worker({ workerId: 'worker-2', role: '前端负责人' })}
        onClose={vi.fn()}
        onSave={onSave}
      />,
    );
    const customRoleInput = screen.getByPlaceholderText('orca.createWorker.customRolePlaceholder');
    expect((customRoleInput as HTMLInputElement).value).toBe('前端负责人');
    fireEvent.click(screen.getByRole('button', { name: 'orca.editWorker.submit' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenLastCalledWith({ role: '前端负责人', label: 'developer-2' });
    });
  });

  it('blocks saving on an invalid label and reports it inline', () => {
    render(
      <EditWorkerPopover open worker={worker()} onClose={vi.fn()} onSave={vi.fn(async () => true)} />,
    );

    fireEvent.change(screen.getByPlaceholderText('orca.editWorker.labelPlaceholder'), {
      target: { value: '前端' },
    });
    expect(screen.getByText('orca.editWorker.labelInvalid')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'orca.editWorker.submit' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('stays open when saving fails', async () => {
    const onSave = vi.fn(async () => false);
    render(
      <EditWorkerPopover open worker={worker()} onClose={vi.fn()} onSave={onSave} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'orca.editWorker.submit' }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });
    expect(
      (screen.getByPlaceholderText('orca.editWorker.labelPlaceholder') as HTMLInputElement).value,
    ).toBe('developer-2');
  });

  it('keeps in-progress edits across worker projection refreshes', () => {
    const onSave = vi.fn(async () => true);
    const { rerender } = render(
      <EditWorkerPopover open worker={worker()} onClose={vi.fn()} onSave={onSave} />,
    );
    fireEvent.change(screen.getByPlaceholderText('orca.editWorker.labelPlaceholder'), {
      target: { value: 'my-label' },
    });

    // 投影刷新会换 worker 对象身份；同一 worker 不得把用户编辑回滚到库里的值。
    rerender(<EditWorkerPopover open worker={worker()} onClose={vi.fn()} onSave={onSave} />);
    expect(
      (screen.getByPlaceholderText('orca.editWorker.labelPlaceholder') as HTMLInputElement).value,
    ).toBe('my-label');
  });

  it('closes through the header affordance', () => {
    const onClose = vi.fn();
    render(
      <EditWorkerPopover open worker={worker()} onClose={onClose} onSave={vi.fn(async () => true)} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'orca.editWorker.closeAria' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
