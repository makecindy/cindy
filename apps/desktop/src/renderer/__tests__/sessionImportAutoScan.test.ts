// @vitest-environment jsdom

import { StrictMode, createElement } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouter } from 'react-router-dom';

import { SessionImportSection } from '@/components/settings/SessionImportSection';

vi.mock('react-i18next', () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
// The sharing wizard is a separate entry; keep the scanned-list UI real.
vi.mock('@/components/settings/SessionShareImportWizard', () => ({
  SessionShareImportWizard: () => null,
}));

type ScanResult = Awaited<ReturnType<typeof window.electronAPI.localDb.sessionImport.scan>>;
const scan = vi.fn<typeof window.electronAPI.localDb.sessionImport.scan>();

function scanResult(title: string): ScanResult {
  return {
    candidates: [{
      key: 'codex:' + title,
      source: 'codex',
      id: title,
      title,
      cwd: null,
      groupKey: 'dialogue',
      groupName: '',
      groupPath: null,
      dialogue: true,
      updatedAt: Date.parse('2026-10-16T00:00:00.000Z'),
      archived: false,
      sizeBytes: 1024,
      missingDir: false,
      hidden: null,
      unsupportedVersion: null,
    }],
    hiddenCounts: { cindy: 0, temp: 0, internal: 0, imported: 0 },
    sources: [{ id: 'codex', label: 'Codex', count: 1 }],
    sourceErrors: [],
    scannedAt: 0,
  };
}

function renderSection(strict = false) {
  const tree = createElement(MemoryRouter, null, createElement(SessionImportSection));
  return render(strict ? createElement(StrictMode, null, tree) : tree);
}

function pendingScan() {
  let resolve!: (value: ScanResult) => void;
  const promise = new Promise<ScanResult>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  scan.mockReset();
  vi.stubGlobal('electronAPI', {
    platform: 'darwin',
    localDb: { sessionImport: { scan, status: async () => null, onProgress: () => () => undefined } },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// PR #6196 / engineering-conventions §3.2: replace the old source-text checks
// with the real component's mount and cache-reentry behavior. SettingsView's
// tests stub this component, so they cannot catch either regression. Restore
// this module's original unit file: mount once with a pending scan; then remount
// after one result, while its refresh is pending. No other component shares
// this module cache or lifecycle, so these cases cannot join its parent tests.
describe('SessionImportSection automatic scans', () => {
  it('scans immediately once on mount and displays the result without a click', async () => {
    const request = pendingScan();
    scan.mockReturnValueOnce(request.promise);

    renderSection(true);

    expect(scan).toHaveBeenCalledExactlyOnceWith({ force: false });
    expect((screen.getByRole('button', { name: 'settings.sessionImport.rescan' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      request.resolve(scanResult('Found on mount'));
      await request.promise;
    });

    expect(screen.getByText('Found on mount')).toBeTruthy();
    expect(scan).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'settings.sessionImport.rescan' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps cached candidates visible on reentry until the automatic refresh finishes', async () => {
    const initialScan = Promise.resolve(scanResult('Cached candidate'));
    scan.mockReturnValueOnce(initialScan);
    const first = renderSection();
    await act(async () => { await initialScan; });
    expect(screen.getByText('Cached candidate')).toBeTruthy();
    first.unmount();

    const refresh = pendingScan();
    scan.mockReturnValueOnce(refresh.promise);
    renderSection();

    expect(scan).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Cached candidate')).toBeTruthy();

    await act(async () => {
      refresh.resolve(scanResult('Fresh candidate'));
      await refresh.promise;
    });

    expect(screen.getByText('Fresh candidate')).toBeTruthy();
    expect(screen.queryByText('Cached candidate')).toBeNull();
  });
});
