// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { RemoteSection } from '../RemoteSection';
import { parseSelfHostedRelayCommand } from '../../../../shared/selfHostedRelay';

const { t } = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
vi.mock('../RemoteHostDetail', () => ({ RemoteHostDetail: () => null }));
vi.mock('../SshKeySetupDialog', () => ({ SshKeySetupDialog: () => null }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const legacyHost: RemoteHostSnapshot = {
  config: {
    id: '测试服务器',
    hostname: 'example.com',
    port: 22,
    user: 'ubuntu',
    authMethod: 'agent',
    identityFileConfigured: false,
    source: 'manual',
    managedByCindy: true,
  },
  status: 'disconnected',
  statusChangedAt: 0,
  autoConnect: false,
  agentProxy: null,
  agentProxyTunnel: null,
};

async function openForm(hosts: RemoteHostSnapshot[] = []) {
  const add = vi.fn(async () => ({}));
  vi.stubGlobal('electronAPI', {
    remoteSsh: {
      list: async () => ({ hosts }),
      onStatusChanged: () => () => {},
      add,
    },
  });
  // The host bridge lives on window; jsdom shares the global property.
  render(<RemoteSection />);
  await act(async () => {});
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.button.add' }));
  fireEvent.change(screen.getByLabelText('settings.remote.add.hostname'), {
    target: { value: 'example.com' },
  });
  fireEvent.change(screen.getByLabelText('settings.remote.add.user'), {
    target: { value: 'ubuntu' },
  });
  return add;
}

it('explains an SSH alias conflict while keeping the existing edit and remove boundaries', async () => {
  const conflict = { ...legacyHost, config: {
    ...legacyHost.config, id: 'conflict', hostname: 'conflict.example.com',
    managedByCindy: false, managedAliasConflict: true,
  } };
  const external = { ...legacyHost, config: {
    ...legacyHost.config, id: 'external', managedByCindy: false,
  } };
  vi.stubGlobal('electronAPI', {
    remoteSsh: {
      list: async () => ({ hosts: [conflict, legacyHost, external] }),
      onStatusChanged: () => () => {},
    },
  });
  render(<RemoteSection />);
  await act(async () => {});

  expect(screen.getAllByRole('button', { name: 'settings.remote.button.remove' })).toHaveLength(1);
  expect(screen.getAllByText('settings.remote.readOnlyFromSshConfig')).toHaveLength(1);
  expect(screen.getAllByText('settings.remote.managedAliasConflict')).toHaveLength(1);
  const editButtons = screen.getAllByRole('button', { name: 'settings.remote.button.edit' });
  fireEvent.click(editButtons[0]);
  expect((screen.getByDisplayValue('conflict.example.com') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getAllByText('settings.remote.managedAliasConflict')).toHaveLength(2);
  fireEvent.click(editButtons[1]);
  expect((screen.getByDisplayValue('example.com') as HTMLInputElement).disabled).toBe(false);
});

it('keeps the alias rules associated with the input after typing', async () => {
  await openForm();
  const alias = screen.getByLabelText('settings.remote.add.alias');
  fireEvent.change(alias, { target: { value: 'my-server' } });
  const hint = screen.getByText('settings.remote.add.aliasHint');
  expect(alias.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
});

it('blocks unsupported aliases before saving and recovers after correction', async () => {
  const add = await openForm();
  const alias = screen.getByLabelText('settings.remote.add.alias');
  const submit = screen.getByRole('button', { name: 'settings.remote.add.submit' });
  for (const value of [
    '测试服务器',
    'bad host',
    'bad*host',
    'bad?host',
    '[host]',
    '!host',
    'é',
    'a'.repeat(129),
  ]) {
    fireEvent.change(alias, { target: { value } });
    expect(alias.getAttribute('aria-invalid')).toBe('true');
    expect(submit.hasAttribute('disabled')).toBe(true);
    fireEvent.click(submit);
  }
  expect(add).not.toHaveBeenCalled();
  fireEvent.change(alias, { target: { value: 'my-server' } });
  expect(alias.hasAttribute('aria-invalid')).toBe(false);
  expect(submit.hasAttribute('disabled')).toBe(false);
});

it('accepts every supported symbol and length boundary while keeping Chinese display names', async () => {
  const add = await openForm();
  const alias = screen.getByLabelText('settings.remote.add.alias');
  const submit = screen.getByRole('button', { name: 'settings.remote.add.submit' });
  for (const value of ['a', 'A0._@:-', 'a'.repeat(128)]) {
    fireEvent.change(alias, { target: { value } });
    expect(submit.hasAttribute('disabled')).toBe(false);
    expect(parseSelfHostedRelayCommand({ type: 'check-server', sshHostId: value })).not.toBeNull();
  }
  fireEvent.change(alias, { target: { value: 'my-server' } });
  fireEvent.change(screen.getByLabelText('settings.remote.add.displayName'), {
    target: { value: '测试服务器' },
  });
  fireEvent.click(submit);
  await act(async () => {});
  expect(add).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'my-server', displayName: '测试服务器' }),
  );
});

it('keeps an existing Chinese alias editable through its display name', async () => {
  await openForm([legacyHost]);
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.add.cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.remote.button.edit' }));
  const alias = screen.getByLabelText('settings.remote.add.alias');
  expect(alias.hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('settings.remote.add.displayName'), {
    target: { value: '新显示名' },
  });
  expect(
    screen.getByRole('button', { name: 'settings.remote.edit.submit' }).hasAttribute('disabled'),
  ).toBe(false);
  expect(alias.hasAttribute('aria-invalid')).toBe(false);
});

// SSH access to the person's own devices (decision 6): a host Cindy keeps for one of their devices says so
// (「来自我的设备」), adds 「主机指纹已核对」 only where main reports its key pinned (not for every device host), shows
// when it cannot be used, and its connection fields stay read-only in the edit form (main refuses such edits too).
// An ordinary Cindy host is unchanged.
it('labels a host of the person\'s own device, marks it unavailable and keeps its connection read-only', async () => {
  const deviceHost: RemoteHostSnapshot = {
    ...legacyHost,
    config: { ...legacyHost.config, id: 'cindy-studio', hostname: '203.0.113.7', authMethod: 'key', identityFileConfigured: true, deviceHost: true },
    device: { deviceId: 'studio', available: false },
  };
  const pinnedHost: RemoteHostSnapshot = {
    ...deviceHost,
    config: { ...deviceHost.config, id: 'cindy-cloud', hostname: '203.0.113.9' },
    device: { deviceId: 'cloud', available: true },
    hostKeyPinned: true,
  };
  vi.stubGlobal('electronAPI', {
    remoteSsh: { list: async () => ({ hosts: [deviceHost, pinnedHost, legacyHost] }), onStatusChanged: () => () => {} },
  });
  render(<RemoteSection />);
  await act(async () => {});
  expect(screen.getAllByText('settings.remote.fromMyDevice')).toHaveLength(1);
  expect(screen.getAllByText('settings.remote.fromMyDeviceKeyPinned')).toHaveLength(1);
  expect(screen.getAllByText('settings.remote.deviceUnavailable')).toHaveLength(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'settings.remote.button.edit' })[0]!);
  expect((screen.getByDisplayValue('203.0.113.7') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('settings.remote.edit.deviceHostReadOnly')).toBeTruthy();
  expect((screen.getByLabelText('settings.remote.add.displayName') as HTMLInputElement).disabled).toBe(false);
});

