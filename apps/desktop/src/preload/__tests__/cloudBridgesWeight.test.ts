import { expect, it, vi } from 'vitest';

// Unit: the main window's preload takes the cloud channel names only; the cloud settings schemas
// and the settings catalog stay in Main, which validates every request.
vi.mock('electron', () => ({ ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('../../shared/cloudSettingsClient', () => { throw new Error('the preload loaded the cloud settings client'); });
vi.mock('../../shared/settingsReadCatalog', () => { throw new Error('the preload loaded the settings catalog'); });

it('loads the cloud bridges without the cloud settings client or the settings catalog', async () => {
  await expect(import('../cloudBridges')).resolves.toHaveProperty('cloudWindowBridges');
});
