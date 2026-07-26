/**
 * mediaTransfer.ts — device-link 双向媒体「OSS 中转」的 main 侧传输 client。
 * ---------------------------------------------------------------------------
 * relay 帧上限 2MB,内联字节不可行 —— 大媒体(图片/文件/视频)一律走 OSS 直传/直下,
 * bytes **不经 relay / server**:
 *
 *   上传方  ──presign-put──▶ server(签名)         PUT bytes ──▶ OSS
 *   下载方  ──presign-get──▶ server(同账号鉴权)    GET bytes ◀── OSS
 *   用后    ──DELETE /media─▶ server(owner 校验)   delete   ──▶ OSS
 *
 * 出/入方向共用本 client:
 *   - 入方向(控制端看被控端媒体):被控端 upload 本地缓存文件 → 控制端 download/range 取。
 *   - 出方向(控制端发附件):控制端 upload 本地附件 → 被控端 download 物化喂 agent。
 *
 * server 端点见 `apps/server/src/services/deviceLinkMedia.ts`;presign 走 `serverApiFetch`
 * (自动带 Bearer + 401 refresh),OSS PUT/GET 走裸 `net.fetch`(绝对 URL,不经 API_BASE)。
 *
 * 大文件策略:
 *   - 上传:≤ STREAM_THRESHOLD 的小媒体读进 Buffer 后整体 PUT(沿用 imageUploadIpc 的成熟路径,
 *     对图片/小文件最稳);超过阈值的大文件从磁盘**流式** PUT(`Readable.toWeb` + `duplex:'half'`
 *     + 显式 Content-Length),避免把几 GB 视频整文件读进内存。流式上传的端到端可用性在 #25
 *     本地全栈 e2e 复核(Chromium net 栈支持 duplex half,但个别 endpoint 行为需实测)。
 *   - 下载:整文件下载(小媒体)用 arrayBuffer;range 流式(视频/音频)返回**原始 OSS Response**,
 *     由调用方(`cindy-remote-media://` handler)透传其 body 流,绝不在此 buffer 整个视频。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { net } from 'electron';
import type { AttachmentIntegrity } from '@cindy/device-link';

import { serverApiFetch } from '../serverApiClient.js';
import { requireAppCapability } from '../appCapabilities.js';
import { deviceLinkApiBase } from './index.js';
import { describeErrorChain } from '../utils/errorChain.js';
import { createLogger } from '../logger.js';

const log = createLogger('device-link:mediaTransfer');

/** 超过此大小的上传走磁盘流式,不进内存。64 MiB 覆盖几乎所有图片/文档。 */
const STREAM_THRESHOLD = 64 * 1024 * 1024;
/**
 * 单对象上限 2GB,与 server deviceLinkMedia.MAX_SIZE 对齐。OSS V1 预签名 PUT 无法绑定
 * content-length,故在客户端(本机 main = 实际上传方)按真实字节数自校并拒绝超限,
 * 让大小上限对正常上传路径真实生效(server 端再校验声称的 size 作第二道)。
 */
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;

const PRESIGN_PUT_PATH = '/api/device-link/media/presign-put';
const PRESIGN_GET_PATH = '/api/device-link/media/presign-get';
const DELETE_PATH = '/api/device-link/media';

/**
 * device-link 媒体关心的 ext→mime(覆盖图片/视频/音频/常见文档)。
 * 仅作 OSS 存储 Content-Type 的 best-effort 兜底;入方向权威 mime 来自被控端
 * cache-store resolver(readFile 返回),不依赖本表。未知 → octet-stream。
 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  pdf: 'application/pdf',
  txt: 'text/plain',
  json: 'application/json',
};

/** 从文件路径取裸扩展名(无点、小写),无扩展名 → 'bin'。 */
function extOf(localPath: string): string {
  const e = path.extname(localPath).replace(/^\.+/, '').toLowerCase();
  return e || 'bin';
}

