import { Directory, File, Paths } from 'expo-file-system';
import { EncodingType, readAsStringAsync, StorageAccessFramework, writeAsStringAsync } from 'expo-file-system/legacy';
import { Asset } from 'expo-media-library';
import { Platform } from 'react-native';
import { sniffImageMimeFromBase64 } from './imageAnnotationModel';
import { extOfMime, imageMimeFromUrl } from './remoteMediaDiskCache';
import { copyRemoteFile } from './remoteMediaDiskCacheExpo';

/** Export original bytes. Modern Android can add an owned photo without reading the library. */
export async function savePreviewImage(source: string, mimeHint?: string, title?: string): Promise<boolean> {
  let destination: Directory | undefined;
  if (Number(Platform.Version) < 30) {
    const picker = StorageAccessFramework;
    const result = await picker.requestDirectoryPermissionsAsync(picker.getUriForDirectoryInRoot('Pictures'));
    if (!result.granted) return false;
    destination = new Directory(result.directoryUri);
  }

  const staging = new Directory(Paths.cache, `save-image-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  staging.create();
  try {
    const copy = new File(staging, 'original');
    const inline = /^data:(image\/[\w.+-]+);base64,/i.exec(source);
    if (inline) {
      await writeAsStringAsync(copy.uri, source.slice(inline[0].length), { encoding: EncodingType.Base64 });
    } else if (/^(?:file|https?):\/\//i.test(source)) {
      await copyRemoteFile(source, copy);
    } else {
      throw new Error('UNSUPPORTED_IMAGE_SOURCE');
    }
    const head = await readAsStringAsync(copy.uri, { encoding: EncodingType.Base64, position: 0, length: 16 });
    const mime = sniffImageMimeFromBase64(head) ?? inline?.[1]
      ?? (mimeHint?.startsWith('image/') ? mimeHint : null) ?? imageMimeFromUrl(title ?? '') ?? imageMimeFromUrl(source);
    if (!mime || !copy.size) throw new Error('UNKNOWN_IMAGE_FORMAT');
    const ext = extOfMime(mime);
    const extension = ext === 'img' ? /^image\/(\w+)$/.exec(mime)?.[1] : ext;
    if (!extension) throw new Error('UNKNOWN_IMAGE_FORMAT');
    const named = new File(staging, `Image-${Date.now()}.${extension}`);
    copy.moveSync(named);
    if (destination) await named.copy(destination);
    else await Asset.create(named.uri);
    return true;
  } finally {
    try { staging.delete(); } catch { /* Android can reclaim the private cache. */ }
  }
}
