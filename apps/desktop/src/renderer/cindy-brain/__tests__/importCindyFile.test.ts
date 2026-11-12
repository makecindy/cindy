import { afterEach, describe, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { refreshLocalThemes } from '@/themes/local-themes';
import { importCindyFile } from '../importCindyFile';
import type { CindyFileOpenResult } from '../../../shared/cindyFile';

vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/themes/local-themes', () => ({ refreshLocalThemes: vi.fn(async () => ({ success: true, themes: [], diagnostics: [] })) }));

const t = ((key: string) => key) as never;
function setup(result: CindyFileOpenResult) {
  const install = vi.fn(async () => ({ ghost: { manifest: { name: 'Legacy' } } }));
  const inspect = vi.fn(async () => ({ manifest: { id: 'legacy', name: 'Legacy' }, packageSha256: 'a'.repeat(64) }));
  const open = vi.fn(async () => result);
  vi.stubGlobal('window', { electronAPI: { cindyFiles: { open }, ghosts: { inspect, install, listSync: () => ({ ghosts: [] }) } } });
  return { open, inspect, install };
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

/** Unit: the shared renderer import entry, absent from plugin-only installFlow
 * coverage. A theme must refresh the list without entering plugin approvals;
 * old files must still use the original inspect → hash-bound install flow. */
describe('Cindy file import routing', () => {
  it('keeps legacy plugin installation and its package hash unchanged', async () => {
    const { inspect, install } = setup({ type: 'plugin' });
    await importCindyFile('/tmp/legacy.cindy', { t });
    expect(inspect).toHaveBeenCalledWith('/tmp/legacy.cindy');
    expect(install).toHaveBeenCalledWith('/tmp/legacy.cindy', { enable: true, expectedPackageSha256: 'a'.repeat(64) });
    expect(refreshLocalThemes).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith('settings.ghosts.toast.installed');
  });

  it('refreshes installed themes and opens appearance without plugin side effects', async () => {
    const { install, inspect } = setup({ type: 'theme', names: ['Mist'] });
    const openThemes = vi.fn();
    await importCindyFile('/tmp/mist.cindy', { t, openThemes });
    expect(refreshLocalThemes).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('cindyFiles.themeInstalled');
    expect(openThemes).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it.each(['unsupported', 'invalid', 'failed'] as const)('reports %s without falling back to plugins', async (type) => {
    const { install, inspect } = setup({ type });
    await importCindyFile('/tmp/future.cindy', { t });
    expect(toast.error).toHaveBeenCalledWith(`cindyFiles.${type}`);
    expect(refreshLocalThemes).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
    expect(inspect).not.toHaveBeenCalled();
  });

  it('distinguishes a failed list refresh from an already completed installation', async () => {
    setup({ type: 'theme', names: ['Mist'] });
    vi.mocked(refreshLocalThemes).mockRejectedValueOnce(new Error('List unavailable'));
    const openThemes = vi.fn();
    await importCindyFile('/tmp/mist.cindy', { t, openThemes });
    expect(toast.error).toHaveBeenCalledWith('cindyFiles.refreshFailed');
    expect(toast.success).not.toHaveBeenCalled();
    expect(openThemes).toHaveBeenCalledOnce();
  });
});
