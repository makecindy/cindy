// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ImagePickerAsset } from 'expo-image-picker';
import { afterEach, expect, it, vi } from 'vitest';
import { WallpaperProvider } from '@/theme/WallpaperProvider';
import { useWallpaper, type CustomWallpaperFile } from '@/theme/wallpaper';

const storage = vi.hoisted(() => new Map<string, string>());
const discard = vi.hoisted(() => vi.fn(async (_id: string) => {}));
vi.mock('@/theme/customWallpaper', () => {
  const resolve = (file: CustomWallpaperFile) => ({
    ...file, imageUri: 'file:///docs/' + file.id + '/poster.jpg',
    videoUri: file.video ? 'file:///docs/' + file.id + '/loop.mp4' : null,
  });
  return {
    cleanUnusedCustomWallpapers: async () => {},
    prepareCustomWallpaper: async (asset: ImagePickerAsset) => resolve({
      id: asset.type || 'image', width: 1200, height: 800, video: asset.type === 'video' ? 'mp4' : null,
    }),
    restoreCustomWallpaper: async (file: CustomWallpaperFile) => resolve(file),
    discardCustomWallpaper: discard,
  };
});
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => { storage.set(key, value); }),
  removeItem: async (key: string) => { storage.delete(key); },
} }));
vi.mock('react-native', () => ({ StyleSheet: { create: (styles: unknown) => styles } }));
vi.mock('@/theme', () => ({ useTheme: () => ({ mode: 'light' }) }));
afterEach(() => { cleanup(); storage.clear(); vi.clearAllMocks(); });
const mount = () => renderHook(useWallpaper, { wrapper: WallpaperProvider });

// Unit: the settings and screen canvases share this provider. Theme mode tests do
// not cover wallpaper restoration or a late startup read overtaking a new choice.
it('restores the chosen scene after remount and removes its override on None', async () => {
  const first = mount();
  await act(() => first.result.current.select('cindy-whisper'));
  first.unmount();
  const second = mount();
  await waitFor(() => expect(second.result.current.selected).toBe('cindy-whisper'));
  await act(() => second.result.current.select('none'));
  expect(second.result.current.selected).toBe('none');
  expect(storage.size).toBe(0);
});

it('keeps the last tap when storage returns an older scene after selection', async () => {
  let finishRead!: (stored: string) => void;
  vi.mocked(AsyncStorage.getItem).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  const { result } = mount();
  await act(async () => {
    const pending = Promise.all([result.current.select('cindy-neon'), result.current.select('cindy-prism')]);
    finishRead('cindy-whisper');
    await pending;
  });
  expect(result.current.selected).toBe('cindy-prism');
  expect([...storage.values()]).toEqual(['cindy-prism']);
});

it('remembers motion across scenes and restarts, then restores static mode on None', async () => {
  const first = mount();
  await act(() => first.result.current.select('cindy-neon', true));
  await act(() => first.result.current.select('cindy-prism'));
  first.unmount();
  const restored = mount();
  await waitFor(() => expect(restored.result.current.dynamic).toBe(true));
  expect(restored.result.current.selected).toBe('cindy-prism');
  await act(() => restored.result.current.select('none'));
  await act(() => restored.result.current.select('cindy-whisper'));
  expect(restored.result.current.dynamic).toBe(false);
  expect([...storage.values()]).toEqual(['cindy-whisper']);
});

const photo: ImagePickerAsset = { uri: 'file:///picker/photo.jpg', type: 'image', width: 1200, height: 800 };
const video: ImagePickerAsset = { ...photo, type: 'video', uri: 'file:///picker/clip.mp4' };

// Unit: switching to None must keep a custom clip available after restart,
// while explicitly removing the clip must keep an active built-in scene.
it('keeps imported media across None and restart, and releases it on explicit removal', async () => {
  const first = mount();
  await act(() => first.result.current.importCustom(video));
  expect(first.result.current.dynamic).toBe(true);
  await act(() => first.result.current.select('custom', false));
  await act(() => first.result.current.select('none'));
  expect([...storage.values()][0]).not.toContain('file:');
  first.unmount();
  const restored = mount();
  await waitFor(() => expect(restored.result.current.custom?.video).toBe('mp4'));
  expect(restored.result.current.selected).toBe('none');
  await act(() => restored.result.current.select('custom'));
  expect(restored.result.current.dynamic).toBe(false);
  await act(() => restored.result.current.select('cindy-neon'));
  await act(() => restored.result.current.removeCustom());
  expect(discard).toHaveBeenCalledWith('video');
  expect(restored.result.current.custom).toBeNull();
  expect([...storage.values()]).toEqual(['cindy-neon']);
});

// Unit: disk-full during a replacement must preserve the working wallpaper
// and release only the new staging files. The user can still replace it later.
it('preserves the original until a replacement commits and keeps photos static', async () => {
  const { result } = mount();
  await act(() => result.current.importCustom(video));
  vi.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('disk full'));
  await act(async () => { await expect(result.current.importCustom(photo)).rejects.toThrow('disk full'); });
  expect(result.current.custom?.id).toEqual('video');
  expect(discard.mock.calls).toEqual([['image']]);
  await act(() => result.current.importCustom(photo));
  await act(() => result.current.select('custom', true));
  expect(result.current.custom?.id).toEqual('image');
  expect(result.current.dynamic).toBe(false);
  expect(discard.mock.calls).toEqual([['image'], ['video']]);
  await act(() => result.current.removeCustom());
  expect(result.current.selected).toBe('none');
  expect(storage.size).toBe(0);
});
