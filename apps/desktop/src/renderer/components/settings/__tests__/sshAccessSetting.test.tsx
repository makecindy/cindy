// @vitest-environment jsdom
import { cloneElement, type ReactElement } from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SSH_ACCESS_MAX_MANUAL_KEYS,
  type SshAccessLocalState,
  type SshAccessSessionCleanup,
  type SshDeviceHostView,
} from '../../../../shared/sshAccess';
import { SSHD_INSTALL_COMMAND, SshAccessSetting } from '../SshAccessSetting';
import { SshDeviceHostRow, useSshDeviceHosts } from '../SshDeviceHostRow';

// 测试价值
// - 生产入口与可观察结果：SshAccessSetting（「这台电脑」卡片里的 SSH 访问）与 SshDeviceHostRow / useSshDeviceHosts
//   （其它设备卡片上的 SSH 一行），经 window.electronAPI.sshAccess / sshDeviceHosts 与真实组件交互；断言用户看到的
//   文案 key、发出的 IPC 操作、确认框与结果提示。
// - Bug／规则依据：spec 决定 3、5、11（位置与内容、恢复默认、移除设备 = 撤销远程访问且确认框写明、手动公钥直接移除、
//   添加公钥的校验错误与上限、断开全部会话先确认再报告数量、macOS 只给指引、Linux 给可复制命令且不执行 sudo；只有 Linux
//   且不以 root 运行时能断开被撤销设备自己的会话，其他情况确认框不承诺断开）；spec 决定 6（其它设备卡片：终端命令、
//   连接、「添加到 SSH 远程主机」、需要更新、暂不可用，被对方阻断时写明对方给出的原因）；DESIGN §11.1（失败提示说明
//   哪项操作没完成）；engineering-conventions §8.6（变化通知期间只读一次、待读一笔）。
// - 现有覆盖缺口：新组件；主进程测试只覆盖 IPC 与状态，不覆盖哪些状态出现哪些按钮、确认框说什么。
// - 最小失败输入：不支持的电脑仍显示开关；移除设备没有确认就撤销；不能按设备断开会话时（macOS、Linux 上以 root
//   运行）确认框仍写会话会被断开；没断开任何会话时提示「已断开 0 个」；有会话没断开时只给 1.2 秒的成功提示；
//   校验失败后弹窗关闭；断开会话不报告数量；连续通知触发多次读取；用户删过的主机仍显示「连接」；连接失败直接显示
//   主进程的英文原始错误；对方 Mac 关了「远程登录」或原因未知时卡片仍写「对方的 SSH 服务没有运行」；添加公钥到上限时
//   弹窗写「稍后重试」。
// - tier：unit（jsdom，宿主接口为内存 fake，单独运行约 3 秒）。各语言的真实句间空格见 sshAccessSetting.i18n.test.tsx。
const { t, toast } = vi.hoisted(() => ({
  t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
  // Renders the key, then the string's <command> element holding the interpolated command.
  Trans: ({ i18nKey, values, components }: {
    i18nKey: string;
    values: { command: string };
    components: { command: ReactElement };
  }) => <>{i18nKey}{cloneElement(components.command, undefined, values.command)}</>,
}));
vi.mock('@/lib/toast', () => ({ toast }));

const FP = 'SHA256:9fQ2abcdefghijklmnopqrstuvwxyz0123456789k1Zc';
const base: SshAccessLocalState = {
  supported: true, remoteControlEnabled: true, setting: true, defaultSetting: true, customized: false, cloudGuest: true,
  enabled: true, blocked: null, endpoint: null, recordUnreadable: false, lastSessionCleanup: null, endsDeviceSessions: true,
  devices: [{ deviceId: 'studio', deviceName: 'Studio Mac', fingerprint: 'SHA256:x', enrolledAt: Date.now(), active: true }],
  manualKeys: [{ fingerprint: FP, label: '办公室服务器', addedAt: 1, active: true }],
};