/** ext → mime,未知回落 application/octet-stream。 */
function mimeOf(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

interface PresignPutResponse {
  putUrl: string;
  key: string;
  expiresAt: string;
}
interface PresignGetResponse {
  getUrl: string;
  expiresAt: string;
}

export interface UploadResult {
  /** OSS object key(key 内嵌 userId,承载同账号鉴权);引用经 relay 传给对端。 */
  key: string;
  size: number;
  contentType: string;
  /** 实际送入 OSS 的字节摘要。 */
  sha256: string;
}

/** 向 relay server 申请上传预签名。 */
async function presignPut(
  size: number,
  ext: string,
  contentType: string,
): Promise<PresignPutResponse> {
  requireAppCapability('canUseDeviceLink', 'Device Link requires a Cindy account.');
  return serverApiFetch<PresignPutResponse>(PRESIGN_PUT_PATH, {
    method: 'POST',
    body: { size, ext, contentType },
    baseUrl: deviceLinkApiBase(),
  });
}

/** 向 relay server 申请下载预签名(server 校验请求方 == key 内嵌 userId)。 */
async function presignGet(key: string): Promise<PresignGetResponse> {
  requireAppCapability('canUseDeviceLink', 'Device Link requires a Cindy account.');
  return serverApiFetch<PresignGetResponse>(PRESIGN_GET_PATH, {
    method: 'POST',
    body: { key },
    baseUrl: deviceLinkApiBase(),
  });
}

type OssPutBody = ArrayBuffer | ReadableStream;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 可重放的 PUT body 供给者。换传输栈重试必须重新构造 body(流只能消费一次),
 * 同时要能分辨"这一跳失败是网络问题还是本地读盘问题",并释放上一跳的资源。
 */
interface OssPutBodySource {
  /** 构造本跳的 body。抛错视为不可重试(源打不开,换栈无益)。 */
  create(): OssPutBody;
  /** 本跳是否因**本地源**出错而失败;返回原错误则不换栈重试。 */
  localFailure?(): unknown;
  /** 放弃本跳:关掉底层文件流,别让被丢弃的 body 攥着 fd 与缓冲。 */
  dispose?(): void;
}

/**
 * presign URL 的 query 里带着可直接复用的上传签名,日志与回传给控制端的错误
 * 只能出现 host。
 */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<invalid-url>';
  }
}

/**
 * 用户可见错误只带最必要的判因线索:第一个 errno(ETIMEDOUT / ECONNREFUSED /
 * 证书类),够反馈截图判因,又不把 host、地址族、完整链路抖到控制端界面上
 * ——那些只进主进程日志。
 *
 * 必须同时下探 `AggregateError.errors`:undici 开着 happy-eyeballs,每个地址族
 * 的真实 errno 恰恰只存在于聚合分支里,只走 cause 链会在最典型的场景下什么码
 * 都拿不到。
 */
function failureHint(err: unknown): string {
  const seen = new Set<unknown>();
  const visit = (cur: unknown, depth: number): string | null => {
    if (!(cur instanceof Error) || depth > 4 || seen.has(cur)) return null;
    seen.add(cur);
    const code = (cur as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && code) return code;
    // Chromium 侧不带 errno,可判因的码在 message 里(net::ERR_PROXY_CONNECTION_FAILED 等)。
    const chromiumCode = /net::ERR_[A-Z0-9_]+/.exec(cur.message);
    if (chromiumCode) return chromiumCode[0];
    if (cur instanceof AggregateError) {
      for (const inner of cur.errors) {
        const hit = visit(inner, depth + 1);
        if (hit) return hit;
      }
    }
    return visit(cur.cause, depth + 1);
  };
  const hit = visit(err, 0);
  if (hit) return hit;
  if (err instanceof Error) return err.name === 'TypeError' ? 'NETWORK_ERROR' : err.name;
  return 'UNKNOWN';
}

/**
 * 换传输栈重试也没用的失败:body 构造失败(源文件读不了)与 HTTP 应用层拒绝
 * (签名/权限/配额)。携带最终要抛给调用方的错误。
 */
