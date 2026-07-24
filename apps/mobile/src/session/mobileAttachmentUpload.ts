import { apiFetchRaw } from '@/api/client';
import { DEVICE_LINK_API_BASE_URL } from '@/config/env';
import { i18n } from '@/i18n';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { isAttachmentOssRef, parseAttachmentOssRef } from '@/session/attachmentOssRef';
import {
  buildMobileUploadedAttachment,
  assertMobileDocumentSize,
  categorizeMobileAttachment,
  extractRemoteFileExt,
} from '@/session/attachments';
import type { RemoteSerializedAttachment } from '@/session/types';
import {
  sha256MobileAttachmentBody,
  sha256MobileAttachmentFile,
  type MobileAttachmentChunkReader,
} from '@/session/mobileAttachmentSha256';

export interface MobileAttachmentUploadCandidate {
  name: string;
  size: number;
  mimeType?: string;
}

export interface MobileAttachmentPresignResult {
  putUrl: string;
  key: string;
  expiresAt: string;
}

export type MobileAttachmentUploadBody = BodyInit;

/** 原生文件直传实现(可注入,测试用):返回 HTTP 状态码;signal 中止时应尽快取消传输。 */
export type MobileAttachmentFileUploader = (
  putUrl: string,
  fileUri: string,
  headers: Record<string, string>,
  opts?: { signal?: AbortSignal },
) => Promise<{ status: number; body?: string }>;

interface UploadDeps {
  apiFetch?: typeof apiFetchRaw;
  fetch?: typeof fetch;
  uploadFile?: MobileAttachmentFileUploader;
  readFileChunk?: MobileAttachmentChunkReader;
  snapshotFile?: (uri: string) => Promise<{ uri: string; size: number; cleanup?: () => Promise<void> }>;
}

/** presign 是小 POST,不该吃满默认 20s 超时;弱网抖动重试一次(重复 presign 无副作用,PUT 前不产生对象)。 */
const PRESIGN_TIMEOUT_MS = 12_000;
const PRESIGN_MAX_ATTEMPTS = 2;

/**
 * mimeType 缺失时的统一兜底。预签名的 contentType 与 PUT 实发的 Content-Type
 * 必须**逐字节一致**且**都不能缺**:缺失时预签名把 Content-Type 位签成空串,而
 * expo-file-system 原生直传层会自动补 application/octet-stream,两边不一致直接
 * OSS SignatureDoesNotMatch 403(2026-07 粘贴图片无 mimeType 实撞)。presign 与
 * buildMobileAttachmentUploadHeaders 都必须经 effectiveUploadMimeType 取值。
 */
const FALLBACK_UPLOAD_MIME = 'application/octet-stream';

export function effectiveUploadMimeType(mimeType: string | undefined): string {
  const trimmed = mimeType?.trim();
  return trimmed ? trimmed : FALLBACK_UPLOAD_MIME;
}

export async function presignMobileAttachmentUpload(
  candidate: MobileAttachmentUploadCandidate,
  options: { token: string | null; deps?: UploadDeps },
): Promise<MobileAttachmentPresignResult> {
  const apiFetch = options.deps?.apiFetch ?? apiFetchRaw;
  const result = await withTransientRemoteRetry(
    () => apiFetch<MobileAttachmentPresignResult>('/api/device-link/media/presign-put', {
      baseUrl: DEVICE_LINK_API_BASE_URL,
      method: 'POST',
      token: options.token,
      timeoutMs: PRESIGN_TIMEOUT_MS,
      body: {
        size: candidate.size,
        contentType: effectiveUploadMimeType(candidate.mimeType),
        ext: uploadExtForName(candidate.name),
      },
    }),
    { maxAttempts: PRESIGN_MAX_ATTEMPTS },
  );
  return normalizePresignResult(result);
}

/**
 * Blob PUT 的整体超时:Android 的 RN fetch 没有默认超时,弱网僵死会让上传
 * (以及等它的发送按钮)无限挂起。上限放宽到 2 分钟,给慢速蜂窝网上传大附件
 * 留足余量;body 是 Blob 可复用,传输层失败(拿不到 HTTP 响应)重试一次,
 * 与原生文件直传路径(putMobileAttachmentUploadFromFile)同口径。
 */
const PUT_BLOB_TIMEOUT_MS = 120_000;

