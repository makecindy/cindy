/**
 * 浏览页与预览页共用文件读取接口，转换为分享/下载地址。
 * 完整文件由共用读取层优先返回本地缓存、后台复验；流式地址保留独立有效期。
 */
import { i18n } from "@/i18n";
import type { MobileMakerTransport } from "@/device-link/mobileMakerTransport";
import {
  getCachedExportUrl,
  storeCachedExportUrl,
} from "@/session/fileBrowserCache";
import type { MobileRemoteMediaPresignResult } from "@/session/remoteMedia";
import { peerMediaUri, releasePeerMedia } from "@/device-link/peerFileRegistry";
import { errorText } from "@/debug/fileDiagnostics";
import { mobileDebugLog } from "@/debug/mobileDebugLog";

export interface ExportRemoteFileDeps {
  /** Retained preview URLs must not reuse short-lived full-file peer results. */
  stream?: boolean;
  maker: Pick<MobileMakerTransport, "fileBrowser">;
  deviceId: string;
  openLink: (deviceId: string) => Promise<unknown>;
  presignGet: (ossKey: string) => Promise<MobileRemoteMediaPresignResult>;
  deleteOssObject?: (key: string) => void;
  /** 取消信号(如页面卸载)，转成文件读取接口的 AbortSignal。 */
  isCancelled?: () => boolean;
  /** 电脑上传到云存储期间的真实字节进度(缓存命中与直连不回调)。 */
  onProgress?: (uploaded: number, total: number) => void;
}

export async function exportRemoteFileToUrl(
  deps: ExportRemoteFileDeps,
  workdir: string,
  relPath: string,
  mtimeMs: number,
): Promise<string> {
  const ownerScope = deps.maker.fileBrowser.cacheScope ?? deps.deviceId;
  const scope = JSON.stringify([ownerScope, deps.stream === true ? "stream" : "file"]);
  const cached = deps.stream === true ? getCachedExportUrl(scope, workdir, relPath, mtimeMs) : null;
  if (cached) {
    mobileDebugLog("debug", "files", "file export cache hit", { stream: deps.stream === true });
    return cached;
  }
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
      { stream: deps.stream === true, onProgress: deps.onProgress,
        retainBackground: async (fresh, isCurrent) => {
          if (!fresh.ossKey || isCurrent?.() === false) return;
          try {
            const signed = await deps.presignGet(fresh.ossKey);
            const local = await fresh.cacheDownload?.(signed.getUrl);
            const uri = local && peerMediaUri(local);
            if (uri) releasePeerMedia(uri);
          } finally { if (isCurrent?.() !== false) deps.deleteOssObject?.(fresh.ossKey); }
        },
      },
    );
    check();
    if (abort.signal.aborted) throw new Error(i18n.t("files.export.leftPage"));
    const local = peerMediaUri(result);
    if (local) return local;
    if (result.inlineBase64 !== undefined)
      return `data:${result.mimeType};base64,${result.inlineBase64}`;
    const presignStartedAt = Date.now();
    const signed = await deps.presignGet(result.ossKey).catch((error: unknown) => {
      mobileDebugLog("warn", "files", "file export presign failed", {
        ms: Date.now() - presignStartedAt,
        error: errorText(error),
      });
      throw error;
    });
    const downloaded = await result.cacheDownload?.(signed.getUrl);
    const downloadedUri = downloaded && peerMediaUri(downloaded);
    if (downloadedUri) {
      deps.deleteOssObject?.(result.ossKey);
      return downloadedUri;
    }
    mobileDebugLog("debug", "files", "file export presigned", {
      ms: Date.now() - presignStartedAt,
      size: result.size,
    });
    check();
    if (abort.signal.aborted) throw new Error(i18n.t("files.export.leftPage"));
    if (deps.stream === true) storeCachedExportUrl(
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