class NonRetriableOssPutError extends Error {
  constructor(
    readonly inner: unknown,
    /** HTTP 应用层拒绝时的状态码;body 构造失败等本地故障没有。 */
    readonly httpStatus?: number,
  ) {
    super('non-retriable OSS PUT failure');
    this.name = 'NonRetriableOssPutError';
  }
}

/**
 * 上次靠 Electron net 才传成功的 host → 记忆时间。ETIMEDOUT 类失败一次要等
 * 几十秒,不记住的话用户每预览一个文件都先白等一轮 undici 超时。
 * 带 TTL 是为了让网络环境恢复(关掉代理/换网)后自动回到主路径。
 */
const electronNetPreferredHosts = new Map<string, number>();
const TRANSPORT_PREFERENCE_TTL_MS = 30 * 60 * 1000;

interface OssPutTransport {
  name: 'undici' | 'electron-net';
  impl: FetchLike;
}

const UNDICI_TRANSPORT: OssPutTransport = {
  name: 'undici',
  impl: (url, init) => globalThis.fetch(url, init),
};
const ELECTRON_NET_TRANSPORT: OssPutTransport = {
  name: 'electron-net',
  impl: (url, init) => net.fetch(url, init),
};

/**
 * 记住某 host 要走 Electron 优先。顺手清掉已过期的条目:清理原本只发生在
 * "再次命中同一 host"时,多 region / 多 bucket 场景下这张表会在 main 进程的
 * 整个生命周期里只增不减。
 */
function rememberElectronNetPreference(host: string, now: number): void {
  for (const [known, at] of electronNetPreferredHosts) {
    if (now - at >= TRANSPORT_PREFERENCE_TTL_MS) electronNetPreferredHosts.delete(known);
  }
  electronNetPreferredHosts.set(host, now);
}

function transportOrderFor(host: string): OssPutTransport[] {
  const preferredAt = electronNetPreferredHosts.get(host);
  if (preferredAt !== undefined && Date.now() - preferredAt < TRANSPORT_PREFERENCE_TTL_MS) {
    return [ELECTRON_NET_TRANSPORT, UNDICI_TRANSPORT];
  }
  if (preferredAt !== undefined) electronNetPreferredHosts.delete(host);
  return [UNDICI_TRANSPORT, ELECTRON_NET_TRANSPORT];
}

/**
 * 裸 PUT 字节到 OSS 预签名 URL(绝对 URL,不经 serverApiFetch)。失败抛错。
 *
 * 传输栈两跳:默认先 undici(`globalThis.fetch`),**网络层**失败再换 Electron
 * `net.fetch` 试一次。两者差别是致命的——undici 不吃系统代理,而本进程其它请求
 * (presign / OSS GET)全走 `net.fetch`(Chromium 网络栈,吃系统代理、PAC 与系统
 * 证书)。代理或分流环境下于是出现"登录、聊天、文本预览都正常,凡是要 OSS 中转
 * 的图片 / PDF / 视频 / 导出分享全打不开"的怪象,且 undici 只回一个裸
 * `fetch failed`,日志里看不出因。换栈成功后按 host 记住顺序,免得之后每传一个
 * 文件都先白等一轮 undici 超时。
 *
 * 默认主路径仍是 undici:`x-oss-object-acl` 是 canonical header,与 server 侧
 * signPutUrl 的签名绑定,历史上 Chromium net 栈对自定义 header 的处理让这条路
 * 不可靠。换栈因此是安全的——若 `net.fetch` 剥掉该 header,签名不再匹配,OSS
 * 只会返回 403,绝不会静默把对象降级成 bucket 默认的公开可读。
 *
 * 只有**网络层**失败才换栈:HTTP 应用层拒绝(签名/权限/配额)与本地源读盘失败
 * 换栈都无益,原样抛给调用方,免得白传一遍还把原因掩盖成"两条栈都失败"。
 */