export async function putMobileAttachmentUpload(
  putUrl: string,
  body: MobileAttachmentUploadBody,
  mimeType: string | undefined,
  deps: UploadDeps = {},
): Promise<void> {
  const fetchImpl = deps.fetch ?? fetch;
  let transportError: unknown;
  for (let attempt = 0; attempt < UPLOAD_TRANSPORT_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PUT_BLOB_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(putUrl, {
        method: 'PUT',
        headers: buildMobileAttachmentUploadHeaders(mimeType),
        body,
        signal: controller.signal,
      });
    } catch (err) {
      transportError = err;
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const code = extractOssErrorCode(await readResponseTextSafe(response));
      throw new Error(i18n.t('composer.upload.failedHttp', { status: response.status, code: code ? ` (${code})` : '' }));
    }
    return;
  }
  throw new Error(i18n.t('composer.upload.failedNetwork', { detail: summarizeTransportError(transportError) }));
}

function buildMobileAttachmentUploadHeaders(mimeType: string | undefined): Record<string, string> {
  return {
    // 恒发 Content-Type(缺失走 effectiveUploadMimeType 兜底),与 presign 同源同值,
    // 保证参与 OSS 签名的 header 两边永远一致。
    'Content-Type': effectiveUploadMimeType(mimeType),
    'x-oss-object-acl': 'private',
  };
}

/** 从 OSS 错误响应体提取 <Code>(SignatureDoesNotMatch / AccessDenied 等),定位 403 类失败用。 */
function extractOssErrorCode(body: string | undefined): string | null {
  const match = body?.match(/<Code>([^<]{1,64})<\/Code>/);
  return match ? match[1] : null;
}

/** 读失败响应体(测试 mock 可能没有 text();读不到不影响报错主流程)。 */
async function readResponseTextSafe(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/**
 * 原生直传本地文件(expo-file-system createUploadTask)。
 * 不走 fetch(file://) + Response.blob():新架构运行时里 Response 会退化成 ArrayBuffer
 * 体,而 RN 的 Blob 不接受 ArrayBuffer 分片,直接抛
 * "Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported"。
 * sessionType 必须显式 FOREGROUND:expo 默认 BACKGROUND 会把传输交给 iOS 的
 * nsurlsessiond 后台守护进程,该通道对交互式短上传有一族传输层玄学失败
 * (NSURLErrorDomain -1 / -997 / -999,线上实撞 Code=-1 "unknown error");
 * 用户停在输入框前台等结果,不需要后台会话语义,走进程内前台会话绕开。
 * 用 createUploadTask 而非 uploadAsync:UploadTask 有 cancelAsync,signal 中止
 * (超时 / 用户 X 掉)时能真正断掉传输,不再让僵死连接吊着调用方。
 * 动态 import 保证本模块在 vitest(node 环境)下可被导入——测试路径全部经 deps.uploadFile 注入。
 */
async function uploadFileNative(
  putUrl: string,
  fileUri: string,
  headers: Record<string, string>,
  opts: { signal?: AbortSignal } = {},
): Promise<{ status: number; body?: string }> {
  const FileSystem = await import('expo-file-system/legacy');
  if (opts.signal?.aborted) throw new Error(uploadAbortedMessage());
  const task = FileSystem.createUploadTask(putUrl, fileUri, {
    headers,
    httpMethod: 'PUT',
    sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });
  const onAbort = () => {
    void task.cancelAsync().catch(() => undefined);
  };
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const result = await task.uploadAsync();
    // 取消后 uploadAsync resolve undefined/null(而非 reject),归一化成异常让上层分诊。
    if (!result) throw new Error(uploadAbortedMessage());
    return { status: result.status, body: result.body };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** 传输层异常(拿不到 HTTP 响应)总尝试次数:失败自动重试 1 次。 */
const UPLOAD_TRANSPORT_ATTEMPTS = 2;

/**
 * 原生文件直传的单次尝试超时,与 Blob 版 PUT_BLOB_TIMEOUT_MS 同口径:iOS 前台
 * NSURLSession 只在「60s 完全无字节流动」时才自行超时,慢速蜂窝网上传大附件
 * (上限 30MB)可以合法地涓涓细流挂很多分钟,期间发送等待没有任何出口。
 * 超时不进传输层重试(两轮 120s 太久),直接报错让用户看到失败卡原地重试。
 */
const PUT_FILE_TIMEOUT_MS = 120_000;

// i18n 文案取值放函数里(而非模块顶层常量):模块顶层求值会把语言冻结在加载时刻,
// LocaleProvider 挂载后的语言切换就读不到,故在抛错点当场求值。
const uploadAbortedMessage = () => i18n.t('composer.upload.cancelled');
const uploadTimeoutMessage = () => i18n.t('composer.upload.timeout');

export async function putMobileAttachmentUploadFromFile(
  putUrl: string,
  fileUri: string,
  mimeType: string | undefined,
  deps: UploadDeps = {},
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const uploadFile = deps.uploadFile ?? uploadFileNative;
  const headers = buildMobileAttachmentUploadHeaders(mimeType);
  // 原生传输层异常(如 iOS NSURLError,连 HTTP 响应都没拿到)自动重试一次;
  // 拿到 HTTP 状态码的失败(403 签名/权限类)重试无意义,直接抛。
  let transportError: unknown;
  for (let attempt = 0; attempt < UPLOAD_TRANSPORT_ATTEMPTS; attempt += 1) {
    if (opts.signal?.aborted) throw new Error(uploadAbortedMessage());
    // 每次尝试独立的超时窗;外部取消(用户 X 掉 / 页面退出)与超时共用一个
    // 传给传输层的 signal,层内只管断传输,这里负责把两种中止分诊成不同结局。
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), PUT_FILE_TIMEOUT_MS);
    const onOuterAbort = () => timeout.abort();
    if (opts.signal) opts.signal.addEventListener('abort', onOuterAbort);
    let status: number;
    let body: string | undefined;
    try {
      ({ status, body } = await uploadFile(putUrl, fileUri, headers, {
        signal: timeout.signal,
      }));
    } catch (err) {
      // 外部取消:立刻收手,不重试(调用方自己发起的中止,静默语义由上层决定)。
      if (opts.signal?.aborted) throw new Error(uploadAbortedMessage());
      // 超时:不进第二轮(再等 120s 只会让用户在失败卡出现前多干等一轮),直接报错。
      if (timeout.signal.aborted) throw new Error(uploadTimeoutMessage());
      transportError = err;
      continue;
    } finally {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }
    if (status < 200 || status >= 300) {
      // 拿到 HTTP 状态码的失败重试无意义,直接抛;带上 OSS 错误 Code
      // (SignatureDoesNotMatch / AccessDenied / …),否则裸 403 无法定位。
      const code = extractOssErrorCode(body);
      throw new Error(i18n.t('composer.upload.failedHttp', { status, code: code ? ` (${code})` : '' }));
    }
    return;
  }
  throw new Error(i18n.t('composer.upload.failedNetwork', { detail: summarizeTransportError(transportError) }));
}

