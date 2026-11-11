// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, args?: { name: string }) => args?.name ?? key,
    i18n: { language: 'en' },
  }),
}));
import { LlamaCppCandidates } from '../LlamaCppCandidates';
afterEach(cleanup);
const catalog = [
  {
    id: 'example',
    name: 'Example',
    aliases: ['别名'],
    variants: [
      {
        repo: 'owner/model',
        file: 'part-00001-of-00002.gguf',
        quantization: 'Q4_K_M',
        sizeBytes: 12345,
        verifiedAt: '2026-09-25',
      },
    ],
  },
];
it('downloads the catalog file directly without a repository lookup or automatic start', () => {
  const onDownload = vi.fn();
  render(
    <LlamaCppCandidates catalog={catalog} models={[]} locked={false} onDownload={onDownload} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.local.downloadAdd' }));
  expect(onDownload).toHaveBeenCalledWith({
    repo: 'owner/model',
    file: 'part-00001-of-00002.gguf',
  });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unknown' } });
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '别名' } });
  expect(screen.getByRole('button', { name: 'settings.providers.local.downloadAdd' })).toBeTruthy();
});
it('prevents duplicate downloads and disables actions while busy', () => {
  const props = { catalog, models: [], locked: true, onDownload: vi.fn() };
  const { rerender } = render(<LlamaCppCandidates {...props} />);
  expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true);
  rerender(
    <LlamaCppCandidates
      {...props}
      models={[
        { id: 'installed', repo: 'owner/model', file: 'part-00001-of-00002.gguf', size: 12345 },
      ]}
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Example' } });
  expect(screen.getByText('settings.providers.local.alreadyInstalled')).toBeTruthy();
});

it('hides installed primary downloads but keeps them discoverable in search, like Ollama', () => {
  const recommendation = {
    featuredIds: ['example'],
    memoryGb: 256,
    appleSilicon: true,
    chip: 'Apple M5 Ultra',
  };
  render(
    <LlamaCppCandidates
      catalog={catalog}
      models={[
        { id: 'installed', repo: 'owner/model', file: 'part-00001-of-00002.gguf', size: 12345 },
      ]}
      locked={false}
      onDownload={vi.fn()}
      recommendation={recommendation}
    />,
  );
  expect(document.querySelectorAll('article')).toHaveLength(0);
  expect(screen.queryByText('settings.providers.llamacpp.primaryPick')).toBeNull();
  expect(screen.getByText(/Apple M5 Ultra/)).toBeTruthy();
  expect(screen.getByText('settings.providers.local.recommendedInstalled')).toBeTruthy();
  expect(screen.queryByText('settings.providers.local.moreModels')).toBeNull();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Example' } });
  expect(screen.getByText('settings.providers.local.alreadyInstalled')).toBeTruthy();
  expect(document.querySelectorAll('article')).toHaveLength(1);
  expect(screen.queryByText('settings.providers.local.noRecommendation')).toBeNull();
});

it('keeps an active candidate in only one section and restores pause controls', () => {
  const pause = vi.fn(),
    resume = vi.fn(),
    cancel = vi.fn();
  const props = {
    catalog,
    models: [],
    locked: true,
    onDownload: vi.fn(),
    onPause: pause,
    onResume: resume,
    onCancel: cancel,
  };
  const { rerender } = render(
    <LlamaCppCandidates
      {...props}
      download={{
        input: catalog[0]!.variants[0]!,
        progress: { label: 'downloading', completed: 50, total: 100 },
      }}
    />,
  );
  expect(document.querySelectorAll('article')).toHaveLength(1);
  expect(screen.queryByText('settings.providers.local.moreModels')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.local.pauseDownload' }));
  expect(pause).toHaveBeenCalledOnce();
  rerender(
    <LlamaCppCandidates
      {...props}
      download={{
        input: catalog[0]!.variants[0]!,
        progress: { label: 'paused', paused: true, completed: 50, total: 100 },
      }}
    />,
  );
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'unrelated' } });
  expect(document.querySelectorAll('article')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.local.resumeDownload' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.local.cancelDownload' }));
  expect(resume).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
});
