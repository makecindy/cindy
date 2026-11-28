/**
 * 托管 Skill 在执行环境里的目录视图(控制端，只用于 Codex 的 exec-server 中继)。
 *
 * 任务在这台电脑、模型在另一台时，对方的 Codex 经执行环境在这台电脑上找项目 Skill：`<影子目录>/.agents/skills`
 * 先 `fs/getMetadata`，是目录才 `fs/canonicalize` 与 `fs/walk`，再按清单读各个 SKILL.md(Codex 0.167.2
 * ext/skills/src/host_roots.rs；仓库 Skill 只经执行环境读，不读对方自己的磁盘)。这台电脑带过去的托管 Skill
 * 只有逐个 Skill 目录的路径映射(`<影子目录>/.agents/skills/<名字>` → 这台的 Skill 目录)，上级目录映射到项目里的
 * `.agents/skills`：项目里没有这个目录时 Codex 判为不存在，有的话 walk 也只列出项目自己的 Skill，托管 Skill
 * 一个都看不到(#13718)。
 *
 * 这里只在托管 Skill 目录的直接上级(`<影子目录>/.agents/skills`)这一层补齐：项目里没有这个目录时按空目录
 * 回答，walk 的结果里加上本任务托管 Skill 的目录与文件(文件清单与带过去时同一套规则，见 managedSkillDigest；
 * 只列名字，内容照常经路径映射与权限上限读这台的文件)。项目共用 .claude/skills 时也沿用该虚拟根。
 */
import { listManagedSkillFiles } from '../managedSkillDigest';

export interface ManagedSkillOverlay {
  /** 托管 Skill 目录在对方电脑上的路径(影子目录下，对方的路径写法)。 */
  agentDir: string;
  /** 这台电脑上的 Skill 目录。 */
  localDir: string;
}

/** 要补齐结果的一条请求(按对方路径记，回包投影成对方路径后处理)。 */
export type ManagedSkillOverlayRequest =
  | { method: 'fs/getMetadata' | 'fs/canonicalize'; uri: string; path: string; linkTarget?: string }
  | { method: 'fs/walk'; uri: string; path: string; options: WalkOptions; overlays: ManagedSkillOverlay[] };

interface WalkOptions {
  maxDepth: number;
  maxEntries: number;
  pruneHiddenDirectories: boolean;
}

const NOT_FOUND = -32004;

/** 对方路径统一成 `/` 分隔、盘符前带 `/` 的写法(与 file URI 的 pathname 一致)，去掉结尾分隔符。 */
function toUriPath(agentPath: string): string {
  const slashed = agentPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(slashed) ? `/${slashed}` : slashed;
}

