/**
 * 远程 Agent 执行器的工作区(控制端)。
 *
 * Agent 跑在另一台电脑上，它对本机文件和命令的每个请求都在这里落地。路径一律按本机路径
 * 解析：相对路径以任务工作目录为基准。Agent 所在电脑上的影子目录(只放项目说明类小文件，
 * 让 Agent 照常加载项目说明与 Skill)在这里映射回本机真实目录，模型即使用了影子路径也落在
 * 本机项目里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSensitiveCredentialPath } from '@cindy/maker-core';
import { diffLines, diffWordsWithSpace } from 'diff';

export interface ExecutorPathAlias {
  /** Agent 所在电脑上的影子目录(绝对路径，按该电脑的路径写法)。 */
  from: string;
  /** 对应的本机真实目录。 */
  to: string;
}

export interface ExecutorWorkspaceRoots {
  /** 任务工作目录(本机绝对路径)。 */
  workingDir: string;
  /** 额外允许的目录(任务的附加目录)。 */
  extraDirs?: readonly string[];
  /** 影子目录映射。 */
  aliases?: readonly ExecutorPathAlias[];
}

/** 单条返回结果共用的路径视图；不用于文件访问授权。 */
export interface ExecutorAgentProjection {
  toAgentPath(input: string): string;
  mapTextForAgent(text: string, context?: PathTextContext): string;
  mapOutputForAgent(data: Buffer): Buffer;
}

export class ExecutorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorPathError';
  }
}

