// @vitest-environment jsdom

/**
 * 伙伴「外观」页的自定义壁纸一行。依据：makecindy/cindy#12542 评审（c4430b7）指出的两处缺口，
 * 此前没有任何测试渲染这张页面。
 * - 移除图片的请求还没返回时用户另选了壁纸，返回后不得把新选择改回「跟随应用设置」。
 * - 伙伴自己的视频播放失败要在这张页面给出提示（docs/design-rules/wallpaper.md：
 *   playback failure shows an actionable error in wallpaper settings），且不影响全局壁纸的状态。
 * Tier：unit（jsdom）；经真实的页面组件、壁纸 provider 与 `<video>` 元素，只替换 IPC 桥。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_APPEARANCE_SETTINGS } from '@/../shared/appearanceSettings';
import { WallpaperSettingsProvider } from '@/hooks/useWallpaperSettings';

import { BotAppearanceSettings } from '../BotAppearanceSettings';
import {
  BOT_APPEARANCE_STORAGE_KEY,
  __resetBotAppearanceCacheForTest,
  getBotAppearance,
  setBotAppearance,
  useBotAppearanceOverride,
} from '../botAppearance';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const videoUrl = `cindy-media://client-wallpaper/${'d'.repeat(64)}.mp4`;

function Page({ botId }: { botId: string }) {
  // The drawer sits over the teammate's own view, which holds the override.
  useBotAppearanceOverride(botId);
  return <BotAppearanceSettings botId={botId} />;
}

function stubBridge(extra: Record<string, unknown>) {
  vi.stubGlobal('electronAPI', { appearanceSettings: {
    getSync: () => ({ ...DEFAULT_APPEARANCE_SETTINGS, wallpaperMotion: 'dynamic' }),
    onChanged: () => () => {}, setPatch: vi.fn(),
    ensureWallpaperImage: vi.fn().mockResolvedValue(null),
    getBotWallpapers: vi.fn().mockResolvedValue({ 'bot-1': videoUrl }),
    onBotWallpapersChanged: () => () => {},
    ...extra,
  } });
}

beforeEach(() => {
  __resetBotAppearanceCacheForTest();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  localStorage.setItem(BOT_APPEARANCE_STORAGE_KEY, JSON.stringify({ 'bot-1': { wallpaperId: 'custom' } }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('teammate appearance page: own wallpaper media', () => {
  // Minimal input: removal pending, then another wallpaper is chosen (the row's own
  // onValueChange writes through setBotAppearance), then the removal resolves.
  it('keeps a wallpaper chosen while the image removal is still in flight', async () => {
    let finishRemoval!: (map: Record<string, string>) => void;
    const removeBotWallpaper = vi.fn(() => new Promise<Record<string, string>>((resolve) => { finishRemoval = resolve; }));
    stubBridge({ removeBotWallpaper });
    render(<WallpaperSettingsProvider><Page botId="bot-1" /></WallpaperSettingsProvider>);
    const remove = await screen.findByRole('button', { name: 'settings.appearance.wallpaper.customRemove' });
    fireEvent.click(remove);
    // A second click while the first is pending must not start another removal.
    fireEvent.click(remove);
    act(() => setBotAppearance('bot-1', { wallpaperId: 'night-launch' }));
    await act(async () => { finishRemoval({}); });
    expect(removeBotWallpaper).toHaveBeenCalledOnce();
    expect(getBotAppearance('bot-1').wallpaperId).toBe('night-launch');
  });

  it('returns to following the app when the removed image was still the choice', async () => {
    stubBridge({ removeBotWallpaper: vi.fn().mockResolvedValue({}) });
    render(<WallpaperSettingsProvider><Page botId="bot-1" /></WallpaperSettingsProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.appearance.wallpaper.customRemove' }));
    await waitFor(() => expect(getBotAppearance('bot-1').wallpaperId).toBeUndefined());
  });

  // Review of 00481ae: a slow import wrote "custom" over a wallpaper chosen meanwhile.
  // The wallpaper row is locked until the import or removal returns.
  it('locks the wallpaper choice while an import is in flight', async () => {
    let finishImport!: (map: Record<string, string> | null) => void;
    stubBridge({ importBotWallpaper: vi.fn(() => new Promise((resolve) => { finishImport = resolve; })) });
    render(<WallpaperSettingsProvider><Page botId="bot-1" /></WallpaperSettingsProvider>);
    const wallpaper = () => screen.getByRole('combobox', { name: 'bots.appearance.wallpaper' });
    fireEvent.click(await screen.findByRole('button', { name: 'settings.appearance.wallpaper.customReplace' }));
    expect(wallpaper()).toHaveProperty('disabled', true);
    await act(async () => { finishImport(null); });
    expect(wallpaper()).toHaveProperty('disabled', false);
  });

  // Review of 1cc6c34, docs/design-rules/wallpaper.md (custom MP4 exposes Static / Dynamic):
  // with the app wallpaper at its defaults (none, static) the app's own control is hidden,
  // so a teammate video could never play. Minimal input: default app settings, teammate MP4.
  it('offers still or moving for this teammate’s video without touching the app setting', async () => {
    const setPatch = vi.fn();
    stubBridge({ getSync: () => DEFAULT_APPEARANCE_SETTINGS, setPatch });
    const play = vi.mocked(HTMLMediaElement.prototype.play);
    render(<WallpaperSettingsProvider><Page botId="bot-1" /></WallpaperSettingsProvider>);
    const moving = await screen.findByRole('radio', { name: 'settings.appearance.wallpaper.motionDynamic' });
    expect(play).not.toHaveBeenCalled();
    fireEvent.click(moving);
    expect(getBotAppearance('bot-1').wallpaperMotion).toBe('dynamic');
    await waitFor(() => expect(play).toHaveBeenCalled());
    expect(setPatch).not.toHaveBeenCalled();
  });

  it('offers no motion choice for a still image', async () => {
    stubBridge({ getBotWallpapers: vi.fn().mockResolvedValue({ 'bot-1': videoUrl.replace('.mp4', '.webp') }) });
    vi.stubGlobal('Image', class { src = ''; decode = async () => {}; });
    render(<WallpaperSettingsProvider><Page botId="bot-1" /></WallpaperSettingsProvider>);
    await screen.findByRole('button', { name: 'settings.appearance.wallpaper.customRemove' });
    expect(screen.queryByRole('radio', { name: 'settings.appearance.wallpaper.motionDynamic' })).toBeNull();
  });

  // Minimal input: the teammate's own MP4 fails to play while its page is open.
  it('reports that this teammate’s video cannot play', async () => {
    stubBridge({});
    render(<WallpaperSettingsProvider><Page botId="bot-1" /></WallpaperSettingsProvider>);
    await waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toBe(videoUrl));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.error(document.querySelector('video')!);
    expect((await screen.findByRole('alert')).textContent).toContain('settings.appearance.wallpaper.customPlaybackFailed');
  });
});
