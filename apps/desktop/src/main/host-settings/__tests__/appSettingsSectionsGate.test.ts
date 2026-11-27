import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../windowFocusClassifier.js', () => ({ isAppContentWindow: () => true }));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: (code: string) => { throw new Error(code); } }));
vi.mock('../../appearance-settings-ipc.js', () => ({ applySavedAppearance: vi.fn() }));
vi.mock('../catalog.js', () => ({ readSettingsModelCatalog: vi.fn() }));
// An ordinary desktop, not a managed cloud instance.
vi.mock('../personalization.js', () => ({ currentSettingsOwner: vi.fn(), assertSettingsOwner: vi.fn(), isManagedCloudInstance: () => false }));
vi.mock('../additionalModels.js', () => ({ readModelSettings: vi.fn(), validateModelSettingsChange: vi.fn(), commitModelSettings: vi.fn() }));
vi.mock('../additionalApplication.js', () => ({ applyAdditionalSettings: vi.fn() }));
vi.mock('../additionalNative.js', () => ({ nativeSettingsOperations: {} }));
vi.mock('../index.js', () => ({ readHostSettings: vi.fn(), getHostSettings: vi.fn(), updateHostSettings: vi.fn(), onHostSettingsChanged: vi.fn(), configureHostSettingsApplication: vi.fn(), HostSettingsError: Error }));
import { registerHostSettingsIpc } from '../ipc.js';
import { runtimeSettingsSections } from '../../app-settings/runtime.js';

describe('ordinary desktop', () => {
  it('keeps the ordinary settings sections unchanged', () => {
    registerHostSettingsIpc(() => {});
    expect(runtimeSettingsSections()).toEqual([]);
  });
});
