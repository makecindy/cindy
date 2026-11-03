// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PiKernelState } from '../../../../shared/piKernel';
import { PiKernelVersionRow } from '../PiKernelVersionRow';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'zh-CN' }, t: (key: string, values?: { version?: string }) => key + (values?.version ? ` ${values.version}` : '') }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const getState = vi.fn();
const install = vi.fn();
const baseline: PiKernelState = { currentVersion: '0.85.1', restartRequired: false, official: { release: { version: '0.84.4' }, checkedAt: 123, error: false }, upstream: { release: { version: '0.87.1', releaseUrl: 'https://github.com/earendil-works/pi/releases/tag/v0.87.1' }, checkedAt: 123, error: false }, operation: null };
const key = (suffix: string) => `settings.about.piKernel.${suffix}`;
beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseline);
  install.mockResolvedValue({ ...baseline, currentVersion: '0.87.1' });
  window.electronAPI = { maker: { piKernel: { getState, install } }, openExternal: vi.fn(async () => ({ success: true })) } as never;
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); Reflect.deleteProperty(window, 'electronAPI'); });
async function menu() {
  await screen.findByText('0.85.1');
  await waitFor(() => expect(screen.queryByText(key('checking'))).toBeNull());
  fireEvent.keyDown(screen.getByRole('button', { name: key('manage') }), { key: 'ArrowDown' });
  await screen.findByRole('menu');
}

describe('Pi compact version management', () => {
  it('checks real bridge data while keeping sources and actions out of the collapsed row', async () => {
    render(<PiKernelVersionRow />);
    await screen.findByText(key('available'));
    expect(getState).toHaveBeenCalledWith(true);
    expect(screen.queryByText('0.84.4')).toBeNull();
    expect(screen.queryByText('0.87.1')).toBeNull();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getAllByTestId('pi-kernel-row')).toHaveLength(1);
  });
  it('installs exactly the upstream version confirmed in the risk dialog', async () => {
    render(<PiKernelVersionRow />); await menu();
    fireEvent.click(screen.getByRole('menuitem', { name: /update.*0.87.1/ }));
    await screen.findByRole('alertdialog');
    expect(screen.getByText(key('updateDescription'))).toBeTruthy();
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: key('updateConfirm') }));
    await waitFor(() => expect(install).toHaveBeenCalledWith({ source: 'upstream', version: '0.87.1' }));
  });
  it('offers the older Cindy formal version for an explicit restore', async () => {
    render(<PiKernelVersionRow />); await menu();
    fireEvent.click(screen.getByRole('menuitem', { name: /restore.*0.84.4/ }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: key('restoreConfirm') }));
    await waitFor(() => expect(install).toHaveBeenCalledWith({ source: 'official', version: '0.84.4' }));
  });
  it('offers the stable release when a native prerelease has the same core version', async () => {
    getState.mockResolvedValue({ ...baseline, currentVersion: '0.87.1-beta.1' });
    render(<PiKernelVersionRow />);
    await screen.findByText(key('available'));
  });
  it('does not mistake build metadata for an older prerelease', async () => {
    getState.mockResolvedValue({ ...baseline, currentVersion: '0.87.1+custom-build' });
    render(<PiKernelVersionRow />);
    await screen.findByText('0.87.1+custom-build');
    await waitFor(() => expect(screen.queryByText(key('checking'))).toBeNull());
    expect(screen.queryByText(key('available'))).toBeNull();
  });
  it('preserves the current version and reports failed checks inline', async () => {
    getState.mockResolvedValue({ ...baseline, upstream: { ...baseline.upstream, error: true } });
    render(<PiKernelVersionRow />);
    await screen.findByText(key('checkFailed'));
    expect(screen.getByText('0.85.1')).toBeTruthy();
    expect(screen.queryByText(key('available'))).toBeNull();
  });
  it('shows managed-command progress and prevents a concurrent UI install', async () => {
    getState.mockResolvedValue({ ...baseline, operation: { source: 'upstream', phase: 'download' } });
    render(<PiKernelVersionRow />); await menu();
    expect(screen.getByText(key('download'))).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /restore.*0.84.4/ }).getAttribute('aria-disabled')).toBe('true');
  });
});
