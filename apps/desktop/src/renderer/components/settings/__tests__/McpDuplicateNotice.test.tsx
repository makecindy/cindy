// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { McpDuplicateNotice } from '../McpDuplicateNotice';
import type { McpDuplicateChoice, McpDuplicateReport } from '@/../shared/customMcp';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
const choiceName = (choice: McpDuplicateChoice) => choice === 'both' ? /settings.mcp.duplicates.keep.both/
  : new RegExp('settings.mcp.duplicates.keep(This|These).*' + (choice === 'cindy' ? 'Cindy' : 'Claude Code'));
// #8902, unit/jsdom: the real notice must never decide for the user. Existing
// dialog tests cover editing a connection, not resolving duplicate sources.
function setup() {
  const report: McpDuplicateReport = { complete: true, connections: [{
    id: 'a'.repeat(64), cindyId: 'custom_magpie', cindyName: 'Magpie', claudeName: 'magpie',
    origin: 'http://localhost:3425', reason: 'similar',
  }] };
  const choose = vi.fn(async ({ id, choice }: { id: string; choice: McpDuplicateChoice | null }) => {
    report.connections.find(pair => pair.id === id)!.choice = choice ?? undefined;
  });
  const list = vi.fn(async () => structuredClone(report));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
    listMcpDuplicates: list, chooseMcpDuplicate: choose, onMcpChanged: () => () => {},
  } } });
  return { report, choose, list };
}
it.each(['cindy', 'claude', 'both'] as const)('waits for an explicit %s choice, then lets the user reset it', async choice => {
  const api = setup(); render(<McpDuplicateNotice />);
  const button = await screen.findByRole('button', { name: choiceName(choice) });
  expect(api.choose).not.toHaveBeenCalled();
  fireEvent.click(button);
  await screen.findByText(`settings.mcp.duplicates.selected.${choice}`);
  expect(api.choose).toHaveBeenCalledWith({ id: 'a'.repeat(64), choice });
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp.duplicates.reset' }));
  await screen.findByRole('button', { name: choiceName(choice) });
  expect(api.choose).toHaveBeenLastCalledWith({ id: 'a'.repeat(64), choice: null });
});

// User feedback: one-pair coverage missed ambiguous actions with multiple MCPs.
// Unit/jsdom: choosing/resetting the second named group must leave the first untouched.
it('binds each action and saved result to its named connection group', async () => {
  const api = setup();
  api.report.connections.push({ ...api.report.connections[0]!, id: 'b'.repeat(64),
    cindyId: 'custom_github', cindyName: 'GitHub', claudeName: 'github', origin: 'https://github.test' });
  render(<McpDuplicateNotice />);
  const magpie = within(await screen.findByRole('group', { name: /Magpie/ }));
  const github = within(screen.getByRole('group', { name: /GitHub/ }));
  fireEvent.click(github.getByRole('button', { name: choiceName('claude') }));
  await github.findByText('settings.mcp.duplicates.selected.claude');
  expect(api.choose).toHaveBeenCalledWith({ id: 'b'.repeat(64), choice: 'claude' });
  expect(magpie.queryByRole('status')).toBeNull();
  expect(magpie.getByRole('button', { name: choiceName('claude') })).toBeTruthy();
  fireEvent.click(github.getByRole('button', { name: 'settings.mcp.duplicates.reset' }));
  await github.findByRole('button', { name: choiceName('claude') });
  expect(api.choose).toHaveBeenLastCalledWith({ id: 'b'.repeat(64), choice: null });
});

it('shows every affected connection in one card when duplicate pairs overlap', async () => {
  const api = setup();
  api.report.connections.push({ ...api.report.connections[0]!, id: 'b'.repeat(64),
    cindyId: 'custom_magpie_extra', cindyName: 'Magpie Extra' });
  render(<McpDuplicateNotice />);
  const group = within(await screen.findByRole('group', { name: /Magpie/ }));
  expect(screen.getAllByRole('group')).toHaveLength(1);
  expect(group.getByText('Magpie Extra')).toBeTruthy();
  expect(group.getByText('custom_magpie_extra')).toBeTruthy();
  expect(group.getByRole('button', { name: /keepThese.*Cindy.*Magpie.*Magpie Extra/ }).textContent)
    .toBe('settings.mcp.duplicates.keepThese');
  expect(group.getAllByRole('button')).toHaveLength(3);
});
it('shows a save failure only in the affected group and keeps its choices available', async () => {
  const api = setup(); api.choose.mockRejectedValue(new Error('changed'));
  api.report.connections.push({ ...api.report.connections[0]!, id: 'b'.repeat(64),
    cindyId: 'custom_github', cindyName: 'GitHub', claudeName: 'github', origin: 'https://github.test' });
  render(<McpDuplicateNotice />);
  const github = within(await screen.findByRole('group', { name: /GitHub/ }));
  fireEvent.click(github.getByRole('button', { name: choiceName('cindy') }));
  expect((await github.findByRole('alert')).textContent).toContain('saveFailed');
  expect(within(screen.getByRole('group', { name: /Magpie/ })).queryByRole('alert')).toBeNull();
  await waitFor(() => expect((github.getByRole('button', { name: choiceName('cindy') }) as HTMLButtonElement).disabled).toBe(false));
});
it('reports unreadable configuration instead of claiming no duplicates', async () => {
  const api = setup(); api.list.mockResolvedValue({ complete: false, connections: [] });
  render(<McpDuplicateNotice />);
  expect((await screen.findByRole('status')).textContent).toContain('unavailable');
  expect(api.choose).not.toHaveBeenCalled();
});

// PR #9055, unit/jsdom: a save rejected for stale credentials refreshes the ID or
// removes the group; unlike a plain rejection, this must not erase the visible error.
it.each(['changed', 'removed'] as const)('keeps the save failure visible after the connection is %s', async state => {
  const api = setup();
  api.choose.mockImplementation(async () => {
    if (state === 'changed') api.report.connections[0]!.id = 'c'.repeat(64);
    else api.report.connections = [];
    throw new Error('stale');
  });
  render(<McpDuplicateNotice />);
  fireEvent.click(await screen.findByRole('button', { name: choiceName('claude') }));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  if (state === 'changed') {
    await waitFor(() => expect((screen.getByRole('button', { name: choiceName('claude') }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(screen.getByRole('group', { name: /Magpie/ })).getByRole('alert').textContent).toContain('saveFailed');
  } else {
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
    expect(screen.getByRole('alert').textContent).toContain('Magpie');
    expect(screen.getByRole('alert').textContent).toContain('saveFailed');
  }
});