async function putBytesToOss(
  putUrl: string,
  bodySource: OssPutBodySource,
  contentType: string,
): Promise<void> {
  const host = hostOf(putUrl);
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    // device-link 媒体一律私有:对象 ACL 设 private(覆盖 public-read bucket 默认),
    // 仅 presign-get 可下载。OSS V1 签名规范要求 ACL 走 canonical header(sub-resource 白名单
    // 不含 x-oss-object-acl,放 query 会签名不匹配)。
    'x-oss-object-acl': 'private',
  };
  const attempt = async (impl: FetchLike): Promise<void> => {
    let body: OssPutBody;
    try {
      body = bodySource.create();
    } catch (err) {
      throw new NonRetriableOssPutError(err);
    }
    const init: RequestInit & { duplex?: 'half' } = { method: 'PUT', headers, body };
    // 流式 body 必须带 duplex:'half'(标准 fetch 要求),Buffer body 无需。
    if (body instanceof ReadableStream) init.duplex = 'half';
    const resp = await impl(putUrl, init as RequestInit);
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      log.warn(`OSS PUT rejected status=${resp.status} host=${host} body=${txt.slice(0, 200)}`);
      throw new NonRetriableOssPutError(new Error(`OSS PUT 失败 (${resp.status})`), resp.status);
    }
    // PUT 的成功响应体用不上,但不消费/取消的话底层连接不会及时归还
    // (与 provider-diagnostics 的非流式探测同一处理)。
    try {
      await resp.body?.cancel();
    } catch {
      /* no-op */
    }
  };

  const order = transportOrderFor(host);
  // 记忆把 Electron 跳提到了首位——而它正是"对自定义 header 不可靠"的那条。
  // 这种顺序下它的 HTTP 拒绝不能当最终结论,否则环境一变就要卡到 TTL 到期;
  // 只有默认顺序(undici 先)的拒绝才权威。
  const cachedFallbackFirst = order[0]?.name === 'electron-net';
  const failures: string[] = [];
  const hints: string[] = [];
  for (const transport of order) {
    try {
      await attempt(transport.impl);
    } catch (err) {
      if (err instanceof NonRetriableOssPutError) {
        const retriableCacheArtifact =
          cachedFallbackFirst && transport.name === 'electron-net' && err.httpStatus !== undefined;
        if (!retriableCacheArtifact) {
          bodySource.dispose?.();
          throw err.inner;
        }
        // 这条记忆已经不值得信:清掉,让本次与后续都回到 undici 优先。
        electronNetPreferredHosts.delete(host);
        bodySource.dispose?.();
        // 只进 failures(日志),不进 hints:这一跳是"已判定不可信、已换栈"的中间
        // 态,把它的 HTTP 码混进用户可见串会把人往权限方向带,而真正卡住的是后面
        // 那跳。默认栈自己被拒时是 non-retriable,状态码照样会原样抛出。
        failures.push(`${transport.name}:HTTP ${err.httpStatus}`);
        log.warn(`OSS PUT cached fallback rejected host=${host} status=${err.httpStatus}; retrying via undici`);
        continue;
      }
      // 源文件读盘失败在 fetch 消费 body 时才浮出来,形态与网络失败一样;
      // 不甄别就会白读一遍磁盘,还把真实原因埋进"两条栈都失败"的汇总里。
      const localFailure = bodySource.localFailure?.();
      bodySource.dispose?.();
      if (localFailure !== undefined && localFailure !== null) throw localFailure;
      const detail = describeErrorChain(err);
      failures.push(`${transport.name}:${detail}`);
      hints.push(failureHint(err));
      log.warn(`OSS PUT transport failed host=${host} via=${transport.name}: ${detail}`);
      continue;
    }
    if (transport.name === 'electron-net') {
      // 只在"确实是从 undici 失败里救回来"时记时间戳。命中记忆直接成功的不刷新,
      // 否则只要每 30 分钟内传一次文件,TTL 就永远到不了期,undici 再也不被探测。
      if (failures.length > 0) {
        rememberElectronNetPreference(host, Date.now());
        log.info(`OSS PUT recovered via Electron net host=${host} (undici unusable: ${failures.join('; ')})`);
      }
    } else {
      // undici 又通了:清掉记忆,回到默认顺序。
      electronNetPreferredHosts.delete(host);
    }
    return;
  }
  // 用户可见串只留 errno;host 与完整 cause 链已进日志(见上面的 warn)。
  // 括号而非冒号:控制端模板本身是「取回 PDF 失败：{{detail}}」,再来一个冒号
  // 会串成两级冒号。中文标点按 i18n/GLOSSARY.md 的 zh-CN 规则用全角。
  const visibleHints = [...new Set(hints)].join(' / ');
  throw new Error(visibleHints ? `OSS 上传失败（${visibleHints}）` : 'OSS 上传失败');
}