function stubApi(state: SshAccessLocalState, overrides: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>();
  const api = {
    read: vi.fn(async () => state),
    setEnabled: vi.fn(async (enabled: boolean) => ({ ...state, setting: enabled, customized: true })),
    restoreDefault: vi.fn(async () => ({ ...state, setting: state.defaultSetting, customized: false })),
    addKey: vi.fn(async () => ({ state, fingerprint: FP })),
    removeKey: vi.fn(async () => ({ ...state, manualKeys: [] })),
    removeDevice: vi.fn(async (): Promise<{ state: SshAccessLocalState; revoked: boolean; sessions: SshAccessSessionCleanup | null }> => (
      { state: { ...state, devices: [] }, revoked: true, sessions: { at: 1, supported: true, terminated: 2, unmapped: 1 } })),
    endAllSessions: vi.fn(async () => ({ state, sessions: { at: 1, supported: true, terminated: 3, unmapped: 0 } })),
    onChanged: vi.fn((callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); }),
    ...overrides,
  };
  Object.assign(window, { electronAPI: { sshAccess: api } });
  return { api, notify: () => { for (const listener of listeners) listener(); } };
}

async function renderSetting() {
  const view = render(<SshAccessSetting selfName="VM-4-7-ubuntu" selfDeviceId="abc" deviceNames={new Map()} />);
  await act(async () => {});
  return view;
}

