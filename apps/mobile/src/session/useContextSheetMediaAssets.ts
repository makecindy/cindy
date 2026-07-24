import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';
// SDK 56 起主入口换成 class 式新 API(逐字段异步取值,不适合列表批量渲染);
// 这里走官方保留的 legacy 入口,批量拿 uri/filename 一次到位。
import * as MediaLibrary from 'expo-media-library/legacy';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { i18n } from '@/i18n';
import { MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE } from '@/session/mobileImagePreprocess';

/** Context 面板媒体列表的单个资产(展示 + 附加所需的最小字段)。 */
export interface ContextSheetMediaAsset {
  id: string;
  filename: string;
  /** 展示用 URI(iOS ph:// / Android content://);渲染走 expo-image,RN Image 在新架构下不支持 ph://。 */
  uri: string;
}

export type ContextSheetMediaKind = 'recent' | 'screenshots';

export type ContextSheetMediaStatus =
  | 'idle'
  | 'loading'
  | 'ready'
  | 'denied'
  | 'unavailable';

export interface UseContextSheetMediaAssetsResult {
  status: ContextSheetMediaStatus;
  assets: ContextSheetMediaAsset[];
  /** denied 时重新发起权限请求(系统弹窗或引导去设置)。 */
  requestPermission: () => void;
}

/**
 * 模块级资产缓存:面板内容随 Modal 关闭卸载,hook state 留不住;缓存提到模块层,
 * 重开面板先即刻渲染旧列表、后台刷新覆盖(规则 7,不闪空白)。
 */
const assetsCache = new Map<ContextSheetMediaKind, ContextSheetMediaAsset[]>();

const DEFAULT_FIRST: Record<ContextSheetMediaKind, number> = { recent: 24, screenshots: 60 };

/** 按 kind 拉一页资产(权限已就绪的前提下)。 */
async function fetchAssets(kind: ContextSheetMediaKind, first: number): Promise<ContextSheetMediaAsset[] | null> {
  let album: MediaLibrary.Album | null = null;
  if (kind === 'screenshots' && Platform.OS === 'android') {
    album = await MediaLibrary.getAlbumAsync('Screenshots');
    if (!album) return [];
  }
  const page = await MediaLibrary.getAssetsAsync({
    first,
    mediaType: [MediaLibrary.MediaType.photo],
    sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    ...(kind === 'screenshots' && Platform.OS === 'ios'
      ? { mediaSubtypes: ['screenshot' as MediaLibrary.MediaSubtype] }
      : {}),
    ...(album ? { album } : {}),
  });
  return page.assets.map((asset) => ({
    id: asset.id,
    filename: asset.filename,
    uri: asset.uri,
  }));
}

/**
 * 页面挂载时静默预取(打开面板即刻出图)。只在照片权限已授予时拉取——
 * 绝不在预取时机弹权限框,首次授权仍由面板打开触发;失败静默,面板打开时照常加载。
 */
export async function prefetchContextSheetMediaAssets(kind: ContextSheetMediaKind = 'recent'): Promise<void> {
  if (Platform.OS === 'web' || assetsCache.has(kind)) return;
  try {
    const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
    if (!permission.granted) return;
    const assets = await fetchAssets(kind, DEFAULT_FIRST[kind]);
    if (assets) assetsCache.set(kind, assets);
  } catch {
    // 静默:预取只是加速,不承担错误上报。
  }
}

/**
 * Context 面板的相册资产加载 hook(最近照片条 / 截图列表共用)。
 *
 * enabled 变 true(面板打开)时才请求权限并加载,面板关闭不清缓存——再次打开先显示
 * 旧列表再后台刷新,遵守规则 7(先有内容再刷新,不闪空白帧)。
 * 截图过滤:iOS 用 mediaSubtypes=['screenshot'];Android 找 Screenshots 相册,
 * 找不到则退化为空列表(UI 显示「没有找到截图」)。
 */
export function useContextSheetMediaAssets(input: {
  enabled: boolean;
  kind: ContextSheetMediaKind;
  first?: number;
}): UseContextSheetMediaAssetsResult {
  // 有缓存(预取过 / 开过面板)→ 初始即 ready,即刻渲染;后台刷新静默覆盖。
  const cached = assetsCache.get(input.kind);
  const [status, setStatus] = useState<ContextSheetMediaStatus>(cached ? 'ready' : 'idle');
  const [assets, setAssets] = useState<ContextSheetMediaAsset[]>(cached ?? []);
  const loadSeqRef = useRef(0);
  const first = input.first ?? DEFAULT_FIRST[input.kind];

  const load = useCallback(async (requestIfNeeded: boolean) => {
    const seq = ++loadSeqRef.current;
    if (Platform.OS === 'web') {
      setStatus('unavailable');
      return;
    }
    try {
      let permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
      if (!permission.granted && permission.canAskAgain && requestIfNeeded) {
        permission = await MediaLibrary.requestPermissionsAsync(false, ['photo']);
      }
      if (seq !== loadSeqRef.current) return;
      if (!permission.granted) {
        setStatus('denied');
        return;
      }
      setStatus((current) => (current === 'ready' ? current : 'loading'));
      const next = await fetchAssets(input.kind, first);
      if (seq !== loadSeqRef.current) return;
      const normalized = next ?? [];
      assetsCache.set(input.kind, normalized);
      setAssets(normalized);
      setStatus('ready');
    } catch {
      if (seq !== loadSeqRef.current) return;
      setStatus('unavailable');
    }
  }, [first, input.kind]);

  useEffect(() => {
    if (!input.enabled) return;
    void load(true);
  }, [input.enabled, load]);

  const requestPermission = useCallback(() => {
    void (async () => {
      try {
        const permission = await MediaLibrary.getPermissionsAsync(false, ['photo']);
        if (!permission.granted && !permission.canAskAgain) {
          // 系统照片权限弹窗只弹一次:永久拒绝后再 load 是注定 no-op 的死按钮,
          // 对齐仓库既有做法(openVoiceSettings)直接跳系统设置。
          await Linking.openSettings();
          return;
        }
      } catch {
        // 读权限状态失败时退回正常加载路径(load 内部会再处理)。
      }
      void load(true);
    })();
  }, [load]);

  return { assets, requestPermission, status };
}