/**
 * 上传本地文件到 OSS 中转区,返回 { key, size, contentType }。
 * 小文件整体 PUT,大文件磁盘流式 PUT(见文件头策略)。
 * @param contentType 显式覆盖;不传则按扩展名 best-effort 推断。
 * @param extHint 扩展名来源覆盖:字节仍从 `localPath` 读,但 OSS key 后缀与
 *   mime 推断按此扩展名。用于 localPath 是 symlink 真实目标(可能无/异扩展名)、
 *   而语义扩展名应取请求 URL 的场景(device-link 取件的 symlink 媒体)。
 */
export async function uploadLocalFile(
  localPath: string,
  opts: {
    contentType?: string;
    extHint?: string;
    /** 可选上传进度(已送入 HTTP 栈的字节数,略超前于真实网络进度)。 */
    onProgress?: (uploadedBytes: number) => void;
  } = {},
): Promise<UploadResult> {
  const st = await stat(localPath);
  if (!st.isFile()) throw new Error(`不是文件: ${localPath}`);
  const size = st.size;
  if (size > MAX_MEDIA_BYTES) {
    throw new Error(`文件超过上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024 / 1024)}GB`);
  }
  const ext =
    opts.extHint !== undefined ? opts.extHint.replace(/^\.+/, '').toLowerCase() : extOf(localPath);
  const contentType = opts.contentType ?? mimeOf(ext);
  const { putUrl, key } = await presignPut(size, ext, contentType);
  let sha256: string;

  try {
    if (size <= STREAM_THRESHOLD) {
      // 小媒体:读进 Buffer 整体 PUT(成熟稳定路径)。整体 PUT 无中间粒度,
      // 完成时一次性回调。
      const buf = await readFile(localPath);
      if (buf.byteLength !== size) {
        throw new Error(`文件在上传前发生变化:预期 ${size} 字节,实际 ${buf.byteLength} 字节`);
      }
      sha256 = createHash('sha256').update(buf).digest('hex');
      // Buffer body 可重放:换栈重试直接复用同一份字节(fetch 不 transfer ArrayBuffer),
      // 也没有需要释放的底层资源。
      await putBytesToOss(putUrl, { create: () => exactArrayBuffer(buf) }, contentType);
      opts.onProgress?.(size);
    } else {
      // 大媒体:磁盘流式 PUT,避免整文件进内存;经计数 Transform 上报进度。
      // 流只能消费一次,换传输栈重试必须重新开流。每次尝试各记各的字节数与摘要:
      // 被放弃的那条流在 backpressure 停住前还会再推几个 chunk,共享计数会被它
      // 串扰成"实际字节多于文件大小",于是好端端的重传被判成"文件上传期间变了"。
      interface StreamAttempt {
        sent: number;
        sha256: string;
        sourceError: unknown;
        dispose(): void;
      }
      const attempts: StreamAttempt[] = [];
      const bodySource: OssPutBodySource = {
        create(): ReadableStream {
          const source = createReadStream(localPath);
          const hasher = createHash('sha256');
          const current: StreamAttempt = {
            sent: 0,
            sha256: '',
            sourceError: null,
            dispose() {
              source.destroy();
              counter.destroy();
            },
          };
          const counter = new Transform({
            transform(chunk: Buffer, _enc, cb) {
              current.sent += chunk.length;
              hasher.update(chunk);
              // 只有当前这跳有资格上报进度(控制端看到的已传字节因此可能回退一次)。
              if (attempts.at(-1) === current) opts.onProgress?.(current.sent);
              cb(null, chunk);
            },
            flush(cb) {
              current.sha256 = hasher.digest('hex');
              cb();
            },
          });
          // 读盘失败多半是异步 'error' 事件,到 putBytesToOss 手里只是一个
          // "fetch 消费 body 时挂了",与网络失败长得一模一样——记下来供其甄别。
          // 必须同时把错误推给下游:`pipe` 不转发 error,只记不推的话 counter
          // 既不 end 也不 error,web body 就此挂住,PUT 会一直干等到超时。
          source.on('error', (err) => {
            current.sourceError = err;
            counter.destroy(err);
          });
          attempts.push(current);
          return Readable.toWeb(source.pipe(counter)) as unknown as ReadableStream;
        },
        localFailure: () => attempts.at(-1)?.sourceError ?? null,
        // 被放弃的 body 不主动关掉的话,底层 createReadStream 会一直攥着 fd 与
        // 已缓冲的数据,每次换栈上传都漏一个。
        dispose: () => attempts.at(-1)?.dispose(),
      };
      await putBytesToOss(putUrl, bodySource, contentType);
      const uploadedAttempt = attempts.at(-1);
      if (!uploadedAttempt || uploadedAttempt.sent !== size) {
        // Cleanup is centralized below so transport and source-stream errors use the same path.
        throw new Error(
          `文件在上传期间发生变化：预期 ${size} 字节，实际 ${uploadedAttempt?.sent ?? 0} 字节`,
        );
      }
      if (!uploadedAttempt.sha256) throw new Error('上传流未读完，无法确认字节摘要');
      sha256 = uploadedAttempt.sha256;
    }
  } catch (error) {
    // Cleanup is best-effort after every post-presign transfer failure.
    await removeRemote(key);
    throw error;
  }
  log.debug(`uploaded key=${key} size=${size} ct=${contentType} integrity=sha256`);
  return { key, size, contentType, sha256 };
}

