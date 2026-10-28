/**
 * model3d.ts — 3D 模型文件识别的单一来源（Desktop / Mobile 共用，零运行时依赖）。
 * ---------------------------------------------------------------------------
 * 聊天里的 3D 模型有两条互不相同的存放通道，识别规则必须分开表达：
 *
 * 1. 媒体总仓 `cindy-media://blobs/<sha256>.<ext>`：Cindy 持有副本，入仓前必须按字节
 *    嗅探真实类型（见 `sniffMediaMime`）。总仓目前只收 GLB——它有可靠的文件头；
 *    OBJ / 二进制 STL 没有魔数，扩展名又不能单独作为可信依据。
 * 2. 用户磁盘上的原始文件：就地读取（`xdt-file`），不复制进总仓，按扩展名识别。
 *
 * 另外「能识别」不等于「应用内能预览」：预览能力随查看器升级而扩大，单独导出，
 * 避免识别范围一变就把没法渲染的格式路由进查看器。
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

/** 应用内查看器当前能渲染的格式（model-viewer 只认 glTF 系）。 */
export const IN_APP_PREVIEW_MODEL3D_FORMATS = ['glb', 'gltf'] as const;

/** 媒体总仓里的 3D 模型地址：整串精确匹配，目前仅 GLB。 */
export const MANAGED_MODEL3D_URL_RE = /^cindy-media:\/\/blobs\/[0-9a-f]{64}\.glb$/;

const FORMAT_SET: ReadonlySet<string> = new Set(MODEL3D_FORMATS);
const PREVIEW_SET: ReadonlySet<string> = new Set(IN_APP_PREVIEW_MODEL3D_FORMATS);

/** 取路径 / URL 的扩展名；忽略 `?query` 与 `#hash`，两种路径分隔符都认。 */
function extensionOf(pathOrUrl: string): string {
  const withoutSuffix = pathOrUrl.split(/[?#]/, 1)[0] ?? '';
  const base = withoutSuffix.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** `xdt-file://local/?path=<编码后的绝对路径>`：真实路径在 query 里，其余地址按原样取扩展名。 */
function resolveSubject(pathOrUrl: string): string {
  if (!pathOrUrl.startsWith('xdt-file://')) return pathOrUrl;
  const query = pathOrUrl.split('?', 2)[1];
  const encoded = query?.split('#', 1)[0]?.split('&').find((part) => part.startsWith('path='));
  if (!encoded) return '';
  try {
    return decodeURIComponent(encoded.slice('path='.length));
  } catch {
    return '';
  }
}

/** 按扩展名识别 3D 模型格式；不是 3D 模型返回 null。ZIP 不是模型。 */
export function getModel3DFormat(pathOrUrl: unknown): Model3DFormat | null {
  if (typeof pathOrUrl !== 'string' || !pathOrUrl) return null;
  const ext = extensionOf(resolveSubject(pathOrUrl));
  return FORMAT_SET.has(ext) ? (ext as Model3DFormat) : null;
}

export function isModel3DPath(pathOrUrl: unknown): boolean {
  return getModel3DFormat(pathOrUrl) !== null;
}

/** 该格式能否在应用内查看器里渲染。 */
export function canPreviewModel3DInApp(format: string): boolean {
  return PREVIEW_SET.has(format.trim().toLowerCase());
}

/** 是否为媒体总仓里的 3D 模型地址（整串精确匹配）。 */
export function isManagedModel3DUrl(url: unknown): url is string {
  return typeof url === 'string' && MANAGED_MODEL3D_URL_RE.test(url);
}
