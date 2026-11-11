// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import zhCN from '@/i18n/locales/zh-CN/common.json';
import en from '@/i18n/locales/en/common.json';
import zhTW from '@/i18n/locales/zh-TW/common.json';
import ja from '@/i18n/locales/ja/common.json';
import ko from '@/i18n/locales/ko/common.json';
import { CindyMakeSyncStatus } from '../CindyMakeSync';
import {
  CINDY_MAKE_SYNC_ERRORS,
  CINDY_MAKE_SYNC_STEPS,
  type CindyMakeSyncState,
  type CindyMakeSyncWaiting,
} from '../../../../shared/cindyMakeSync';

const locales = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko };
async function show(
  state: CindyMakeSyncState,
  locale: keyof typeof locales = 'zh-CN',
  props: Partial<Parameters<typeof CindyMakeSyncStatus>[0]> = {},
) {
  const i18n = createInstance();
  await i18n.init({
    lng: locale,
    fallbackLng: false,
    interpolation: { escapeValue: false },
    resources: { [locale]: { translation: locales[locale] } },
  });
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <CindyMakeSyncStatus state={state} {...props} />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

afterEach(cleanup);

const waits: CindyMakeSyncWaiting[] = [
  { kind: 'combine', reason: 'working', sessionId: 'task' },
  { kind: 'official', reason: 'working', sessionId: 'task' },
  { kind: 'official', reason: 'input', sessionId: 'task' },
  { kind: 'official', reason: 'interrupted', sessionId: 'task' },
  { kind: 'combine', reason: 'interrupted' },
  { kind: 'combine', reason: 'missing', missing: 3, sessionId: 'task' },
  { kind: 'official', reason: 'stale', sessionId: 'task' },
  { kind: 'official', reason: 'failed', sessionId: 'task' },
  { kind: 'official', reason: 'working', abandoning: true },
  { kind: 'combine', reason: 'paused', sessionId: 'task' },
  { kind: 'official', reason: 'otherAccount' },
];

describe('Sync status line', () => {
  it('says which official version Sync reached and what waits for a Cindy update', async () => {
    await show({ done: { at: 1, ref: 'v1.2.0', held: 'v1.3.0' } });
    expect(screen.getByText('已同步到官方 v1.2.0')).toBeTruthy();
    expect(screen.getByText(/官方 v1\.3\.0 已发布/)).toBeTruthy();
    // Polite live text; the version summary keeps the single status region.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows the running step and the conflict it waits for in plain words', async () => {
    const running = await show({ running: true, step: 'combine' });
    expect(running.container.textContent).toBe(zhCN.cindyMake.sync.step.combine);
    running.unmount();
    const waiting = await show({ waiting: waits[0] });
    expect(waiting.container.textContent).toContain(zhCN.cindyMake.sync.waiting.working.combine);
    expect(screen.getByRole('button', { name: zhCN.cindyMake.merge.openTask })).toBeTruthy();
  });

  it('offers abandoning the operation Sync waits for', async () => {
    const onAbandon = vi.fn();
    await show({ waiting: waits[1] }, 'zh-CN', { onAbandon });
    fireEvent.click(screen.getByRole('button', { name: zhCN.cindyMake.sync.abandon.action }));
    expect(onAbandon).toHaveBeenCalledOnce();
  });

  it('lets the user use a result that lost changes, and says how many', async () => {
    const onAccept = vi.fn();
    const { container } = await show({ waiting: waits[5] }, 'zh-CN', { onAccept });
    expect(container.textContent).toContain('少了 3 项');
    fireEvent.click(screen.getByRole('button', { name: zhCN.cindyMake.sync.accept.action }));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it('continues an operation whose task is gone, and leaves another account’s alone', async () => {
    const onResume = vi.fn();
    const paused = await show({ waiting: waits[9] }, 'zh-CN', { onResume, onAbandon: vi.fn() });
    expect(screen.queryByRole('button', { name: zhCN.cindyMake.merge.openTask })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: zhCN.cindyMake.sync.resume }));
    expect(onResume).toHaveBeenCalledOnce();
    paused.unmount();
    await show({ waiting: waits[10] }, 'zh-CN', { onResume, onAbandon: vi.fn() });
    expect(screen.getByText(zhCN.cindyMake.sync.waiting.otherAccount)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers nothing but progress while Abandon is carried out', async () => {
    await show({ waiting: waits[8] }, 'zh-CN', { onAbandon: vi.fn(), onAccept: vi.fn() });
    expect(screen.getByText(zhCN.cindyMake.sync.waiting.abandoning)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('points to generating when the personal version changed since it was generated', async () => {
    const onGenerate = vi.fn();
    await show({ done: { at: 1, ref: 'v1.2.0' } }, 'zh-CN', { needsGenerate: true, onGenerate });
    expect(screen.getByText(zhCN.cindyMake.sync.needsGenerate)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: zhCN.cindyMake.history.generatePersonal }),
    );
    expect(onGenerate).toHaveBeenCalledOnce();
  });

  it('offers keeping one side when the two versions cannot be combined', async () => {
    const onKeep = vi.fn();
    const { unmount } = await show({ error: 'diverged' }, 'zh-CN', { onKeep });
    fireEvent.click(screen.getByRole('button', { name: zhCN.cindyMake.sync.keep.local }));
    expect(onKeep).toHaveBeenCalledWith('local');
    unmount();
    // Not after an abandoned official update: there is nothing to choose between.
    await show({ error: 'cancelled', abandoned: 'official' }, 'zh-CN', { onKeep });
    expect(screen.queryByRole('button', { name: zhCN.cindyMake.sync.keep.github })).toBeNull();
  });

  it('keeps the completed local update visible above a GitHub problem', async () => {
    const { container } = await show({ error: 'github', done: { at: 1, ref: 'v1.2.0' } });
    expect(container.textContent).toContain('已同步到官方 v1.2.0');
    expect(container.textContent).toContain(zhCN.cindyMake.sync.errors.github);
  });

  it('explains a personal version already ahead of this computer’s Cindy', async () => {
    const { container } = await show({ done: { at: 1, ahead: true } });
    expect(container.textContent).toContain(zhCN.cindyMake.sync.doneCurrent);
    expect(container.textContent).toContain(zhCN.cindyMake.sync.ahead);
  });

  it.each(Object.keys(locales) as (keyof typeof locales)[])(
    'has complete copy for every step, wait and error in %s',
    async (locale) => {
      const states: CindyMakeSyncState[] = [
        ...CINDY_MAKE_SYNC_STEPS.map((step) => ({ running: true, step })),
        ...waits.map((waiting) => ({ waiting })),
        ...CINDY_MAKE_SYNC_ERRORS.map((error) => ({ error })),
        { done: { at: 1, ref: 'main' } },
        { done: { at: 1, ref: 'v1.2.0', held: 'v1.3.0' } },
        { done: { at: 1, ahead: true } },
        { done: { at: 1, ref: 'v1.2.0', uploadAfterBuild: true } },
        { done: { at: 1, ref: 'v1.2.0', buildFirst: true } },
        { error: 'cancelled', abandoned: 'combine' },
        { done: { at: 1, generateFirst: 'v1.3.0' } },
      ];
      for (const state of states) {
        const { container, unmount } = await show(state, locale, {
          onAbandon: () => undefined,
          onAccept: () => undefined,
          needsGenerate: true,
          onGenerate: () => undefined,
          onKeep: () => undefined,
          onResume: () => undefined,
        });
        expect(container.textContent?.trim(), JSON.stringify(state)).toBeTruthy();
        expect(container.textContent).not.toMatch(/cindyMake\.|\{\{/);
        unmount();
      }
    },
  );
});