/**
 * 上传内存字节到 OSS 中转区(出方向 base64 附件用;无本地文件可走 uploadLocalFile)。
 * 始终整体 PUT(base64 附件通常是小图/截图;真大文件走文件路径的流式 uploadLocalFile)。
 */
export async function uploadBuffer(
  bytes: Buffer,
  opts: { ext: string; contentType?: string },
): Promise<UploadResult> {
  const size = bytes.byteLength;
  if (size <= 0) throw new Error('uploadBuffer: 空字节');
  if (size > MAX_MEDIA_BYTES) {
    throw new Error(`文件超过上限 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024 / 1024)}GB`);
  }
  const ext = extOf(`x.${opts.ext}`);
  const contentType = opts.contentType ?? mimeOf(ext);
  const { putUrl, key } = await presignPut(size, ext, contentType);
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await putBytesToOss(putUrl, { create: () => ab }, contentType);
  log.debug(`uploaded(buffer) key=${key} size=${size} ct=${contentType} integrity=sha256`);
  return { key, size, contentType, sha256 };
}

/** Buffer → 精确 ArrayBuffer，避免 Buffer pool 带出视图外字节。 */
function exactArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

export interface DownloadResult {
  bytes: Buffer;
  contentType: string | null;
}

/** 整文件下载到内存(用于小媒体物化;大视频走 openMediaStream 流式,勿用本函数)。 */
export async function downloadToBuffer(key: string): Promise<DownloadResult> {
  const { getUrl } = await presignGet(key);
  const resp = await net.fetch(getUrl, { method: 'GET' });
  if (!resp.ok) {
    throw new Error(`OSS GET 失败 (${resp.status})`);
  }
  const ab = await resp.arrayBuffer();
  return { bytes: Buffer.from(ab), contentType: resp.headers.get('content-type') };
}

