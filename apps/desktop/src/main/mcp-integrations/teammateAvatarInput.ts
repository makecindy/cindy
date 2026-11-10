import type { SessionPathAuthorization } from '@cindy/mcps';
import { BOT_AVATAR_MAX_BYTES, isCindyBotAvatarValue, isSingleBotAvatarGrapheme } from '../../shared/botAvatarValue.js';
import { validateBotAvatarBuffer } from '../localDb/ipc/botAvatarSelection.js';
import { fetchPublicImageBytes } from '../im/publicImageFetch.js';
import { readHandoffPicture } from '../input-handoff/pictureRef.js';

export interface TeammateAvatarInput {
  avatar: string;
  sessionId: string;
  sessionInstanceId?: string;
  workingDir: string | null;
  remoteHostId: string | null;
}

export interface TeammateAvatarInputDeps {
  isCurrentSession(sessionId: string, instanceId: string): boolean;
  authorizePath(absPath: string): Promise<SessionPathAuthorization>;
  fetchImage?: typeof fetchPublicImageBytes;
  readPicture?: typeof readHandoffPicture;
}

function isPortableAvatar(value: string): boolean {
  return isSingleBotAvatarGrapheme(value) || isCindyBotAvatarValue(value);
}

/** Keep model-supplied paths and URLs out of persisted Profile values. */
export async function resolveTeammateAvatarInput(
  input: TeammateAvatarInput,
  deps: TeammateAvatarInputDeps,
): Promise<{ ok: true; avatar?: string; avatarImageBase64?: string; isAccessCurrent?: () => boolean }
  | { ok: false; errorCode: string; message: string }> {
  const { avatar, sessionId, sessionInstanceId, workingDir, remoteHostId } = input;
  if (isPortableAvatar(avatar)) return { ok: true, avatar };
  if (!sessionInstanceId || !deps.isCurrentSession(sessionId, sessionInstanceId))
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '当前任务实例无法读取头像图片' };
  let image: Buffer;
  let isGrantCurrent: (() => boolean) | undefined;
  if (avatar.startsWith('https://')) {
    try {
      const fetched = await (deps.fetchImage ?? fetchPublicImageBytes)(avatar, BOT_AVATAR_MAX_BYTES, undefined, { timeoutMs: 15_000 });
      image = Buffer.from(fetched.buffer);
    } catch {
      return { ok: false, errorCode: 'IMAGE_NOT_FOUND', message: '无法下载头像图片，请检查 HTTPS 地址' };
    }
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(avatar) && !avatar.startsWith('cindy-media://') && !avatar.startsWith('xdt-image://') && !avatar.startsWith('file://')) {
    return { ok: false, errorCode: 'INVALID_ARGS', message: '头像只接受 HTTPS 图片地址、本地图片路径或内置头像' };
  } else {
    if (!workingDir || remoteHostId)
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: '远程任务不能读取控制端的本地头像图片' };
    const authorizePath = async (absPath: string) => {
      const grant = await deps.authorizePath(absPath);
      if (grant.allowed) isGrantCurrent = grant.isCurrent;
      return grant;
    };
    const picture = await (deps.readPicture ?? readHandoffPicture)(avatar, workingDir, authorizePath,
      { allowWebp: true, maxBytes: BOT_AVATAR_MAX_BYTES });
    if (!picture.ok) return { ok: false, errorCode: picture.errorCode, message: picture.message };
    image = picture.bytes;
  }
  try { validateBotAvatarBuffer(image); }
  catch { return { ok: false, errorCode: 'INVALID_ARGS', message: '头像只支持小于 5 MB 的 PNG、JPEG 或 WebP 图片' }; }
  // Keep both the task instance and any external-file grant live until persistence.
  const granted = isGrantCurrent;
  const isAccessCurrent = () => deps.isCurrentSession(sessionId, sessionInstanceId) && (granted?.() ?? true);
  if (!isAccessCurrent())
    return { ok: false, errorCode: 'PERMISSION_DENIED', message: '当前任务实例已变化，请重新操作' };
  return { ok: true, avatarImageBase64: image.toString('base64'), isAccessCurrent };
}
