// @vitest-environment jsdom
import React, { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TaskTagEditor, TaskTagMenuSection } from '../TaskTags';
import { TASK_TAG_COLORS } from '@cindy/maker-shared';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { emitTaskTagCatalog, resetTaskTagCatalogCache } from '../taskTagEvents';
import type { Session } from '@/lib/ccAgent.types';

vi.mock('@/features/cc-agent/lib/remoteSessionWriteGuard', () => ({
  isRemoteSessionWriteBlocked: (s: Session) => s.deviceLinkConnectionStatus === 'disconnected',
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      (
        ({
          'taskTags.title': 'Labels',
          'taskTags.red': 'Red',
          'taskTags.green': 'Green',
          'taskTags.presetWork': '工作',
          'taskTags.more': 'More labels',
          'taskTags.addLabel': `Add ${options?.name}`,
          'taskTags.removeLabel': `Remove ${options?.name}`,
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

afterEach(() => {
  cleanup();
  resetTaskTagCatalogCache();
});
it('keeps guest labels visible but disabled without requesting the host catalog', () => {
  const invoke = vi.fn();
  const onMore = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
  render(<TaskTagMenuSection session={{ id: 'guest-task', deviceLinkDeviceId: sharedTaskHostPeer('share', 'host'), tags: [] } as unknown as Session} onMore={onMore} />);
  expect(screen.getByText('Labels')).toBeTruthy();
  const more = screen.getByRole('button', { name: 'More labels' });
  expect((more as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(more);
  expect(onMore).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
it('treats 工作 to Work as an explicit rename, but not an unchanged save', async () => {
  const tag = { id: 'preset:work', name: 'Work', color: 'blue', favoriteOrder: null, revision: 1 };
  const execute = vi.fn(async () => ({ tags: [tag], sessions: [] }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { taskTags: { execute } } } });
  render(<TaskTagEditor session={{ id: 'task', tags: [] } as unknown as Session} onClose={() => {}} />);
  fireEvent.doubleClick(await screen.findByRole('button', { name: '工作' }));
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.save' }));
  await waitFor(() => expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'update', name: undefined, nameCustomized: undefined })));
  fireEvent.doubleClick(await screen.findByRole('button', { name: '工作' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Work' } });
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.save' }));
  await waitFor(() => expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'update', name: 'Work', nameCustomized: true })));
});

it.each([false, true])('ignores a previous device mutation after switching tasks (reject: %s)', async (reject) => {
  const tag = (name: string) => ({ id: name, name, color: 'blue', favoriteOrder: null, revision: 1 });
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  const invoke = vi.fn(async (device: string, _channel: string, [request]: [{ action: string }]) => request.action === 'get'
    ? { tags: [tag(device)], sessions: [] }
    : new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke } } });
  const session = (device: string) => ({ id: device, deviceLinkDeviceId: device, tags: [] } as unknown as Session);
  const view = render(<TaskTagMenuSection session={session('A')} onMore={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'A' }));
  view.rerender(<TaskTagMenuSection session={session('B')} onMore={() => {}} />);
  await screen.findByRole('button', { name: 'B' });
  await act(async () => { if (reject) fail(new Error('old failure')); else finish({ tags: [tag('A')], sessions: [] }); });
  expect(screen.queryByRole('button', { name: 'A' })).toBeNull();
  expect(screen.queryByText('taskTags.failed')).toBeNull();
  expect(screen.getByRole('button', { name: 'B' })).toBeTruthy();
});
it.each([false, true])(
  'preserves drafts across catalog pushes (external rename: %s)',
  async (renamed) => {
    const tag = {
      id: 'work',
      name: 'Work',
      color: 'red' as const,
      favoriteOrder: null,
      revision: 1,
    };
    const execute = vi.fn(async () => ({ tags: [tag], sessions: [] }));
    Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
    render(
    <TaskTagEditor session={{ id: 'task', tags: [] } as unknown as Session} onClose={() => {}} />,
  );
    fireEvent.doubleClick(await screen.findByRole('button', { name: 'Work' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'My draft' } });
    act(() =>
      emitTaskTagCatalog(undefined, [
        { ...tag, revision: 2, name: renamed ? 'Other name' : tag.name },
      ]),
    );
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('My draft');
    fireEvent.click(screen.getByRole('button', { name: 'taskTags.save' }));
    await waitFor(() =>
      expect(execute).toHaveBeenLastCalledWith({
        action: 'update',
        tagId: tag.id,
        revision: renamed ? 1 : 2,
        name: 'My draft',
        nameCustomized: true,
        color: 'red',
      }),
    );
  },
);
it('names the hovered label, describes the action and toggles its inner check', async () => {
  const red = {
    id: 'default:red',
    name: 'Red',
    color: 'red' as const,
    favoriteOrder: 0,
    revision: 1,
  };
  const green = {
    id: 'default:green',
    name: 'Green',
    color: 'green' as const,
    favoriteOrder: 1,
    revision: 1,
  };
  const execute = vi.fn(async (request: { action: string }) => ({
    tags: [red, green],
    sessions: request.action === 'attach' ? [{ sessionId: 'task', tags: [red, green] }] : [],
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  render(<TaskTagMenuSection session={{ id: 'task', tags: [red] } as Session} onMore={() => {}} />);
  const greenButton = await screen.findByRole('button', { name: 'Green' });
  const redButton = screen.getByRole('button', { name: 'Red' });
  expect(redButton.getAttribute('aria-pressed')).toBe('true');
  expect(redButton.querySelector('.lucide-check')).not.toBeNull();
  expect(greenButton.getAttribute('aria-pressed')).toBe('false');
  fireEvent.pointerEnter(greenButton);
  fireEvent.pointerMove(greenButton, { pointerType: 'mouse' });
  expect(screen.getAllByText('Add Green').length).toBeGreaterThan(0);
  expect((await screen.findByRole('tooltip')).textContent).toBe('Add Green');
  fireEvent.click(greenButton);
  await waitFor(() => expect(greenButton.getAttribute('aria-pressed')).toBe('true'));
  expect(execute).toHaveBeenLastCalledWith({
    action: 'attach',
    sessionIds: ['task'],
    tagIds: ['default:green'],
  });
  expect(greenButton.querySelector('.lucide-x')).not.toBeNull();
  fireEvent.pointerLeave(greenButton);
  expect(screen.getByText('Labels')).toBeTruthy();
});

it('edits on double click without toggling membership and reorders the unified directory', async () => {
  const tags = ['One', 'Two'].map((name, sortOrder) => ({
    id: name,
    name,
    color: 'red' as const,
    sortOrder,
    favoriteOrder: null,
    revision: 1,
  }));
  const execute = vi.fn(async () => ({ tags, sessions: [] }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  render(
    <TaskTagEditor
      session={{ id: 'task', title: 'Example', tags: [] } as unknown as Session}
      onClose={() => {}}
    />,
  );
  const name = await screen.findByRole('button', { name: 'One' });
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.doubleClick(name);
  expect(screen.getByRole('textbox').getAttribute('value')).toBe('One');
  expect(execute.mock.calls).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.cancel' }));
  expect(screen.queryByRole('textbox')).toBeNull();
  const rows = screen.getAllByRole('button', { name: 'taskTags.reorderLabel' });
  fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
  await waitFor(() =>
    expect(execute).toHaveBeenLastCalledWith({
      action: 'reorder',
      tagIds: ['Two', 'One'],
      expectedOrder: ['One', 'Two'],
    }),
  );
});
it('shows only the first seven ordered labels, including non-favorites', async () => {
  const tags = Array.from({ length: 9 }, (_, i) => ({
    id: String(i),
    name: `Label ${i}`,
    color: 'blue' as const,
    sortOrder: i,
    favoriteOrder: null,
    revision: 1,
  }));
  const execute = vi.fn(async () => ({ tags, sessions: [] }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  render(
    <TaskTagMenuSection
      session={{ id: 'task', tags: [] } as unknown as Session}
      onMore={() => {}}
    />,
  );
  await screen.findByRole('button', { name: 'Label 6' });
  expect(screen.queryByRole('button', { name: 'Label 7' })).toBeNull();
  expect(screen.getAllByRole('button')).toHaveLength(8);
});

it('opens a twelve-color form only on add, saves white, and returns to selection', async () => {
  const created = { id: 'new', name: 'Paper', color: 'white', favoriteOrder: null, revision: 1 };
  const execute = vi.fn(async (request: { action: string }) => ({
    tags: request.action === 'get' ? [] : [created],
    sessions: [],
    supportedColors: TASK_TAG_COLORS,
  }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  render(
    <TaskTagEditor session={{ id: 'task', tags: [] } as unknown as Session} onClose={() => {}} />,
  );
  await waitFor(() => expect(execute).toHaveBeenCalled());
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.add' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Paper' } });
  const white = screen.getByRole('button', { name: 'taskTags.white' });
  expect(screen.queryByRole('button', { name: 'taskTags.none' })).toBeNull();
  fireEvent.click(white);
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.create' }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({ action: 'create', name: 'Paper', color: 'white' }),
  );
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
});

it('keeps the form when attachment fails and retries without creating a duplicate', async () => {
  const created = { id: 'new', name: 'Paper', color: 'blue', favoriteOrder: null, revision: 1 };
  let failures = 1;
  const execute = vi.fn(async (request: { action: string }) => {
    if (request.action === 'update') throw new Error('CONFLICT');
    if (request.action === 'attach' && failures-- > 0) {
      created.revision++; // Committed on the host; only the response was lost.
      throw new Error('OFFLINE');
    }
    return {
      tags: request.action === 'get' ? [] : [created],
      sessions: [],
      supportedColors: TASK_TAG_COLORS,
    };
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  render(
    <TaskTagEditor session={{ id: 'task', tags: [] } as unknown as Session} onClose={() => {}} />,
  );
  await waitFor(() => expect(execute).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.add' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Paper' } });
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.create' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('textbox')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.save' }));
  await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  expect(execute.mock.calls.filter(([r]) => r.action === 'create')).toHaveLength(1);
  expect(execute.mock.calls.filter(([r]) => r.action === 'attach')).toHaveLength(2);
  expect(execute.mock.calls.filter(([r]) => r.action === 'update')).toHaveLength(0);
});

it('lets an old host rename an existing uncolored tag without requiring a new color', async () => {
  const old = { id: 'old', name: 'Old', color: 'none', favoriteOrder: null, revision: 1 };
  const execute = vi.fn(async () => ({ tags: [old], sessions: [] }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  render(
    <TaskTagEditor session={{ id: 'task', tags: [] } as unknown as Session} onClose={() => {}} />,
  );
  fireEvent.doubleClick(await screen.findByRole('button', { name: 'Old' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Renamed' } });
  fireEvent.click(screen.getByRole('button', { name: 'taskTags.save' }));
  await waitFor(() =>
    expect(execute).toHaveBeenCalledWith({
      action: 'update',
      tagId: 'old',
      revision: 1,
      name: 'Renamed',
      nameCustomized: true,
      color: undefined,
    }),
  );
});

it.each(['menu', 'editor'])('retries a failed %s load without reopening', async (surface) => {
  const execute = vi
    .fn()
    .mockRejectedValueOnce(new Error('network failure'))
    .mockResolvedValue({
      tags: [{ id: 'x', name: 'Recovered', color: 'red', favoriteOrder: null, revision: 1 }],
      sessions: [],
    });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { taskTags: { execute } } },
  });
  const session = { id: 'task', tags: [] } as unknown as Session;
  render(
    surface === 'menu' ? (
      <TaskTagMenuSection session={session} onMore={() => {}} />
    ) : (
      <TaskTagEditor session={session} onClose={() => {}} />
    ),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'taskTags.retry' }));
  await screen.findByRole('button', { name: 'Recovered' });
  expect(execute).toHaveBeenCalledTimes(2);
});

it('opens the complete cached directory offline after menu unmount, with writes disabled', async () => {
  const tags = Array.from({ length: 12 }, (_, i) => ({
    id: `tag-${i}`,
    name: `Label ${i}`,
    color: 'blue' as const,
    favoriteOrder: null,
    sortOrder: i,
    revision: 1,
  }));
  const invoke = vi.fn(async () => ({ tags, sessions: [] }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { deviceLink: { invoke } },
  });
  const session = {
    id: 'task',
    deviceLinkDeviceId: 'remote',
    deviceLinkConnectionStatus: 'connected',
    tags: [],
  } as unknown as Session;
  const view = render(<TaskTagMenuSection session={session} onMore={() => {}} />);
  await screen.findByRole('button', { name: 'Label 0' });
  view.unmount();
  const offline = { ...session, deviceLinkConnectionStatus: 'disconnected' } as Session;
  const more = vi.fn();
  const menu = render(<TaskTagMenuSection session={offline} onMore={more} />);
  fireEvent.click(screen.getByRole('button', { name: 'More labels' }));
  expect(more).toHaveBeenCalledOnce();
  menu.unmount();
  render(<TaskTagEditor session={offline} onClose={() => {}} />);
  expect((screen.getByRole('button', { name: 'Label 11' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(invoke).toHaveBeenCalledTimes(1);
});