/** 原生 NSError 描述冗长(整条预签名 URL 都在里面),截前段给用户当排查线索即可。 */
function summarizeTransportError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const firstLine = raw.split('\n')[0] ?? raw;
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine;
}

/** 读本地文件字节数(拿不到时返回 0,由调用方决定兜底 / 报错)。 */
export async function statMobileAttachmentFileSize(uri: string): Promise<number> {
  const FileSystem = await import('expo-file-system/legacy');
  const info = await FileSystem.getInfoAsync(uri);
  return info.exists && typeof info.size === 'number' && Number.isFinite(info.size) ? info.size : 0;
}

export async function uploadMobileAttachment(
  candidate: MobileAttachmentUploadCandidate,
  body: MobileAttachmentUploadBody,
  options: { token: string | null; id?: string; deps?: UploadDeps },
): Promise<RemoteSerializedAttachment> {
  // 上传前先校验类型:不支持的本机文件(如 .zip)若先 presign + PUT、再在
  // buildMobileUploadedAttachment 处被拒,会在 device-link OSS 桶里留下一个永不被引用、
  // 也没有 delete 回收的孤儿对象(泄漏用户数据 + 占用存储)。类型判定复用
  // categorizeMobileAttachment 这一唯一真源,保证与下面最终校验同口径。
  if (!categorizeMobileAttachment(candidate.name)) {
    throw new Error(i18n.t('composer.upload.fileTypeUnsupported'));
  }
  assertMobileDocumentSize(candidate.size);
  const sha256 = await sha256MobileAttachmentBody(body, candidate.size);
  const presigned = await presignMobileAttachmentUpload(candidate, options);
  await putMobileAttachmentUpload(presigned.putUrl, body, candidate.mimeType, options.deps);
  const attachment = buildMobileUploadedAttachment({
    id: options.id,
    ossKey: presigned.key,
    name: candidate.name,
    size: candidate.size,
    sha256,
    mimeType: candidate.mimeType,
  });
  if (!attachment) {
    throw new Error(i18n.t('composer.upload.fileTypeUnsupported'));
  }
  return attachment;
}

