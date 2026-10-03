// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexFollowUpControl } from '../CodexFollowUpControl';
const mock = vi.hoisted(() => ({
  get: vi.fn(),
  setGlobal: vi.fn(),
  setSession: vi.fn(),
  getProjection: vi.fn(),
  error: vi.fn(),
}));
vi.mock('@/lib/makerTransport', () => ({
  makerApiForSticky: () => ({ codexFollowUp: mock, input: { getProjection: mock.getProjection } }),
}));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => null,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mock.error } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: { mode: string }) =>
      ({
        'codexFollowUp.taskLabel': '对话跟进方式',
        'codexFollowUp.taskHint': '对话过程中的后续消息加入排队，或引导当前对话',
        'codexFollowUp.globalLabel': 'Codex 跟进消息',
        'codexFollowUp.queue': '排队',
        'codexFollowUp.steer': '引导',
        'codexFollowUp.inherit': `跟随全局：${vars?.mode}`,
        'codexFollowUp.saveFailed': '保存失败，请重试。',
      })[key] ?? key,
  }),
}));
vi.mock('@/components/ui/select', () => ({
  Select: (props: {
    id: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
    disabled: boolean;
    onValueChange: (value: string) => void;
    'aria-describedby': string;
  }) => (
    <select
      id={props.id}
      aria-label={props.label}
      aria-describedby={props['aria-describedby']}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onValueChange(e.target.value)}
    >
      {props.options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ text, children }: { text: string; children: React.ReactNode }) => (
    <span title={text}>{children}</span>
  ),
}));
vi.mock('@/components/settings/DefaultOverrideControls', () => ({
  DefaultOverrideControls: ({ onReset }: { onReset: () => void }) => (
    <button onClick={onReset}>恢复默认</button>
  ),
}));
const inherited = {
  globalMode: 'queue',
  override: null,
  effectiveMode: 'queue',
  isCustomized: false,
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.get.mockResolvedValue(inherited);
  mock.getProjection.mockResolvedValue({ composerAutoDelivery: true });
  mock.setSession.mockResolvedValue({ ...inherited, override: 'steer', effectiveMode: 'steer' });
  mock.setGlobal.mockResolvedValue(inherited);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        codexFollowUp: { ...mock, onChanged: () => () => {} },
        onInputProjection: () => () => {},
      },
    },
  });
});
describe('Codex follow-up control', () => {
  it('shows the exact title, hint and inheritance options', async () => {
    render(<CodexFollowUpControl sessionId="task-1" />);
    const control = screen.getByRole('combobox', { name: '对话跟进方式' });
    await waitFor(() => expect((control as HTMLSelectElement).disabled).toBe(false));
    expect(screen.getAllByTitle('对话过程中的后续消息加入排队，或引导当前对话')).toHaveLength(2);
    expect(document.getElementById(control.getAttribute('aria-describedby')!)?.textContent).toBe(
      '对话过程中的后续消息加入排队，或引导当前对话',
    );
    expect(screen.getByRole('option', { name: '跟随全局：排队' })).toBeTruthy();
  });
  it('saves only this task and can restore inheritance without sending', async () => {
    render(<CodexFollowUpControl sessionId="task-1" />);
    const control = screen.getByRole('combobox');
    await waitFor(() => expect((control as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(control, { target: { value: 'steer' } });
    await waitFor(() => expect(mock.setSession).toHaveBeenCalledWith('task-1', 'steer'));
    await waitFor(() => expect((control as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(control, { target: { value: 'inherit' } });
    await waitFor(() => expect(mock.setSession).toHaveBeenCalledWith('task-1', null));
    expect(mock.setGlobal).not.toHaveBeenCalled();
  });
  it('retains the confirmed choice on save failure', async () => {
    mock.setSession.mockRejectedValueOnce(new Error('offline'));
    render(<CodexFollowUpControl sessionId="task-1" />);
    const control = screen.getByRole('combobox');
    await waitFor(() => expect((control as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(control, { target: { value: 'steer' } });
    await waitFor(() => expect(mock.error).toHaveBeenCalledWith('保存失败，请重试。'));
    expect((control as HTMLSelectElement).value).toBe('inherit');
  });
  it('hides the new task control on an older host', async () => {
    mock.getProjection.mockResolvedValueOnce({});
    const view = render(<CodexFollowUpControl sessionId="old-host" />);
    await waitFor(() => expect(view.queryByRole('combobox')).toBeNull());
    expect(mock.get).not.toHaveBeenCalled();
  });
  it('restores the control on focus after the same host gains support', async () => {
    mock.getProjection.mockResolvedValueOnce({});
    const view = render(<CodexFollowUpControl sessionId="upgraded-host" />);
    await waitFor(() => expect(view.queryByRole('combobox')).toBeNull());
    mock.getProjection.mockResolvedValue({ composerAutoDelivery: true });
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(view.getByRole('combobox')).toBeTruthy());
    await waitFor(() =>
      expect((view.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false),
    );
    expect(mock.get).toHaveBeenCalledWith('upgraded-host');
  });
  it('restores the global default using a null override', async () => {
    render(<CodexFollowUpControl />);
    await waitFor(() =>
      expect((screen.getByRole('combobox') as HTMLSelectElement).disabled).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '恢复默认' }));
    await waitFor(() => expect(mock.setGlobal).toHaveBeenCalledWith(null));
    expect(mock.setSession).not.toHaveBeenCalled();
  });
});
