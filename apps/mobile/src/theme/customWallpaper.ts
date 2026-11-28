import * as fs from 'expo-file-system/legacy';
import { randomUUID } from 'expo-crypto';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImagePickerAsset } from 'expo-image-picker';
import type { VideoThumbnail } from 'expo-video';
import type { CustomWallpaper, CustomWallpaperFile } from './wallpaper';

// Only generated directory IDs are persisted. The iOS container URL can change on upgrade.
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i;
function directory(id: string) {
  if (!fs.documentDirectory || !uuid.test(id)) throw new Error('Invalid wallpaper directory');
  return fs.documentDirectory + 'wallpapers/' + id + '/';
}

function resolveFiles(file: CustomWallpaperFile): CustomWallpaper {
  const dir = directory(file.id);
  return { ...file, imageUri: dir + 'poster.jpg', videoUri: file.video ? dir + 'loop.' + file.video : null };
}

export async function restoreCustomWallpaper(value: Partial<CustomWallpaperFile> | null): Promise<CustomWallpaper | null> {
  if (!value || typeof value.id !== 'string' || !uuid.test(value.id)
    || typeof value.width !== 'number' || !(value.width > 0 && value.width <= 3840)
    || typeof value.height !== 'number' || !(value.height > 0 && value.height <= 3840)
    || !(value.video === null || value.video === 'mov' || value.video === 'mp4' || value.video === 'm4v')) return null;
  const file = resolveFiles({ id: value.id, width: value.width, height: value.height, video: value.video });
  if (!(await fs.getInfoAsync(file.imageUri)).exists) return null;
  if (file.videoUri && !(await fs.getInfoAsync(file.videoUri)).exists) return { ...file, video: null, videoUri: null };
  return file;
}

export function discardCustomWallpaper(id: string) {
  return fs.deleteAsync(directory(id), { idempotent: true });
}

// An interrupted import can leave a staged directory behind. The provider
// serializes imports, so only the committed ID needs to survive the next one.
export async function cleanUnusedCustomWallpapers(keep?: string) {
  if (!fs.documentDirectory) return;
  const root = fs.documentDirectory + 'wallpapers/';
  if (!(await fs.getInfoAsync(root)).exists) return;
  for (const id of await fs.readDirectoryAsync(root)) {
    if (id !== keep && uuid.test(id)) await discardCustomWallpaper(id);
  }
}

async function savePoster(source: string | VideoThumbnail, destination: string) {
  const context = ImageManipulator.manipulate(source, { maxWidth: 3840, maxHeight: 3840 });
  try {
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.9 });
      try {
        await fs.moveAsync({ from: saved.uri, to: destination });
        return { width: saved.width, height: saved.height };
      } finally {
        await fs.deleteAsync(saved.uri, { idempotent: true }).catch(() => undefined);
      }
    } finally { image.release(); }
  } finally { context.release(); }
}

async function saveVideoPoster(videoUri: string, destination: string) {
  const { createVideoPlayer } = await import('expo-video');
  const player = createVideoPlayer(null);
  try {
    await player.replaceAsync(videoUri);
    const [frame] = await player.generateThumbnailsAsync([0], { maxWidth: 2560, maxHeight: 2560 });
    if (!frame) throw new Error('Video has no frame');
    try { return await savePoster(frame, destination); }
    finally { frame.release(); }
  } finally { player.release(); }
}

export async function prepareCustomWallpaper(asset: ImagePickerAsset): Promise<CustomWallpaper> {
  const id = randomUUID();
  const dir = directory(id);
  try {
    const video = asset.type === 'video';
    const info = await fs.getInfoAsync(asset.uri);
    if (!info.exists || info.isDirectory || info.size <= 0) throw new Error('Unreadable wallpaper');
    if (info.size > (video ? 100 : 20) * 1024 * 1024) throw new Error('WALLPAPER_TOO_LARGE');
    const ext = asset.uri.split('.').pop()?.toLowerCase();
    const format = video ? (ext === 'mov' || ext === 'm4v' ? ext : 'mp4') : null;
    await fs.makeDirectoryAsync(dir, { intermediates: true });
    const poster = dir + 'poster.jpg';
    let size;
    if (format) {
      const videoUri = dir + 'loop.' + format;
      await fs.copyAsync({ from: asset.uri, to: videoUri });
      size = await saveVideoPoster(videoUri, poster);
    } else {
      size = await savePoster(asset.uri, poster);
    }
    return resolveFiles({ id, video: format, ...size });
  } catch (error) {
    await discardCustomWallpaper(id).catch(() => undefined);
    throw error;
  } finally {
    // PHPicker exports a private temporary file. Never remove a Photos asset or a caller's original.
    if (fs.cacheDirectory && asset.uri.startsWith(fs.cacheDirectory + 'ImagePicker/')) {
      await fs.deleteAsync(asset.uri, { idempotent: true }).catch(() => undefined);
    }
  }
}