/**
 * 打开 OSS 媒体的(可选 range)读取流,返回**原始 OSS Response**。
 * 调用方(控制端 `cindy-remote-media://` handler)直接透传其 status(200/206)、
 * Content-Range / Content-Length / Content-Type 头与 body 流,实现视频/音频流式 206,
 * 不在此 buffer 整个文件。
 * @param rangeHeader 形如 "bytes=0-1023";不传则整文件 GET。
 */
export async function openMediaStream(
  key: string,
  rangeHeader?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const { getUrl } = await presignGet(key);
  const headers: Record<string, string> = {};
  if (rangeHeader) headers['Range'] = rangeHeader;
  // signal 透传:renderer 中途取消(视频 seek / 关闭播放器)时,撕掉上游 OSS 连接,
  // 避免悬挂的 net.fetch 流(否则 <video> 反复 scrub 会堆积半读连接)。
  const resp = await net.fetch(getUrl, { method: 'GET', headers, signal });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`OSS GET(range) 失败 (${resp.status})`);
  }
  return resp;
}

/** 附件下载内容与发送端声明不一致。 */
export class AttachmentIntegrityError extends Error {
  constructor(
    public readonly reason: 'size' | 'sha256',
    message: string,
  ) {
    super(message);
    this.name = 'AttachmentIntegrityError';
  }
}

/**
 * 流式下载 OSS 对象到本地文件(用于出方向附件物化:被控端把字节写盘喂 agent)。
 * 不经内存整 buffer —— 大附件(几 GB)也不会撑爆 main 进程堆；完整性校验通过后才原子发布。
 */
export async function downloadToFile(
  key: string,
  destPath: string,
  expected?: AttachmentIntegrity,
  onProgress?: (downloadedBytes: number) => void,
): Promise<void> {
  const { getUrl } = await presignGet(key);
  const resp = await net.fetch(getUrl, { method: 'GET' });
  if (!resp.ok) throw new Error(`OSS GET 失败 (${resp.status})`);
  if (!resp.body) throw new Error('OSS GET 响应无 body');
  const partPath = `${destPath}.${randomUUID()}.part`;
  const hasher = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hasher.update(chunk);
      onProgress?.(size);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(resp.body as Parameters<typeof Readable.fromWeb>[0]),
      counter,
      createWriteStream(partPath, { flags: 'wx' }),
    );
    const sha256 = hasher.digest('hex');
    if (expected && size !== expected.size) {
      throw new AttachmentIntegrityError(
        'size',
        `附件下载不完整:预期 ${expected.size} 字节,实际 ${size} 字节,请重新上传。`,
      );
    }
    if (expected && sha256 !== expected.sha256) {
      throw new AttachmentIntegrityError(
        'sha256',
        '附件完整性校验失败:下载内容与发送端不一致,请重新上传。',
      );
    }
    await rename(partPath, destPath);
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** 删除中转对象(relay 校验 ownership 后删 OSS;对象不存在幂等)。失败仅 warn 不抛——
 *  清理是 best-effort,失败让 OSS 生命周期规则兜底,不应阻断主流程。 */
export async function removeRemote(key: string): Promise<void> {
  try {
    requireAppCapability('canUseDeviceLink', 'Device Link requires a Cindy account.');
    await serverApiFetch<{ deleted: boolean }>(DELETE_PATH, {
      method: 'DELETE',
      body: { key },
      baseUrl: deviceLinkApiBase(),
    });
    log.debug(`removed key=${key}`);
  } catch (err) {
    log.warn(`removeRemote failed key=${key}: ${String(err)}`);
  }
}

export const __testing = {
  extOf,
  mimeOf,
  MIME_BY_EXT,
  STREAM_THRESHOLD,
  MAX_MEDIA_BYTES,
  /** 传输栈记忆是模块级状态,单测之间必须清干净。 */
  electronNetPreferredHosts,
  TRANSPORT_PREFERENCE_TTL_MS,
};
