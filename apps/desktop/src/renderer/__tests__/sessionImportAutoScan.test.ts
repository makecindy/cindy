// @vitest-environment jsdom

import { StrictMode, createElement } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryRouter } from 'react-router-dom';

import { SessionImportSection } from '@/components/settings/SessionImportSection';
import { IMPORT_SOURCE_NAMES } from '@/components/icons/ImportSourceMark';
import type { ImportSourceId } from '../../shared/sessionImport';

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

function scanResult(title: string, ...more: Array<[ImportSourceId, string]>): ScanResult {
  const items: Array<[ImportSourceId, string]> = [['codex', title], ...more];
  return {
    candidates: items.map(([source, name]) => ({
      key: `${source}:${name}`,
      source,
      id: name,
      title: name,
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
    })),
    hiddenCounts: { cindy: 0, temp: 0, internal: 0, imported: 0 },
    sources: [...new Set(items.map(([source]) => source))].map((id) => ({
      id, label: IMPORT_SOURCE_NAMES[id], count: items.filter(([source]) => source === id).length,
    })),
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

// Regression (#12342 review PRRT_kwDOTgdRUs67AjOy). Production entry: SessionImportSection's
// source filter (shared Select). After every task of the chosen source is imported, a rescan drops
// that source from the counts while the filter keeps it; the trigger must still name the source
// (main's hand-made trigger always did) instead of rendering blank over an empty list. The cases
// above never change the source filter. Minimal input: pick Codex, rescan with only a Gemini task
// left. Tier: unit (jsdom); Radix needs the same layout stubs as the shared Select tests.
describe('SessionImportSection source filter', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('PointerEvent', class extends MouseEvent {
      pointerType: string;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerType = options.pointerType ?? 'mouse';
      }
    });
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
  });

  it('keeps naming the chosen source after a rescan leaves it with no tasks', async () => {
    const first = Promise.resolve(scanResult('Codex task', ['gemini', 'Gemini task']));
    scan.mockReturnValueOnce(first);
    renderSection();
    await act(async () => { await first; });

    const trigger = screen.getByRole('combobox', { name: 'settings.sessionImport.sourceFilterAria' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const codex = await screen.findByRole('option', { name: new RegExp(IMPORT_SOURCE_NAMES.codex) });
    fireEvent.keyDown(codex, { key: 'Enter' });
    expect(trigger.textContent).toContain(IMPORT_SOURCE_NAMES.codex);

    // Every Codex task has been imported: only the Gemini candidate remains.
    const imported = scanResult('Codex task', ['gemini', 'Gemini task']);
    const rescan = Promise.resolve({
      ...imported,
      candidates: imported.candidates.filter((c) => c.source === 'gemini'),
      sources: imported.sources.filter((s) => s.id === 'gemini'),
    });
    scan.mockReturnValueOnce(rescan);
    fireEvent.click(screen.getByRole('button', { name: 'settings.sessionImport.rescan' }));
    await act(async () => { await rescan; });

    expect(screen.queryByText('Gemini task')).toBeNull();
    expect(trigger.textContent).toContain(IMPORT_SOURCE_NAMES.codex);
  });
});
