// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { TaskMoveSubmenu, moveRemoteTaskProject } from '../TaskMoveSubmenu';
const h = vi.hoisted(() => ({ request: vi.fn(), invoke: vi.fn(), merge: vi.fn(), destination: vi.fn(), browse: vi.fn(), list: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: {
  captureSessionRead: () => Object.assign(() => true, { mergeActivity: (row: unknown) => row }),
  getDeviceName: () => 'Source Mac', mergeDeviceSessions: h.merge,
} }));
const session = { id: 'task', title: 'Task', status: 'active', workspaceKind: 'project', workingDir: '/source/current', deviceLinkDeviceId: 'A' } as Session;
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('owner');
  h.list.mockResolvedValue({ devices: ['A', 'B', 'offline', 'local'].map(deviceId => ({ deviceId, name: deviceId,
    online: deviceId !== 'offline', isSelf: deviceId === 'local', controlEnabled: true, remoteControlEnabled: true, platform: 'darwin' })) });
  h.request.mockImplementation(async (device, command) => ({ supported: true, deviceId: device ?? 'local',
    ...(command.action === 'caps' ? { projects: ['/destination/project'] } : { projectMove: { sessionId: 'task', workingDir: command.workingDir, workspaceKind: 'project' } }) }));
  h.invoke.mockImplementation(async (_device, channel) => channel === 'local-db:recent-workdirs:list'
    ? [{ path: '/source/current', lastUsedAt: '' }, { path: '/source/another', lastUsedAt: '' }]
    : { ...session, workingDir: '/source/another' });
  Object.assign(window, { electronAPI: { deviceLink: { taskMigration: h.request, invoke: h.invoke, listDevices: h.list } } });
});
afterEach(cleanup);
async function mount(task = session) {
  render(
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>More</DropdownMenuTrigger>
      <DropdownMenuContent>
        <TaskMoveSubmenu
          session={task}
          disabled={false}
          localProjects={null}
          onMigration={h.destination}
          onBrowseRemote={h.browse}
        />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
  fireEvent.keyDown(
    screen.getByRole('menuitem', { name: 'ccAgent.sidebar.sessionMenu.moveToProject' }),
    { key: 'ArrowRight' },
  );
  await screen.findByRole('menuitem', { name: /another/ });
}
it('moves a remote task to a project on its source computer using the host business action', async () => {
  await mount();
  expect(screen.getByRole('menuitem', { name: /current\/source\/current/ }).getAttribute('aria-disabled')).toBe('true');
  fireEvent.click(screen.getByRole('menuitem', { name: /another/ }));
  await waitFor(() => expect(h.request).toHaveBeenCalledWith('A', { action: 'move-project', sessionId: 'task', workingDir: '/source/another' }));
  await waitFor(() => expect(h.merge).toHaveBeenCalledWith('A', 'Source Mac', [expect.objectContaining({ workingDir: '/source/another' })]));
});
it('opens the source folder picker and hides offline devices', async () => {
  await mount();
  expect(screen.queryByRole('menuitem', { name: 'A' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /offline/ })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'ccAgent.sidebar.sessionMenu.browseProjectFolder' }));
  expect(h.browse).toHaveBeenCalledOnce(); expect(h.request).not.toHaveBeenCalled();
});
it('selects a computer project directly and supports moving back to the controller', async () => {
  await mount();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'localsettings.devices.thisDevice' }), { key: 'ArrowRight' });
  fireEvent.click(await screen.findByRole('menuitem', { name: /project\/destination\/project/ }));
  expect(h.request).toHaveBeenCalledWith(null, { action: 'caps' });
  expect(h.destination).toHaveBeenCalledWith({ deviceId: 'local', deviceName: 'local', isSelf: true, project: '/destination/project' });
  expect(h.request.mock.calls.some(([, command]) => command.action === 'start')).toBe(false);
});
it('does not merge a move response into a different account', async () => {
  h.request.mockImplementationOnce(async () => {
    setDataOwnerGeneration('different-owner');
    return { projectMove: { sessionId: 'task' } };
  });
  await moveRemoteTaskProject(session, null);
  expect(h.invoke).not.toHaveBeenCalled(); expect(h.merge).not.toHaveBeenCalled();
});

it('explains missing migration support without offering a misleading load retry', async () => {
  h.request.mockRejectedValueOnce(new Error('[PRECONDITION_FAILED] MIGRATION_UNSUPPORTED'));
  await mount();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'B' }), { key: 'ArrowRight' });
  expect(await screen.findByText('taskMove.upgradeComputer')).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'taskMove.retry' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'taskMigration.defaultFolder' })).toBeNull();
});
it('keeps transient connection failures retryable without claiming an old version', async () => {
  h.request.mockRejectedValueOnce(new Error('MIGRATION_FAILED'));
  await mount();
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'B' }), { key: 'ArrowRight' });
  fireEvent.click(await screen.findByRole('menuitem', { name: 'taskMove.retry' }));
  expect(await screen.findByRole('menuitem', { name: 'taskMigration.defaultFolder' })).toBeTruthy();
  expect(screen.queryByText('taskMove.upgradeComputer')).toBeNull();
});

it.each([false, true])(
  'shows other computers for a lead and requires team migration support: %s',
  async (supported) => {
    h.request.mockResolvedValue({
      supported: true,
      deviceId: 'B',
      projects: [],
      ...(supported ? { teamMigration: true } : {}),
    });
    await mount({ ...session, orcaRole: 'lead' });
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'B' }), { key: 'ArrowRight' });
    if (supported)
      expect(
        await screen.findByRole('menuitem', { name: 'taskMigration.defaultFolder' }),
      ).toBeTruthy();
    else expect(await screen.findByText('taskMove.upgradeComputer')).toBeTruthy();
  },
);
