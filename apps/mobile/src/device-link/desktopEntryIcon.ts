/**
 * 把伙伴头像变成桌面组件能画的图标。
 *
 * 优先复用头像来源：预设头像走 App 内置资源，媒体头像走现有 peer 头像缓存或预签名地址；
 * 取不到时退回首字 / emoji，再不行交给原生用应用图标。这里不发账号请求、不存凭证，
 * 也绝不让「图片失败」挡住同步。
 */
import { companionAvatarPreset } from '@/components/companionAvatarPresets';
import {
  desktopEntryGlyph,
  type DesktopEntryAvatar,
} from './desktopEntryModel';

/** 原生只认「图」和「字」；`brand` 表示这份目标没有自带图标，由原生退回应用图标。 */
export type DesktopEntryIcon =
  | { kind: 'image'; pngBase64: string; background?: string }
  | { kind: 'glyph'; text: string; background?: string }
  | { kind: 'brand' };

export interface DesktopEntryIconInput {
  avatar?: DesktopEntryAvatar | null;
  name: string;
  deviceId: string;
  /** 与对话头像相同的缓存键：`JSON.stringify([deviceId, avatarValue])`。 */
  cachedAvatarUri?: (identity: string) => Promise<string | null>;
  /** 在线时才提供的预签名地址解析。 */
  mediaAvatarUri?: () => Promise<string | null>;
}

export async function resolveDesktopEntryIcon(input: DesktopEntryIconInput): Promise<DesktopEntryIcon> {
  const background = avatarColor(input.avatar?.color);
  const glyph = desktopEntryGlyph(input.avatar, input.name);
  const fallback: DesktopEntryIcon = glyph
    ? { kind: 'glyph', text: glyph, background }
    : { kind: 'brand' };
  try {
    const uri = await avatarUri(input);
    if (!uri) return fallback;
    const pngBase64 = await avatarPng(uri);
    return pngBase64 ? { kind: 'image', pngBase64, background } : fallback;
  } catch {
    return fallback;
  }
}

async function avatarUri(input: DesktopEntryIconInput): Promise<string | null> {
  const value = input.avatar?.value?.trim() ?? '';
  if (!value) return null;
  const preset = companionAvatarPreset(value);
  if (preset) return bundledAssetUri(preset);
  if (input.avatar?.kind !== 'media') return null;
  const cached = await input.cachedAvatarUri?.(JSON.stringify([input.deviceId, value])).catch(() => null);
  if (cached) return cached;
  return (await input.mediaAvatarUri?.().catch(() => null)) ?? null;
}

/** Release 包里预设图是 drawable，不是可直接读取的 URI：先让 expo-asset 落到缓存。 */
async function bundledAssetUri(moduleId: number): Promise<string | null> {
  const { Asset } = await import('expo-asset');
  const asset = Asset.fromModule(moduleId);
  if (!asset.localUri) await asset.downloadAsync();
  return asset.localUri ?? asset.uri ?? null;
}

/** 位置头像通常是方图；只限宽度，让原生按正中心裁成圆形。 */
async function avatarPng(uri: string): Promise<string | null> {
  const [{ ImageManipulator, SaveFormat }, { File }] = await Promise.all([
    import('expo-image-manipulator'),
    import('expo-file-system'),
  ]);
  const context = ImageManipulator.manipulate(uri);
  let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  try {
    context.resize({ width: 256 });
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.PNG, base64: true });
    try {
      new File(saved.uri).delete();
    } catch {
      // The OS can clean its own temp directory.
    }
    return saved.base64 ?? null;
  } finally {
    image?.release();
    context.release();
  }
}

function avatarColor(value: string | undefined): string | undefined {
  return value && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(value) ? value : undefined;
}
