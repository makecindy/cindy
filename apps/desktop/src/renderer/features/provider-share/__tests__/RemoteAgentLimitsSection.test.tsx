// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { RemoteAgentLimitsSection } from '../RemoteAgentLimitsSection';

const command = vi.hoisted(() => vi.fn());
vi.mock('../../provider-group/providerManagement', () => ({
  providerShareManagementCommand: command,
  providerManagementErrorKey: () => 'providerGroup.management.unsupported',
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const view = (perDevice = 16, total = 64, isCustomized = false) => ({
  value: { perDevice, total }, defaults: { perDevice: 16, total: 64 }, isCustomized,
  customizedKeys: isCustomized ? ['perDevice', 'total'] : [],
  usage: { total: 0, devices: 0, largestDevice: 0 },
});
const input = (key: 'perDevice' | 'total') => screen.getByTestId(`remote-agent-limit-${key}`) as HTMLInputElement;
const button = (key: 'save' | 'reset') => screen.getByRole('button', { name: `providerShare.runLimits.${key}` }) as HTMLButtonElement;

beforeEach(() => {
  setDataOwnerGeneration('owner-a');
  command.mockReset().mockResolvedValue(view());
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('RemoteAgentLimitsSection', () => {
  it('saves only edited fields, including an explicitly chosen default', async () => {
    render(<RemoteAgentLimitsSection />);
    await waitFor(() => expect(input('perDevice').value).toBe('16'));
    fireEvent.change(input('perDevice'), { target: { value: '32' } });
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ action: 'set-run-limits', limits: { perDevice: 32 } }, undefined));
    await waitFor(() => expect(button('save').disabled).toBe(true));
    fireEvent.change(input('perDevice'), { target: { value: '24' } });
    fireEvent.change(input('perDevice'), { target: { value: '16' } });
    expect(button('save').disabled).toBe(false);
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ action: 'set-run-limits', limits: { perDevice: 16 } }, undefined));
  });

  it('accepts slow reads instead of superseding every response with the next poll', async () => {
    vi.useFakeTimers();
    command.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(view()), 6_000)));
    render(<RemoteAgentLimitsSection deviceId="slow-computer" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(command).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(input('perDevice').value).toBe('16');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(command).toHaveBeenCalledTimes(2);
    expect(input('total').value).toBe('64');
  });
  it('validates both limits, saves on the selected computer and resets its overrides', async () => {
    render(<RemoteAgentLimitsSection deviceId="provider-computer" />);
    await waitFor(() => expect(input('perDevice').value).toBe('16'));
    fireEvent.change(input('perDevice'), { target: { value: '65' } });
    expect(button('save').disabled).toBe(true);
    expect(screen.getByRole('alert').textContent).toBe('providerShare.runLimits.invalid');
    fireEvent.change(input('total'), { target: { value: '100' } });
    command.mockResolvedValueOnce(view(65, 100, true));
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'set-run-limits', limits: { perDevice: 65, total: 100 } }, 'provider-computer'));
    await waitFor(() => expect(button('reset').disabled).toBe(false));
    command.mockResolvedValueOnce(view());
    fireEvent.click(button('reset'));
    await waitFor(() => expect(input('perDevice').value).toBe('16'));
    expect(command).toHaveBeenLastCalledWith({ action: 'reset-run-limits' }, 'provider-computer');
    expect(button('reset').disabled).toBe(true);
  });

  it('refreshes usage without overwriting an unsaved edit', async () => {
    vi.useFakeTimers();
    render(<RemoteAgentLimitsSection />);
    await act(async () => {});
    fireEvent.change(input('perDevice'), { target: { value: '32' } });
    command.mockResolvedValue(view(20, 80, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(command).toHaveBeenCalledTimes(2);
    expect(input('perDevice').value).toBe('32');
    expect(input('total').value).toBe('80');
  });

  it('does not show an old account response after an account switch', async () => {
    let resolve!: (next: ReturnType<typeof view>) => void;
    command.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<RemoteAgentLimitsSection />);
    setDataOwnerGeneration('owner-b');
    await act(async () => { resolve(view(99, 100, true)); });
    expect(screen.queryByTestId('remote-agent-limit-perDevice')).toBeNull();
  });

  // provider-sharing.md §3「闲置收回由提供方决定」：只有设置里带 idleMinutes 的电脑显示这一项；旧版电脑会拒绝
  // 不认识的字段，所以读不到时既不显示也不提交。
  it('edits idle reclaim minutes only on computers that report the setting', async () => {
    const withIdle = (idleMinutes: number, isCustomized = false) => ({
      ...view(), value: { perDevice: 16, total: 64, idleMinutes }, defaults: { perDevice: 16, total: 64, idleMinutes: 30 },
      isCustomized, customizedKeys: isCustomized ? ['idleMinutes'] : [],
    });
    command.mockResolvedValue(withIdle(30));
    render(<RemoteAgentLimitsSection deviceId="provider-computer" />);
    const idle = () => screen.getByTestId('remote-agent-limit-idleMinutes') as HTMLInputElement;
    await waitFor(() => expect(idle().value).toBe('30'));
    fireEvent.change(idle(), { target: { value: '1441' } });
    expect(button('save').disabled).toBe(true);
    expect(screen.getByText('providerShare.runLimits.idleInvalid')).toBeTruthy();
    fireEvent.change(idle(), { target: { value: '' } });
    expect(button('save').disabled).toBe(true);
    fireEvent.change(idle(), { target: { value: '0' } });
    command.mockResolvedValue(withIdle(0, true));
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenCalledWith({ action: 'set-run-limits', limits: { idleMinutes: 0 } }, 'provider-computer'));
    await waitFor(() => expect(idle().value).toBe('0'));
    cleanup();
    command.mockResolvedValue(view());
    render(<RemoteAgentLimitsSection deviceId="old-computer" />);
    await waitFor(() => expect(input('perDevice').value).toBe('16'));
    expect(screen.queryByTestId('remote-agent-limit-idleMinutes')).toBeNull();
    fireEvent.change(input('perDevice'), { target: { value: '20' } });
    fireEvent.click(button('save'));
    await waitFor(() => expect(command).toHaveBeenLastCalledWith({ action: 'set-run-limits', limits: { perDevice: 20 } }, 'old-computer'));
  });

  it('keeps failed edits for retry and shows an unsupported remote computer', async () => {
    render(<RemoteAgentLimitsSection deviceId="old-computer" />);
    await waitFor(() => expect(input('perDevice').value).toBe('16'));
    fireEvent.change(input('perDevice'), { target: { value: '32' } });
    command.mockRejectedValueOnce(new Error('offline'));
    fireEvent.click(button('save'));
    await waitFor(() => expect(button('save').disabled).toBe(false));
    expect(input('perDevice').value).toBe('32');
    cleanup();
    command.mockRejectedValue(new Error('UNSUPPORTED_CAPABILITY'));
    render(<RemoteAgentLimitsSection deviceId="old-computer" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('providerGroup.management.unsupported'));
    expect(screen.queryByTestId('remote-agent-limit-perDevice')).toBeNull();
  });
});
