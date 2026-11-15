/**
 * useWorkspaceMediaPath —— 回复里嵌入的本地图片 / 视频 / 音频，相对路径按「任务目录 + 路径」
 * 找不到时，换成任务目录里唯一匹配的真实文件。
 *
 * 背景:
 *   Agent 常先进入任务目录下的子文件夹工作，交付时写相对子文件夹的路径（如
 *   `renders/out/clip.mp4`，文件实际在 `<任务目录>/film/renders/out/clip.mp4`）。正文里的
 *   路径 chip 早已用 fs:resolve-path（直接拼接 → 任务目录内按后缀搜索，唯一命中才采用）兜住
 *   这种写法；嵌入媒体此前只做直接拼接，于是同一条回复里路径能点、播放器却是坏的。
 *
 * 行为:
 *   - 复用路径 chip 的同一套解析与缓存。直接拼接能找到、没有命中或命中多个时都保持原路径
 *     （原行为），只有唯一命中且位置与直接拼接不同才替换成绝对路径。
 *   - 解析完成前不交出地址（pending）：先拿拼接地址加载会让播放器进入失败态，解析结果晚到
 *     时界面已经显示过「不可用」。缓存命中时同步给出结论，没有等待。
 *   - 含 `%` 的路径不搜索：主进程查找前会先做 URL 解码，任务目录同时有 `a%20b.jpg` 与
 *     `a b.jpg` 时会换成另一个文件，违背「直接拼接能找到时保持原地址」。
 *   - 结论在组件里另存一份：共享缓存有容量上限，被其他引用挤掉后不能退回坏地址。
 *   - 没有命中 / 命中多个不是最终结论：回复可能先引用产物、文件后写出。新挂载、流式结束、
 *     窗口重新聚焦时重查一次（与图片加载失败的自然重试时机一致），重查期间照常显示拼接
 *     地址；唯一命中不重查。流式结束 / 聚焦时若有更早发出的查找还在进行，它回来仍未命中
 *     就再补查一次。流式结束常伴随重挂载（流式分块换成完整 Markdown），「这个路径在流式中
 *     出现过」记在模块级集合里，由之后第一个以非流式运行的实例当作流式结束处理。
 *   - 从未命中变成找到时给出新的 revision，调用方据此重建媒体元素：文件可能恰好写在直接
 *     拼接的位置，地址不变，播放器停在失败态不会自己重试。
 *
 * 范围:
 *   只用于本机会话。远程会话的路径解析不在远端搜索（见 MarkdownRenderer 的
 *   useResolvedMarkdownTarget），调用方传 enabled=false 时原样返回。
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';

import {
  peekResolveLocalPathSmart,
  resolveLocalPath,
  resolveLocalPathSmartCached,
  revalidateNegativeLocalPathSmart,
  type SmartResolveResult,
} from '@/lib/localPathResolver';

const WIN_ABS_RE = /^[A-Za-z]:[\\/]/;
const URL_SCHEME_RE = /^[a-zA-Z][\w+.-]*:/;

/** 相对任务目录书写的本地路径：既不是 URL / 受管媒体地址，也不是绝对路径。 */
function isRelativeLocalPath(src: string): boolean {
  // 盘符路径要先判：`C:/x.png` 在形状上也匹配 URL scheme。
  if (WIN_ABS_RE.test(src)) return false;
  if (URL_SCHEME_RE.test(src)) return false;
  return !src.startsWith('/') && !src.startsWith('\\');
}

/**
 * 查找用的规范写法：去掉 `.` 段与多余分隔符，按 `..` 回退。主进程按「/<路径>」后缀匹配，
 * `./renders/out/clip.mp4` 原样传下去永远匹配不上。会越出任务目录的路径返回 null（不搜索）。
 * 只用于查找；没有命中时仍按原始写法加载。
 */
