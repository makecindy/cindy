/**
 * 浏览页与预览页共用文件读取接口，转换为分享/下载地址。
 * 按账号、设备、path 和 mtime 缓存到地址过期；传输选择与瞬断重试由文件接口负责。
 */
import { i18n } from "@/i18n";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import {
  getCachedExportUrl,
  storeCachedExportUrl,
} from "@/session/fileBrowserCache";
import type { MobileRemoteMediaPresignResult } from "@/session/remoteMedia";
import { peerMediaUri, peerMediaExpiry } from "@/device-link/peerFileRegistry";

export interface ExportRemoteFileDeps {
  maker: Pick<MobileMakerTransport, "fileBrowser">;
  deviceId: string;
  openLink: (deviceId: string) => Promise<unknown>;
  presignGet: (ossKey: string) => Promise<MobileRemoteMediaPresignResult>;
  /** 取消信号(如页面卸载)，转成文件读取接口的 AbortSignal。 */
  isCancelled?: () => boolean;
}

export async function exportRemoteFileToUrl(
  deps: ExportRemoteFileDeps,
  workdir: string,
  relPath: string,
  mtimeMs: number,
): Promise<string> {
  const scope = deps.maker.fileBrowser.cacheScope ?? deps.deviceId;
  const cached = getCachedExportUrl(scope, workdir, relPath, mtimeMs);
  if (cached) return cached;
  const abort = new AbortController();
  const check = () => {
    if (deps.isCancelled?.()) abort.abort();
  };
  check();
  const timer = setInterval(check, 100);
  try {
    if (abort.signal.aborted) throw new Error(i18n.t("files.export.leftPage"));
    const result = await deps.maker.fileBrowser.readBytes(
      workdir,
      relPath,
      abort.signal,
      () => deps.openLink(deps.deviceId),
    );
    check();
    if (abort.signal.aborted) throw new Error(i18n.t("files.export.leftPage"));
    const local = peerMediaUri(result);
    if (local) {
      storeCachedExportUrl(
        scope,
        workdir,
        relPath,
        mtimeMs,
        local,
        peerMediaExpiry(result)!,
      );
      return local;
    }
    if (result.inlineBase64 !== undefined)
      return `data:${result.mimeType};base64,${result.inlineBase64}`;
    const signed = await deps.presignGet(result.ossKey);
    check();
    if (abort.signal.aborted) throw new Error(i18n.t("files.export.leftPage"));
    storeCachedExportUrl(
      scope,
      workdir,
      relPath,
      mtimeMs,
      signed.getUrl,
      signed.expiresAt,
    );
    return signed.getUrl;
  } finally {
    clearInterval(timer);
  }
}
