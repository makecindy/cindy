// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeVersionsPanel } from '../CindyMakeVersionsPanel';
const h = vi.hoisted(() => ({ get: vi.fn(), act: vi.fn(), confirm: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: h.confirm }),
}));
const versions = {
  currentId: 'original',
  selectedId: 'original',
  switching: false,
  versions: [
    {
      id: 'original',
      kind: 'original',
      development: true,
      version: '0.1.99',
      commit: 'a'.repeat(40),
      available: true,
      compatible: true,
    },
    {
      id: 'personal',
      kind: 'personal',
      title: 'Blue background',
      available: true,
      compatible: true,
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue(versions);
  h.act.mockResolvedValue(versions);
  h.confirm.mockResolvedValue(false);
  vi.stubGlobal('electronAPI', { getCindyVersions: h.get, actCindyVersion: h.act });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Cindy Make local versions', () => {
  it('reports the current version inventory to its parent', async () => {
    const onState = vi.fn();
    render(<CindyMakeVersionsPanel onState={onState} />);
    await waitFor(() => expect(onState).toHaveBeenLastCalledWith(versions));
  });

  it('leads with the running version and reveals alternatives only on request', async () => {
    h.get.mockResolvedValue({ ...versions, currentId: 'personal', selectedId: 'personal' });
    render(<CindyMakeVersionsPanel />);
    expect(await screen.findByText('cindyMake.versions.personal')).toBeTruthy();
    expect(screen.queryByText('Blue background')).toBeNull();
    expect(screen.queryByText('cindyMake.versions.original')).toBeNull();
    expect(screen.queryByRole('button', { name: 'cindyMake.versions.using' })).toBeNull();
    const toggle = screen.getByRole('button', { name: 'cindyMake.overview.switchVersion' });
    fireEvent.click(toggle);
    expect(screen.getByText('cindyMake.versions.original')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.versions.remove' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.versions.switch' }));
    await waitFor(() => expect(h.act).toHaveBeenCalledWith('switch', 'original'));
  });
  it('shows Dev inside the original row and switches through the shared native operation', async () => {
    render(<CindyMakeVersionsPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.overview.switchVersion' }),
    );
    await screen.findByText('cindyMake.versions.personal');
    expect(screen.queryByText('Blue background')).toBeNull();
    expect(screen.getByText('cindyMake.versions.original')).toBeDefined();
    expect(
      screen.getByText('cindyMake.versions.development · 0.1.99 · aaaaaaaaaaaa'),
    ).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.versions.switch' }));
    await waitFor(() => expect(h.act).toHaveBeenCalledWith('switch', 'personal'));
  });
  it('requires explicit deletion confirmation and never offers deleting the running version', async () => {
    render(<CindyMakeVersionsPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.overview.switchVersion' }),
    );
    const remove = await screen.findByRole('button', { name: 'cindyMake.versions.remove' });
    fireEvent.click(remove);
    await waitFor(() => expect(h.confirm).toHaveBeenCalledOnce());
    expect(h.act).not.toHaveBeenCalled();
    h.confirm.mockResolvedValueOnce(true);
    fireEvent.click(remove);
    await waitFor(() => expect(h.act).toHaveBeenCalledWith('remove', 'personal'));
  });
  it('does not let an incompatible version switch', async () => {
    h.get.mockResolvedValue({
      ...versions,
      versions: versions.versions.map((version) =>
        version.id === 'personal' ? { ...version, compatible: false } : version,
      ),
    });
    render(<CindyMakeVersionsPanel />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.overview.switchVersion' }),
    );
    const switchButton = await screen.findByRole('button', {
      name: 'cindyMake.versions.incompatible',
    });
    expect(screen.getAllByText('cindyMake.versions.incompatible')).toHaveLength(2);
    expect((switchButton as HTMLButtonElement).disabled).toBe(true);
  });
  it('updates the same personal version without adding a second personal row', async () => {
    h.get.mockResolvedValue({
      ...versions,
      currentId: 'personal',
      selectedId: 'personal',
      personalUpdateAvailable: true,
      currentVersion: { ...versions.versions[1], commit: 'b'.repeat(40) },
      versions: [versions.versions[0], { ...versions.versions[1], commit: 'c'.repeat(40) }],
    });
    render(<CindyMakeVersionsPanel />);
    const update = await screen.findByRole('button', { name: 'cindyMake.versions.updatePersonal' });
    expect(screen.getByText('bbbbbbbbbbbb')).toBeTruthy();
    expect(screen.getByText('cccccccccccc')).toBeTruthy();
    expect(screen.getAllByText('cindyMake.versions.personal')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.overview.switchVersion' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('cindyMake.versions.original')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'cindyMake.versions.remove' })).toBeNull();
    fireEvent.click(update);
    await waitFor(() => expect(h.act).toHaveBeenCalledWith('switch', 'personal'));
  });
  it('explains why an updated personal application cannot replace the running one', async () => {
    h.get.mockResolvedValue({
      ...versions,
      currentId: 'personal',
      selectedId: 'personal',
      personalUpdateAvailable: true,
      currentVersion: versions.versions[1],
      versions: [versions.versions[0], { ...versions.versions[1], compatible: false }],
    });
    render(<CindyMakeVersionsPanel />);
    const update = await screen.findByRole('button', {
      name: 'cindyMake.versions.incompatible',
    });
    expect(screen.getAllByText('cindyMake.versions.incompatible')).toHaveLength(2);
    expect((update as HTMLButtonElement).disabled).toBe(true);
  });
  it('shows unavailable as the update action state when a personal version cannot be read', async () => {
    h.get.mockResolvedValue({
      ...versions,
      currentId: 'personal',
      selectedId: 'personal',
      personalUpdateAvailable: true,
      versions: [versions.versions[0], { ...versions.versions[1], available: false }],
    });
    render(<CindyMakeVersionsPanel />);
    const update = await screen.findByRole('button', {
      name: 'cindyMake.versions.unavailable',
    });
    expect((update as HTMLButtonElement).disabled).toBe(true);
    expect(update.getAttribute('title')).toBe('cindyMake.versions.unavailable');
  });
  it('keeps switching available while another Make operation is running', async () => {
    h.get.mockResolvedValue({
      ...versions,
      currentId: 'personal',
      selectedId: 'personal',
      personalUpdateAvailable: true,
    });
    render(<CindyMakeVersionsPanel busy />);
    const update = await screen.findByRole('button', {
      name: 'cindyMake.versions.updatePersonal',
    });
    expect((update as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(update);
    await waitFor(() => expect(h.act).toHaveBeenCalledWith('switch', 'personal'));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.overview.switchVersion' }));
    const remove = await screen.findByRole('button', { name: 'cindyMake.versions.remove' });
    expect((remove as HTMLButtonElement).disabled).toBe(true);
  });
});