beforeEach(() => { toast.success.mockReset(); toast.warning.mockReset(); toast.error.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('SshAccessSetting (this computer)', () => {
  it('stays hidden where this computer cannot accept SSH (Windows, managed cloud instance)', async () => {
    stubApi({ ...base, supported: false });
    const view = await renderSetting();
    expect(view.container.innerHTML).toBe('');
  });

  it('shows the switch, the alias other devices use and the list, and restores the default', async () => {
    const { api } = stubApi({ ...base, setting: false, customized: true });
    await renderSetting();
    expect(screen.getByText('settings.defaults.customizedBadge')).toBeTruthy();
    // One string joins the description and this computer's default, so each language decides the space between them.
    expect(screen.getByText(
      'settings.remoteControl.sshAccess.descriptionWithDefault {"description":"settings.remoteControl.sshAccess.description",'
      + '"defaultNote":"settings.remoteControl.sshAccess.defaultOn"}',
    )).toBeTruthy();
    expect(screen.queryByText(/settings\.remoteControl\.sshAccess\.listHeading/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.defaults.restore' }));
    await act(async () => {});
    expect(api.restoreDefault).toHaveBeenCalledOnce();
    expect(screen.queryByText('settings.defaults.customizedBadge')).toBeNull();
    // The command sits inside the translated sentence, not after a space the component adds.
    const command = screen.getByText('ssh cindy-vm-4-7-ubuntu');
    expect(command.tagName).toBe('CODE');
    expect(command.parentElement?.textContent).toBe('settings.remoteControl.sshAccess.aliasIntrossh cindy-vm-4-7-ubuntu');
    expect(screen.getByText('settings.remoteControl.sshAccess.listHeading {"count":2}')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'settings.remoteControl.sshAccess.title' }));
    await act(async () => {});
    expect(api.setEnabled).toHaveBeenCalledWith(false);
  });

  it('guides macOS to Remote Login without a command, and gives Linux a copyable install command', async () => {
    stubApi({ ...base, blocked: 'REMOTE_LOGIN_OFF' });
    await renderSetting();
    expect(screen.getByText('settings.remoteControl.sshAccess.blocked.REMOTE_LOGIN_OFF')).toBeTruthy();
    expect(screen.queryByText(SSHD_INSTALL_COMMAND)).toBeNull();
    cleanup();

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    stubApi({ ...base, blocked: 'SSHD_UNREACHABLE' });
    await renderSetting();
    expect(screen.getByText('settings.remoteControl.sshAccess.blocked.SSHD_UNREACHABLE')).toBeTruthy();
    expect(screen.getByText(SSHD_INSTALL_COMMAND)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.sshAccess.copyCommand' }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(SSHD_INSTALL_COMMAND);
  });

  it('revokes a device only after a confirmation that says remote control goes too, and removes a manual key directly', async () => {
    const { api } = stubApi(base);
    await renderSetting();
    const removeButtons = screen.getAllByRole('button', { name: 'settings.remoteControl.sshAccess.remove' });
    expect(screen.getByText('Studio Mac')).toBeTruthy();
    expect(screen.getByText('settings.remoteControl.sshAccess.manualMeta {"fingerprint":"SHA256:9fQ2…k1Zc"}')).toBeTruthy();

    fireEvent.click(removeButtons[0]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('settings.remoteControl.sshAccess.removeDeviceConfirm.body {"name":"Studio Mac"}')).toBeTruthy();
    expect(api.removeDevice).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.remoteControl.revokeConfirm.confirm' }));
    await act(async () => {});
    expect(api.removeDevice).toHaveBeenCalledWith('studio');
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.remoteControl.sshAccess.remove' })[0]!);
    await act(async () => {});
    expect(api.removeKey).toHaveBeenCalledWith(FP);
  });

  // Ending one device's sessions needs each session's key: Linux, and never as root (sessionTerminator.ts). Main reports
  // that capability as endsDeviceSessions; the confirmation follows it, and the result toast follows what happened.
  it.each([
    ['ends them here, some ended', true, { at: 1, supported: true, terminated: 2, unmapped: 0 },
      'body', 'success', 'deviceRemovedSessionsEnded {"name":"Studio Mac","count":2}'],
    ['ends them here, some left running', true, { at: 1, supported: true, terminated: 2, unmapped: 1 },
      'body', 'warning', 'deviceRemovedSessionsLeft {"name":"Studio Mac","count":2,"unmapped":1}'],
    ['ends them here, none open', true, { at: 1, supported: true, terminated: 0, unmapped: 0 },
      'body', 'success', 'deviceRemoved {"name":"Studio Mac"}'],
    ['cannot end them here (macOS, or root on Linux)', false, { at: 1, supported: false, terminated: 0, unmapped: 0 },
      'bodyKeepsSessions', 'success', 'deviceRemovedSessionsKept {"name":"Studio Mac"}'],
  ] as const)('says what becomes of a revoked device\'s SSH sessions: %s', async (_case, endsDeviceSessions, sessions, body, variant, message) => {
    const state = { ...base, endsDeviceSessions };
    stubApi(state, { removeDevice: vi.fn(async () => ({ state: { ...state, devices: [] }, revoked: true, sessions })) });
    await renderSetting();
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.remoteControl.sshAccess.remove' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(`settings.remoteControl.sshAccess.removeDeviceConfirm.${body} {"name":"Studio Mac"}`)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.remoteControl.revokeConfirm.confirm' }));
    await act(async () => {});
    expect(toast[variant]).toHaveBeenCalledOnce();
    expect(toast[variant].mock.calls[0]![0]).toBe(`settings.remoteControl.sshAccess.${message}`);
  });

  it('names the operation that did not finish', async () => {
    stubApi(base, {
      setEnabled: vi.fn(async () => { throw new Error('[PRECONDITION_FAILED] the SSH access record is unreadable'); }),
      removeKey: vi.fn(async () => { throw new Error('[INTERNAL] authorized keys could not be written'); }),
    });
    await renderSetting();
    fireEvent.click(screen.getByRole('switch', { name: 'settings.remoteControl.sshAccess.title' }));
    await act(async () => {});
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.remoteControl.sshAccess.remove' })[1]!);
    await act(async () => {});
    expect(toast.error.mock.calls.map(([message]) => message)).toEqual([
      'settings.remoteControl.sshAccess.toggleFailed',
      'settings.remoteControl.sshAccess.removeKeyFailed',
    ]);
  });

  it('keeps the add-key dialog open with the reason when the key is refused, and closes it once added', async () => {
    const refused = Object.assign(new Error('[INVALID_PARAMS] only a single ssh-ed25519 public key line'), { code: 'INVALID_PARAMS' });
    const { api } = stubApi(base);
    api.addKey.mockRejectedValueOnce(refused);
    await renderSetting();
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.sshAccess.addKey' }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByLabelText('settings.remoteControl.sshAccess.addKeyDialog.keyField');
    fireEvent.change(field, { target: { value: 'ssh-rsa AAAA' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.remoteControl.sshAccess.addKeyDialog.submit' }));
    await act(async () => {});
    expect(within(dialog).getByText('settings.remoteControl.sshAccess.addKeyErrors.INVALID_PARAMS')).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.change(field, { target: { value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7' } });
    fireEvent.change(within(dialog).getByLabelText('settings.remoteControl.sshAccess.addKeyDialog.noteField'), { target: { value: ' 办公室 ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.remoteControl.sshAccess.addKeyDialog.submit' }));
    await act(async () => {});
    expect(api.addKey).toHaveBeenLastCalledWith('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7', '办公室');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('settings.remoteControl.sshAccess.addedKey');
  });

  it('says the limit was reached when every added key is in use, rather than "try again later"', async () => {
    const { api } = stubApi(base);
    api.addKey.mockRejectedValueOnce(new Error('[SSH_ACCESS_KEY_LIMIT] too many keys: at most 32 added public keys'));
    await renderSetting();
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.sshAccess.addKey' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('settings.remoteControl.sshAccess.addKeyDialog.keyField'), {
      target: { value: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJfYPtO9L0UmsOJcs+BJ3iMNHFGtQIONiQHLRdZfuvr7' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.remoteControl.sshAccess.addKeyDialog.submit' }));
    await act(async () => {});
    expect(within(dialog).getByText(`settings.remoteControl.sshAccess.addKeyErrors.SSH_ACCESS_KEY_LIMIT {"max":${SSH_ACCESS_MAX_MANUAL_KEYS}}`)).toBeTruthy();
  });

  it('ends all SSH sessions only after confirming, then reports how many ended', async () => {
    const { api } = stubApi(base);
    await renderSetting();
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.sshAccess.endSessions' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(api.endAllSessions).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'settings.remoteControl.sshAccess.endSessionsConfirm.action' }));
    await act(async () => {});
    expect(api.endAllSessions).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('settings.remoteControl.sshAccess.sessionsEnded {"count":3}');
  });

  it('reads once per burst of change notices while a read is in flight', async () => {
    let finish!: () => void;
    const { api, notify } = stubApi(base);
    await renderSetting();
    api.read.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(base); }));
    notify();
    notify();
    notify();
    expect(api.read).toHaveBeenCalledTimes(2);
    await act(async () => { finish(); });
    expect(api.read).toHaveBeenCalledTimes(3);
  });
});

describe('SSH on another device\'s card (this computer as controller)', () => {
  const view = (state: SshDeviceHostView['state'], extra: Partial<SshDeviceHostView> = {}): SshDeviceHostView => ({
    deviceId: 'cloud', alias: 'cindy-studio-cloud', hostId: 'cindy-studio-cloud', state, reason: null, blocked: null, ...extra,
  });

  it.each([
    ['ready', view('ready'), { command: true, connect: true, restore: false, note: null }],
    ['unavailable', view('unavailable', { reason: 'revoked' }), { command: true, connect: false, restore: false, note: 'settings.remoteControl.sshAccess.device.unavailable.revoked' }],
    ['user-deleted', view('user-deleted', { hostId: null }), { command: false, connect: false, restore: true, note: 'settings.remoteControl.sshAccess.device.userDeleted' }],
    ['needs-update', view('needs-update', { alias: null, hostId: null }), { command: false, connect: false, restore: false, note: 'settings.remoteControl.sshAccess.device.needsUpdate' }],
  ] as const)('%s', async (_state, row, expected) => {
    const restore = vi.fn(async () => undefined);
    render(<SshDeviceHostRow view={row} name="Studio Cloud" onRestore={restore} />);
    expect(!!screen.queryByText('ssh cindy-studio-cloud')).toBe(expected.command);
    expect(!!screen.queryByRole('button', { name: 'settings.remoteControl.sshAccess.device.copy' })).toBe(expected.command);
    expect(!!screen.queryByRole('button', { name: 'settings.remoteControl.sshAccess.device.connect' })).toBe(expected.connect);
    const restoreButton = screen.queryByRole('button', { name: 'settings.remoteControl.sshAccess.device.restore' });
    expect(!!restoreButton).toBe(expected.restore);
    if (expected.note) expect(screen.getByText(expected.note)).toBeTruthy();
    if (restoreButton) {
      fireEvent.click(restoreButton);
      await act(async () => {});
      expect(restore).toHaveBeenCalledWith('cloud');
      // Adding it back can fail; the toast says what did not happen, for which device.
      restore.mockRejectedValueOnce(new Error('[INTERNAL] SSH device hosts request failed'));
      fireEvent.click(restoreButton);
      await act(async () => {});
      expect(toast.error).toHaveBeenCalledWith('settings.remoteControl.sshAccess.device.restoreFailed {"name":"Studio Cloud"}');
    }
  });

  // A device that blocks SSH says why; no reason, or one this build does not know, reads neutrally instead of guessing.
  it.each([
    ['SSHD_UNREACHABLE', 'SSHD_UNREACHABLE'],
    ['REMOTE_LOGIN_OFF', 'REMOTE_LOGIN_OFF'],
    ['AUTHORIZED_KEYS_UNSUPPORTED', 'AUTHORIZED_KEYS_UNSUPPORTED'],
    ['PLATFORM_UNSUPPORTED', 'PLATFORM_UNSUPPORTED'],
    ['UNKNOWN', 'UNKNOWN'],
    [null, 'UNKNOWN'],
  ] as const)('a device that blocks SSH with %s says so on its card', (blocked, note) => {
    render(<SshDeviceHostRow view={view('unavailable', { reason: 'blocked', blocked })} name="Studio Cloud" onRestore={vi.fn()} />);
    expect(screen.getByText(`settings.remoteControl.sshAccess.device.unavailable.blocked.${note}`)).toBeTruthy();
  });

  it('connects through the SSH host list and reads the device hosts once per notice burst', async () => {
    const connect = vi.fn(async () => ({ host: null }));
    const listeners = new Set<() => void>();
    const read = vi.fn(async () => [view('ready')]);
    Object.assign(window, { electronAPI: {
      remoteSsh: { connect },
      sshDeviceHosts: { read, restore: vi.fn(), onChanged: (callback: () => void) => { listeners.add(callback); return () => listeners.delete(callback); } },
    } });
    render(<SshDeviceHostRow view={view('ready')} name="Studio Cloud" onRestore={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.sshAccess.device.connect' }));
    await act(async () => {});
    expect(connect).toHaveBeenCalledWith('cindy-studio-cloud');
    expect(toast.success).toHaveBeenCalledWith('settings.remoteControl.sshAccess.device.connected {"name":"Studio Cloud"}');
    // A failure reads like one in the SSH host list: translated, not main's English message.
    connect.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] host is not configured'));
    fireEvent.click(screen.getByRole('button', { name: 'settings.remoteControl.sshAccess.device.connect' }));
    await act(async () => {});
    expect(toast.error).toHaveBeenCalledWith('ipcError.PRECONDITION_FAILED');

    const hook = renderHook(() => useSshDeviceHosts(true));
    await act(async () => {});
    expect(hook.result.current.hosts.get('cloud')?.state).toBe('ready');
    expect(read).toHaveBeenCalledOnce();
    for (const listener of listeners) listener();
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    hook.unmount();
    expect(listeners.size).toBe(0);
  });
});
