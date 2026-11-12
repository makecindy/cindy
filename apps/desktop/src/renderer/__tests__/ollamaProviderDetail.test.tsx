// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalModelPullProgress } from '../../shared/localModelRuntime';
import { OllamaProviderDetail } from '../components/settings/OllamaProviderDetail';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../components/settings/LocalOllamaInstall', () => ({
  LocalOllamaInstall: () => null,
  offersManagedOllamaInstall: () => false,
}));
vi.mock('../components/settings/DownloadMeter', () => ({
  DownloadMeter: ({ progress }: { progress: { percent?: number } }) => (
    <div data-testid="progress">{progress.percent ?? 'starting'}</div>
  ),
}));

const model = {
  id: 'test',
  name: 'Test model',
  libraryName: 'test:latest',
  minUnifiedMemoryGb: 8,
  sizeBytes: 1024,
};
const progress = (
  percent: number,
  phase: LocalModelPullProgress['phase'] = 'downloading',
): LocalModelPullProgress => ({
  name: model.libraryName,
  status: phase!,
  phase,
  percent,
  done: phase === 'success',
});
const snapshot = (pulls: LocalModelPullProgress[] = []) => ({
  status: { kind: 'ready' },
  models: [],
  catalog: [model],
  featured: [model],
  memoryGb: 128,
  pulls,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((r, fail) => {
    resolve = r;
    reject = fail;
  });
  return { promise, resolve, reject };
}
let onProgress: (value: LocalModelPullProgress) => void;
let onCatalog: () => void;
const list = vi.fn();
const pull = vi.fn();
const changed = vi.fn();
const downloadLabel = 'settings.providers.local.downloadAdd';
const download = () =>
  screen.getAllByText(downloadLabel).find((el) => !el.hasAttribute('disabled'))!;

beforeEach(() => {
  list.mockReset().mockResolvedValue(snapshot());
  pull.mockReset().mockReturnValue(new Promise(() => undefined));
  changed.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'darwin',
      maker: {
        localModelList: list,
        localModelPull: pull,
        onProvidersChanged: (cb: typeof onCatalog) => {
          onCatalog = cb;
          return () => undefined;
        },
        onLocalModelPullProgress: (cb: typeof onProgress) => {
          onProgress = cb;
          return () => undefined;
        },
        onLocalModelStatus: () => () => undefined,
      },
    },
  });
});
afterEach(cleanup);
const mount = async () => {
  await act(async () => {
    render(<OllamaProviderDetail onChanged={changed} />);
  });
};

describe('Ollama download snapshot ordering', () => {
  it('does not replace a newly started download with a late empty list', async () => {
    await mount();
    const old = deferred<ReturnType<typeof snapshot>>();
    list.mockReturnValueOnce(old.promise);
    act(() => onCatalog());
    fireEvent.click(download());
    expect(screen.getByTestId('progress').textContent).toBe('starting');
    await act(async () => old.resolve(snapshot()));
    expect(screen.getByTestId('progress').textContent).toBe('starting');
  });

  it('keeps newer progress while still restoring unrelated paused downloads', async () => {
    const old = deferred<ReturnType<typeof snapshot>>();
    list.mockReturnValueOnce(old.promise);
    await mount();
    act(() => onProgress(progress(40)));
    await act(async () =>
      old.resolve(
        snapshot([progress(5), { ...progress(12, 'paused'), name: 'other:latest', done: true }]),
      ),
    );
    expect(screen.getAllByTestId('progress').map((el) => el.textContent)).toEqual(['40', '12']);
  });

  it('does not resurrect a completed download from a late list', async () => {
    const old = deferred<ReturnType<typeof snapshot>>();
    list.mockReturnValueOnce(old.promise);
    await mount();
    act(() => {
      onProgress(progress(40));
      onProgress(progress(100, 'success'));
    });
    await act(async () => old.resolve(snapshot([progress(5)])));
    expect(screen.queryByTestId('progress')).toBeNull();
  });

  it('ignores an older list that finishes after a newer refresh', async () => {
    const old = deferred<ReturnType<typeof snapshot>>();
    list.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot([progress(60)]));
    await mount();
    await act(async () => onCatalog());
    await act(async () => old.resolve(snapshot([progress(5)])));
    expect(screen.getByTestId('progress').textContent).toBe('60');
  });

  it('keeps a local start while the pull IPC has not registered it yet', async () => {
    await mount();
    fireEvent.click(download());
    await act(async () => onCatalog());
    expect(screen.getByTestId('progress').textContent).toBe('starting');
  });

  it.each([false, true])('keeps the resumed pull guarded after the old refresh (fails=%s)', async (fails) => {
    await mount();
    const first = deferred<{ stopped: boolean }>();
    pull.mockReturnValueOnce(first.promise);
    fireEvent.click(download());
    act(() => onProgress({ ...progress(25, 'paused'), done: true }));
    const old = deferred<ReturnType<typeof snapshot>>();
    list.mockReturnValueOnce(old.promise);
    await act(async () => first.resolve({ stopped: true }));
    // Resume while the old call is still awaiting its post-stop list refresh.
    const input = document.querySelector('#ollama-manual-download')!;
    fireEvent.change(input, { target: { value: 'test' } });
    const manual = screen.getAllByText(downloadLabel).at(-1)!;
    fireEvent.click(manual);
    expect(pull).toHaveBeenCalledTimes(2);
    act(() => onProgress(progress(40)));
    await act(async () => {
      if (fails) old.reject(new Error('list unavailable'));
      else old.resolve(snapshot([progress(25, 'paused')]));
    });
    fireEvent.click(manual);
    expect(pull).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('progress').textContent).toBe('40');
  });

  it('dispatches once when the same model is submitted twice', async () => {
    await mount();
    const input = document.querySelector('#ollama-manual-download')!;
    fireEvent.change(input, { target: { value: 'test' } });
    const buttons = screen.getAllByText(downloadLabel);
    const manual = buttons[buttons.length - 1]!;
    fireEvent.click(manual);
    fireEvent.click(manual);
    expect(pull).toHaveBeenCalledTimes(1);
    act(() => onProgress(progress(25)));
    fireEvent.click(manual);
    expect(screen.getByTestId('progress').textContent).toBe('25');
    expect(pull).toHaveBeenCalledTimes(1);
  });
});