function lookupPath(src: string): string | null {
  const segments: string[] = [];
  for (const segment of src.split(/[\\/]+/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

function isSamePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/') === b.replace(/\\/g, '/');
}

/** 在流式输出中出现过、还没被当作「流式结束」处理的路径（`workingDir::href`）。 */
const streamingMediaKeys = new Set<string>();

type Shown = 'pending' | 'missing' | 'found';

/** Test-only: forget which paths were seen while streaming. */
export function _clearStreamingMediaKeys(): void {
  streamingMediaKeys.clear();
}

export interface WorkspaceMediaPath {
  /** 用于加载的路径；pending 时为 undefined。 */
  src: string | undefined;
  /** 相对路径还在任务目录里解析，调用方此时不应加载媒体。 */
  pending: boolean;
  /** 从未命中变成找到时递增；调用方以它为 key 重建媒体元素，清掉旧地址留下的失败态。 */
  revision: number;
}

export function useWorkspaceMediaPath(
  src: string | undefined,
  workingDir: string,
  enabled: boolean,
  streaming = false,
): WorkspaceMediaPath {
  const href =
    enabled && src && workingDir && isRelativeLocalPath(src) && !src.includes('%') ? lookupPath(src) : null;
  const key = href ? `${workingDir}::${href}` : null;
  const [settled, setSettled] = useState<{ key: string; result: SmartResolveResult } | null>(null);
  // 重查时机：窗口重新聚焦、所在消息流式结束(挂载本身由下面的 effect 覆盖)。记下发生的
  // 时刻：那之前已发出、还没回来的查找可能已经错过新写出的文件，回来仍未命中时要再查一次。
  const [boundary, setBoundary] = useState<{ at: number } | null>(null);
  const handledBoundary = useRef<{ at: number } | null>(null);
  useEffect(() => {
    if (!href) return;
    const onFocus = () => setBoundary({ at: Date.now() });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [href]);
  useEffect(() => {
    if (!key) return;
    if (streaming) streamingMediaKeys.add(key);
    else if (streamingMediaKeys.delete(key)) setBoundary({ at: Date.now() });
  }, [key, streaming]);

  // 组件自己记下的结论（共享缓存可能已把它挤掉），给下面的 effect 判断是否已唯一命中。
  const settledRef = useRef(settled);
  useEffect(() => {
    settledRef.current = settled;
  }, [settled]);

  useEffect(() => {
    if (!href || !key) return;
    let cancelled = false;
    const apply = (result: SmartResolveResult) => {
      if (cancelled) return;
      setSettled((current) =>
        current?.key === key && current.result === result ? current : { key, result },
      );
    };
    // 只有这次运行由新的时机触发时才按时机重查；挂载 / 路径变化走普通重查。
    const boundaryAt =
      boundary && boundary !== handledBoundary.current ? boundary.at : undefined;
    handledBoundary.current = boundary;
    const cached = peekResolveLocalPathSmart(href, workingDir);
    if (cached) {
      apply(cached);
      void revalidateNegativeLocalPathSmart(href, workingDir, boundaryAt)?.then(apply);
    } else {
      // 唯一命中不重查：共享缓存挤掉了它，组件自己记着的结论仍然有效。
      const own = settledRef.current;
      if (own?.key === key && own.result.status === 'unique') return;
      const recheck =
        boundaryAt === undefined ? null : revalidateNegativeLocalPathSmart(href, workingDir, boundaryAt);
      void (recheck ?? resolveLocalPathSmartCached(href, workingDir)).then(apply);
    }
    return () => {
      cancelled = true;
    };
  }, [href, key, workingDir, boundary]);

  const result = href
    ? (peekResolveLocalPathSmart(href, workingDir) ??
      (settled?.key === key ? settled.result : undefined))
    : undefined;
  const shown: Shown = !result
    ? 'pending'
    : result.status === 'unique' && result.kind !== 'directory'
      ? 'found'
      : 'missing';
  // 渲染期间按上一次展示的结论推进 revision（React 推荐的「随 props 调整 state」写法）。
  const [display, setDisplay] = useState<{ key: string | null; shown: Shown; revision: number }>({
    key,
    shown,
    revision: 0,
  });
  if (display.key !== key || display.shown !== shown) {
    const recovered = display.key === key && display.shown === 'missing' && shown === 'found';
    setDisplay({ key, shown, revision: display.revision + (recovered ? 1 : 0) });
  }
  const revision = display.revision;

  if (!href) return { src, pending: false, revision };
  if (!result) return { src: undefined, pending: true, revision };
  if (result.status !== 'unique' || result.kind === 'directory') return { src, pending: false, revision };
  // 直接拼接本来就能找到、且原写法就是规范写法时保持原写法，避免播放器因地址写法不同而重新加载；
  // 原写法不规范（如 POSIX 任务目录里的反斜杠）时拼不出能用的地址，换成找到的绝对路径。
  return {
    src: src === href && isSamePath(result.absPath, resolveLocalPath(href, workingDir)) ? src : result.absPath,
    pending: false,
    revision,
  };
}

/**
 * render-prop 形态，供 react-markdown 的 `img` 组件映射等不能直接调用 hook 的位置使用。
 * 解析中不渲染媒体，结论出来后再交给 children。
 */
export function WorkspaceMediaSrc({
  src,
  workingDir,
  enabled,
  streaming,
  children,
}: {
  src: string | undefined;
  workingDir: string;
  enabled: boolean;
  /** 所在消息仍在流式输出；结束时重查没有命中的路径。 */
  streaming?: boolean;
  children: (src: string | undefined) => ReactNode;
}) {
  const resolved = useWorkspaceMediaPath(src, workingDir, enabled, streaming);
  return resolved.pending ? null : <Fragment key={resolved.revision}>{children(resolved.src)}</Fragment>;
}
