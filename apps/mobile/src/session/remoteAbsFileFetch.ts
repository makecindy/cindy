/**
 * workdir 外远程文件取件(absPath → 可下载 URL)。
 *
 * 聊天 chip 的目标可能落在会话 workdir 之外(如 agent 写到 /tmp 的截图),
 * file-browser 的 relPath 通道(readFile / thumbnail / exportFile*)对这类
 * 路径一律拒绝。这里改走被控端 media:fetch 的绝对路径通道
 * (`xdt-file://open?path=<absPath>`,与文件浏览器 gallery 同一 scheme):
 * 被控端把文件上传 OSS → 手机 presign 换下载地址。安全边界与桌面控制端一致
 * ——media:fetch 故意不限 workdir,靠 device-link 的三道 gate(被控开关 /
 * 撤销黑名单 / channel 白名单)保证「等同本地访问」的信任级。
 *
 * 缓存策略(bot review 实捉后收紧):`xdt-file://` 不进被控端 mtime/size 感知
 * 的上传去重缓存(那只对 `xdt-image://` 生效,见 desktop mediaFetch.ts),手机侧
 * 又没有 mtime 来源可验证文件是否被覆写——若按 presign 全期(约 1 小时)缓存,
 * 同路径文件被 agent 覆写后会一直吃到旧字节。因此这里只做**短 TTL** 缓存:
 * 覆盖同一次预览/分享内的连续消费(图片页取原图 → lightbox → 导出分享),
 * 跨时间点重进则重新取件拿新字节;条目数带上限 FIFO 淘汰(对齐被控端
 * rememberUpload 的写法),长会话不累积。
 */
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { i18n } from '@/i18n';
import type {
  FileBrowserReadFileResult,
  MobileMakerTransport,
  RemoteTextFilePreviewResult,
} from '@/device-link/mobileMakerTransport';
import {
  effectiveRemoteMediaSshContext,
  remoteFileMediaUrl,
  type RemoteMediaFetchConstraints,
  type RemoteMediaSshContext,
} from '@/session/fileBrowserGallery';
import {
  isResolvedRemoteMediaFresh,
  resolveMobileRemoteMedia,
  type MobileRemoteMediaPresignResult,
  type MobileResolvedRemoteMedia,
} from '@/session/remoteMedia';

export interface RemoteAbsFileFetchDeps {
  maker: Pick<MobileMakerTransport, 'fetchRemoteMedia'>;
  deviceId: string;
  openLink: (deviceId: string) => Promise<unknown>;
  presignGet: (ossKey: string) => Promise<MobileRemoteMediaPresignResult>;
}

/** 缓存 TTL:只护住一次预览/分享动作链,把「同路径覆写吃旧字节」窗口压到 1 分钟。 */
const CACHE_TTL_MS = 60 * 1000;
/** 条目上限:超出按插入序淘汰最旧(Map 迭代序 = 插入序)。 */
const CACHE_MAX = 64;

interface CacheEntry {
  media: MobileResolvedRemoteMedia;
  cachedAt: number;
}

/** 短 TTL 取件结果缓存(模块级;命中同时要求 presign 未过期)。 */
const cache = new Map<string, CacheEntry>();

function lookupCache(key: string, now: number): MobileResolvedRemoteMedia | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.cachedAt >= CACHE_TTL_MS || !isResolvedRemoteMediaFresh(hit.media, now)) {
    cache.delete(key);
    return null;
  }
  return hit.media;
}

