// @vitest-environment jsdom
/**
 * 「远程与分享」页的供应商组一块：建组(本机默认在组里)、组内电脑状态、参与分配开关、组策略与自动换电脑。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupView } from '../../../../shared/providerGroup';
import { ProviderGroupRow } from '../ProviderGroupRow';
import { ProviderGroupSection } from '../ProviderGroupSection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
const confirmSpy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: confirmSpy }) }));
// Radix 的浮层要 ResizeObserver,jsdom 里没有;行内「更多操作」菜单只需要验证菜单项的行为,
// 所以把菜单摊平成普通按钮,不去驱动真实的 Radix 开合。
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onClick,
    disabled,
  }: {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

const LOCAL = { key: 'local', kind: 'local' as const, agentDeviceId: null, providerId: 'anthropic', limit: 4, weight: 1, paused: false };
const MINI = {
  key: 'device:mini:anthropic-1a2b3c4d',
  kind: 'device' as const,
  agentDeviceId: 'mini',
  providerId: 'anthropic-1a2b3c4d',
  label: 'Mac mini',
  limit: 4,
  weight: 1,
  paused: false,
};

let stored: ProviderGroupConfig | null = null;
/** 按 member key 覆盖「正在运行」的台数；不设时本机 1、其余 0。 */
let running: Record<string, number> | null = null;
const command = vi.fn();

function viewOf(config: ProviderGroupConfig | null): ProviderGroupView {
  return {
    providerId: 'anthropic',
    config,
    members: (config?.members ?? []).map((m) => ({
      key: m.key,
      kind: m.kind,
      label: m.kind === 'local' ? 'Home Mac Studio' : m.label ?? m.key,
      state: m.paused ? 'paused' : m.kind === 'local' ? 'available' : 'cooling',
      running: running?.[m.key] ?? (m.kind === 'local' ? 1 : 0),
      limit: m.limit,
      weight: m.weight,
      paused: m.paused,
      ...(m.kind === 'local' ? {} : { coolingUntil: Date.UTC(2026, 9, 9, 7, 20) }),
    })),
  };
}

beforeEach(() => {
  stored = null;
  running = null;
  confirmSpy.mockClear();
  command.mockReset();
  command.mockImplementation(async (cmd: { action: string; config?: ProviderGroupConfig }) => {
    if (cmd.action === 'get') return viewOf(stored);
    if (cmd.action === 'candidates') {
      return [
        { key: MINI.key, kind: 'device', agentDeviceId: 'mini', providerId: MINI.providerId, label: 'Mac mini', providerName: 'Claude' },
        { key: 'share:s1:anthropic', kind: 'share', agentDeviceId: 'share:s1', providerId: 'anthropic', label: 'Studio-PC', providerName: 'Anthropic', ownerName: 'Kai', blocked: 'member' },
      ];
    }
    if (cmd.action === 'save') {
      stored = cmd.config ?? null;
      return viewOf(stored);
    }
    if (cmd.action === 'delete') {
      stored = null;
      return viewOf(null);
    }
    throw new Error(`unexpected ${cmd.action}`);
  });
  Object.assign(window, { electronAPI: { providerGroup: { command, onChanged: () => () => undefined } } });
});

afterEach(() => cleanup());

describe('ProviderGroupSection', () => {
  it('creates a group with this computer plus the selected computers', async () => {
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    expect(await screen.findByText(/providerGroup\.section\.empty/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'providerGroup.section.addComputer' }));
    const dialog = await screen.findByTestId('provider-group-add-dialog');
    const candidates = await within(dialog).findAllByTestId('provider-group-candidate');
    expect(candidates).toHaveLength(2);
    // 已在组里的不能再勾选。
    expect((candidates[1] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(candidates[0]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'providerGroup.add.confirm' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.objectContaining({ action: 'save' })));
    const saved = command.mock.calls.find(([cmd]) => cmd.action === 'save')![0].config as ProviderGroupConfig;
    expect(saved.members.map((m) => m.key)).toEqual(['local', MINI.key]);
    expect(saved).toMatchObject({ strategy: 'least', autoSwitch: true });
    expect(await screen.findAllByTestId('provider-group-member')).toHaveLength(2);
  });

  it('shows each computer with its state and lets the user pause one', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    expect(rows[0].getAttribute('data-member-state')).toBe('available');
    // 运行数在状态行，上限只在下拉里：同一个数字不出现两次。
    expect(within(rows[0]).getByText('providerGroup.member.runningCount:{"count":1}')).toBeTruthy();
    expect(within(rows[0]).getByText('providerGroup.member.limitOption:{"count":4}')).toBeTruthy();
    expect(within(rows[1]).queryByText(/providerGroup\.member\.runningCount/)).toBeNull();
    expect(rows[1].getAttribute('data-member-state')).toBe('cooling');
    expect(within(rows[1]).getByText(/providerGroup\.member\.status\.coolingUntil/)).toBeTruthy();
    // 本机与远程共用同一个开关；本机不能移出组。
    expect(within(rows[0]).getByRole('switch')).toBeTruthy();
    expect(within(rows[0]).queryByRole('button', { name: 'providerGroup.member.remove' })).toBeNull();
    fireEvent.click(
      within(rows[1]).getByRole('switch', { name: 'providerGroup.member.assignAria:{"name":"Mac mini"}' }),
    );
    await waitFor(() => expect(stored?.members[1].paused).toBe(true));
  });

  it('says idle instead of staying silent when a computer is available with nothing running', async () => {
    running = { local: 0 };
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    // 每行都要报负载：跑 0 个时说「空闲」，不是什么都不显示。
    expect(within(rows[0]).getByText('providerGroup.member.status.idle')).toBeTruthy();
    expect(within(rows[0]).queryByText(/providerGroup\.member\.runningCount/)).toBeNull();
  });

  it('changes the group strategy and turns automatic switching off', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    await screen.findAllByTestId('provider-group-member');
    fireEvent.click(screen.getByRole('radio', { name: 'providerGroup.strategy.round' }));
    await waitFor(() => expect(stored?.strategy).toBe('round'));
    fireEvent.click(screen.getByRole('switch', { name: 'providerGroup.autoSwitch.label' }));
    await waitFor(() => expect(stored?.autoSwitch).toBe(false));
  });

  it('removes a computer after confirmation', async () => {
    stored = { strategy: 'least', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupSection providerId="anthropic" providerName="Anthropic" />);
    const rows = await screen.findAllByTestId('provider-group-member');
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'providerGroup.member.remove' }));
    await waitFor(() => expect(stored?.members.map((m) => m.key)).toEqual(['local']));
    expect(confirmSpy).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }));
  });
});

describe('ProviderGroupRow', () => {
  it('summarizes the group or offers to set one up', async () => {
    const onOpen = vi.fn();
    const { unmount } = render(<ProviderGroupRow providerId="anthropic" onOpen={onOpen} />);
    expect(await screen.findByRole('button', { name: 'providerGroup.row.setUp' })).toBeTruthy();
    unmount();
    stored = { strategy: 'order', autoSwitch: true, members: [LOCAL, MINI] };
    render(<ProviderGroupRow providerId="anthropic" onOpen={onOpen} />);
    fireEvent.click(await screen.findByRole('button', { name: 'providerGroup.row.manage' }));
    expect(onOpen).toHaveBeenCalled();
    expect(screen.getByTestId('provider-group-summary').textContent).toContain('"count":2');
  });
});
