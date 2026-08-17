// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SplashScreen wave4 统一面板版测试(implementation-plan Step 3b WHAT1/WHAT3)。
 *
 * 承载 state-manifest slice=pr2b 的 Splash 行映射(六可见态 style 行 + 三失败
 * 弹窗 state 行 + splash-chain state/copy 行),测试名 = manifest testId。
 * 静态样式基准 = wave4 五帧(379:581/525/607/633/655,figma §10.3);
 * 文案 = 现网 splash.* / splash.tips.* key verbatim(t mock 回显 key,断言 key 名)。
 */

const mocks = vi.hoisted(() => ({
  splash: {
    phase: 'splash_checking' as string,
    isDownloading: false,
    downloadProgress: 0,
    downloadInfo: { progress: 0 } as {
      progress: number;
      speed?: string;
      downloaded?: string;
      total?: string;
    },
    resetSignal: 0,
    tipsText: null as string | null,
    tipsClickable: false,
    tipsDestructive: false,
    showManifestFailedDialog: false,
    showDownloadFailedDialog: false,
    showSpawnFailedDialog: false,
    updateVersion: undefined as string | undefined,
    onRetryManifest: vi.fn(),
    onRetryDownload: vi.fn(),
    onSpawnFailedDownload: vi.fn(),
    onTipsClick: vi.fn(),
    onTransitionEnd: vi.fn(),
    skipSplash: vi.fn(),
  },
  env: { step: undefined as 1 | 2 | undefined, totalSteps: undefined as 2 | undefined },
  coverHeld: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// useSplash 模块整体 mock(避免传递性引入 AuthContext 重依赖;fixture helper 在
// 本测试中不使用——显示 phase 直接经 mocks.splash.phase 驱动,与 dev fixture 通道
// 的映射语义已由 useSplashFixture.test.ts 单独锚定)。
vi.mock('@/hooks/useSplash', () => ({
  useSplash: () => mocks.splash,
  readSplashPhaseFixture: () => null,
  splashPhaseForFixture: (value: string) =>
    value === 'failed' ? 'splash_failed' : `splash_${value}`,
  SPLASH_PHASE_FIXTURE_VALUES: [
    'checking_update',
    'updating',
    'update_done',
    'checking',
    'downloading',
    'failed',
    'manifest_failed',
    'download_failed',
    'spawn_failed',
  ],
}));

vi.mock('@/contexts/EnvCheckContext', () => ({
  useEnvCheck: () => ({ step: mocks.env.step, totalSteps: mocks.env.totalSteps }),
}));

vi.mock('@/contexts/AppShellCoverContext', () => ({
  useAppShellCover: () => ({ coverHeld: mocks.coverHeld, reportLocalDbGate: () => {} }),
}));

vi.mock('@/components/title-bar/WindowControls', () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));

import { SplashScreen } from '../SplashScreen';

function setPhase(phase: string) {
  mocks.splash.phase = phase;
  mocks.splash.isDownloading = phase === 'splash_updating' || phase === 'splash_downloading';
  mocks.splash.showManifestFailedDialog = phase === 'splash_manifest_failed';
  mocks.splash.showDownloadFailedDialog = phase === 'splash_download_failed';
  mocks.splash.showSpawnFailedDialog = phase === 'splash_spawn_failed';
}

function renderSplash(phase: string) {
  setPhase(phase);
  return render(<SplashScreen />);
}

function panel(): HTMLElement {
  return screen.getByTestId('splash-panel');
}

/** 面板承载几何:登录同款白面板(680×440 r36,wave4 描边 token)。 */
function expectUnifiedPanel() {
  const p = panel();
  expect(p.style.width).toBe('680px');
  expect(p.style.height).toBe('440px');
  expect(p.style.borderRadius).toBe('36px');
  expect(p.style.background).toContain('var(--login-panel-bg)');
  expect(p.style.boxShadow).toContain('inset 0 0 0 1px var(--login-panel-border)');
}

/** spinner 64×64 @面板内(308,188),内弧 token;动画挂 HTML wrapper(规则 7)。 */
function expectSpinner() {
  const ring = screen.getByTestId('splash-loading-ring');
  expect(ring.tagName).toBe('SPAN');
  expect(ring.className).toContain('animate-spin');
  expect(ring.className).toContain('motion-reduce:animate-none');
  expect(ring.style.left).toBe('308px');
  expect(ring.style.top).toBe('188px');
  expect(ring.style.width).toBe('64px');
  expect(ring.style.height).toBe('64px');
  expect(ring.style.borderTopColor).toContain('var(--login-secondary-text)');
}

beforeEach(() => {
  mocks.env.step = undefined;
  mocks.env.totalSteps = undefined;
  mocks.splash.downloadProgress = 0;
  mocks.splash.downloadInfo = { progress: 0 };
  mocks.splash.resetSignal = 0;
  mocks.coverHeld = false;
  setPhase('splash_checking');
  document.documentElement.removeAttribute('data-splash-active');
  (window as unknown as { electronAPI: { platform: string } }).electronAPI = {
    platform: 'darwin',
  };
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-splash-active');
  vi.clearAllMocks();
});

describe('SplashScreen wave4 统一面板', () => {
  it('checking_update:统一面板 + 现网 checkingUpdate 文案 + spinner(379:581 样式)', () => {
    renderSplash('splash_checking_update');
    expectUnifiedPanel();
    expectSpinner();
    expect(screen.getByText('splash.tips.checkingUpdate')).toBeTruthy();
    expect(screen.queryByTestId('splash-progress-track')).toBeNull();
  });

  it('updating:进度条 轨 501×16 r12 @(90,346) token + 填充 + 明细行 20px(379:525 样式)', () => {
    mocks.splash.downloadProgress = 38;
    mocks.splash.downloadInfo = {
      progress: 38,
      speed: '3.2 MB/s',
      downloaded: '24.8 MB',
      total: '65.3 MB',
    };
    renderSplash('splash_updating');
    expectUnifiedPanel();
    expectSpinner();
    expect(screen.getByText('splash.tips.updating')).toBeTruthy();

    const track = screen.getByTestId('splash-progress-track');
    expect(track.style.left).toBe('90px');
    expect(track.style.top).toBe('346px');
    expect(track.style.width).toBe('501px');
    expect(track.style.height).toBe('16px');
    expect(track.style.borderRadius).toBe('12px');
    expect(track.style.background).toContain('var(--login-splash-progress-track)');

    const fill = screen.getByTestId('splash-progress-fill');
    expect(fill.style.width).toBe('38%');
    expect(fill.style.background).toContain('var(--login-splash-progress-fill)');

    const stats = screen.getByTestId('splash-progress-stats');
    expect(stats.style.fontSize).toBe('20px');
    expect(stats.style.left).toBe('41px');
    expect(stats.style.top).toBe('375px');
    expect(stats.textContent).toContain('38%');
    expect(stats.textContent).toContain('3.2 MB/s');
    expect(stats.textContent).toContain('24.8 MB');
    expect(stats.textContent).toContain('65.3 MB');
  });

  it('update_done:统一面板 + 现网 updateDone 文案 + spinner(379:607 样式)', () => {
    renderSplash('splash_update_done');
    expectUnifiedPanel();
    expectSpinner();
    expect(screen.getByText('splash.tips.updateDone')).toBeTruthy();
    expect(screen.queryByTestId('splash-progress-track')).toBeNull();
  });

  it('checking:统一面板 + 现网 checkingEnv 文案 + spinner(379:633 样式)', () => {
    renderSplash('splash_checking');
    expectUnifiedPanel();
    expectSpinner();
    expect(screen.getByText('splash.tips.checkingEnv')).toBeTruthy();
    expect(screen.queryByTestId('splash-progress-track')).toBeNull();
  });

  it('downloading:复用更新下载态面板形态 + 现网 waking 文案与 (x/2) 标签(379:525 复用)', () => {
    mocks.env.step = 1;
    mocks.env.totalSteps = 2;
    mocks.splash.downloadProgress = 12;
    renderSplash('splash_downloading');
    expectUnifiedPanel();
    expectSpinner();
    // D 场景 (x/2) 标签;文案 = 现网 splash.tips.waking verbatim(§8.1 延展,无专属帧)
    expect(screen.getByText('splash.tips.waking(1/2)')).toBeTruthy();
    expect(screen.getByTestId('splash-progress-track')).toBeTruthy();
    expect(screen.getByTestId('splash-progress-fill').style.width).toBe('12%');
  });

  it('failed:标题「环境初始化失败」+ 主按钮「重试」540×80@70,300 → checkEnvironment(379:655 样式)', () => {
    renderSplash('splash_failed');
    expectUnifiedPanel();
    // 取代旧白字下划线交互:无 spinner,标题 + 主按钮
    expect(screen.queryByTestId('splash-loading-ring')).toBeNull();
    expect(screen.getByText('splash.envFailed.title')).toBeTruthy();

    const retry = screen.getByTestId('splash-retry-button');
    expect(retry.textContent).toContain('splash.envFailed.retry');
    expect(retry.style.left).toBe('70px');
    expect(retry.style.top).toBe('300px');
    expect(retry.style.width).toBe('540px');
    expect(retry.style.height).toBe('80px');
    fireEvent.click(retry);
    expect(mocks.splash.onTipsClick).toHaveBeenCalledTimes(1);
  });

  it('manifest_failed:统一面板视觉 + 现网文案 + CTA=重试动作(onRetryManifest)', () => {
    renderSplash('splash_manifest_failed');
    expectUnifiedPanel();
    expect(screen.getByText('splash.manifestFailed.title')).toBeTruthy();
    expect(screen.getByText('splash.manifestFailed.description')).toBeTruthy();
    const cta = screen.getByTestId('splash-manifest-failed-cta');
    expect(cta.textContent).toContain('splash.manifestFailed.confirm');
    fireEvent.click(cta);
    expect(mocks.splash.onRetryManifest).toHaveBeenCalledTimes(1);
    expect(mocks.splash.onSpawnFailedDownload).not.toHaveBeenCalled();
  });

  it('download_failed:统一面板视觉 + 现网文案 + CTA=重试动作(onRetryDownload)', () => {
    renderSplash('splash_download_failed');
    expectUnifiedPanel();
    expect(screen.getByText('splash.downloadFailed.title')).toBeTruthy();
    expect(screen.getByText('splash.downloadFailed.description')).toBeTruthy();
    const cta = screen.getByTestId('splash-download-failed-cta');
    expect(cta.textContent).toContain('splash.downloadFailed.confirm');
    fireEvent.click(cta);
    expect(mocks.splash.onRetryDownload).toHaveBeenCalledTimes(1);
    expect(mocks.splash.onSpawnFailedDownload).not.toHaveBeenCalled();
  });

  it('spawn_failed:统一面板视觉 + CTA=「前往下载」onSpawnFailedDownload,禁 retry(v6.12/v6.14)', () => {
    renderSplash('splash_spawn_failed');
    expectUnifiedPanel();
    expect(screen.getByText('splash.spawnFailed.title')).toBeTruthy();
    expect(screen.getByText('splash.spawnFailed.description')).toBeTruthy();
    const cta = screen.getByTestId('splash-spawn-failed-cta');
    expect(cta.textContent).toContain('splash.spawnFailed.confirm');
    fireEvent.click(cta);
    // spawn 的 CTA 语义沿现网「前往下载」:只走下载页动作,绝不触发任何 retry
    expect(mocks.splash.onSpawnFailedDownload).toHaveBeenCalledTimes(1);
    expect(mocks.splash.onRetryManifest).not.toHaveBeenCalled();
    expect(mocks.splash.onRetryDownload).not.toHaveBeenCalled();
    expect(mocks.splash.onTipsClick).not.toHaveBeenCalled();
  });

  it('六可见态遍历:每态渲染统一面板且状态特征互斥(demo 阶段选择器 6 态覆盖)', () => {
    const cases: Array<{ phase: string; text: string; bar: boolean; retry: boolean }> = [
      {
        phase: 'splash_checking_update',
        text: 'splash.tips.checkingUpdate',
        bar: false,
        retry: false,
      },
      { phase: 'splash_updating', text: 'splash.tips.updating', bar: true, retry: false },
      { phase: 'splash_update_done', text: 'splash.tips.updateDone', bar: false, retry: false },
      { phase: 'splash_checking', text: 'splash.tips.checkingEnv', bar: false, retry: false },
      { phase: 'splash_downloading', text: 'splash.tips.waking', bar: true, retry: false },
      { phase: 'splash_failed', text: 'splash.envFailed.title', bar: false, retry: true },
    ];
    for (const c of cases) {
      const view = renderSplash(c.phase);
      expectUnifiedPanel();
      expect(screen.getByText(c.text, { exact: false })).toBeTruthy();
      expect(!!screen.queryByTestId('splash-progress-track')).toBe(c.bar);
      expect(!!screen.queryByTestId('splash-retry-button')).toBe(c.retry);
      // 全程只有一块面板(统一面板化,无第二 panel)
      expect(screen.getAllByTestId('splash-panel').length).toBe(1);
      view.unmount();
    }
  });

  it('splash.* / splash.tips.* 现网 key 5 语齐全(含 envFailed 新 key)', () => {
    const localesDir = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../i18n/locales',
    );
    const required = [
      'tips.checkingUpdate',
      'tips.updating',
      'tips.updateDone',
      'tips.checkingEnv',
      'tips.waking',
      'tips.envFailed',
      'envFailed.title',
      'envFailed.retry',
      'manifestFailed.title',
      'manifestFailed.description',
      'manifestFailed.confirm',
      'downloadFailed.title',
      'downloadFailed.description',
      'downloadFailed.confirm',
      'spawnFailed.title',
      'spawnFailed.description',
      'spawnFailed.confirm',
    ];
    for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
      const json = JSON.parse(
        readFileSync(path.join(localesDir, locale, 'common.json'), 'utf8'),
      ) as { splash: Record<string, unknown> };
      for (const key of required) {
        const value = key
          .split('.')
          .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], json.splash);
        expect(typeof value, `${locale} splash.${key}`).toBe('string');
        expect((value as string).trim().length, `${locale} splash.${key} 非空`).toBeGreaterThan(0);
      }
    }
    // spawn CTA 语义锚:现网「前往下载」verbatim,禁改重试(v6.14)
    const zhCN = JSON.parse(readFileSync(path.join(localesDir, 'zh-CN', 'common.json'), 'utf8'));
    expect(zhCN.splash.spawnFailed.confirm).toBe('前往下载');
  });

  it('根层透明化:白底全盖由品牌层承载,splash 根不再自带背景,fade 契约保留', () => {
    const { container } = renderSplash('splash_checking');
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('style') ?? '').not.toContain('background');
    expect(root.getAttribute('style')).toContain('--splash-fade-duration');
    expect(root.className).toContain('opacity-100');
  });

  it('marks the document as splash-active only before fade out', () => {
    const view = renderSplash('splash_checking');
    expect(document.documentElement.getAttribute('data-splash-active')).toBe('1');

    setPhase('fading_out');
    view.rerender(<SplashScreen />);
    expect(document.documentElement.hasAttribute('data-splash-active')).toBe(false);
  });

  it('removes the splash-active marker on unmount', () => {
    const view = renderSplash('splash_checking');
    expect(document.documentElement.getAttribute('data-splash-active')).toBe('1');
    view.unmount();
    expect(document.documentElement.hasAttribute('data-splash-active')).toBe(false);
  });

  it('splash_done / splash_skipped 渲染 null(生命周期跟真实 phase)', () => {
    const view = renderSplash('splash_done');
    expect(view.container.firstElementChild).toBeNull();
    setPhase('splash_skipped');
    view.rerender(<SplashScreen />);
    expect(view.container.firstElementChild).toBeNull();
  });

  it('LocalDbGate 未就绪时 splash_done 仍保持加载面板(登录后不得露白底)', () => {
    mocks.coverHeld = true;
    renderSplash('splash_done');
    expect(screen.getByTestId('splash-panel')).toBeTruthy();
    expectSpinner();
    expect(screen.getByText('splash.tips.waking')).toBeTruthy();
    expect(document.documentElement.getAttribute('data-splash-active')).toBe('1');
  });

  it('cover 放行后淡出层不拦截点击', () => {
    mocks.coverHeld = true;
    const view = renderSplash('splash_done');
    mocks.coverHeld = false;
    view.rerender(<SplashScreen />);
    expect(screen.getByTestId('splash-root').className).toContain('pointer-events-none');
    expect(screen.getByTestId('splash-root').className).toContain('opacity-0');
  });

  it('reduced-motion 下 cover 放行立即卸载,不留 500ms 透明遮罩', () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: String(query).includes('prefers-reduced-motion'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    mocks.coverHeld = true;
    const view = renderSplash('splash_done');
    expect(screen.getByTestId('splash-panel')).toBeTruthy();
    mocks.coverHeld = false;
    view.rerender(<SplashScreen />);
    expect(view.container.firstElementChild).toBeNull();
  });
});
