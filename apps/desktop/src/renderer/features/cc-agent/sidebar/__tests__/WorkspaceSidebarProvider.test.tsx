// @vitest-environment jsdom

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useProjectWorkspaces } from '../../hooks/useProjectWorkspaces';
import { MountedMenuContent } from '../MountedMenuContent';
import {
  ProjectWorkspaceActions,
  WorkspaceSidebarProvider,
  useWorkspaceSidebar,
} from '../WorkspaceSidebarProvider';

const mockToast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: mockToast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../hooks/useProjectWorkspaces', () => ({ useProjectWorkspaces: vi.fn() }));

type WorkspaceState = ReturnType<typeof useProjectWorkspaces>;
const mutate = vi.fn<WorkspaceState['mutate']>();
const onCreated = vi.fn();
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);
let state: WorkspaceState;

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function ProjectMenu({ label, projectKey }: { label: string; projectKey: string }) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger>{label}</DropdownMenuTrigger>
      <DropdownMenuContent>
        <MountedMenuContent>
          {() => <ProjectWorkspaceActions projectKey={projectKey} />}
        </MountedMenuContent>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WorkspaceCommands() {
  const actions = useWorkspaceSidebar();
  if (!actions) return null;
  return (
    <>
      <output data-testid="workspace-names">
        {actions.workspaces.map((workspace) => workspace.name).join(', ')}
      </output>
      <button onClick={() => actions.create()}>Create workspace</button>
      <button onClick={() => actions.rename(actions.workspaces[0])}>Rename workspace</button>
      <button onClick={() => actions.remove(actions.workspaces[0])}>Delete workspace</button>
    </>
  );
}

function Fixture() {
  return (
    <WorkspaceSidebarProvider onCreated={onCreated}>
      <ProjectMenu label="Pinned project menu" projectKey="local:/client" />
      <ProjectMenu label="Rail project menu" projectKey="local:/code" />
      <WorkspaceCommands />
    </WorkspaceSidebarProvider>
  );
}

async function openWorkspaceMenu(label: string) {
  fireEvent.keyDown(screen.getByRole('button', { name: label }), { key: 'Enter' });
  const submenu = await screen.findByRole('menuitem', {
    name: 'ccAgent.sidebar.workspaces.moveTo',
  });
  fireEvent.keyDown(submenu, { key: 'ArrowRight' });
  await screen.findByRole('menuitem', { name: 'ccAgent.sidebar.workspaces.createAndMove' });
}

beforeEach(() => {
  mutate.mockReset().mockResolvedValue(undefined);
  onCreated.mockReset();
  mockToast.error.mockReset();
  state = {
    workspaces: [
      { id: 'business', name: 'Business', projectKeys: ['local:/client'], collapsed: false },
      { id: 'code', name: 'Code', projectKeys: ['local:/code'], collapsed: false },
    ],
    loading: false,
    error: null,
    pending: false,
    ready: true,
    mutate,
    reload: vi.fn(),
  };
  vi.mocked(useProjectWorkspaces)
    .mockReset()
    .mockImplementation(() => state);
  vi.stubGlobal('electronAPI', { platform: 'darwin' });
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((media: string) => ({
      matches: true,
      media,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      onchange: null,
      dispatchEvent: () => false,
    })),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (originalScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

describe('WorkspaceSidebarProvider', () => {
  it('shares one workspace hook and the same saved groups across project menus', async () => {
    render(<Fixture />);
    expect(useProjectWorkspaces).toHaveBeenCalledTimes(1);
    await openWorkspaceMenu('Pinned project menu');
    expect(screen.getByRole('menuitem', { name: 'Business' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Code' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(mutate).toHaveBeenNthCalledWith(1, {
      type: 'move-project',
      projectKey: 'local:/client',
      workspaceId: 'code',
    });
    await openWorkspaceMenu('Rail project menu');
    expect(screen.getByRole('menuitem', { name: 'Code' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'Business' }));
    expect(mutate).toHaveBeenNthCalledWith(2, {
      type: 'move-project',
      projectKey: 'local:/code',
      workspaceId: 'business',
    });
    expect(useProjectWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('keeps the create-and-move dialog after the pinned project dropdown unmounts', async () => {
    render(<Fixture />);
    await openWorkspaceMenu('Pinned project menu');
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'ccAgent.sidebar.workspaces.createAndMove' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'ccAgent.sidebar.workspaces.createTitle',
    });
    await waitFor(() => expect(screen.queryByRole('menu', { hidden: true })).toBeNull());
    expect(screen.getByRole('dialog')).toBe(dialog);
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'New workspace' } });
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'ccAgent.sidebar.workspaces.create' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      type: 'create',
      id: expect.any(String),
      name: 'New workspace',
      projectKey: 'local:/client',
    });
    expect(onCreated).toHaveBeenCalledOnce();
  });

  it('retains the delete dialog and saved group after failure, and closes only after a successful retry', async () => {
    const failed = deferred();
    const saved = deferred();
    mutate.mockReturnValueOnce(failed.promise).mockReturnValueOnce(saved.promise);
    const view = render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'ccAgent.sidebar.workspaces.delete',
      }),
    );
    await act(async () => failed.reject(new Error('SAVE_FAILED')));
    expect(mockToast.error).toHaveBeenCalledWith('ccAgent.sidebar.workspaces.saveError');
    expect(screen.getByTestId('workspace-names').textContent).toBe('Business, Code');
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'ccAgent.sidebar.workspaces.delete',
      }),
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    await act(async () => {
      state = { ...state, workspaces: [state.workspaces[1]] };
      view.rerender(<Fixture />);
      saved.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('workspace-names').textContent).toBe('Code');
    expect(mutate).toHaveBeenNthCalledWith(1, { type: 'delete', id: 'business' });
    expect(mutate).toHaveBeenNthCalledWith(2, { type: 'delete', id: 'business' });
  });

  it('closes the confirmation after a successful deletion and renders the saved groups', async () => {
    const saved = deferred();
    mutate.mockReturnValueOnce(saved.promise);
    const view = render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'ccAgent.sidebar.workspaces.delete',
      }),
    );
    expect(mutate).toHaveBeenCalledExactlyOnceWith({ type: 'delete', id: 'business' });
    await act(async () => {
      state = { ...state, workspaces: [state.workspaces[1]] };
      view.rerender(<Fixture />);
      saved.resolve();
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByTestId('workspace-names').textContent).toBe('Code');
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it.each(['Create workspace', 'Rename workspace', 'Delete workspace'])(
    'discards the old %s dialog when owner readiness is lost',
    async (command) => {
      const view = render(<Fixture />);
      fireEvent.click(screen.getByRole('button', { name: command }));
      const role = command === 'Delete workspace' ? 'alertdialog' : 'dialog';
      expect(screen.getByRole(role)).toBeTruthy();
      state = { ...state, ready: false, workspaces: [] };
      view.rerender(<Fixture />);
      await waitFor(() => expect(screen.queryByRole(role)).toBeNull());
      state = {
        ...state,
        ready: true,
        workspaces: [{ id: 'other', name: 'Other account', projectKeys: [], collapsed: false }],
      };
      view.rerender(<Fixture />);
      expect(screen.queryByRole(role)).toBeNull();
      expect(mutate).not.toHaveBeenCalled();
    },
  );
});
