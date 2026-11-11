// @vitest-environment jsdom

import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionInfoMeta } from '../SessionInfoMeta';
import type { SessionPrRef } from '@/lib/gitContext.types';
import type { PrStatusResult } from '@/lib/gitContext.types';

let status: PrStatusResult | undefined;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count != null ? `${key}:${opts.count}` : key,
  }),
}));

vi.mock('@/contexts/PrRefsContext', () => ({
  usePrActions: () => ({ fetchStatusesForSession: vi.fn() }),
  usePrStatus: () => status,
}));

const prRef: SessionPrRef = {
  id: 'pr-ref-1',
  sessionId: 'session-1',
  owner: 'makecindy',
  repo: 'cindy',
  prNumber: 2818,
  url: 'https://github.com/makecindy/cindy/pull/2818',
  firstSeenAt: 0,
  lastSeenAt: 0,
};

afterEach(() => {
  cleanup();
  status = undefined;
  document.documentElement.classList.remove('dark');
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty('--sidebar');
  document.documentElement.style.removeProperty('--sidebar-item-active');
});

beforeEach(() => {
  document.documentElement.classList.add('dark');
});

describe('SessionInfoMeta PR 徽标', () => {
  it('open + 未解决 thread 时打角点,夜间未选中用深表面绿', () => {
    status = {
      ok: true,
      owner: prRef.owner,
      repo: prRef.repo,
      prNumber: prRef.prNumber,
      status: 'open',
      title: 'demo',
      htmlUrl: prRef.url,
      branch: 'feat/demo',
      unresolvedCount: 3,
    };

    const { container } = render(
      createElement(SessionInfoMeta, {
        pieces: [{ key: 'pr', text: '' }],
        prRef,
        isActive: false,
      }),
    );

    expect(screen.getByText('#2818')).toBeTruthy();
    expect(screen.getByTitle(/unresolved:3/)).toBeTruthy();
    const icon = container.querySelector('svg');
    expect(icon).toBeTruthy();
    expect((icon as SVGElement).style.color).toBe('var(--pr-open-on-dark)');
    expect(container.querySelector('[aria-hidden].rounded-full')).toBeTruthy();
  });

  it('夜间选中改走浅表面绿', () => {
    status = {
      ok: true,
      owner: prRef.owner,
      repo: prRef.repo,
      prNumber: prRef.prNumber,
      status: 'open',
      title: 'demo',
      htmlUrl: prRef.url,
      branch: 'feat/demo',
      unresolvedCount: 0,
    };

    const { container } = render(
      createElement(SessionInfoMeta, {
        pieces: [{ key: 'pr', text: '' }],
        prRef,
        isActive: true,
      }),
    );

    const icon = container.querySelector('svg');
    expect((icon as SVGElement).style.color).toBe('var(--pr-open-on-light)');
    expect(container.querySelector('[aria-hidden].rounded-full')).toBeNull();
  });

  it('merged 即使还有 thread 也不打点', () => {
    status = {
      ok: true,
      owner: prRef.owner,
      repo: prRef.repo,
      prNumber: prRef.prNumber,
      status: 'merged',
      title: 'demo',
      htmlUrl: prRef.url,
      branch: 'feat/demo',
      unresolvedCount: 2,
    };

    const { container } = render(
      createElement(SessionInfoMeta, {
        pieces: [{ key: 'pr', text: '' }],
        prRef,
      }),
    );

    expect(container.querySelector('[aria-hidden].rounded-full')).toBeNull();
  });

  it('同模式切主题只改 data-theme 时重读选中表面', async () => {
    status = {
      ok: true,
      owner: prRef.owner,
      repo: prRef.repo,
      prNumber: prRef.prNumber,
      status: 'open',
      title: 'demo',
      htmlUrl: prRef.url,
      branch: 'feat/demo',
      unresolvedCount: 0,
    };
    document.documentElement.style.setProperty('--sidebar-item-active', '0.0 0.0% 93.3%');

    const { container } = render(
      createElement(SessionInfoMeta, {
        pieces: [{ key: 'pr', text: '' }],
        prRef,
        isActive: true,
      }),
    );
    expect((container.querySelector('svg') as SVGElement).style.color).toBe(
      'var(--pr-open-on-light)',
    );

    document.documentElement.style.setProperty('--sidebar-item-active', '0.0 0.0% 18.0%');
    document.documentElement.dataset.theme = 'monokai-pro';

    await waitFor(() => {
      expect((container.querySelector('svg') as SVGElement).style.color).toBe(
        'var(--pr-open-on-dark)',
      );
    });
  });
});