/** 按指定 realpath 实现取真实路径；不存在时按最近的已存在祖先解析，再拼回剩余部分。 */
function realPathOrAncestorWith(target: string, resolveRealpath: (path: string) => string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = resolveRealpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** 取一个路径的真实路径；不存在时按最近的已存在祖先解析，再拼回剩余部分。 */
export function realPathOrAncestor(target: string): string {
  return realPathOrAncestorWith(target, fs.realpathSync.native);
}

/** Windows 的 native realpath 可能返回长路径，而 Node 的普通实现保留短路径写法；两者都要覆盖。 */
function realPathOrAncestorPortable(target: string): string {
  return realPathOrAncestorWith(target, fs.realpathSync);
}

/** realpath 的磁盘访问交给 Node 文件系统线程池，不能在输出热路径阻塞 Electron。 */
async function realPathOrAncestorAsync(
  target: string, resolveRealpath: (target: string) => Promise<string> = fs.promises.realpath,
): Promise<string> {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await resolveRealpath(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function portableRealpathAsync(target: string): Promise<string> {
  return new Promise((resolve, reject) => fs.realpath(target, (error, real) => error ? reject(error) : resolve(real)));
}

function projectUtf8Output(data: Buffer, project: (text: string) => string): Buffer {
  const text = data.toString('utf8');
  if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) return data;
  const projected = project(text);
  return projected === text ? data : Buffer.from(projected, 'utf8');
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 影子目录前缀匹配：只认完整路径段(`/a/b` 不匹配 `/a/bc`)，不区分分隔符写法。 */
function stripAliasPrefix(input: string, from: string): string | null {
  const normalizedInput = input.replace(/\\/g, '/');
  const normalizedFrom = from.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedFrom) return null;
  const windows = /^[A-Za-z]:|^\/\//.test(normalizedFrom);
  const comparedInput = windows ? normalizedInput.toLowerCase() : normalizedInput;
  const comparedFrom = windows ? normalizedFrom.toLowerCase() : normalizedFrom;
  if (comparedInput === comparedFrom) return '';
  if (comparedInput.startsWith(`${comparedFrom}/`)) return normalizedInput.slice(normalizedFrom.length + 1);
  return null;
}

const WINDOWS_PATH = /^[A-Za-z]:|^[\\/]{2}/;

/** 正文与脚本里的路径边界（含通配符/变量后缀）；若磁盘上存在同名延续，仍由 continuesName 保留字面目录名。 */
const NAME_END = /[\s"'\x60<>()[\]{}|&;:,*?$%，。、；：！？（）【】《》「」『』“”‘’]/;

/**
 * 目录前缀后面那个字符是否让这一段结束。串尾和分隔符一定结束；空白、引号、括号和句末标点
 * (`路径。`、`path.`)只在正文里算结束，仍可能是同级目录名的一部分(`xxx copy`)，由调用方按
 * 磁盘核对。其余字符(`xxx.git`、`xxx-v1`)接着的是另一个名字：只按完整目录段匹配，与
 * mapAlias 的判断一致，否则文本和文件操作会把同一个路径换到两个地方。
 */
function segmentEnd(text: string, index: number): 'separator' | 'punctuation' | null {
  const char = text[index];
  if (char === undefined || char === '/' || char === '\\') return 'separator';
  if (NAME_END.test(char)) return 'punctuation';
  if (!/[.!?]/.test(char)) return null;
  let next = index;
  while (/[.!?]/.test(text[next] ?? '')) next += 1;
  return next >= text.length || NAME_END.test(text[next]) ? 'punctuation' : null;
}

interface AliasPrefixes<T extends ExecutorPathAlias> {
  finder: RegExp;
  prefixes: Array<{ alias: T; pattern: RegExp }>;
}

/**
 * 别名需已按 from 由长到短排好；Windows 路径不区分大小写，其余按原样比较。
 * 分隔符按路径写法认：Mac / Linux 路径只认 `/`(`C:\Users\x` 里的 `\Users` 不是 `/Users`)；Windows 路径认
 * `\` 与 `/`。escapedSeparators 时 Windows 路径还认转义成两个的 `\\`(Windows 上的 Agent 按 bash / 源码
 * 字符串的写法写 `"C:\\Users\\x"`，它表示的仍是同一个路径)。
 */
function aliasPrefixes<T extends ExecutorPathAlias>(
  aliases: readonly T[], { escapedSeparators = false }: { escapedSeparators?: boolean } = {},
): AliasPrefixes<T> {
  const prefixes = aliases.map((alias) => {
    const windows = WINDOWS_PATH.test(alias.from);
    const separator = !windows ? '/' : escapedSeparators ? String.raw`(?:\\\\|[/\\])` : String.raw`[/\\]`;
    return {
      alias,
      pattern: new RegExp(alias.from.replace(/[\\/]+$/, '').split(/[\\/]/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(separator), windows ? 'iy' : 'y'),
    };
  });
  return { finder: new RegExp(prefixes.map((item) => item.pattern.source).join('|'), 'gi'), prefixes };
}

/** Mac / Linux 路径前面紧挨着盘符(`C:/Users`)时，它是 Windows 路径的一部分。 */
function followsDriveLetter(text: string, index: number): boolean {
  return /(?:^|[^A-Za-z0-9_])[A-Za-z]:$/.test(text.slice(Math.max(0, index - 3), index));
}

/** 路径里第一个分隔符的写法：`\\`(转义)、`\` 或 `/`。 */
function separatorToken(value: string): string | undefined {
  return /\\\\|[\\/]/.exec(value)?.[0];
}

/** 从 start 起找下一个完整的目录前缀；同一位置先试最长的别名，不成立再试它的上级。 */
function nextAliasPrefix<T extends ExecutorPathAlias>(
  text: string, start: number, { finder, prefixes }: AliasPrefixes<T>,
  continuesName?: (alias: T, rest: string) => boolean,
  boundary: (text: string, index: number, start: number) => 'separator' | 'punctuation' | null = segmentEnd,
): { index: number; end: number; alias: T } | null {
  for (let from = start; from < text.length;) {
    finder.lastIndex = from;
    const found = finder.exec(text);
    if (!found) return null;
    const index = found.index;
    if (index === 0 || !/[A-Za-z0-9_]/.test(text[index - 1])) {
      for (const { alias, pattern } of prefixes) {
        if (!WINDOWS_PATH.test(alias.from) && followsDriveLetter(text, index)) continue;
        pattern.lastIndex = index;
        const hit = pattern.exec(text);
        if (!hit) continue;
        const end = index + hit[0].length;
        const kind = boundary(text, end, index);
        if (!kind || (kind === 'punctuation' && continuesName?.(alias, text.slice(end, end + 1024)))) continue;
        return { index, end, alias };
      }
    }
    from = index + 1;
  }
  return null;
}

/** 正文里的路径后缀；在变量和通配符前停下，父目录别名回退也能还原未改路径的原拼写。 */
const PATH_SUFFIX = /[/\\][^\s\x60'";:|&)<>}\]*?$%]*/y;

/**
 * target：分隔符按目标端统一(Agent 看到的路径、结构化路径字段)。
 * source：本机 Windows 路径沿用 Agent 原文的分隔符。写回文件和正文时用它：Agent 写的
 * `/` 换成 `\` 会让源码字符串里的 `\f`、`\b` 变成转义字符，Markdown 里的 `\.git` 也会被吃掉。
 */
export type SeparatorStyle = 'target' | 'source';

function joinMapped(to: string, matched: string, suffix: string, style: SeparatorStyle, escapedSeparators = false): string {
  const base = to.replace(/[\\/]+$/, '');
  // 只在认转义写法的方向(Agent 写回本机)：Agent 写的是转义的 `\\` 时，后缀里的 `\\` 是一个分隔符，
  // 目标端仍用反斜杠时保持转义写法。网络共享路径开头的 `\\server` 不是转义。
  const escaped = escapedSeparators && separatorToken(matched.replace(/^[\\/]{2}(?=[^\\/])/, '')) === '\\\\';
  const suffixSeparators = escaped ? /\\\\|[\\/]/g : /[\\/]/g;
  if (style === 'source' && WINDOWS_PATH.test(base)) {
    const separator = escaped ? '\\\\' : /[\\/]/.exec(matched)?.[0] ?? '\\';
    return base.replace(/[\\/]/g, separator) + suffix.replace(suffixSeparators, separator);
  }
  const separator = to.includes('\\') ? (escaped ? '\\\\' : '\\') : '/';
  return (escaped && separator === '\\\\' ? base.replace(/\\/g, separator) : base) + suffix.replace(suffixSeparators, separator);
}

/** 记录 / 还原路径的原写法：text 为正文 token，decoded 为 JSON 字符串里的值，json 为 JSON 字符串字面量。 */
export type SpellingLevel = 'text' | 'decoded' | 'json';

export interface PathSpellingHooks {
  record?(level: SpellingLevel, output: string, input: string): void;
  restore?(level: SpellingLevel, input: string): string | undefined;
}

export interface ProjectPathTextOptions {
  /** 正文 token 的分隔符写法，默认 target。 */
  separators?: SeparatorStyle;
  /** 整值路径(路径字段、已存在的完整路径)的分隔符写法，默认 target。 */
  wholeSeparators?: SeparatorStyle;
  /** false 时不按 JSON 解析，只逐行逐 token 投影(与 Read 工具带行号的输出一致)。 */
  json?: boolean;
  /** 目录名后接空白或标点时，核对它是否其实是同级目录名的一部分。 */
  continuesName?: (alias: ExecutorPathAlias, rest: string) => boolean;
  /** Agent 写回本机的方向：Windows 虚拟路径也认转义的 `\\` 分隔符(见 aliasPrefixes)。 */
  escapedSeparators?: boolean;
  spellings?: PathSpellingHooks;
  /** 原始正文中的位置，不包含 JSON 解码后的临时字符串。 */
  restoreOriginal?(offset: number, input: string): string | undefined;
  recordReplacement?(offset: number, input: string, output: string): void;
}

export function isPathTextField(key: string): boolean {
  return /^(?:cwd|workdir|working_?dir|script|files?|paths?|directories)$|(?:^|_)(?:paths?|files?|dirs?|directory|directories|root)$|(?:Paths?|Files?|Dirs?|Directory|Directories|Root)$/.test(key);
}

export type PathTextContext = 'text' | 'path' | 'ambiguous-path' | 'untyped';

/** The existing script fields contain both executable paths and source text. */
export function pathTextContext(key: string): PathTextContext {
  if (key === 'script') return 'ambiguous-path';
  return isPathTextField(key) ? 'path' : 'text';
}

export function mapJsonPathText(
  text: string, project: (value: string, context: PathTextContext) => string, rootContext: PathTextContext = 'untyped',
  literals?: { record?(output: string, input: string): void; restore?(input: string, offset: number): string | undefined; replaced?(offset: number, input: string, output: string): void },
): string {
  JSON.parse(text);
  // 顶层字符串/数组也能承载正文，容器本身不提供完整路径的证据。
  const frames: { type: 'object' | 'array'; context: PathTextContext; key?: string }[] = [];
  const valueContext = (): PathTextContext => {
    const frame = frames.at(-1);
    return frame?.type === 'object' ? pathTextContext(frame.key ?? '') : frame?.context ?? rootContext;
  };
  return text.replace(/"(?:\\[\s\S]|[^"\\])*"|[{}[\],:]/g, (token, offset: number) => {
    if (token === '{' || token === '[') {
      frames.push({ type: token === '{' ? 'object' : 'array', context: valueContext() });
      return token;
    }
    if (token === '}' || token === ']') {
      frames.pop();
      return token;
    }
    if (token === ',') {
      const frame = frames.at(-1);
      if (frame?.type === 'object') frame.key = undefined;
      return token;
    }
    if (token === ':') return token;
    const decoded = JSON.parse(token) as string;
    if (/^\s*:/.test(text.slice(offset + token.length))) {
      const frame = frames.at(-1);
      if (frame?.type === 'object') frame.key = decoded;
      return token;
    }
    const restored = literals?.restore?.(token, offset);
    if (restored !== undefined) {
      if (restored !== token) literals?.replaced?.(offset, token, restored);
      return restored;
    }
    const projected = project(decoded, valueContext());
    const output = projected === decoded ? token : JSON.stringify(projected);
    if (output !== token) literals?.record?.(output, token);
    if (output !== token) literals?.replaced?.(offset, token, output);
    return output;
  });
}

interface ProjectionPlan { size: number; entries: ExecutorPathAlias[]; prefixes?: AliasPrefixes<ExecutorPathAlias> }

/**
 * 别名排序和前缀正则只与别名数组有关，按数组引用缓存(#7710)：每段输出、每个流式 delta 都要投影，
 * 别名几百条时逐次重建会占满主线程。数组必须整体替换，不得原地修改；长度变了也视为失效。
 */
const projectionPlans = new WeakMap<readonly ExecutorPathAlias[], Map<boolean, ProjectionPlan>>();

function projectionPlan(aliases: readonly ExecutorPathAlias[], escapedSeparators: boolean): ProjectionPlan {
  let byEscape = projectionPlans.get(aliases);
  if (!byEscape) projectionPlans.set(aliases, byEscape = new Map());
  const cached = byEscape.get(escapedSeparators);
  if (cached?.size === aliases.length) return cached;
  const entries = aliases.filter((alias) => alias.from.replace(/[\\/]+$/, '').length > 2)
    .sort((a, b) => b.from.length - a.from.length);
  const plan: ProjectionPlan = { size: aliases.length, entries, prefixes: entries.length ? aliasPrefixes(entries, { escapedSeparators }) : undefined };
  byEscape.set(escapedSeparators, plan);
  return plan;
}

/** 对已知目录做单次双向投影，最长前缀先匹配，防止替换结果再次被短祖先别名改写。 */
export function projectPathText(
  text: string, aliases: readonly ExecutorPathAlias[], context: PathTextContext = 'text',
  isCompletePath?: (mapped: string) => boolean, options: ProjectPathTextOptions = {},
): string {
  const { entries, prefixes } = projectionPlan(aliases, options.escapedSeparators ?? false);
  if (!prefixes) return text;
  const { spellings } = options;
  // 同一个路径在 JSON 字符串里和正文里的转义不同，原写法按所处层级分别记录与还原。
  let depth = 0;
  const replace = (input: string, mapped: () => string, offset: number | null): string => {
    const level: SpellingLevel = depth ? 'decoded' : 'text';
    const restored = (offset === null ? undefined : options.restoreOriginal?.(offset, input)) ?? spellings?.restore?.(level, input);
    const output = restored ?? mapped();
    if (output !== input) {
      if (restored === undefined) spellings?.record?.(level, output, input);
      if (offset !== null) options.recordReplacement?.(offset, input, output);
    }
    return output;
  };
  const project = (value: string, valueContext: PathTextContext = 'text', offset: number | null = 0): string => {
    // MCP 的 text 常嵌一层 JSON；Skill/命令输出和文本文件也可能是 JSON。
    // 先解码字符串再投影，才能识别 Windows 转义路径；只改变化的字符串 token，保留格式与其它字节。
    if (options.json !== false && /^\s*[{["]/.test(value)) {
      depth += 1;
      try {
        return mapJsonPathText(value, (decoded, context) => project(decoded, context, null), valueContext === 'text' ? 'untyped' : valueContext, {
          record: (output, input) => spellings?.record?.('json', output, input),
          restore: (input, index) => (offset === null ? undefined : options.restoreOriginal?.(offset + index, input)) ?? spellings?.restore?.('json', input),
          replaced: (index, input, output) => { if (offset !== null) options.recordReplacement?.(offset + index, input, output); },
        });
      } catch { /* 普通文本继续按路径边界投影。 */ } finally {
        depth -= 1;
      }
    }
    // 脚本可能先打印日志再逐行输出 JSON；保留换行格式，逐行应用同一套转义处理。
    if (value.includes('\n')) {
      let lineStart = 0;
      return value.split('\n').map((line) => {
        const output = project(line, valueContext, offset === null ? null : offset + lineStart);
        lineStart += line.length + 1;
        return output;
      }).join('\n');
    }
    // 整个字符串就是路径时(含已解码的 JSON 字符串)，空格也属于路径，不能截断后续分隔符。
    const lineEnd = value.endsWith('\r') ? '\r' : '';
    const pathValue = lineEnd ? value.slice(0, -1) : value;
    if (valueContext !== 'text') {
      for (const alias of entries) {
        if (stripAliasPrefix(pathValue, alias.from) === null) continue;
        const suffix = pathValue.slice(alias.from.replace(/[\\/]+$/, '').length);
        const mapped = joinMapped(alias.to, pathValue, suffix, options.wholeSeparators ?? 'target', options.escapedSeparators);
        // 明确的路径字段可整体映射；歧义字段(如 script)只有现存完整路径才整体映射，
        // 否则按正文逐 token 投影，避免把脚本源码里的 /api/v1 等内容当成路径。
        if (valueContext === 'path' || isCompletePath?.(mapped)) return replace(pathValue, () => mapped, offset) + lineEnd;
        break;
      }
    }
    let result = '';
    let position = 0;
    for (let hit = nextAliasPrefix(value, 0, prefixes, options.continuesName); hit;
      hit = nextAliasPrefix(value, position, prefixes, options.continuesName)) {
      PATH_SUFFIX.lastIndex = hit.end;
      const suffix = PATH_SUFFIX.exec(value)?.[0] ?? '';
      const input = value.slice(hit.index, hit.end + suffix.length);
      const { to } = hit.alias;
      result += value.slice(position, hit.index) + replace(input, () => joinMapped(to, input, suffix, options.separators ?? 'target', options.escapedSeparators), offset === null ? null : offset + hit.index);
      position = hit.end + suffix.length;
    }
    return result + value.slice(position);
  };
  return project(text, context);
}

const escapeJson = (value: string): string => JSON.stringify(value).slice(1, -1);

interface UnchangedRange { before: number; after: number; length: number }
interface OriginalSpelling { input: string; output: string }
interface OriginalProjection { text: string; spellings: Map<number, OriginalSpelling> }

/** 按上下文对齐未改内容，不能按同一个虚拟路径在新文件里的出现序号认领原写法。 */
function unchangedRanges(before: string, after: string): UnchangedRange[] {
  const ranges: UnchangedRange[] = [];
  const deadline = Date.now() + 75;
  const changes = diffLines(before, after, { timeout: 50, maxEditLength: 4096 });
  let oldOffset = 0;
  let newOffset = 0;
  let removed = '';
  let added = '';
  const refine = () => {
    // 行内小修改也保留未改的完整路径；限制同步 diff 的工作量，整文件重写不占满 main。
    const remaining = deadline - Date.now();
    const parts = remaining > 0 && removed.length + added.length <= 64 * 1024
      ? diffWordsWithSpace(removed, added, { timeout: Math.min(25, remaining), maxEditLength: 4096 }) : undefined;
    let oldPart = oldOffset - removed.length;
    let newPart = newOffset - added.length;
    for (const part of parts ?? []) {
      if (!part.added && !part.removed) ranges.push({ before: oldPart, after: newPart, length: part.value.length });
      if (!part.added) oldPart += part.value.length;
      if (!part.removed) newPart += part.value.length;
    }
    removed = '';
    added = '';
  };
  for (const change of changes ?? []) {
    if (change.removed) { removed += change.value; oldOffset += change.value.length; }
    else if (change.added) { added += change.value; newOffset += change.value.length; }
    else {
      refine();
      ranges.push({ before: oldOffset, after: newOffset, length: change.value.length });
      oldOffset += change.value.length;
      newOffset += change.value.length;
    }
  }
  refine();
  // 完整且唯一的一行即便被移动，也仍能确定它对应哪段原文；同时作为 diff 超时的低成本回退。
  const uniqueLines = new Map<string, number | null>();
  let offset = 0;
  for (const line of before.split('\n')) {
    uniqueLines.set(line, uniqueLines.has(line) ? null : offset);
    offset += line.length + 1;
  }
  offset = 0;
  for (const line of after.split('\n')) {
    const old = uniqueLines.get(line);
    if (old !== undefined && old !== null && line) ranges.push({ before: old, after: offset, length: line.length });
    offset += line.length + 1;
  }
  return ranges;
}

function alignedSpellings(projection: OriginalProjection, ranges: readonly UnchangedRange[]): Map<number, OriginalSpelling> {
  const result = new Map<number, OriginalSpelling>();
  const entries = [...projection.spellings].sort((a, b) => a[0] - b[0]);
  for (const range of ranges) {
    let low = 0;
    let high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle][0] < range.before) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < entries.length && entries[index][0] < range.before + range.length; index += 1) {
      const [offset, spelling] = entries[index];
      if (offset + spelling.input.length <= range.before + range.length) {
        result.set(range.after + offset - range.before, spelling);
      }
    }
  }
  return result;
}

/**
 * 写回文件时沿用原文件里路径的写法。Agent 读到的是投影后的虚拟路径，而原文件里同一个目录
 * 可能写成 `E:/x`、`E:\x`、`/e/x`、`/tmp` 或不同大小写；按 Agent 看到的写法查回原写法，
 * 没改动的部分写回后逐字节不变。同一个虚拟写法对应多种原写法时按出现顺序对应。
 */
export class PathSpellings {
  readonly projectedTexts: string[] = [];
  private readonly spellings = new Map<string, string[]>();
  private readonly used = new Map<string, number>();
  private readonly ambiguous = new Map<string, string[]>();
  private forced = new Map<string, string>();

  /** raw：Agent 写的是文件原文(Write / Edit)；decoded：写的是 JSON 里解码后的内容(Notebook 单元格)。 */
  constructor(private readonly view: 'raw' | 'decoded' = 'raw') {}

  /** 正向投影原文件时记录。A 为不解析 JSON 的逐行投影(Read 工具所见)，B 为默认投影(fs.read 所见)。 */
  recorder(pass: 'A' | 'B'): PathSpellingHooks {
    return {
      record: (level, output, input) => {
        this.add(pass + ':' + level, output, input);
        // JSON 字符串里的值出现在 JSON 源码片段(如 Edit 的 old_string)里时带着转义。
        if (pass === 'B' && level === 'decoded') this.add('B:escaped', escapeJson(output), escapeJson(input));
      },
    };
  }

  restorer(pass?: 'A' | 'B' | 'unique'): PathSpellingHooks {
    return { restore: (level, input) => this.restore(level, input, pass) };
  }

  /** 查过的、原文件里有多种原写法的虚拟写法。 */
  alternatives(): Array<[string, string[]]> {
    return [...this.ambiguous];
  }

  /** 指定某些虚拟写法用哪种原写法(Edit 在原文件里定位 old_string 时用)，并从头计数。 */
  force(choices: ReadonlyMap<string, string>): void {
    this.forced = new Map(choices);
    this.used.clear();
  }

  private add(namespace: string, output: string, input: string): void {
    const key = namespace + '\0' + output;
    const list = this.spellings.get(key);
    if (list) list.push(input);
    else this.spellings.set(key, [input]);
  }

  private order(level: SpellingLevel, pass?: 'A' | 'B' | 'unique'): string[] {
    // 还原 Read 的逐行视图时，不能借用整体 JSON 视图的队列：其中有些转义路径在 Read 里没有投影。
    if (pass === 'A') return level === 'json' ? [] : ['A:text'];
    if (level === 'json') return ['B:json'];
    if (level === 'decoded' || this.view === 'decoded') return ['B:decoded', 'A:text', 'B:text'];
    return ['A:text', 'B:text', 'B:escaped', 'B:decoded'];
  }

  private restore(level: SpellingLevel, input: string, pass?: 'A' | 'B' | 'unique'): string | undefined {
    const key = level + '\0' + input;
    const forced = this.forced.get(key);
    if (forced !== undefined) return forced;
    let picked: string | undefined;
    const choices: string[] = [];
    for (const namespace of this.order(level, pass)) {
      const counter = namespace + '\0' + input;
      const list = this.spellings.get(counter);
      if (!list) continue;
      if (picked === undefined) {
        const count = this.used.get(counter) ?? 0;
        this.used.set(counter, count + 1);
        picked = list[Math.min(count, list.length - 1)];
      }
      for (const item of list) if (!choices.includes(item)) choices.push(item);
    }
    if (choices.length > 1) this.ambiguous.set(key, choices);
    if (pass === 'unique' && choices.length !== 1) return undefined;
    return picked;
  }
}

const NO_PREFIXES: readonly string[] = [];

export class ExecutorWorkspace {
  readonly workingDir: string;
  private roots: string[];
  private extraDirs: string[];
  private aliases: ExecutorPathAlias[];
  /** 由 this.aliases 派生的数组，按它的引用缓存；别名整体替换后自然失效(#7710)。 */
  private derived?: { aliases: ExecutorPathAlias[]; toLocal?: ExecutorPathAlias[]; prefixes?: readonly string[]; toAgent?: ExecutorPathAlias[] };
  private virtualRoot?: string;

  constructor(roots: ExecutorWorkspaceRoots) {
    if (!path.isAbsolute(roots.workingDir)) throw new ExecutorPathError('working directory must be absolute');
    this.workingDir = path.resolve(roots.workingDir);
    this.extraDirs = [];
    this.roots = [];
    this.aliases = [];
    this.setAliases(roots.aliases ?? []);
    this.setExtraDirs(roots.extraDirs ?? []);
  }

  /** Agent 启动后才知道它那边的影子目录，届时设置。 */
  setAliases(aliases: readonly ExecutorPathAlias[]): void {
    this.installAliases(this.expandAliases(aliases));
  }

  private expandAliases(
    aliases: readonly ExecutorPathAlias[],
    canonicalPathsByTarget = new Map<string, readonly string[]>(),
  ): ExecutorPathAlias[] {
    const expanded: ExecutorPathAlias[] = [];
    for (const alias of aliases) {
      if (!alias.from || !path.isAbsolute(alias.to)) continue;
      expanded.push(alias);
      let canonicalPaths = canonicalPathsByTarget.get(alias.to);
      if (!canonicalPaths) {
        canonicalPaths = [realPathOrAncestor(alias.to), realPathOrAncestorPortable(alias.to)];
        canonicalPathsByTarget.set(alias.to, canonicalPaths);
      }
      for (const canonical of canonicalPaths) {
        if (path.resolve(canonical) !== path.resolve(alias.to)) expanded.push({ from: alias.from, to: canonical });
      }
    }
    return expanded;
  }

  private installAliases(expanded: readonly ExecutorPathAlias[]): void {
    const seen = new Set<string>();
    this.aliases = expanded
      .filter((alias) => {
        const key = alias.from + '\\0' + path.resolve(alias.to);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.from.length - a.from.length);
  }

  /**
   * 连回同一个会话时补进对方新给的映射。已有的保持原来的目标、排在同长度的新映射前面：对话里出现过的
   * 虚拟路径(含运行中分配的 runtime-*)接回后仍指向同一个本机目录，不会被换成别的目录。
   */
  addAliases(aliases: readonly ExecutorPathAlias[]): void {
    this.setAliases([...this.aliases, ...aliases]);
  }

  /**
   * 命令沿用 Desktop 的完整环境(与本机 Agent 一致)，虚拟化只作用于 Agent 看到的路径文本。
   * 用户目录与临时目录已有别名；PATH 里其余目录在这里登记，env / which 之类的输出也只露虚拟路径。
   */
  setVirtualRoot(root?: string): void {
    this.virtualRoot = root;
    if (root) this.virtualizeDirs(this.unaliasedSearchDirs());
  }

  private unaliasedSearchDirs(): string[] {
    const dirs: string[] = [];
    for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!entry || !path.isAbsolute(entry) || this.toAgentPath(entry) !== entry) continue;
      try {
        if (fs.statSync(entry).isDirectory()) dirs.push(entry);
      } catch {
        // PATH 里不存在的目录不会出现在输出里，无需登记。
      }
    }
    return dirs;
  }

  /** 运行中新增的目录分配新的 opaque 别名，撤销授权不撤销路径身份。 */
  virtualizeDirs(dirs: readonly string[]): string[] {
    if (!this.virtualRoot) return [...dirs];
    const native = /^[A-Za-z]:|^\\\\/.test(this.virtualRoot) ? path.win32 : path.posix;
    // PATH 注册会逐个加入目录；同一批不应在每次加入时重开全部旧目录。
    // 快照仅属于这次展示映射，下一批重新解析，权限判断不使用它。
    const canonical = new Map<string, readonly string[]>();
    return dirs.map((dir) => {
      const real = this.resolve(dir);
      const exact = this.aliases.find((alias) => path.resolve(alias.to) === real);
      if (exact) return exact.from;
      const virtual = native.join(this.virtualRoot!, 'additional', 'runtime-' + this.aliases.length);
      this.installAliases(this.expandAliases([...this.aliases, { from: virtual, to: real }], canonical));
      return virtual;
    });
  }

  /** exec-server 初始化返回的目录也异步解析；等待期间新增的别名不能被旧快照覆盖。 */
  async virtualizeDirsAsync(dirs: readonly string[]): Promise<void> {
    if (!this.virtualRoot) return;
    const native = /^[A-Za-z]:|^\\\\/.test(this.virtualRoot) ? path.win32 : path.posix;
    for (const dir of dirs) {
      const real = this.resolve(dir);
      if (this.aliases.some((alias) => path.resolve(alias.to) === real)) continue;
      const canonical = await Promise.all([
        realPathOrAncestorAsync(real), realPathOrAncestorAsync(real, portableRealpathAsync),
      ]);
      if (this.aliases.some((alias) => path.resolve(alias.to) === real)) continue;
      const from = native.join(this.virtualRoot, 'additional', 'runtime-' + this.aliases.length);
      this.installAliases([...this.aliases, ...[real, ...canonical].map((to) => ({ from, to }))]);
    }
  }

  /** 任务运行中附加目录变化时更新。 */
  setExtraDirs(extraDirs: readonly string[]): void {
    this.extraDirs = extraDirs.filter((dir) => path.isAbsolute(dir)).map((dir) => path.resolve(dir));
    this.roots = [this.workingDir, ...this.extraDirs].map((dir) => realPathOrAncestor(dir));
  }

  /** 工作目录与附加目录(本机路径，未解析符号链接)。 */
  allRoots(): string[] {
    return [this.workingDir, ...this.extraDirs];
  }

  /** 影子路径映射回本机路径；不是影子路径时原样返回。 */
  mapAlias(input: string): string {
    return this.localPathFromAgent(input) ?? input;
  }

  /** 影子路径对应的本机路径；不是影子路径(Agent 主机自己的路径)时返回 null。 */
  localPathFromAgent(input: string, aliases: readonly ExecutorPathAlias[] = this.aliases): string | null {
    for (const alias of aliases) {
      const rest = stripAliasPrefix(input, alias.from);
      if (rest !== null) return rest ? path.join(alias.to, ...rest.split('/')) : alias.to;
    }
    return null;
  }

  /**
   * Agent 给的绝对 glob：影子前缀换成本机目录，目录名按字面匹配——通配字符写成字符类(`[` → `[[]`，
   * 两种路径约定都认)，POSIX 本机目录名里合法的反斜杠写成 `\\`(Codex 在 POSIX 约定下把它当转义符)；
   * 前缀后面的模式保持 Agent 的写法，POSIX 模式里的反斜杠转义不当成分隔符。
   */
  localGlobFromAgent(pattern: string): string | null {
    const windows = process.platform === 'win32';
    for (const alias of this.aliases) {
      if (stripAliasPrefix(pattern, alias.from) === null) continue;
      const from = alias.from.replace(/[\\/]+$/, '');
      const rest = pattern.slice(from.length).replace(/^[\\/]/, '');
      const local = alias.to.replace(windows ? /[\\/]+$/ : /\/+$/, '');
      const base = (windows ? local : local.replace(/\\/g, '\\\\')).replace(/[*?[\]{}]/g, (char) => `[${char}]`);
      if (!rest) return base;
      return `${base}/${WINDOWS_PATH.test(from) ? rest.replace(/\\/g, '/') : rest}`;
    }
    return null;
  }

  /** 本机真实路径投影到 Agent 主机上的路径；仅匹配完整路径段。 */
  toAgentPath(input: string): string {
    if (!this.virtualRoot) return input;
    return this.pathToAgent(input, this.aliases);
  }

  private pathToAgent(input: string, pathAliases: readonly ExecutorPathAlias[]): string {
    const aliases = [...pathAliases].sort((a, b) => b.to.length - a.to.length);
    for (const alias of aliases) {
      const rest = stripAliasPrefix(input, alias.to);
      if (rest === null) continue;
      const native = /^[A-Za-z]:|^\\\\/.test(alias.from) ? path.win32 : path.posix;
      return rest ? native.join(alias.from, ...rest.split('/')) : alias.from;
    }
    return input;
  }

  /** 工具输出、诊断和可逆的 UTF-8 文本内容使用虚拟路径；二进制字节保持原样。 */
  mapTextForAgent(text: string, context: PathTextContext = 'text'): string {
    return this.projectForAgent(text, context);
  }

  private projectForAgent(text: string, context: PathTextContext, options: ProjectPathTextOptions = {}): string {
    if (!this.virtualRoot) return text;
    return projectPathText(text, this.agentAliases(), context, (mapped) => fs.existsSync(this.mapAlias(mapped)),
      { ...options, continuesName: this.continuesName });
  }

  /** 每条结果刷新一次 canonical 目录；同一结果的所有字段复用，后续结果仍能看到 junction 的变化。 */
  async prepareAgentProjection(): Promise<ExecutorAgentProjection> {
    if (!this.virtualRoot) return { toAgentPath: (text) => text, mapTextForAgent: (text) => text, mapOutputForAgent: (data) => data };
    const aliases = this.aliases;
    const targets = [...new Set(aliases.map((alias) => alias.to))];
    const canonical = new Map(await Promise.all(targets.map(async (target) => {
      const paths = [realPathOrAncestorAsync(target)];
      // Windows native realpath expands 8.3 names, while process output can retain
      // them. Refresh both spellings when a junction changes its target.
      if (process.platform === 'win32') paths.push(realPathOrAncestorAsync(target, portableRealpathAsync));
      return [target, await Promise.all(paths)] as const;
    })));
    const projectedAliases = this.agentAliases(aliases, canonical);
    const pathAliases = aliases.flatMap((alias) => [alias, ...canonical.get(alias.to)!.map((to) => ({ from: alias.from, to }))]);
    const project = (text: string, context: PathTextContext = 'text') =>
      projectPathText(text, projectedAliases, context, (mapped) => fs.existsSync(this.localPathFromAgent(mapped, aliases) ?? mapped),
        { continuesName: this.continuesName });
    return {
      toAgentPath: (input) => this.pathToAgent(input, pathAliases),
      mapTextForAgent: project,
      mapOutputForAgent: (data) => projectUtf8Output(data, project),
    };
  }

  /** 本机真实路径(含 Git Bash 写法)→ Agent 看到的虚拟路径。 */
  private agentAliases(aliases: readonly ExecutorPathAlias[] = this.aliases, canonical?: ReadonlyMap<string, readonly string[]>): ExecutorPathAlias[] {
    if (canonical || aliases !== this.aliases) return this.buildAgentAliases(aliases, canonical);
    // 每次都同步 realpath 全部别名会随输出条数相乘；同一个事件循环批次内复用，下一批重新解析(junction 变化仍可见)。
    const derived = this.derivedAliases();
    if (!derived.toAgent) {
      derived.toAgent = this.buildAgentAliases(aliases, canonical);
      setImmediate(() => { derived.toAgent = undefined; });
    }
    return derived.toAgent;
  }

  private derivedAliases(): NonNullable<ExecutorWorkspace['derived']> {
    if (this.derived?.aliases !== this.aliases) this.derived = { aliases: this.aliases };
    return this.derived;
  }

  private buildAgentAliases(aliases: readonly ExecutorPathAlias[], canonical?: ReadonlyMap<string, readonly string[]>): ExecutorPathAlias[] {
    const seen = new Set<string>();
    return aliases.flatMap((alias) => {
      // A junction/symlink can be resolved differently by the Windows runner and by
      // the process that created the alias. Include the current canonical target at
      // projection time so both spellings still map to the same virtual directory.
      const targets = [alias.to, ...(canonical ? canonical.get(alias.to)! : [realPathOrAncestor(alias.to)])];
      return targets.flatMap((target) => {
        const real = target.replace(/\\/g, '/');
        const entries: ExecutorPathAlias[] = [{ from: real, to: alias.from }];
        // Git Bash / MSYS 的 pwd 和诊断使用 /c/...，而 Node 返回 C:\...。
        if (/^[A-Za-z]:\//.test(real)) entries.push({ from: '/' + real[0].toLowerCase() + real.slice(2), to: alias.from });
        if (process.platform === 'win32') {
          const temporary = os.tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
          const relative = stripAliasPrefix(real, temporary);
          if (relative !== null) entries.push({ from: '/tmp' + (relative ? '/' + relative : ''), to: alias.from });
        }
        return entries.filter((entry) => {
          const normalizedFrom = entry.from.replace(/\\/g, '/');
          const keyFrom = process.platform === 'win32' ? normalizedFrom.toLowerCase() : normalizedFrom;
          const key = keyFrom + '\\0' + entry.to;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
    });
  }

  /**
   * 正文里目录名后接空白或标点时，按磁盘核对后面是否其实是同级目录名(`xxx copy`、`xxx (1)`)：
   * 是就交给上级目录别名按完整目录段投影，Agent 用这个路径读写时才会落回同一个目录。
   */
  private readonly continuesName = (alias: ExecutorPathAlias, rest: string): boolean => {
    const real = alias.from.replace(/\\/g, '/').replace(/\/+$/, '');
    const cut = real.lastIndexOf('/');
    if (cut <= 0) return false;
    const name = real.slice(cut + 1);
    let parent = real.slice(0, cut);
    if (/^[A-Za-z]:$/.test(parent)) parent += '/';
    // Git Bash 写法 /c/x 对应 C:/x。
    else if (process.platform === 'win32' && /^\/[A-Za-z](?:\/|$)/.test(parent)) parent = parent[1] + ':/' + parent.slice(3);
    // 命令刚建的目录也要认得，不缓存目录列表；只核对到下一个分隔符为止的几处可能的名字结尾。
    let checked = 0;
    for (let length = 1; length <= Math.min(rest.length, 255) && checked < 8; length += 1) {
      if (/[\\/\r\n]/.test(rest[length - 1])) break;
      if (!segmentEnd(rest, length)) continue;
      checked += 1;
      if (fs.existsSync(parent.replace(/\/+$/, '') + '/' + name + rest.slice(0, length))) return true;
    }
    return false;
  };

  private agentPathsToLocal(): ExecutorPathAlias[] {
    const derived = this.derivedAliases();
    return derived.toLocal ??= this.aliases.map((alias) => ({ from: alias.from.replace(/\\/g, '/'), to: alias.to }));
  }

  /**
   * 把 Agent 虚拟路径还原成本机路径，用于展示的正文、工具参数等。正文 token 沿用 Agent 的分隔符，
   * 结构化路径字段与已存在的完整路径用本机写法。
   */
  private readonly localContinuesName = (alias: ExecutorPathAlias, rest: string): boolean => {
    const virtual = alias.from.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    const cut = virtual.lastIndexOf('/');
    if (cut <= 0) return false;
    // basename 属于虚拟目录名，父目录则在本机侧检查，确保与 mapAlias 落在同一处。
    return this.continuesName({ ...alias, from: path.join(this.mapAlias(virtual.slice(0, cut)), virtual.slice(cut + 1)) }, rest);
  };

  mapTextFromAgent(text: string, context: PathTextContext = 'text'): string {
    if (!this.virtualRoot) return text;
    return projectPathText(text, this.agentPathsToLocal(), context, (mapped) => fs.existsSync(mapped), {
      separators: 'source', continuesName: this.localContinuesName, escapedSeparators: true,
    });
  }

  /** 正文里的单个完整路径(代码段、尖括号链接)：还原成本机路径，分隔符沿用 Agent 的写法。 */
  mapAliasInText(input: string): string {
    const local = this.mapAlias(input);
    if (local === input || !WINDOWS_PATH.test(local)) return local;
    const separator = /[\\/]/.exec(input)?.[0] ?? '\\';
    return local.replace(/[\\/]/g, separator);
  }

  /**
   * Agent 写回的文件内容。original 为写入前的文件内容：Agent 读到的是投影后的路径，按它还原原文件里
   * 的写法，没改动的部分逐字节不变；新出现的路径沿用 Agent 的分隔符。
   */
  mapContentFromAgent(text: string, original?: string | null, view: 'raw' | 'decoded' = 'raw'): string {
    if (!this.virtualRoot) return text;
    if (!original || view === 'decoded') return this.contentFromAgent(text, original ? this.contentSpellings(original, view) : undefined);
    const projections = this.originalProjections(original);
    if (projections.some((projection) => projection.text === text)) return original;
    if (projections.every((projection) => projection.text === original)) return this.contentFromAgent(text);
    let matched = new Map<number, OriginalSpelling>();
    let bestLength = -1;
    for (const projection of projections) {
      const candidate = alignedSpellings(projection, unchangedRanges(projection.text, text));
      const length = [...candidate.values()].reduce((sum, item) => sum + item.input.length, 0);
      if (length > bestLength) { matched = candidate; bestLength = length; }
    }
    // 字符串内的正文改变而路径不变时，只有一种原写法的路径仍可直接还原；有歧义的只按上下文恢复。
    return this.contentFromAgent(text, this.contentSpellings(original, view), { restoreOriginal: (offset, input) => {
      const spelling = matched.get(offset);
      return spelling?.input === input ? spelling.output : undefined;
    } }, 'unique');
  }

  /**
   * Edit 在 Agent 读到的投影视图里匹配，保证同一虚拟路径的多种原写法都参与唯一性和批量替换检查。
   * 写回时恢复未改内容；没有投影视图能匹配的旧请求继续按本机原文匹配。
   */
  mapEditFromAgent(oldString: string, newString: string, original: string | null): {
    oldString: string; newString: string; text?: string; restore?: (updated: string) => string;
  } {
    if (!this.virtualRoot) return { oldString, newString };
    if (!original) return { oldString: this.contentFromAgent(oldString), newString: this.contentFromAgent(newString) };
    const normalizedOld = oldString.replace(/\r\n/g, '\n');
    let selected: OriginalProjection | undefined;
    let mostMatches = 0;
    for (const projection of this.originalProjections(original.replace(/\r\n/g, '\n'))) {
      if (!normalizedOld) break;
      let count = 0;
      for (let offset = projection.text.indexOf(normalizedOld); offset >= 0; offset = projection.text.indexOf(normalizedOld, offset + normalizedOld.length)) count++;
      if (count > mostMatches) { selected = projection; mostMatches = count; }
    }
    // Read 的逐行文本与 Bash/fs.read 的 JSON 视图可能不同；来源未知时保守保留更多匹配，要求补充上下文。
    if (selected) return { oldString, newString, text: selected.text, restore: (updated) => this.mapContentFromAgent(updated, original) };
    const spellings = this.contentSpellings(original, 'raw');
    const haystack = original.replace(/\r\n/g, '\n');
    const found = (value: string) => haystack.includes(value.replace(/\r\n/g, '\n'));
    let mappedOld = this.contentFromAgent(oldString, spellings);
    let chosen = new Map<string, string>();
    if (!found(mappedOld)) {
      const alternatives = spellings.alternatives().slice(0, 4);
      let combinations: Array<Map<string, string>> = [new Map()];
      for (const [key, values] of alternatives) {
        combinations = combinations.flatMap((choice) => values.map((value) => new Map(choice).set(key, value))).slice(0, 64);
      }
      for (const choice of combinations) {
        spellings.force(choice);
        const candidate = this.contentFromAgent(oldString, spellings);
        if (found(candidate)) {
          mappedOld = candidate;
          chosen = choice;
          break;
        }
      }
    }
    spellings.force(chosen);
    return { oldString: mappedOld, newString: this.contentFromAgent(newString, spellings) };
  }

  private contentFromAgent(text: string, spellings?: PathSpellings, options: ProjectPathTextOptions = {}, pass?: 'A' | 'B' | 'unique'): string {
    return projectPathText(text, this.agentPathsToLocal(), 'text', (mapped) => fs.existsSync(mapped), {
      ...options, separators: 'source', wholeSeparators: 'source', spellings: spellings?.restorer(pass), continuesName: this.localContinuesName,
      escapedSeparators: true,
    });
  }

  /** 按 Agent 读这个文件时看到的两种投影(Read 工具逐行、fs.read 整体)记下路径的原写法。 */
  private contentSpellings(original: string, view: 'raw' | 'decoded'): PathSpellings {
    const spellings = new PathSpellings(view);
    spellings.projectedTexts.push(this.projectForAgent(original, 'text', { json: false, spellings: spellings.recorder('A') }));
    const json = this.projectForAgent(original, 'text', { spellings: spellings.recorder('B') });
    if (!spellings.projectedTexts.includes(json)) spellings.projectedTexts.push(json);
    return spellings;
  }

  /** 在完整旧投影上恢复一次，记录每个路径/JSON字面量的精确位置与原写法。 */
  private originalProjections(original: string): OriginalProjection[] {
    const spellings = this.contentSpellings(original, 'raw');
    return spellings.projectedTexts.map((text, index) => {
      spellings.force(new Map());
      const entries = new Map<number, OriginalSpelling>();
      const restored = this.contentFromAgent(text, spellings, { recordReplacement: (offset, input, output) => { entries.set(offset, { input, output }); } }, index === 0 ? 'A' : 'B');
      // 逆投影必须确实得到整份原文，才能把其中的位置信息用于局部恢复。
      if (restored !== original) entries.clear();
      return { text, spellings: entries };
    });
  }

  /** 展示层延迟尚未传完整的虚拟路径；别名仍由当前执行器维护。 */
  agentPathPrefixes(): readonly string[] {
    if (!this.virtualRoot) return NO_PREFIXES;
    const derived = this.derivedAliases();
    return derived.prefixes ??= this.aliases.map((alias) => alias.from);
  }

  mapOutputForAgent(data: Buffer): Buffer {
    // 二进制 stdout 不做 UTF-8 往返，避免 exec.run / process/output 改变原始字节。
    return projectUtf8Output(data, (text) => this.mapTextForAgent(text));
  }

  /** Agent 写入的文件字节；original 为写入前的文本内容(见 mapContentFromAgent)。 */
  mapInputFromAgent(data: Buffer, original?: string | null): Buffer {
    const text = data.toString('utf8');
    if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) return data;
    const projected = this.mapContentFromAgent(text, original);
    return projected === text ? data : Buffer.from(projected, 'utf8');
  }

  /** 命令文本里出现的影子目录前缀替换成本机目录(按 shell 语法安全引用)。 */
  mapCommand(command: string, dialect: 'bash' | 'cmd' = 'bash'): string {
    const aliases = this.aliases.map((alias) => ({
      from: alias.from,
      to: process.platform === 'win32' ? alias.to.replace(/\\/g, '/') : alias.to,
    })).filter((alias) => alias.from.replace(/[\\/]+$/, '').length > 2)
      .sort((a, b) => b.from.length - a.from.length);
    if (!aliases.length) return command;
    // 路径尾部遇到引号即止：闭合引号属于外层 shell 语法，吞进路径会被按引号上下文转义
    // ('…mjs' → '…mjs'\'')，留下未闭合的引号。
    const prefixes = aliasPrefixes(aliases, { escapedSeparators: true });
    const commandContext = (input: string, end: number): { quote: 'none' | 'single' | 'double'; wordStart: number } => {
      let quote: 'none' | 'single' | 'double' = 'none';
      let wordStart = 0;
      let escaped = false;
      for (let i = 0; i < end; i += 1) {
        const char = input[i];
        if (escaped) { escaped = false; continue; }
        if (dialect === 'bash' && char === '\\' && (quote === 'none'
          || (quote === 'double' && /[$\x60"\\\n]/.test(input[i + 1] ?? '')))) { escaped = true; continue; }
        if (dialect === 'cmd' && char === '^' && quote === 'none') { escaped = true; continue; }
        if (quote === 'none' && /[\s;|&()<>]/.test(char)) wordStart = i + 1;
        if (dialect === 'bash' && quote === 'none' && char === "'") quote = 'single';
        else if (quote === 'none' && char === '"') quote = 'double';
        else if (quote === 'single' && char === "'") quote = 'none';
        else if (quote === 'double' && char === '"') quote = 'none';
      }
      return { quote, wordStart };
    };
    const quote = (value: string, context: 'none' | 'single' | 'double'): string => {
      if (dialect === 'cmd') {
        const safe = value.replace(/%/g, '%%');
        return context === 'double' ? safe : /[\s"&|<>^]/.test(safe) ? '"' + safe.replace(/"/g, '\\"') + '"' : safe;
      }
      if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
      if (context === 'single') return value.replace(/'/g, "'\\''");
      if (context === 'double') return value.replace(/[\\$\x60"]/g, '\\$&');
      return /[\s'"\x60$;&|<>(){}!*?[\]\\]/.test(value)
        ? "'" + value.replace(/'/g, "'\\''") + "'"
        : value;
    };
    const inPathList = (input: string, index: number): boolean => {
      const { wordStart } = commandContext(input, index);
      const word = input.slice(wordStart, index);
      const assignment = (dialect === 'cmd' ? /^"?([A-Za-z_][A-Za-z0-9_]*)=/ : /^([A-Za-z_][A-Za-z0-9_]*)\+?=/).exec(word);
      if (!assignment) return false;
      const name = dialect === 'cmd' ? assignment[1].toUpperCase() : assignment[1];
      // 常见环境路径列表也包括 NODE_PATH、CLASSPATH、XDG_DATA_DIRS 等。
      // 文件名变量（如 FILE）里的冒号/分号仍按字面路径处理。
      return /(?:PATH|_DIRS)$/.test(name) || ['PERL5LIB', 'PERLLIB', 'RUBYLIB', 'TEXINPUTS', 'INCLUDE', 'LIB'].includes(name);
    };
    const listSeparator = dialect === 'cmd' ? ';' : ':';
    // Shell 里的边界由引号与展开语法决定。引号内的空格/标点属于目录名；动态后缀保留给 shell。
    const commandBoundary = (text: string, index: number, start: number): 'separator' | 'punctuation' | null => {
      const char = text[index];
      if (char === undefined || char === '/' || char === '\\') return 'separator';
      const { quote: context } = commandContext(text, index);
      if ((context === 'single' && char === "'") || (context === 'double' && char === '"')) return 'separator';
      if (dialect === 'cmd' && /[%!^]/.test(char)) return 'separator';
      if (dialect === 'bash' && context !== 'single' && /[$\x60]/.test(char)) return 'separator';
      // PATH 列表在引号内仍分隔目录；普通文件名里的冒号/分号保持字面语义。
      if (char === listSeparator && inPathList(text, start)) return 'separator';
      if (context !== 'none') return null;
      return /[\s'"*?\[{};|&()<>]/.test(char) ? 'separator' : null;
    };
    let result = '';
    let end = 0;
    for (let hit = nextAliasPrefix(command, 0, prefixes, undefined, commandBoundary); hit; hit = nextAliasPrefix(command, end, prefixes, undefined, commandBoundary)) {
      const { alias, index: start } = hit;
      const separator = alias.to.includes('\\') ? '\\' : '/';
      const { quote: context } = commandContext(command, start);
      const pathList = inPathList(command, start);
      const windowsPath = WINDOWS_PATH.test(command.slice(start, hit.end));
      let suffixEnd = hit.end;
      const suffixStart = suffixEnd;
      if ((windowsPath || dialect === 'cmd') && /[/\\]/.test(command[suffixEnd] ?? '')) {
        // 只转换静态路径段。转义、变量与命令替换从原文原样保留，尤其不能把转义
        // 引号前的反斜杠当成路径分隔符，否则参数中的数据会变成新的 shell 命令。
        for (; suffixEnd < command.length; suffixEnd += 1) {
          const char = command[suffixEnd];
          if (char === '\r' || char === '\n') break;
          // bash 里 `\\` 表示一个反斜杠：Windows 路径中后面紧跟目录名时，它就是一个分隔符。
          // 后面是引号、变量、换行等时仍按转义处理，交给下面的判断原样保留。
          const named = command[suffixEnd + 2];
          if (dialect === 'bash' && windowsPath && char === '\\' && command[suffixEnd + 1] === '\\'
            && named !== undefined && !/[\\/"'$\x60\r\n]/.test(named)
            && (context !== 'none' || !/[\s;|&()<>]/.test(named))) {
            suffixEnd += 1;
            continue;
          }
          if (context === 'single' && char === "'") break;
          if (context === 'double' && char === '"') break;
          if (pathList && char === listSeparator) break;
          if (context === 'none' && /[\s'"\x60;:|&()<>}\]]/.test(char)) break;
          if (dialect === 'bash' && context !== 'single'
            && (/[$\x60]/.test(char) || (char === '\\'
              && (context === 'double' ? /[$\x60"\\\n]/ : /[\s'"$\x60\\;|&()<>]/).test(command[suffixEnd + 1] ?? '')))) break;
          if (dialect === 'cmd' && /[%^!]/.test(char)) break;
        }
      }
      // 上面只把后接目录名的 `\\` 收进后缀，所以后缀里的 `\\` 都是一个分隔符。
      const suffixSeparators = windowsPath && dialect === 'bash' ? /\\\\|[\\/]/g : /[\\/]/g;
      result += command.slice(end, start) + quote(alias.to.replace(/[\\/]+$/, ''), context)
        + command.slice(suffixStart, suffixEnd).replace(suffixSeparators, separator);
      end = suffixEnd;
    }
    return result + command.slice(end);
  }

  /** 把 Agent 给的路径解析成本机绝对路径(相对路径以 baseDir / 工作目录为基准)。 */
  resolve(input: string, baseDir = this.workingDir): string {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
      throw new ExecutorPathError('path is empty or invalid');
    }
    const trimmed = input.startsWith('@') ? input.slice(1) : input;
    const expanded = trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(os.homedir(), trimmed.slice(1))
      : trimmed;
    return path.resolve(this.mapAlias(baseDir), this.mapAlias(expanded));
  }

  /** 真实路径是否落在工作目录或附加目录内(防符号链接与 `..` 借道)。 */
  contains(absolutePath: string): boolean {
    const real = realPathOrAncestor(absolutePath);
    return this.roots.some((root) => isInside(real, root));
  }

  /**
   * 凭证类路径(与本机 harness 权限适配器同一份规则)。本机任务对这类路径是「每次都问」，
   * 执行器同样要求本机确认过才放行。
   */
  isSensitive(absolutePath: string): boolean {
    return isSensitiveCredentialPath(absolutePath) || isSensitiveCredentialPath(realPathOrAncestor(absolutePath));
  }
}
