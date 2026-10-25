/**
 * remoteMediaUrl.ts — 远程会话媒体层的「远程媒体 URL」编解码(renderer 与 main 共用)。
 * ---------------------------------------------------------------------------
 * 远程会话(device-link 跨设备镜像 / SSH 远端 host)里,消息中的本机媒体 URL
 * (`xdt-image://` / `xdt-video://` / `xdt-file://` / `xdt-audio://`,以及媒体总仓
 * 的 `cindy-media://` blob 地址)指向的是**远端
 * 机器**的本地文件 / 缓存,控制端本机并没有这些字节 —— 原样渲染必然 404。本模块把
 * 这些 URL 改写成统一的:
 *
 *     cindy-remote-media://m/{b64url(originToken)}/{b64url(原始媒体URL)}
 *
 * 控制端 main 注册的 `cindy-remote-media://` handler 解出 (origin, 原始URL),按来源
 * 分流取字节(见 device-link/remoteMediaProtocol.ts):
 *   - device(跨设备):经 OSS 中转向被控端取(media:fetch,接受任意绝对路径);
 *   - ssh(远端 host):经 remote-file-service 分片拉到本地磁盘缓存再服务
 *     (只能读会话 workdir 内的文件,见 isSshRewritableMediaUrl)。
 *
 * originToken 线格式(见 encode/decodeRemoteMediaOriginToken):
 *   - device:**裸 deviceId 字符串**(与 ssh 支持引入前逐字节一致 —— device-link
 *     的既有 URL 形态零变化,gallery includes 匹配、缓存键等都不受影响);
 *   - ssh:JSON `{"k":"ssh","id":remoteHostId,"wd":workdir}`。带 workdir 是刻意的:
 *     原始 URL 里只有绝对路径,handler 无状态就能算出 workdir 相对路径去调
 *     file-service,不必反查会话表。
 *   - 解码兼容:非 JSON / 非法 JSON 一律按裸 deviceId 处理(URL 是渲染期临时产物、
 *     不落库,兼容层只为升级混跑窗口)。
 *
 * 设计要点:
 *  - **固定 host `m`**:token / 原始URL 都放进**路径段**。URL host 会被解析器强制
 *    小写(`new URL` 行为),而 deviceId 在本地联调时可被 `XDT_DEVICE_ID_OVERRIDE`
 *    设成任意大小写 —— 放 host 会被静默小写化导致两端 deviceId 对不上。路径段保留大小写。
 *  - **base64url 编码**:原始 URL 含 `://` `?` `/` 等字符,即便 percent-encode 也会干扰
 *    privileged scheme 的标准 URL 解析。base64url 产物只含 `[A-Za-z0-9_-]`,作为单个
 *    路径段绝对安全、无歧义。UTF-8 安全(CJK 文件名)、renderer(btoa/atob)与 main
 *    (Buffer)双环境通用。
 */

/** 远程媒体统一 scheme。 */
export const REMOTE_MEDIA_SCHEME = "cindy-remote-media";
/** 固定 host 哨兵(避免把 deviceId 放 host 被小写化)。 */
export const REMOTE_MEDIA_HOST = "m";

/**
 * 远程媒体来源(URL 线格式的判别单元):
 *  - device:device-link 被控端,经 OSS 中转,可取任意绝对路径;
 *  - ssh:SSH 远端 host,经 file-service 分片取回,只能读 workdir 内文件,
 *    故 token 必须携带会话 workdir。
 */
export type RemoteMediaOrigin =
  | { kind: "device"; deviceId: string }
  | { kind: "ssh"; remoteHostId: string; workdir: string };

/**
 * 需要在远程会话里改写的本机媒体 scheme 前缀(device 来源全量适用;ssh 来源
 * 另有更窄的白名单,见 isSshRewritableMediaUrl)。`xdt-model://`(3D)不在聊天
 * 媒体范围,暂不纳入;未来如需再加。cindy-media:// 是媒体总仓的内容寻址 blob
 * 地址(迁移后生成图/视频的新形态),字节同样只在被控端本机,必须经中转。
 */
