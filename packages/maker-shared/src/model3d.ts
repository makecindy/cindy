/**
 * model3d.ts — 3D 模型文件识别的单一来源（Desktop / Mobile 共用，零运行时依赖）。
 * ---------------------------------------------------------------------------
 * 聊天里的 3D 模型有两条互不相同的存放通道，识别规则必须分开表达：
 *
 * 1. 媒体总仓 `cindy-media://blobs/<sha256>.<ext>`：Cindy 持有副本，入仓前必须按字节
 *    嗅探真实类型（见 `sniffMediaMime`）。总仓目前只收 GLB——它有可靠的文件头；
 *    OBJ / 二进制 STL 没有魔数，扩展名又不能单独作为可信依据。
 * 2. 用户磁盘上的原始文件：就地读取（`xdt-file`），不复制进总仓，按扩展名识别。
 */

/** 能被识别为 3D 模型文件的格式（扩展名，小写、无点）。 */
export const MODEL3D_FORMATS = [
  'glb',
  'gltf',
  'obj',
  'fbx',
  'stl',
  'ply',
  'dae',
  '3mf',
  '3ds',
] as const;

export type Model3DFormat = (typeof MODEL3D_FORMATS)[number];

/** 媒体总仓里的 3D 模型地址：整串精确匹配，目前仅 GLB。 */
export const MANAGED_MODEL3D_URL_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.glb$/;

const FORMAT_SET: ReadonlySet<string> = new Set(MODEL3D_FORMATS);

/**
 * 取扩展名，两种路径分隔符都认。`stripUrlSuffix` 为 true 时先去掉 `?query` 与 `#hash`——
 * 只有 URL 才有这两段；磁盘路径里的 `?` / `#` 是文件名的字面字符（`/work/project#1/a.glb`）。
 */
function extensionOf(pathOrUrl: string, stripUrlSuffix: boolean): string {
  const withoutSuffix = stripUrlSuffix ? (pathOrUrl.split(/[?#]/, 1)[0] ?? '') : pathOrUrl;
  const base = withoutSuffix.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** `scheme://…`：带协议头的才是 URL；`C:\\x`、`/x`、`./x` 都是磁盘路径。 */
const URL_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * `xdt-file://local/?path=<编码后的绝对路径>`：真实路径在 query 里，解码后就是磁盘路径，
 * 其中的 `#` / `?` 是字面字符；其余 URL 按原样取（扩展名前去掉 query / hash），磁盘路径原样取。
 */
function resolveSubject(pathOrUrl: string): { subject: string; isUrl: boolean } {
  if (!pathOrUrl.startsWith('xdt-file://')) {
    return { subject: pathOrUrl, isUrl: URL_SCHEME_RE.test(pathOrUrl) };
  }
  const query = pathOrUrl.split('?', 2)[1];
  const encoded = query?.split('#', 1)[0]?.split('&').find((part) => part.startsWith('path='));
  if (!encoded) return { subject: '', isUrl: false };
  try {
    return { subject: decodeURIComponent(encoded.slice('path='.length)), isUrl: false };
  } catch {
    return { subject: '', isUrl: false };
  }
}

/** 按扩展名识别 3D 模型格式；不是 3D 模型返回 null。ZIP 不是模型。 */
export function getModel3DFormat(pathOrUrl: unknown): Model3DFormat | null {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl) return null;
  const { subject, isUrl } = resolveSubject(pathOrUrl);
  const ext = extensionOf(subject, isUrl);
  return FORMAT_SET.has(ext) ? (ext as Model3DFormat) : null;
}

export function isModel3DPath(pathOrUrl: unknown): boolean {
  return getModel3DFormat(pathOrUrl) !== null;
}

/** 是否为媒体总仓里的 3D 模型地址（整串精确匹配）。 */
export function isManagedModel3DUrl(url: unknown): url is string {
  return typeof url === 'string' && MANAGED_MODEL3D_URL_RE.test(url);
}
