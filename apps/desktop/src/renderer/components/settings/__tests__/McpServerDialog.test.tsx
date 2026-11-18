// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpServerDialog } from '../McpServerDialog';
import { McpServersSection } from '../McpServersSection';

const api = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), read: vi.fn(), error: vi.fn(), list: vi.fn(), delete: vi.fn(), confirm: vi.fn() }));
vi.mock('@/lib/customMcpServers', () => ({
  createCustomMcpServer: api.create,
  updateCustomMcpServer: api.update,
  readCustomMcpToken: api.read,
  listCustomMcpServers: api.list,
  deleteCustomMcpServer: api.delete,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: api.confirm }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: api.error } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
const initial = {
  id: 'custom_original',
  name: 'Example',
  transport: 'sse' as const,
  url: 'https://example.test/mcp',
  headers: { 'X-Test': 'value' },
};
const field = (name: string) =>
  screen.getByLabelText(`settings.mcp.fields.${name}`) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'settings.mcp.save' });
const cancel = () => screen.getByRole('button', { name: 'settings.mcp.cancel' });
const change = (name: string, value: string) =>
  fireEvent.change(field(name), { target: { value } });
beforeEach(() => {
  vi.clearAllMocks();
  api.create.mockResolvedValue(undefined);
  api.update.mockResolvedValue(undefined);
  api.read.mockResolvedValue(null);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.querySelector('[data-ds6-trigger]')?.remove();
});

// UI regression: an unreadable credential must retain an identifiable, deletable settings row.
// Unit tier drives the real settings section; the IPC/store suites cover actual ciphertext decoding.
it('keeps healthy rows editable and unreadable rows visible with deletion only', async () => {
  api.list.mockResolvedValue({ servers: [initial], unreadableServers: [
    { id: 'broken-local', name: 'Broken local', transport: 'stdio', reason: 'unreadable' },
    { id: 'broken-remote', name: 'Broken remote', transport: 'http', reason: 'unreadable' },
  ] });
  api.confirm.mockResolvedValue(true);
  api.delete.mockResolvedValue(undefined);
  vi.stubGlobal('electronAPI', undefined);
  window.electronAPI = { maker: {
    onMcpChanged: () => () => {},
    listMcpDuplicates: async () => ({ connections: [], complete: true }),
  } } as unknown as typeof window.electronAPI;
  render(<McpServersSection />);
  await screen.findByText('Broken local');
  expect(within(screen.getByRole('group', { name: 'Example' })).getByRole('button', { name: 'settings.mcp.editAria' })).toBeTruthy();
  for (const [name, id] of [['Broken local', 'broken-local'], ['Broken remote', 'broken-remote']]) {
    const row = within(screen.getByRole('group', { name }));
    expect(row.getByText('settings.mcp.unreadable')).toBeTruthy();
    expect(row.queryByRole('button', { name: 'settings.mcp.editAria' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'settings.mcp.deleteAria' }));
    await waitFor(() => expect(api.delete).toHaveBeenLastCalledWith(id));
  }
});

it('retains the last visible settings list on a failed read and offers an explicit retry', async () => {
  const changes = new Set<() => void>();
  api.list.mockResolvedValue({ servers: [initial] });
  vi.stubGlobal('electronAPI', undefined);
  window.electronAPI = { maker: {
    onMcpChanged: (listener: () => void) => { changes.add(listener); return () => changes.delete(listener); },
    listMcpDuplicates: async () => ({ connections: [], complete: true }),
  } } as unknown as typeof window.electronAPI;
  render(<McpServersSection />);
  await screen.findByText('Example');
  api.list.mockRejectedValueOnce(new Error('private-db-detail'));
  await act(async () => { for (const listener of changes) listener(); });
  expect(screen.getByText('Example')).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toContain('settings.mcp.loadFailed');
  expect(document.body.textContent).not.toContain('private-db-detail');
  fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});

it('associates field errors and focuses the first invalid field without sending a request', async () => {
  render(<McpServerDialog onSaved={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(save());
  expect(document.activeElement).toBe(field('name'));
  for (const name of ['name', 'url']) {
    expect(field(name).getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(field(name).getAttribute('aria-describedby')!)?.textContent,
    ).toContain('settings.mcp.errors.');
  }
  expect(api.create).not.toHaveBeenCalled();
  change('name', 'Example');
  change('url', 'file:///tmp/example');
  fireEvent.click(save());
  expect(document.activeElement).toBe(field('url'));
  expect(api.error).not.toHaveBeenCalled();
});

it('preserves create ID, transport, trimmed headers and raw token arguments', async () => {
  const onSaved = vi.fn();
  render(<McpServerDialog existingIds={['custom_example']} onSaved={onSaved} onClose={vi.fn()} />);
  change('name', ' Example ');
  change('url', ' https://example.test/mcp ');
  change('token', ' token ');
  // transport 走共享分段控件(review P2):role=radio 的 radiogroup,不再是独立 button。
  expect(screen.getByRole('radiogroup', { name: 'settings.mcp.fields.transport' })).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: 'sse' }));
  fireEvent.change(screen.getByPlaceholderText('settings.mcp.fields.headerNamePlaceholder'), {
    target: { value: ' X-Test ' },
  });
  fireEvent.change(screen.getByPlaceholderText('settings.mcp.fields.headerValuePlaceholder'), {
    target: { value: ' value ' },
  });
  fireEvent.click(save());
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.create).toHaveBeenCalledWith({ ...initial, id: 'custom_example-2' }, ' token ');
});