export const LOCAL_MEDIA_SCHEMES = [
  "xdt-image://",
  "xdt-video://",
  "xdt-file://",
  "xdt-audio://",
  "cindy-media://",
] as const;

/** ssh 来源可改写的 scheme:只有这两个的 URL 带 `?path=` 绝对路径语义。 */
const SSH_PATH_SCHEMES = ["xdt-file://", "xdt-audio://"] as const;

/** UTF-8 安全的 base64url 编码(无 padding,`+/`→`-_`),renderer/main 双环境通用。 */
export function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    typeof btoa !== "undefined"
      ? btoa(binary)
      : Buffer.from(binary, "binary").toString("base64");
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** toBase64Url 的逆:base64url → 原始 UTF-8 字符串。非法输入抛错(调用方需 try/catch)。 */
export function fromBase64Url(input: string): string {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary =
    typeof atob !== "undefined"
      ? atob(b64)
      : Buffer.from(b64, "base64").toString("binary");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** origin → token 线格式(device 裸串保持既有 URL 逐字节稳定;ssh JSON)。 */
export function encodeRemoteMediaOriginToken(
  origin: RemoteMediaOrigin,
): string {
  if (origin.kind === "device") return origin.deviceId;
  return JSON.stringify({
    k: "ssh",
    id: origin.remoteHostId,
    wd: origin.workdir,
  });
}

/**
 * token 线格式 → origin。JSON 且判别字段合法 → 按类型解;其余(含非法 JSON、
 * 数字/布尔等偶然可解析值)一律按 legacy 裸 deviceId。空串 → null。
 */
export function decodeRemoteMediaOriginToken(
  token: string,
): RemoteMediaOrigin | null {
  if (!token) return null;
  if (token.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(token);
      if (typeof parsed === "object" && parsed !== null) {
        const rec = parsed as Record<string, unknown>;
        if (
          rec.k === "ssh" &&
          typeof rec.id === "string" &&
          rec.id &&
          typeof rec.wd === "string" &&
          rec.wd
        ) {
          return { kind: "ssh", remoteHostId: rec.id, workdir: rec.wd };
        }
        // 预留:当前 encode 对 device 恒输出裸 deviceId(保持既有 URL 逐字节
        // 稳定),不会产生此 JSON 形态;保留解码宽容度是为未来 encode 若切换
        // JSON 形态时的混跑窗口,并把 token 语法完整性留在解码侧文档化。
        if (rec.k === "dev" && typeof rec.id === "string" && rec.id) {
          return { kind: "device", deviceId: rec.id };
        }
        return null; // JSON 对象但判别不合法:按畸形拒绝,不当 deviceId 误用
      }
    } catch {
      // 非法 JSON → 按 legacy 裸 deviceId 处理
    }
  }
  return { kind: "device", deviceId: token };
}

/** 该 URL 是否是「本机媒体 scheme」(device 来源下需要改写)。 */
export function isRewritableMediaUrl(url: unknown): url is string {
  return (
    typeof url === "string" &&
    LOCAL_MEDIA_SCHEMES.some((scheme) => url.startsWith(scheme))
  );
}

/**
 * 从 `xdt-file://local/?path=<abs>` / `xdt-audio://…?path=<abs>` 提取绝对路径。
 * 非这两个 scheme / 无 path 参数 / 相对路径 → null。POSIX 与 Windows 盘符绝对
 * 路径都接受(device-link 被控端可能是 Windows;ssh 恒 POSIX,由调用方进一步约束)。
 */
export function extractMediaPathQuery(url: string): string | null {
  if (!SSH_PATH_SCHEMES.some((s) => url.startsWith(s))) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const p = parsed.searchParams.get("path");
  if (!p) return null;
  const isAbs = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
  return isAbs ? p : null;
}

/** POSIX 纯字符串包含判定:p 位于 dir 内(不含 dir 自身),拒绝 `..` 段。 */
function isPosixPathInside(dir: string, p: string): boolean {
  if (!dir.startsWith("/") || !p.startsWith("/")) return false;
  if (p.split("/").includes("..")) return false;
  const base = dir.replace(/\/+$/, "");
  return p.startsWith(`${base}/`) && p.length > base.length + 1;
}

