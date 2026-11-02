// @vitest-environment jsdom
// Unit: production form + original save helper; async snapshots cannot revive a closed form.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpSetupPrompt, useMcpSetupRequest } from '../McpSetupPrompt';
import type { McpSetupRequest } from '../../../../shared/mcpSetup';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const request: McpSetupRequest = { kind: 'mcp_setup', requestId: 'form-1', proposal: { name: 'Example', url: 'https://example.test/mcp' } };
let receive: (value: unknown) => void;
let dismiss: (value: unknown) => void;
const api = {
  listCustomMcpServers: vi.fn(), createCustomMcpServer: vi.fn(), refreshCustomMcpCodex: vi.fn(),
  resolveInteraction: vi.fn(), getPendingInteractions: vi.fn(),
};
const store = vi.fn();
const previousApi = window.electronAPI;

beforeEach(() => {
  vi.clearAllMocks();
  api.listCustomMcpServers.mockResolvedValue({ servers: [] });
  api.createCustomMcpServer.mockResolvedValue({ ok: true });
  api.refreshCustomMcpCodex.mockResolvedValue({ ok: true });
  api.resolveInteraction.mockResolvedValue({ accepted: true });
  api.getPendingInteractions.mockResolvedValue([]);
  store.mockResolvedValue(true);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    maker: { ...api,
      onInteractionRequest: (callback: typeof receive) => { receive = callback; return () => {}; },
      onInteractionDismissed: (callback: typeof dismiss) => { dismiss = callback; return () => {}; },
    }, safeStorageStore: store, safeStorageRemove: vi.fn(async () => true),
  } });
});
afterEach(() => { cleanup(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: previousApi }); });

it('saves through the existing Settings helper and resolves with only the server id', async () => {
  render(<McpSetupPrompt request={request} />);
  const token = await screen.findByLabelText('settings.mcp.fields.token');
  fireEvent.change(token, { target: { value: 'test-invalid-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.save' }));
  await waitFor(() => expect(api.resolveInteraction).toHaveBeenCalledWith('form-1', {
    kind: 'mcp_setup', status: 'saved', serverId: 'custom_example',
  }));
  expect(api.createCustomMcpServer).toHaveBeenCalledWith({ id: 'custom_example', name: 'Example',
    url: 'https://example.test/mcp', transport: 'http', headers: {} });
  expect(store).toHaveBeenCalledWith('mcp_token_custom_example', 'test-invalid-token');
  expect(JSON.stringify(api.resolveInteraction.mock.calls)).not.toContain('test-invalid-token');
});

// Teammates get the tools in this chat on the next message, so they must not see "start a new session".
it.each([
  [true, 'settings.mcp.dialog.teammateDesc', 'settings.mcp.dialog.desc'],
  [false, 'settings.mcp.dialog.desc', 'settings.mcp.dialog.teammateDesc'],
] as const)('teammate=%s shows only its own form hint', async (teammate, shown, hidden) => {
  render(<McpSetupPrompt request={request} teammate={teammate} />);
  expect(await screen.findByText(shown)).toBeTruthy();
  expect(screen.queryByText(hidden)).toBeNull();
});

function Probe({ sessionId = 'task', enabled = true }: { sessionId?: string; enabled?: boolean }) {
  const pending = useMcpSetupRequest(sessionId, enabled);
  return pending ? <McpSetupPrompt key={pending.requestId} request={pending} /> : null;
}

// A lost result must not turn an already saved configuration into another create.
it.each(['saved', 'cancelled'] as const)('retries a failed %s result without saving credentials again', async status => {
  api.resolveInteraction.mockRejectedValueOnce(new Error('test-only IPC failure'));
  render(<McpSetupPrompt request={request} />);
  const token = await screen.findByLabelText('settings.mcp.fields.token');
  if (status === 'saved') fireEvent.change(token, { target: { value: 'test-invalid-token' } });
  fireEvent.click(screen.getByRole('button', { name: status === 'saved' ? 'settings.mcp.save' : 'settings.mcp.cancel' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('settings.mcp.fields.token')).toBeNull();
  let complete!: (value: { accepted: boolean }) => void;
  api.resolveInteraction.mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  const retry = screen.getByRole('button', { name: 'commonUi.retry' });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(api.resolveInteraction).toHaveBeenCalledTimes(2);
  expect(api.resolveInteraction.mock.calls[1]).toEqual(api.resolveInteraction.mock.calls[0]);
  await act(async () => complete({ accepted: true }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.createCustomMcpServer).toHaveBeenCalledTimes(status === 'saved' ? 1 : 0);
  expect(store).toHaveBeenCalledTimes(status === 'saved' ? 1 : 0);
});

it('can cancel result delivery after saving, and retires a request that has already expired', async () => {
  api.resolveInteraction.mockRejectedValueOnce(new Error('test-only lost response'));
  render(<McpSetupPrompt request={request} />);
  await screen.findByLabelText('settings.mcp.fields.token');
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.save' }));
  await screen.findByRole('alert');
  api.resolveInteraction.mockResolvedValueOnce({ accepted: false });
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.cancel' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(api.resolveInteraction).toHaveBeenLastCalledWith(request.requestId, { kind: 'mcp_setup', status: 'cancelled' });
  expect(api.createCustomMcpServer).toHaveBeenCalledOnce();
});

it('ignores other tasks, preserves typed input on repeated metadata, and dismisses the matching form', async () => {
  render(<Probe />);
  await act(async () => {});
  act(() => receive({ sessionId: 'other', request }));
  expect(screen.queryByLabelText('settings.mcp.fields.token')).toBeNull();
  act(() => receive({ sessionId: 'task', request }));
  const token = await screen.findByLabelText('settings.mcp.fields.token');
  fireEvent.change(token, { target: { value: 'test-invalid-token' } });
  act(() => receive({ sessionId: 'task', request: { ...request } }));
  expect((screen.getByLabelText('settings.mcp.fields.token') as HTMLInputElement).value).toBe('test-invalid-token');
  act(() => dismiss({ sessionId: 'task', requestId: 'another-form' }));
  expect(screen.getByLabelText('settings.mcp.fields.token')).toBeTruthy();
  act(() => dismiss({ sessionId: 'task', requestId: 'form-1' }));
  expect(screen.queryByLabelText('settings.mcp.fields.token')).toBeNull();
});

it('does not resurrect a dismissed form from a late recovery snapshot', async () => {
  let complete!: (value: Array<{ request: McpSetupRequest }>) => void;
  api.getPendingInteractions.mockReturnValue(new Promise(resolve => { complete = resolve; }));
  render(<Probe />);
  act(() => dismiss({ sessionId: 'task', requestId: request.requestId }));
  await act(async () => complete([{ request }]));
  expect(screen.queryByLabelText('settings.mcp.fields.token')).toBeNull();
});