/** uploadMobileAttachment 的本地文件版:presign 后由原生层直传 fileUri,全程不经 JS Blob。 */
export async function uploadMobileAttachmentFromFile(
  candidate: MobileAttachmentUploadCandidate,
  fileUri: string,
  options: {
    token: string | null;
    id?: string;
    deps?: UploadDeps;
    signal?: AbortSignal;
  },
): Promise<RemoteSerializedAttachment> {
  // 同 uploadMobileAttachment:presign 前先拦不支持的类型,避免 OSS 孤儿对象。
  if (!categorizeMobileAttachment(candidate.name)) {
    throw new Error(i18n.t('composer.upload.fileTypeUnsupported'));
  }
  assertMobileDocumentSize(candidate.size);
  const snapshot = options.deps?.snapshotFile
    ? await options.deps.snapshotFile(fileUri)
    : options.deps?.readFileChunk
      ? { uri: fileUri, size: candidate.size }
      : await snapshotMobileAttachmentFile(fileUri);
  try {
    if (snapshot.size !== candidate.size) {
      throw new Error(`Attachment size changed: expected ${candidate.size}, actual ${snapshot.size}`);
    }
    const sha256 = await sha256MobileAttachmentFile(snapshot.uri, candidate.size, {
      readChunk: options.deps?.readFileChunk,
      signal: options.signal,
    });
    const presigned = await presignMobileAttachmentUpload(candidate, options);
    try {
      await putMobileAttachmentUploadFromFile(
        presigned.putUrl,
        snapshot.uri,
        candidate.mimeType,
        options.deps,
        { signal: options.signal },
      );
    } catch (error) {
      await deleteMobileAttachmentUpload(presigned.key, options).catch(() => undefined);
      throw error;
    }
    const attachment = buildMobileUploadedAttachment({
      id: options.id,
      ossKey: presigned.key,
      name: candidate.name,
      size: candidate.size,
      sha256,
      mimeType: candidate.mimeType,
    });
    if (!attachment) {
      throw new Error(i18n.t('composer.upload.fileTypeUnsupported'));
    }
    return attachment;
  } finally {
    await snapshot.cleanup?.()?.catch(() => undefined);
  }
}

async function snapshotMobileAttachmentFile(uri: string): Promise<{
  uri: string;
  size: number;
  cleanup: () => Promise<void>;
}> {
  const FileSystem = await import('expo-file-system/legacy');
  const dir = FileSystem.cacheDirectory;
  if (!dir) throw new Error(i18n.t('composer.upload.snapshotFailedNoCacheDir'));
  const snapshotUri = `${dir}device-link-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await FileSystem.copyAsync({ from: uri, to: snapshotUri });
  const info = await FileSystem.getInfoAsync(snapshotUri);
  if (!info.exists || typeof info.size !== 'number') {
    await FileSystem.deleteAsync(snapshotUri, { idempotent: true }).catch(() => undefined);
    throw new Error(i18n.t('composer.upload.snapshotFailed'));
  }
  return {
    uri: snapshotUri,
    size: info.size,
    cleanup: () => FileSystem.deleteAsync(snapshotUri, { idempotent: true }),
  };
}

/** 删除中转区对象(owner 校验在服务端)。 */
export async function deleteMobileAttachmentUpload(
  ossKey: string,
  options: { token: string | null; deps?: UploadDeps },
): Promise<void> {
  const apiFetch = options.deps?.apiFetch ?? apiFetchRaw;
  await apiFetch<{ deleted: boolean }>('/api/device-link/media', {
    baseUrl: DEVICE_LINK_API_BASE_URL,
    method: 'DELETE',
    token: options.token,
    body: { key: ossKey },
  });
}

/**
 * 移除未发送附件时回收中转区对象(best-effort)。已上传的本机文件在被 X 掉后不再有任何
 * 引用,不回收会留下 OSS 孤儿对象直到桶生命周期清理。非 `cindy-oss-attach` 引用(远端路径
 * 附件)没有中转对象,直接跳过;删除失败静默——桶生命周期兜底,不值得打断移除交互。
 */
export function discardMobileUploadedAttachment(
  attachment: { path?: string },
  options: { getToken: () => Promise<string | null>; deps?: UploadDeps },
): void {
  const ref = typeof attachment.path === 'string' && isAttachmentOssRef(attachment.path)
    ? parseAttachmentOssRef(attachment.path)
    : null;
  if (!ref) return;
  void (async () => {
    try {
      const token = await options.getToken();
      if (!token) return;
      await deleteMobileAttachmentUpload(ref.ossKey, {
        token,
        deps: options.deps,
      });
    } catch {
      // best-effort:失败静默,桶生命周期兜底。
    }
  })();
}

function uploadExtForName(name: string): string {
  const ext = extractRemoteFileExt(name).replace(/^\.+/, '');
  return ext || 'bin';
}

function normalizePresignResult(value: MobileAttachmentPresignResult): MobileAttachmentPresignResult {
  if (!value || typeof value.putUrl !== 'string' || typeof value.key !== 'string') {
    throw new Error(i18n.t('composer.upload.invalidUploadUrl'));
  }
  return {
    putUrl: value.putUrl,
    key: value.key,
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : '',
  };
}
