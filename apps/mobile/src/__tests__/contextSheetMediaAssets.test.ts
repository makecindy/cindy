import { beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ os: 'android' }));
const mediaLibrary = vi.hoisted(() => ({
  getAlbumAsync: vi.fn(),
  getAssetInfoAsync: vi.fn(),
  getAssetsAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
}));
const imageManipulator = vi.hoisted(() => ({
  manipulate: vi.fn(),
}));

vi.mock('react-native', () => ({
  Linking: { openSettings: vi.fn() },
  Platform: { get OS() { return platform.os; } },
}));
vi.mock('expo-media-library/legacy', () => ({
  getAlbumAsync: mediaLibrary.getAlbumAsync,
  getAssetInfoAsync: mediaLibrary.getAssetInfoAsync,
  getAssetsAsync: mediaLibrary.getAssetsAsync,
  getPermissionsAsync: mediaLibrary.getPermissionsAsync,
  MediaType: { photo: 'photo' },
  SortBy: { creationTime: 'creationTime' },
}));
vi.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: imageManipulator.manipulate },
  SaveFormat: { JPEG: 'jpeg' },
}));
vi.mock('@/i18n', () => ({
  i18n: { t: (key: string) => key },
}));

import {
  prefetchContextSheetMediaAssets,
  resolveContextSheetMediaAssetForUpload,
  type ContextSheetMediaAsset,
} from '@/session/useContextSheetMediaAssets';

function asset(overrides: Partial<ContextSheetMediaAsset> = {}): ContextSheetMediaAsset {
  return {
    id: 'asset-1',
    filename: 'Screenshot.png',
    uri: 'content://media/external/images/media/1',
    width: 1080,
    height: 2400,
    ...overrides,
  };
}

beforeEach(() => {
  platform.os = 'android';
  mediaLibrary.getAlbumAsync.mockReset();
  mediaLibrary.getAssetInfoAsync.mockReset();
  mediaLibrary.getAssetsAsync.mockReset();
  mediaLibrary.getPermissionsAsync.mockReset();
  imageManipulator.manipulate.mockReset();
});

describe('prefetchContextSheetMediaAssets', () => {
  it('Android 不读取媒体库,由系统照片选择器承担图片选择', async () => {
    platform.os = 'android';

    await prefetchContextSheetMediaAssets('recent');

    expect(mediaLibrary.getPermissionsAsync).not.toHaveBeenCalled();
    expect(mediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
  });

  it('iOS 受限照片权限不在页面预取时读取资产,避免每次冷启动弹系统提醒', async () => {
    platform.os = 'ios';
    mediaLibrary.getPermissionsAsync.mockResolvedValue({
      accessPrivileges: 'limited',
      granted: true,
    });

    await prefetchContextSheetMediaAssets('recent');

    expect(mediaLibrary.getPermissionsAsync).toHaveBeenCalledWith(false, ['photo']);
    expect(mediaLibrary.getAssetsAsync).not.toHaveBeenCalled();
  });

  it('iOS 完全照片权限仍可静默预取资产', async () => {
    platform.os = 'ios';
    mediaLibrary.getPermissionsAsync.mockResolvedValue({
      accessPrivileges: 'all',
      granted: true,
    });
    mediaLibrary.getAssetsAsync.mockResolvedValue({ assets: [] });

    await prefetchContextSheetMediaAssets('screenshots');

    expect(mediaLibrary.getAssetsAsync).toHaveBeenCalledWith(expect.objectContaining({
      first: 60,
      mediaSubtypes: ['screenshot'],
    }));
  });
});

describe('resolveContextSheetMediaAssetForUpload', () => {
  it('Android 缺少媒体位置权限时回退列表 URI 与尺寸,继续图片上传解析', async () => {
    mediaLibrary.getAssetInfoAsync.mockRejectedValue(Object.assign(
      new Error('Unable to load asset'),
      { code: 'ERR_UNABLE_TO_LOAD' },
    ));

    await expect(resolveContextSheetMediaAssetForUpload(asset())).resolves.toEqual({
      filename: 'Screenshot.png',
      uri: 'content://media/external/images/media/1',
      width: 1080,
      height: 2400,
    });
    expect(mediaLibrary.getAssetInfoAsync).toHaveBeenCalledWith('asset-1');
    expect(imageManipulator.manipulate).not.toHaveBeenCalled();
  });

  it('Android 非 ERR_UNABLE_TO_LOAD 错误继续抛出,不延后真实故障', async () => {
    const failure = Object.assign(new Error('Media library internal failure'), {
      code: 'ERR_INTERNAL',
    });
    mediaLibrary.getAssetInfoAsync.mockRejectedValue(failure);

    await expect(resolveContextSheetMediaAssetForUpload(asset())).rejects.toBe(failure);
  });

  it('正常路径优先使用 full info 的 localUri 与尺寸', async () => {
    mediaLibrary.getAssetInfoAsync.mockResolvedValue({
      localUri: 'file:///storage/emulated/0/Pictures/Screenshot.png',
      width: 1440,
      height: 3200,
    });

    await expect(resolveContextSheetMediaAssetForUpload(asset())).resolves.toEqual({
      filename: 'Screenshot.png',
      uri: 'file:///storage/emulated/0/Pictures/Screenshot.png',
      width: 1440,
      height: 3200,
    });
  });

  it('iOS full info 失败时保留原错误,不把 ph:// 交给上传层', async () => {
    platform.os = 'ios';
    const failure = new Error('iCloud asset unavailable');
    mediaLibrary.getAssetInfoAsync.mockRejectedValue(failure);

    await expect(resolveContextSheetMediaAssetForUpload(asset({
      uri: 'ph://asset-1',
    }))).rejects.toBe(failure);
  });
});