/** iOS 相册原生格式;附件白名单与下游模型图像接口都不收,上传前须转 JPEG。 */
const HEIC_EXT_PATTERN = /\.(heic|heif)$/i;
/** HEIC 转 JPEG 的压缩质量(0.9 视觉无损,体积可控)。 */
const HEIC_JPEG_COMPRESS = 0.9;

/**
 * getAssetInfoAsync 的超时兜底:开了「优化 iPhone 储存空间」时,原图可能整张在
 * iCloud 上,这一步会触发系统现场下载——慢网下数十秒是真实场景(与粘贴占位的
 * 超时同口径给 60s),而它自身没有任何超时,挂死会吊住整条上传任务的发送等待。
 * race 超时后系统下载仍在后台继续,用户重试时大概率已就位,重试即成功。
 */
const ASSET_INFO_TIMEOUT_MS = 60_000;

async function getAssetInfoWithTimeout(assetId: string): Promise<MediaLibrary.AssetInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 竞速输家旁路兜底:超时赢了之后底层 getAssetInfoAsync 稍后 reject 的话,
  // 没有 catch 的那份 promise 会抛 unhandled rejection 告警。
  const info = MediaLibrary.getAssetInfoAsync(assetId);
  info.catch(() => undefined);
  try {
    return await Promise.race([
      info,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(i18n.t('interaction.contextSheet.icloudTimeout'))), ASSET_INFO_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把相册资产解析成可上传的 file:// 信息。iOS 的 ph:// 不是文件路径,
 * 必须经 getAssetInfoAsync 换 localUri(带 iCloud 下载超时兜底);iOS 拿不到
 * localUri 时直接报错——ph:// 喂给原生上传层只会变成下游玄学失败,就地把
 * 「照片没就位」说清楚;Android 保留 content:// 回退(原生上传可读)。
 * HEIC / HEIF(iOS 相机默认格式)在这里就地转成 JPEG——附件类型白名单与模型图像
 * 接口都只认 jpeg/png/gif/webp,直接放行 HEIC 会在链路下游变成不可用附件。
 * 转 JPEG 的同一次 manipulate 里顺带把长边压到上传上限(见 mobileImagePreprocess),
 * 避免「先转码再降采样」两次有损编码;optimized=true 告知调用方不必再 preprocess。
 */
export async function resolveContextSheetMediaAssetForUpload(
  asset: ContextSheetMediaAsset,
): Promise<{ uri: string; filename: string; width?: number; height?: number; optimized?: boolean }> {
  const info = await getAssetInfoWithTimeout(asset.id);
  const localUri = info.localUri?.trim();
  if (!localUri && Platform.OS === 'ios') {
    throw new Error(i18n.t('interaction.contextSheet.photoNotReadable'));
  }
  const uri = localUri || asset.uri;
  if (!HEIC_EXT_PATTERN.test(asset.filename) && !HEIC_EXT_PATTERN.test(uri)) {
    return { filename: asset.filename, uri, width: info.width, height: info.height };
  }
  const context = ImageManipulator.manipulate(uri);
  const width = typeof info.width === 'number' ? info.width : 0;
  const height = typeof info.height === 'number' ? info.height : 0;
  if (Math.max(width, height) > MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE) {
    context.resize(width >= height
      ? { width: MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE }
      : { height: MOBILE_IMAGE_UPLOAD_MAX_LONG_EDGE });
  }
  // context / render 结果持有 native GPU 纹理,批量勾选多张 HEIC 时不显式 release
  // 会在 GC 之前持续占用纹理内存(与 mobileImagePreprocess 的 runManipulateNative 同模式)。
  const image = await context.renderAsync();
  try {
    const saved = await image.saveAsync({ compress: HEIC_JPEG_COMPRESS, format: SaveFormat.JPEG });
    const filename = HEIC_EXT_PATTERN.test(asset.filename)
      ? asset.filename.replace(HEIC_EXT_PATTERN, '.jpg')
      : `${asset.filename}.jpg`;
    return { filename, uri: saved.uri, width: saved.width, height: saved.height, optimized: true };
  } finally {
    image.release();
    context.release();
  }
}
