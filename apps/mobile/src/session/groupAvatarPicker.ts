/**
 * 本群头像：从相册选一张、裁成正方形，缩到 512 存成 JPEG 交给上传。生成的缩略图只是临时文件，
 * 用完由 `release` 删除；用户选的原图从不改动或删除。返回 null 表示用户取消了选择。
 */
import { GROUP_AVATAR_EDGE_PX, GROUP_AVATAR_MAX_BYTES } from '@/chat/publicAvatarUpload';
import { statMobileAttachmentFileSize } from './mobileAttachmentUpload';

export interface PickedGroupAvatar { uri: string; size: number; mimeType: 'image/jpeg'; release(): void }

export async function pickGroupAvatar(): Promise<PickedGroupAvatar | null> {
  const picker = await import('expo-image-picker');
  const result = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 1 });
  if (result.canceled || !result.assets[0]) return null;
  const { ImageManipulator, SaveFormat } = await import('expo-image-manipulator');
  const { File } = await import('expo-file-system');
  const context = ImageManipulator.manipulate(result.assets[0].uri);
  context.resize({ width: GROUP_AVATAR_EDGE_PX, height: GROUP_AVATAR_EDGE_PX });
  let image: Awaited<ReturnType<typeof context.renderAsync>> | undefined;
  try {
    image = await context.renderAsync();
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.85 });
    const release = () => { try { new File(saved.uri).delete(); } catch { /* The OS clears its cache later. */ } };
    const size = await statMobileAttachmentFileSize(saved.uri);
    if (size <= 0 || size > GROUP_AVATAR_MAX_BYTES) { release(); throw new Error('AVATAR_TOO_LARGE'); }
    return { uri: saved.uri, size, mimeType: 'image/jpeg', release };
  } finally { image?.release(); context.release(); }
}