// The row of a device host offers its terminal command next to the alias, with the same compact button and feedback
// as the device's card in 我的设备 (spec decision 6, approved mock). Entry: RemoteSection with the host list from the
// bridge; observable: the copy button only on that row, the clipboard text and the toasts. Gap: the device card test
// covers its own button only. Minimal failing input: one device host and one ordinary host. Unit tier (jsdom).
it('copies a device host\'s terminal command from its row, with the device card\'s feedback', async () => {
  const deviceHost: RemoteHostSnapshot = {
    ...legacyHost,
    config: { ...legacyHost.config, id: 'cindy-studio', displayName: 'Studio', hostname: '203.0.113.7', authMethod: 'key', identityFileConfigured: true, deviceHost: true },
    device: { deviceId: 'studio', available: true },
  };
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  const copied = vi.spyOn(toast, 'success');
  const failed = vi.spyOn(toast, 'error');
  vi.stubGlobal('electronAPI', {
    remoteSsh: { list: async () => ({ hosts: [deviceHost, legacyHost] }), onStatusChanged: () => () => {} },
  });
  render(<RemoteSection />);
  await act(async () => {});
  const copy = screen.getAllByRole('button', { name: 'settings.remoteControl.sshAccess.device.copy' });
  expect(copy).toHaveLength(1);
  fireEvent.click(copy[0]!);
  await act(async () => {});
  expect(writeText).toHaveBeenCalledWith('ssh cindy-studio');
  expect(copied).toHaveBeenCalledWith('settings.remoteControl.sshAccess.copied');
  writeText.mockRejectedValueOnce(new Error('clipboard denied'));
  fireEvent.click(copy[0]!);
  await act(async () => {});
  expect(failed).toHaveBeenCalledWith('settings.remoteControl.sshAccess.copyFailed');
});