function uriPath(uri: string): string | null {
  if (!uri.startsWith('file://')) return null;
  try {
    const url = new URL(uri);
    if (url.host) return null;
    return decodeURIComponent(url.pathname).replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function toUri(pathname: string): string {
  const url = new URL('file:///');
  // pathname 的设置不转义 `%`：`50%41.md` 会被对方解成 `50A.md`。
  url.pathname = pathname.replace(/%/g, '%25');
  return url.href;
}

function isStrictlyInside(target: string, dir: string): boolean {
  return target.startsWith(`${dir}/`);
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

/**
 * 这条请求要不要补齐：路径正是某个托管 Skill 目录的直接上级(Skill 目录本身及其内部由路径映射读真实文件)。
 */
export function managedSkillOverlayRequest(
  method: unknown,
  params: unknown,
  overlays: readonly ManagedSkillOverlay[],
): ManagedSkillOverlayRequest | null {
  if (!overlays.length || (method !== 'fs/getMetadata' && method !== 'fs/canonicalize' && method !== 'fs/walk')) return null;
  const record = params && typeof params === 'object' ? params as Record<string, unknown> : {};
  const uri = record.path;
  if (typeof uri !== 'string') return null;
  const target = uriPath(uri);
  if (!target) return null;
  const below = overlays.filter((overlay) => {
    const dir = toUriPath(overlay.agentDir);
    return dir.slice(0, dir.lastIndexOf('/')) === target;
  });
  if (!below.length) return null;
  if (method !== 'fs/walk') {
    const suffix = '/.agents/skills';
    const linkTarget = method === 'fs/canonicalize' && record.sandbox == null && target.endsWith(suffix)
      ? target.slice(0, -suffix.length) + '/.claude/skills'
      : undefined;
    return { method, uri, path: target, linkTarget };
  }
  const options = record.options && typeof record.options === 'object' ? record.options as Record<string, unknown> : {};
  return {
    method,
    uri,
    path: target,
    overlays: below,
    options: {
      maxDepth: nonNegativeInteger(options.maxDepth, Number.MAX_SAFE_INTEGER),
      maxEntries: nonNegativeInteger(options.maxEntries, Number.MAX_SAFE_INTEGER),
      pruneHiddenDirectories: options.pruneHiddenDirectories === true,
    },
  };
}

/** walk 会不会列出这一项：所在层数不超过上限，且(要求时)不在隐藏目录里面。 */
function walkReaches(relative: string[], options: WalkOptions): boolean {
  if (relative.length - 1 > options.maxDepth) return false;
  return !options.pruneHiddenDirectories || relative.slice(0, -1).every((part) => !part.startsWith('.'));
}

async function overlayWalkEntries(request: Extract<ManagedSkillOverlayRequest, { method: 'fs/walk' }>): Promise<Array<{ path: string; kind: 'directory' | 'file' }>> {
  const entries: Array<{ path: string; kind: 'directory' | 'file' }> = [];
  const seen = new Set<string>();
  const add = (pathname: string, kind: 'directory' | 'file') => {
    if (seen.has(pathname)) return;
    const relative = pathname.slice(request.path.length + 1).split('/');
    if (!walkReaches(relative, request.options)) return;
    seen.add(pathname);
    entries.push({ path: pathname, kind });
  };
  for (const overlay of request.overlays) {
    const files = await listManagedSkillFiles(overlay.localDir);
    // 读不全的 Skill 不列(与带过去时一致：要么整个，要么没有)。
    if (!files?.some((file) => file.relative === 'SKILL.md')) continue;
    const dir = toUriPath(overlay.agentDir);
    add(dir, 'directory');
    for (const file of files) {
      const segments = file.relative.split('/');
      for (let index = 1; index < segments.length; index += 1) add(`${dir}/${segments.slice(0, index).join('/')}`, 'directory');
      add(`${dir}/${file.relative}`, 'file');
    }
  }
  return entries;
}

/**
 * 补齐一条回包(已投影成对方的路径)：上级目录在项目里不存在时按目录回答；walk 的结果里换上托管 Skill 的清单
 * (项目里碰巧有同名目录时以托管 Skill 为准，与路径映射一致)。其余错误原样返回。
 */
export async function applyManagedSkillOverlay(request: ManagedSkillOverlayRequest, reply: Record<string, unknown>): Promise<Record<string, unknown>> {
  const error = reply.error && typeof reply.error === 'object' ? reply.error as Record<string, unknown> : null;
  if (error && error.code !== NOT_FOUND) return reply;
  const rest = { ...reply };
  delete rest.error;
  if (request.method !== 'fs/walk') {
    if (!error) {
      // A hosted skill root is a virtual union. Keep its logical name when the
      // project shares the Claude directory so Codex scans the existing mount.
      // The scan still reaches the native exec-server through its usual gate.
      const result = reply.result as { path?: unknown } | undefined;
      return request.linkTarget && typeof result?.path === 'string' && uriPath(result.path) === request.linkTarget
        ? { ...reply, result: { ...result, path: request.uri } }
        : reply;
    }
    return {
      ...rest,
      result: request.method === 'fs/getMetadata'
        ? { isDirectory: true, isFile: false, isSymlink: false, size: 0, createdAtMs: 0, modifiedAtMs: 0 }
        : { path: request.uri },
    };
  }
  const result = !error && reply.result && typeof reply.result === 'object' ? reply.result as Record<string, unknown> : null;
  if (!error && !result) return reply;
  const entryPath = (entry: unknown): string | null => {
    const value = entry && typeof entry === 'object' ? (entry as { path?: unknown }).path : undefined;
    return typeof value === 'string' ? uriPath(value) : null;
  };
  const overlayDirs = request.overlays.map((overlay) => toUriPath(overlay.agentDir));
  const native = (Array.isArray(result?.entries) ? result.entries as unknown[] : []).filter((entry) => {
    const pathname = entryPath(entry);
    return !pathname || !overlayDirs.some((dir) => pathname === dir || isStrictlyInside(pathname, dir));
  });
  const nativePaths = new Set(native.map(entryPath));
  const added = (await overlayWalkEntries(request))
    .filter((entry) => !nativePaths.has(entry.path))
    .map((entry) => ({ path: toUri(entry.path), kind: entry.kind }));
  let entries = [...native, ...added];
  let truncated = result?.truncated === true;
  if (entries.length > request.options.maxEntries) {
    entries = entries.slice(0, request.options.maxEntries);
    truncated = true;
  }
  return { ...rest, result: { ...(result ?? {}), entries, errors: Array.isArray(result?.errors) ? result.errors : [], truncated } };
}