function rememberFetch(key: string, media: MobileResolvedRemoteMedia, now: number): void {
  cache.delete(key); // 重插保持插入序,FIFO 淘汰最旧
  cache.set(key, { media, cachedAt: now });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * absPath → presign 下载地址。并发去重不做(调用场景是单文件预览/分享,
 * 不存在列表级风暴)。
 */
export async function fetchRemoteAbsFileToUrl(
  deps: RemoteAbsFileFetchDeps,
  absPath: string,
  /**
   * SSH 会话的取件上下文(见 remoteFileMediaUrl):不传会让被控端把 absPath 当**本机**
   * 路径解析。**必须进缓存键** —— 同一路径在不同远端主机上是不同文件,漏进去会串味。
   */
  ssh?: RemoteMediaSshContext | null,
): Promise<string> {
  // 缓存键与 URL 必须走**同一份**「有效 SSH 上下文」判定(review P2):只看 `ssh` 对象是否
  // 存在会让字段为空/带空白的对象把键分叉,而 URL 那边已经退化成不带 SSH 参数(被控端按
  // 本机路径取件)—— 于是同一次取件永远命中不了缓存,每次都白发一轮请求。
  const eff = effectiveRemoteMediaSshContext(ssh);
  const sshKey = eff
    ? `${eff.sessionId}\u0000${eff.remoteHostId}\u0000${eff.workdir}`
    : '';
  const key = `${deps.deviceId}\u0000${absPath}\u0000${sshKey}`;
  const cached = lookupCache(key, Date.now());
  if (cached) return cached.url;
  const resolved = await withTransientRemoteRetry(async () => {
    await deps.openLink(deps.deviceId);
    // kind 只影响结果的 previewable 标志(此处不消费),按 image 占位。
    return resolveMobileRemoteMedia(
      { kind: 'image', url: remoteFileMediaUrl(absPath, undefined, ssh) },
      { fetchRemoteMedia: deps.maker.fetchRemoteMedia, presignGet: deps.presignGet },
    );
  });
  rememberFetch(key, resolved, Date.now());
  return resolved.url;
}

/**
 * 一次性取件:返回**完整** resolved 结果(含 ossKey)且**不进共享缓存**。
 *
 * 给「取回字节后立刻转成 data: URI」的消费方用(HTML 渲染态的同目录资源):
 *  - 需要 ossKey 才能在用完后 DELETE 掉 OSS 对象 —— fetchRemoteAbsFileToUrl 只回 url、
 *    丢掉 ossKey,于是每个资源都会遗留一个在世对象,一页最多 32 个,反复进出还会累积
 *    (review P1)。
 *  - 不进那份 60s TTL 缓存:对象用完即删,缓存命中会回一个已被删除的死 URL。
 */
export async function fetchRemoteAbsFileOnce(
  deps: RemoteAbsFileFetchDeps,
  absPath: string,
  ssh?: RemoteMediaSshContext | null,
  /**
   * 每次上传成功、拿到 ossKey 时回调(可能被调用多次,见下)。
   *
   * **调用方必须累加收集,并对每个 key 都做 best-effort DELETE**:
   *  - presign 失败(弱网 / 回包非法)会让 resolveMobileRemoteMedia 在返回之前抛错,
   *    此时对象已经在 OSS 上,但调用方拿不到 resolved 结果 —— 只围绕结果写 finally 的话
   *    这个对象永久遗留(review P1);
   *  - withTransientRemoteRetry 的每一次重试都可能再上传一份,产出**不同**的 key,
   *    所以只记最后一个同样会漏。
   */
  onOssKey?: (ossKey: string) => void,
  /**
   * 服务端强制约束(baseDir / maxBytes)。**必须在这里传**,而不是只在手机侧判:
   * 手机拿到 `media.size` 时被控端已经上传完 OSS(SSH 场景还先整份拉到 Desktop 磁盘缓存),
   * 流量与磁盘已经花掉了(review P2)。老被控端忽略这两个参数,故手机侧判断照旧保留。
   */
  constraints?: RemoteMediaFetchConstraints | null,
): Promise<MobileResolvedRemoteMedia> {
  return withTransientRemoteRetry(async () => {
    await deps.openLink(deps.deviceId);
    // kind 只影响结果的 previewable 标志(此处不消费),按 image 占位。
    return resolveMobileRemoteMedia(
      { kind: 'image', url: remoteFileMediaUrl(absPath, undefined, ssh, constraints) },
      { fetchRemoteMedia: deps.maker.fetchRemoteMedia, presignGet: deps.presignGet },
      onOssKey ? { onOssKey } : undefined,
    );
  });
}

/**
 * text-file:read-preview 回包 → file-browser readFile 同构结果(absPath
 * 单文件模式专用,让预览页文本渲染零分支)。该通道返回纯文本(无 gzip /
 * truncated 语义),oversize 映射 OVERSIZE 供「超上限,可下载」占位复用。
 */
export function adaptTextFilePreviewResult(
  absPath: string,
  res: RemoteTextFilePreviewResult,
): FileBrowserReadFileResult {
  if (res.success && typeof res.data === 'string') {
    return {
      ok: true,
      data: { relPath: absPath, content: res.data, size: res.size, mtimeMs: 0 },
    };
  }
  if (res.reason === 'oversize') {
    return {
      ok: false,
      code: 'OVERSIZE',
      stat: { relPath: absPath, type: 'file', size: res.size, mtimeMs: 0 },
    };
  }
  const message = res.reason === 'not_found'
    ? i18n.t('composer.attachments.fileNotFound')
    : res.reason === 'forbidden'
      ? i18n.t('composer.attachments.pathNotReadable')
      : res.error ?? i18n.t('composer.attachments.readFailed');
  return { ok: false, code: 'READ_FAILED', message };
}
