import { toLocalFileUrl } from '@/lib/localPathResolver';
import { resolveSessionFileOrigin, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { rewriteToRemoteMediaOrigin } from '../../../../../shared/remoteMediaUrl';
import { joinPath } from '@/features/cc-agent/workdir-browse/lib/fileMeta';

interface FileTreeImagePreviewUrlOptions {
  workdir: string;
  relPath: string;
  remoteHostId?: string | null;
  deviceId?: string | null;
}

/**
 * 把文件树图片定位成 ImageLightbox 可读的 URL。
 *
 * 远程来源必须成功改写到 cindy-remote-media://；若路径逃出 SSH workdir 等原因
 * 导致改写被拒绝，则返回 null，不能误读控制端本机的同名绝对路径。
 */
export function buildFileTreeImagePreviewUrl({
  workdir,
  relPath,
  remoteHostId,
  deviceId,
}: FileTreeImagePreviewUrlOptions): string | null {
  const localUrl = toLocalFileUrl(joinPath(workdir, relPath));
  const remoteOrigin = toRemoteMediaOrigin(
    resolveSessionFileOrigin(deviceId ?? undefined, remoteHostId),
    workdir,
  );
  const rewritten = rewriteToRemoteMediaOrigin(localUrl, remoteOrigin);
  return remoteOrigin && rewritten === localUrl ? null : rewritten;
}
