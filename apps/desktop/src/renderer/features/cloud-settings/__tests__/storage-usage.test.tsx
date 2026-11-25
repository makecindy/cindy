// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CloudStorageUsage } from '../CloudStorageUsage';

vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      options && Object.keys(options).length ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
afterEach(cleanup);

const usage = (freeBytes: number) => ({
  version: 1,
  ownerGeneration: 1,
  disk: { totalBytes: 100 * 1024 ** 3, freeBytes },
  databaseBytes: 2 * 1024 ** 3,
  mediaBytes: 1024 ** 3,
  legacyImagesBytes: 0,
  chatAttachmentsBytes: 0,
});
function mount(invoke: (...args: unknown[]) => Promise<unknown>) {
  Object.assign(window, { electronAPI: { deviceLink: { invoke: vi.fn(invoke) } } });
  return render(<CloudStorageUsage deviceId="cloud-a" name="Cloud A" thresholdGiB={10} active />);
}

it('shows the instance disk and totals in the local overview, read-only', async () => {
  mount(async () => usage(60 * 1024 ** 3));
  expect(await screen.findByText(/cloudSettings\.storageDisk/)).toBeTruthy();
  expect(screen.getByText(/cloudSettings\.storageTitle/).textContent).toContain('Cloud A');
  expect(screen.queryByRole('alert')).toBeNull();
  // The bar shows the instance disk (40% used), not the database against its warning threshold.
  const bar = screen.getByRole('progressbar', { name: 'cloudSettings.storageDiskLabel' });
  expect(bar.getAttribute('aria-valuenow')).toBe('40');
  const invoke = vi.mocked(window.electronAPI.deviceLink.invoke);
  expect(invoke).toHaveBeenCalledWith('cloud-a', 'cloud:storage-usage:v1', [{ op: 'read' }]);
  fireEvent.click(
    screen.getByRole('button', { name: /settings\.about\.storage\.refreshStatsButton/ }),
  );
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
});

it('warns when the instance disk is nearly full', async () => {
  mount(async () => usage(5 * 1024 ** 3));
  expect((await screen.findByRole('alert')).textContent).toBe('cloudSettings.storageDiskLow');
});

it('shows nothing on a runtime without the channel', async () => {
  const view = mount(async () => {
    throw new Error('[DEVICE_LINK_CHANNEL_NOT_ALLOWED] not allowed');
  });
  await waitFor(() => expect(view.container.textContent).toBe(''));
});
