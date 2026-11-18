/**
 * Regression coverage for the market Plugin detail view's explicit same-ID
 * replacement action and its data-preservation explanation.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string, options?: { value?: string }) => options?.value !== undefined ? `${options.value} ${key}` : key, i18n: { language: 'en' } }),
}));
// The public share action reads the current account; these detail/install cases
// keep it signed out without loading the application's account lifecycle.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isAuthenticated: false, dataOwnerId: null, dataOwnerGeneration: 0 }),
}));

import { MarketPluginDetailView } from '../MarketPluginDetailView';
import type { GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail } from '../../../../shared/pluginMarket';
import { marketDetailCacheFor } from '../lib/marketDetailCache';
import {
  __resetPluginInstallProgressForTest,
  beginPluginInstallProgress,
  failPluginInstallProgress,
  succeedPluginInstallProgress,
} from '../lib/pluginInstallProgress';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'google-calendar',
  name: 'Google Calendar',
  version: '1.3.11',
  kind: 'chip',
  entry: 'main.js',
  notify: true,
};

const detail: PluginMarketDetail = {
  pluginId: 'release-google-calendar',
  ghostId: 'google-calendar',
  name: 'Google Calendar',
  description: 'Connect Google Calendar',
  author: 'Cindy',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'release-1',
  version: '1.3.11',
  publishedAt: '2026-07-25T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  sourceType: 'server',
  sourceMarketName: null,
  manifest,
};

const renderDetail = (overrides: Partial<PluginMarketDetail> = {}) =>
  render(
    <MarketPluginDetailView
      detail={{ ...detail, ...overrides }}
      busy={false}
      onBack={vi.fn()}
      onInstall={vi.fn()}
      onIconLoadError={vi.fn()}
    />,
  );

describe('MarketPluginDetailView', () => {
  // Unit / user-feedback-1: actual rendered markup is compiled with the same
  // Tailwind dependency, then measured via computed style. The old loading test
  // only checked identity/buttons and missed a reserved height after completion.
  it.each([0, 4])('releases introduction placeholder height after a null README and %i tools finish loading', async count => {
    const { container } = renderDetail({ readme: null, manifest: { ...manifest,
      tools: Array.from({ length: count }, (_, index) => ({ name: `tool-${index}`, description: 'A tool' })) } });
    const { css } = await postcss([tailwindcss({ content: [{ raw: container.innerHTML, extension: 'html' }],
      corePlugins: { preflight: false } })]).process('@tailwind utilities;', { from: undefined });
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    try {
      const security = screen.getByRole('heading', { name: 'settings.ghosts.market.securityTitle' }).closest('section')!;
      const preceding = security.previousElementSibling!;
      expect(Number.parseFloat(getComputedStyle(preceding).minHeight) || 0).toBe(0);
    } finally { style.remove(); }
  });

  // Unit / unified loading design: real cache reads must stay bounded and cannot
  // carry a manifest into a new owner/language partition. No prior cache cases.
  it('evicts the least recently used detail at 50 entries and clears on scope changes', async () => {
    const cache = marketDetailCacheFor('cache-owner-A/en');
    for (let index = 0; index < 50; index++) {
      await cache.load(String(index), async () => ({ ...detail, pluginId: String(index) }));
    }
    cache.peek('0');
    await cache.load('50', async () => ({ ...detail, pluginId: '50' }));
    expect(cache.peek('0')).toBeTruthy();
    expect(cache.peek('1')).toBeUndefined();
    expect(marketDetailCacheFor('cache-owner-A/zh-CN').peek('0')).toBeUndefined();
    expect(marketDetailCacheFor('cache-owner-B/zh-CN').peek('0')).toBeUndefined();
  });
  // Unit / PR review G2: README images have no digest in the renderer mapping.
  // Existing icon-renewal tests miss a plugin without an icon whose signed
  // README URL changes after expiry. Both opening and background reads must
  // deliver that renewed address to the existing README component.
  it.each(['open', 'background', 'prefetch'] as const)('renews signed README images on a stale %s read', async mode => {
    const cache = marketDetailCacheFor(`readme-renewal-${mode}`);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    try {
      const readme = { path: 'README.md', markdown: '![Guide](guide.png)', images: { 'guide.png': 'https://images.invalid/guide.png?signature=expired' } };
      await cache.load(detail.pluginId, async () => ({ ...detail, readme }));
      clock.mockReturnValue(41_000);
      const renewed = { ...readme, images: { 'guide.png': 'https://images.invalid/guide.png?signature=renewed' } };
      const result = await cache.load(detail.pluginId, async () => ({ ...detail, readme: renewed }), mode);
      expect(result.readme?.images['guide.png']).toBe(renewed.images['guide.png']);
      expect(cache.peek(detail.pluginId)?.readme).toBe(result.readme);
      const unchanged = await cache.load(detail.pluginId, async () => ({ ...detail, readme: { ...renewed } }), 'background');
      expect(unchanged).toBe(result);
    } finally { clock.mockRestore(); }
  });
  // Unit / plugin-page-ux-fix: only a pending IPC with a catalog summary exposes
  // the old whole-page wait; existing cases all pass a complete manifest.
  it('delays loading feedback, keeps identity nodes, and never presents unknown permissions as empty', () => {
    vi.useFakeTimers();
    try {
      const item = { ...detail, manifest: undefined };
      const props = { busy: false, onBack: vi.fn(), onInstall: vi.fn(), onIconLoadError: vi.fn() };
      const { rerender } = render(<MarketPluginDetailView {...props} detail={item} />);
      const heading = screen.getByRole('heading', { level: 1, name: detail.name });
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', true);
      expect(screen.queryByText('settings.ghosts.market.noPermissions')).toBeNull();
      act(() => { vi.advanceTimersByTime(299); });
      expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.detailLoading' })).toBeNull();
      act(() => { vi.advanceTimersByTime(1); });
      expect(screen.getByRole('button', { name: 'settings.ghosts.remote.detailLoading' })).toHaveProperty('disabled', true);
      rerender(<MarketPluginDetailView {...props} detail={detail} />);
      expect(screen.getByRole('heading', { level: 1, name: detail.name })).toBe(heading);
      expect(screen.getByRole('button', { name: 'settings.ghosts.market.install' })).toHaveProperty('disabled', false);
    } finally { vi.useRealTimers(); }
  });
  it('shows real download and use counts in the gray header of an uninstalled plugin', () => {
    const { container } = renderDetail({
      downloadStatistics: { requestCount: '0' },
      usageStatistics: { usageCount: '8932', usageCountLast7Days: '12', asOf: '2026-10-13T00:00:00Z' },
    });
    const header = container.querySelector('header');
    expect(header?.textContent).toContain('v1.3.11');
    expect(header?.textContent).toContain('0 settings.ghosts.usage.downloadsValue');
    expect(header?.textContent).toContain('8,932 settings.ghosts.usage.usesValue');
    expect(container.textContent).not.toContain('settings.ghosts.usage.title');
  });

  it('puts purpose and capabilities before version changes, which start collapsed', () => {
    renderDetail({ manifest: { ...manifest, releaseNotes: 'Changes in 1.3.11', tools: [{ name: 'calendar', description: 'Read events' }] } });
    const summary = screen.getByText('settings.ghosts.contribution.versionUpdates');
    const updates = summary.closest('details')!;
    expect(updates.open).toBe(false);
    expect(screen.getByText('Connect Google Calendar').compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('calendar').compareDocumentPosition(updates) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'settings.ghosts.contribution.releaseNotes · 1.3.11' }).closest('details')).toBe(updates);
    fireEvent.click(summary);
    expect(screen.getByRole('heading', { name: 'settings.ghosts.contribution.releaseNotes · 1.3.11' })).toBeTruthy();
  });

  it('shows the marketing description outside the conflict state', () => {
    renderDetail();
    const description = screen.getByText('Connect Google Calendar');
    expect(description.id).toBe('');
    expect(
      screen
        .getByRole('button', { name: /settings\.ghosts\.market\.install/ })
        .getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('presents server catalog permissions before the package is downloaded', () => {
    renderDetail();
    expect(screen.getByText('settings.ghosts.perm.grantsTitle')).toBeTruthy();
  });

  it('offers an explicit same-id replacement and binds its explanation to the action', () => {
    renderDetail({ installState: 'conflict' });

    const reason = screen.getByText('settings.ghosts.market.replaceDescription');
    expect(reason.id).toBeTruthy();
    // 替换提示不能遮掉插件本身的用途。
    expect(screen.getByText('Connect Google Calendar')).toBeTruthy();

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.replace$/,
    }) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('falls back to the ghostId when a plugin has no description', () => {
    renderDetail({ description: null });
    expect(screen.getByText('google-calendar')).toBeTruthy();
  });

  it('hides the install action when the host does not provide one', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy={false}
        onBack={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /settings\.ghosts\.market\.install/ })).toBeNull();
  });

  // 测试价值
  // - 生产入口与可观察结果：市场详情页的安装按钮位置；本机插件页显示本窗口发起的首装进度，
  //   完成写「已安装」，失败写「安装失败」并给出「重试」；远程设备页不显示本机进度。
  // - Bug／规则依据：verified-downloads.md「下载进度与界面」插件市场首装此前只有按钮转圈。
  // - 现有覆盖缺口：页面导航用例只走完整流程，不覆盖远程页不接本机进度这一分支。
  // - 最小失败输入：首装进行中、完成、失败（带原因，PR #11305 评审：单项失败原因不能只留在提示里）
  //   三种状态 × showInstallProgress 开 / 关。
  // - tier：unit（jsdom，直接驱动窗口级进度）。
  it.each([
    { name: 'shows a first install in progress', showInstallProgress: true, step: 'running', ring: 'downloadProgress.phase.preparing', button: null },
    { name: 'says Installed when a first install lands', showInstallProgress: true, step: 'done', ring: 'settings.ghosts.market.installed', button: null },
    { name: 'keeps the reason and offers a retry when it fails', showInstallProgress: true, step: 'failed', ring: 'Download timed out', button: 'commonUi.retry' },
    { name: 'leaves a remote computer\'s view untouched', showInstallProgress: false, step: 'running', ring: null, button: 'settings.ghosts.market.install' },
  ] as const)('$name', ({ showInstallProgress, step, ring, button }) => {
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pluginMarket: { onInstallProgress: () => () => undefined },
    };
    act(() => {
      beginPluginInstallProgress(detail.pluginId, 'install');
      if (step === 'done') succeedPluginInstallProgress(detail.pluginId);
      // The same translated words the failure toast showed; the detail page has room to keep them.
      if (step === 'failed') failPluginInstallProgress(detail.pluginId, 'Download timed out');
    });
    try {
      render(
        <MarketPluginDetailView
          detail={detail}
          busy={false}
          showInstallProgress={showInstallProgress}
          onBack={vi.fn()}
          onInstall={vi.fn()}
          onIconLoadError={vi.fn()}
        />,
      );
      expect(screen.queryByRole('progressbar', { name: detail.name })?.textContent ?? null).toBe(ring);
      // The ring takes the button's place while running and when done; a failure brings back a retry.
      expect(screen.queryByRole('button', { name: 'settings.ghosts.market.install' }) !== null)
        .toBe(button === 'settings.ghosts.market.install');
      expect(screen.queryByRole('button', { name: 'commonUi.retry' }) !== null).toBe(button === 'commonUi.retry');
    } finally {
      act(() => __resetPluginInstallProgressForTest());
    }
  });

  it('replaces the install action with a spinner while busy', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.install/,
    });
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.querySelector('.animate-spinner')).toBeTruthy();
    // Preserve the label width and accessible name while only the spinner is visible.
    expect(action.firstElementChild?.classList.contains('opacity-0')).toBe(true);
    expect(action.firstElementChild?.textContent).toContain('settings.ghosts.market.install');
    expect(action.lastElementChild?.getAttribute('aria-hidden')).toBe('true');
    expect(action.hasAttribute('disabled')).toBe(true);
  });
});