/**
 * ssh 来源下该 URL 是否可改写:仅 `xdt-file://` / `xdt-audio://` 且 `?path=` 是
 * workdir 内的 POSIX 绝对路径。`xdt-image://` / `xdt-video://` 的 cache-id URL
 * 没有路径语义(字节在远端 daemon 数据目录、workdir 外),file-service 取不到,
 * 不改写 → 渲染层走「远端文件不可用」占位。
 */
export function isSshRewritableMediaUrl(
  url: unknown,
  workdir: string,
): url is string {
  if (typeof url !== "string" || !workdir) return false;
  const p = extractMediaPathQuery(url);
  return p !== null && isPosixPathInside(workdir, p);
}

/** 组装远程媒体 URL(origin 任意来源)。 */
export function buildRemoteMediaUrl(
  origin: RemoteMediaOrigin,
  origUrl: string,
): string {
  const token = encodeRemoteMediaOriginToken(origin);
  return `${REMOTE_MEDIA_SCHEME}://${REMOTE_MEDIA_HOST}/${toBase64Url(token)}/${toBase64Url(origUrl)}`;
}

/** 该 URL 是否已是远程媒体 URL(避免二次改写)。 */
export function isRemoteMediaUrl(url: unknown): url is string {
  return typeof url === "string" && url.startsWith(`${REMOTE_MEDIA_SCHEME}://`);
}

/**
 * 解析远程媒体 URL → { origin, origUrl }。非远程媒体 / 畸形 → null。
 * 控制端 main 的 `cindy-remote-media://` handler 用它把请求路由回正确来源 + 原始媒体引用。
 */
export function parseRemoteMediaUrl(
  url: string,
): { origin: RemoteMediaOrigin; origUrl: string } | null {
  if (!isRemoteMediaUrl(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host !== REMOTE_MEDIA_HOST) return null;
  // pathname 形如 /{b64url(originToken)}/{b64url(origUrl)}
  const segs = parsed.pathname.replace(/^\/+/, "").split("/");
  if (segs.length !== 2 || !segs[0] || !segs[1]) return null;
  try {
    const origin = decodeRemoteMediaOriginToken(fromBase64Url(segs[0]));
    const origUrl = fromBase64Url(segs[1]);
    if (!origin || !origUrl) return null;
    return { origin, origUrl };
  } catch {
    return null;
  }
}

/**
 * 远程会话媒体 URL 改写入口(按来源分流白名单):
 *  - origin 为空(本地会话)→ 原样返回,不改写。
 *  - 已是远程媒体 URL → 原样返回,避免二次包裹。
 *  - device 来源:LOCAL_MEDIA_SCHEMES 全量改写(media:fetch 都能取)。
 *  - ssh 来源:仅 workdir 内带路径的 xdt-file / xdt-audio(见 isSshRewritableMediaUrl)。
 *  - 其它(http(s)、data: 等)→ 原样返回。
 */
export function rewriteToRemoteMediaOrigin(
  url: string,
  origin: RemoteMediaOrigin | undefined,
): string {
  if (!origin) return url;
  if (isRemoteMediaUrl(url)) return url;
  if (origin.kind === "device") {
    if (!isRewritableMediaUrl(url)) return url;
    return buildRemoteMediaUrl(origin, url);
  }
  if (!isSshRewritableMediaUrl(url, origin.workdir)) return url;
  return buildRemoteMediaUrl(origin, url);
}

/**
 * device-link 兼容入口(既有调用面:renderer 改写点全部走它)。行为与 ssh 支持
 * 引入前逐字节一致;ssh 来源的改写走 rewriteToRemoteMediaOrigin(PR3 起 renderer
 * 切换)。
 */
export function rewriteToRemoteMedia(
  url: string,
  deviceId: string | undefined,
): string {
  return rewriteToRemoteMediaOrigin(
    url,
    deviceId ? { kind: "device", deviceId } : undefined,
  );
}