it('blocks duplicate submit, Cancel, Escape and outside only while saving, then recovers after failure', async () => {
  let fail!: (error: Error) => void;
  api.update.mockReturnValueOnce(
    new Promise((_, reject) => {
      fail = reject;
    }),
  );
  const onClose = vi.fn(),
    onSaved = vi.fn();
  render(<McpServerDialog initial={initial} onSaved={onSaved} onClose={onClose} />);
  fireEvent.click(save());
  fireEvent.click(save());
  fireEvent.click(cancel());
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  fireEvent.pointerDown(screen.getByRole('dialog').previousElementSibling!);
  expect(api.update).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled();
  expect(save().getAttribute('aria-busy')).toBe('true');
  expect((cancel() as HTMLButtonElement).disabled).toBe(true);
  await act(async () => fail(new Error('Unavailable')));
  expect(api.error).toHaveBeenCalled();
  expect(field('name').value).toBe('Example');
  expect((cancel() as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(save());
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.update).toHaveBeenCalledTimes(2);
});

it('retains existing token when saved before hydration and clears only after a loaded token is emptied', async () => {
  let hydrate!: (value: string) => void;
  api.read.mockReturnValue(
    new Promise<string>((resolve) => {
      hydrate = resolve;
    }),
  );
  api.update.mockRejectedValueOnce(new Error('Retry'));
  render(<McpServerDialog initial={initial} onSaved={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(save());
  await waitFor(() => expect(api.error).toHaveBeenCalled());
  expect(api.update).toHaveBeenLastCalledWith(initial, '', false);
  await act(async () => hydrate('example-secret'));
  expect(field('token').type).toBe('password');
  fireEvent.click(screen.getByRole('button', { name: 'settings.apiKey.showKey' }));
  expect(field('token').type).toBe('text');
  change('token', '');
  fireEvent.click(save());
  await waitFor(() => expect(api.update).toHaveBeenLastCalledWith(initial, '', true));
});

it('keeps header IDs through row deletion and restores the opening control focus on close', async () => {
  const user = userEvent.setup();
  const trigger = document.createElement('button');
  trigger.dataset.ds6Trigger = 'true';
  document.body.append(trigger);
  trigger.focus();
  const { unmount } = render(<McpServerDialog onSaved={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(document.activeElement).toBe(field('name')));
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.fields.addHeader' }));
  const survivor = screen.getAllByPlaceholderText('settings.mcp.fields.headerNamePlaceholder')[1];
  const id = survivor.id;
  await user.click(screen.getByRole('button', { name: 'settings.mcp.fields.removeRow 1' }));
  expect(screen.getByPlaceholderText('settings.mcp.fields.headerNamePlaceholder').id).toBe(id);
  await waitFor(() => expect(document.activeElement).toBe(survivor));
  unmount();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  trigger.remove();
});

it('raises secret eye and remove-row tooltips above the z-10000 modal overlay', async () => {
  const user = userEvent.setup();
  render(<McpServerDialog onSaved={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(document.activeElement).toBe(field('name')));

  // Tip 经 Portal 渲染到 body,默认 z-[60] 会被 z-[10000] 模态层盖住;
  // 弹窗内必须把提示抬到 z-[10001](review P2)。Radix Tooltip 1.2 的
  // role="tooltip" 挂在 Content 内的 sr-only 副本上,带 z class 的可见层
  // 是它的父节点(Popper.Content)。
  const eye = screen.getByRole('button', { name: 'settings.apiKey.showKey' });
  await user.hover(eye);
  const eyeTip = await screen.findByRole('tooltip');
  expect(eyeTip.textContent).toBe('settings.apiKey.showKey');
  expect(eyeTip.parentElement!.className).toContain('z-[10001]');
  // 模态 open 时 Radix 会把 body 置 pointer-events:none,userEvent.unhover 的
  // 交互前检查会拒绝;直接派发 pointerleave 关闭提示(Radix 监听 pointer 事件)。
  fireEvent.pointerLeave(eye);
  await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());

  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.fields.addHeader' }));
  await user.hover(screen.getByRole('button', { name: 'settings.mcp.fields.removeRow 1' }));
  const removeTip = await screen.findByRole('tooltip');
  expect(removeTip.textContent).toBe('settings.mcp.fields.removeRow');
  expect(removeTip.parentElement!.className).toContain('z-[10001]');
});

it('embeds the same Settings form and uses its existing save path with user-edited suggestions', async () => {
  const onSaved = vi.fn();
  render(<McpServerDialog embedded proposal={{ name: 'Suggestion', url: 'http://example.test/mcp?key=public', transport: 'sse' }}
    existingIds={['custom_example']} onSaved={onSaved} onClose={vi.fn()} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(field('name').value).toBe('Suggestion');
  change('name', 'Example');
  change('token', 'test-invalid-token');
  fireEvent.change(screen.getByPlaceholderText('settings.mcp.fields.headerNamePlaceholder'), { target: { value: 'X-Test' } });
  fireEvent.change(screen.getByPlaceholderText('settings.mcp.fields.headerValuePlaceholder'), { target: { value: 'test-invalid-header' } });
  fireEvent.click(save());
  fireEvent.click(save());
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('custom_example-2'));
  expect(api.create).toHaveBeenCalledExactlyOnceWith({ id: 'custom_example-2', name: 'Example', transport: 'sse',
    url: 'http://example.test/mcp?key=public', headers: { 'X-Test': 'test-invalid-header' } }, 'test-invalid-token');
});

// Unit: stdio uses argv without shell parsing and write-only env changes, while remote drafts stay separate.
it('saves stdio suggestions with exact arguments and user-entered environment values', async () => {
  const onSaved = vi.fn();
  render(<McpServerDialog proposal={{ name: 'Grafana', transport: 'stdio', command: 'uvx',
    args: ['mcp-grafana'], envKeys: ['GRAFANA_URL', 'GRAFANA_SERVICE_ACCOUNT_TOKEN'] }}
    onSaved={onSaved} onClose={vi.fn()} />);
  expect(screen.queryByLabelText('settings.mcp.fields.url')).toBeNull();
  change('cwd', '/fixture/work');
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.fields.addArg' }));
  fireEvent.change(screen.getByLabelText('settings.mcp.fields.args 2'), { target: { value: ' a b ' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.fields.addArg' }));
  fireEvent.change(screen.getByLabelText('settings.mcp.fields.envValue 1'), { target: { value: 'https://example.test' } });
  const secret = screen.getByLabelText('settings.mcp.fields.envValue 2') as HTMLInputElement;
  expect(secret.type).toBe('password');
  fireEvent.change(secret, { target: { value: ' test-invalid-token ' } });
  fireEvent.click(save());
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('custom_grafana'));
  expect(api.create).toHaveBeenCalledExactlyOnceWith({ id: 'custom_grafana', name: 'Grafana', transport: 'stdio',
    command: 'uvx', args: ['mcp-grafana', ' a b ', ''], cwd: '/fixture/work',
    envChanges: { set: { GRAFANA_URL: 'https://example.test', GRAFANA_SERVICE_ACCOUNT_TOKEN: ' test-invalid-token ' }, remove: [] } }, '');
  expect(api.read).not.toHaveBeenCalled();
});

it('preserves untouched env, explicitly removes a row and replaces only the edited value', async () => {
  const config = { id: 'custom_stdio', name: 'Local', transport: 'stdio' as const, command: 'uvx',
    args: ['mcp-grafana'], envKeys: ['KEEP', 'REMOVE', 'REPLACE'] };
  api.update.mockRejectedValueOnce(new Error('Retry'));
  render(<McpServerDialog initial={config} onSaved={vi.fn()} onClose={vi.fn()} />);
  expect((screen.getByLabelText('settings.mcp.fields.envValue 1') as HTMLInputElement).value).toBe('');
  fireEvent.click(save());
  await waitFor(() => expect(api.error).toHaveBeenCalled());
  expect(api.update).toHaveBeenLastCalledWith({ id: config.id, name: config.name, command: config.command,
    args: config.args, transport: 'stdio', envChanges: { set: {}, remove: [] } }, '', false);
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.fields.removeEnv 2' }));
  fireEvent.change(screen.getByLabelText('settings.mcp.fields.envValue 2'), { target: { value: 'new-invalid-value' } });
  // Clearing an explicitly changed value means an empty env value, not deletion or fallback to the old value.
  fireEvent.change(screen.getByLabelText('settings.mcp.fields.envValue 2'), { target: { value: '' } });
  fireEvent.click(save());
  await waitFor(() => expect(api.update).toHaveBeenCalledTimes(2));
  expect(api.update.mock.calls[1][0].envChanges).toEqual({ set: { REPLACE: '' }, remove: ['REMOVE'] });
  expect(api.read).not.toHaveBeenCalled();
});

it('validates stdio fields and never sends inactive transport fields', async () => {
  render(<McpServerDialog proposal={{ name: 'Example', transport: 'stdio', envKeys: ['TOKEN', 'TOKEN'] }}
    onSaved={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(save());
  expect(document.activeElement).toBe(field('command'));
  expect(api.create).not.toHaveBeenCalled();
  change('command', 'uvx');
  fireEvent.click(save());
  expect(screen.getByText('settings.mcp.errors.envInvalid')).toBeTruthy();
  expect(api.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: 'http' }));
  change('url', 'https://example.test/mcp');
  fireEvent.click(save());
  await waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  expect(api.create.mock.calls[0][0]).toEqual({ id: 'custom_example', name: 'Example',
    transport: 'http', url: 'https://example.test/mcp', headers: {} });
});
