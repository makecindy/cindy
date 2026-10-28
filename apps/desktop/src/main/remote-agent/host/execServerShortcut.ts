/**
 * 运行 Agent 的电脑上，替任务所在电脑回答「那边注定不存在」的执行环境查询(只用于虚拟工作区)。
 *
 * Codex 建线程时沿工作目录逐级向上找 `.git`、Skill 目录与插件清单(`.codex-plugin/plugin.json` 等)，
 * 每一次都经设备互联往返一次，且上一条回来才发下一条。虚拟工作区固定垫了 MAX_ANCESTOR_LEVELS 层
 * (`workspace/p/…`)，再往上是这台电脑自己的目录。工作区及其真实上级、home、tmp 与 additional
 * 有显式映射(见 controller/startRemote 的 shadowAliases)，镜像根内的其余层级在任务电脑没有对应目录。
 * 镜像外的绝对路径则会原样转发，不能仅凭以点开头就判不存在。2026-10-22 现场：每次跨机 0.5–3 秒，启动
 * 拖到几分钟、甚至撞上 5 分钟上限。
 *
 * 工作区的真实上级目录在任务所在电脑上是存在的，Codex 在每一级查 `.git` 与三种插件清单(实测每级 6 次)。
 * 任务所在电脑打开任务时报来各级有没有这几个名字(wire 的 ancestorMarkers)，报了「没有」的也在本机直接回答；
 * 报了「有」或没报的照常转发。名单以打开时为准，任务连回时重新报一次。
 *
 * 只回答只读查询，回包与 exec-server 原生的「不存在」相同(JSON-RPC -32004，Codex 按 NotFound 处理；
 * 固定 Codex 0.159.2 实测与源码 exec-server/src/remote_file_system.rs 一致)。其余一律照常转给任务所在电脑。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** exec-server 原生的「路径不存在」错误码。 */
export const EXEC_SERVER_NOT_FOUND_CODE = -32004;

/** 只读、只看单个路径的查询：本机能确定答案是「不存在」。 */
const LOOKUP_METHODS = new Set(['fs/getMetadata', 'fs/canonicalize', 'fs/readFile', 'fs/readDirectory']);
/** 查询消息都很短；长消息(写文件等)不解析。 */
const MAX_LOOKUP_MESSAGE_CHARS = 16 * 1024;
/** 镜像根下照常转发的目录：任务所在电脑把它们映射到自己的 home、临时目录与附加目录。 */
const MAPPED_TOP_LEVEL = new Set(['home', 'tmp', 'additional']);

export interface ExecServerShortcutLayout {
  /** 虚拟工作区的镜像根(`<任务目录>/fs`)，本机路径。 */
  mirrorRoot: string;
  /** 任务所在电脑有对应目录的最上一级：工作区向上逐级对应到它的真实根目录或最多 MAX_ANCESTOR_LEVELS 级。 */
  mappedRoot: string;
  /** 工作区各级真实上级目录(影子里的位置)里，任务所在电脑报了「没有」的名字。 */
  ancestorAbsence?: ReadonlyArray<{ dir: string; absent: ReadonlySet<string> }>;
  /** 任务电脑确认不存在的原始绝对路径；仅两端路径格式相同时提供，供镜像外查询核对。 */
  taskAncestorAbsence?: ReadonlyArray<{ dir: string; absent: ReadonlySet<string> }>;
}

function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function reportedAbsent(target: string, ancestors: ExecServerShortcutLayout['ancestorAbsence']): boolean {
  return (ancestors ?? []).some(({ dir, absent }) => (
    target !== dir && isWithin(target, dir) && absent.has(path.relative(dir, target).split(path.sep)[0])
  ));
}

/**
 * 这个本机路径在任务所在电脑上是否注定不存在：
 * - 镜像根内：不在已映射的工作区(及其真实上级)、home、tmp、additional 之下的，都是虚拟工作区垫出来的层级；
 *   在真实上级目录里、任务所在电脑报了「没有」的名字之下的，同样不存在；
 * - 镜像根外：只按任务电脑确认不存在的原始绝对路径回答；其余路径照常转发，包括隐藏文件与未知的标记。
 */
function unreachableOnTaskComputer(target: string, layout: ExecServerShortcutLayout): boolean {
  if (!path.isAbsolute(target)) return false;
  const resolved = path.resolve(target);
  const mirrorRoot = path.resolve(layout.mirrorRoot);
  if (isWithin(resolved, mirrorRoot)) {
    if (resolved === mirrorRoot) return true;
    const first = path.relative(mirrorRoot, resolved).split(path.sep)[0];
    if (MAPPED_TOP_LEVEL.has(process.platform === 'win32' ? first.toLowerCase() : first)) return false;
    if (!isWithin(resolved, path.resolve(layout.mappedRoot))) return true;
    return reportedAbsent(resolved, layout.ancestorAbsence);
  }
  return reportedAbsent(resolved, layout.taskAncestorAbsence);
}

/**
 * 一条 Agent 发给执行环境的消息：能在本机确定答案时返回回包，否则返回 null(照常转发)。
 */
export function createExecServerShortcut(layout: ExecServerShortcutLayout): (data: string) => string | null {
  return (data) => {
    if (data.length > MAX_LOOKUP_MESSAGE_CHARS || !data.includes('"fs/')) return null;
    let message: { id?: unknown; method?: unknown; params?: { path?: unknown } };
    try {
      message = JSON.parse(data) as typeof message;
    } catch {
      return null;
    }
    if (!message || typeof message !== 'object' || typeof message.method !== 'string' || !LOOKUP_METHODS.has(message.method)) return null;
    if (typeof message.id !== 'number' && typeof message.id !== 'string') return null;
    const uri = message.params?.path;
    if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
    let target: string;
    try {
      target = fileURLToPath(uri);
    } catch {
      return null;
    }
    if (!unreachableOnTaskComputer(target, layout)) return null;
    return JSON.stringify({ id: message.id, error: { code: EXEC_SERVER_NOT_FOUND_CODE, message: 'No such file or directory (os error 2)' } });
  };
}
