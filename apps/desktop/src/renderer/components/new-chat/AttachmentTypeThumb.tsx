/**
 * AttachmentTypeThumb — 输入框附件卡左侧的 40×40 缩略区。
 *
 * 「文件需要根据文件类型有图片或者预览」(2026-07-27):
 *   1. 先要系统缩略图(main 的 file:thumbnail → macOS QuickLook / Windows Shell)。
 *      它给的是**文件真实内容**:PDF 首页、docx/pptx 版面、Markdown / 代码的排版
 *      预览、图片视频的画面 —— 一个入口覆盖所有格式,且比在 renderer 里塞 pdfjs
 *      更快更轻(实测 PDF 48ms / Markdown 165ms)。
 *   2. 拿不到时(remote 会话的远端路径、系统不认的冷门扩展名、超时)回落到自绘的
 *      文件图标:纸张 + 折角 + 类型色角标,矢量绘制,40px / 80px 都锐利,双模式跟
 *      着 token 走。
 *
 * 图片附件本身在 ChatInput 里直接走 56×56 缩略图,不会走到这里 —— 只有缓存写
 * 失败、既无 url 也无 base64 的图片才会落到这个组件。
 */

import { useEffect, useRef, useState } from 'react';

import type { AttachedFile, FileCategory } from '@/lib/fileTypes';
import { createLogger } from '@/lib/logger';

const log = createLogger('AttachmentTypeThumb');

/** 缩略区边长(CSS px)。按 2x 要图,retina 下不糊。 */
const THUMB_PX = 40;

interface Thumb {
  url: string;
  /**
   * 系统给的是「类型图标」而不是文件内容缩略图(dmg / zip / 冷门扩展名走这条)。
   * 图标型位图四周是透明的,展示规则跟内容图完全不同,见渲染处。
   */
  isIcon: boolean;
}

/**
 * 已取回的缩略图(key = 路径),只用来消掉重挂载时的闪烁 —— 托盘会随会话切换 /
 * HMR / 草稿恢复反复重挂载,没有它每次都要空一帧再补图。
 *
 * 它**不是**事实源:每次挂载仍会向 main 复核一次(stale-while-revalidate),因为
 * 这里按路径存,而同一路径的文件可能被覆盖(main 侧按 mtime+size 判失效)。
 * 长会话里拖入的文件数没有上限,所以这里也必须有上限,不能无限长。
 */
const THUMB_CACHE_LIMIT = 64;
const thumbCache = new Map<string, Thumb>();

/**
 * 焦点复核的**单例**广播:托盘里的附件数量没有上限,每张卡各挂一个 focus 监听、
 * 各自发一次 IPC 的话,一次切窗口就能打出成百上千次 realpath/stat。这里收敛成
 * 一个监听器 + 节流窗口,订阅者共享同一次广播。
 *
 * 真正昂贵的原生缩略图那一层另有防线(main 的 4 名额闸门 + mtime/size 缓存),
 * 这里挡住的是「切一次窗口就全量重问」的放大效应。
 */
const REVALIDATE_MIN_INTERVAL_MS = 30_000;
const revalidateSubscribers = new Set<() => void>();
let lastRevalidateAt = 0;
let trailingTimer: ReturnType<typeof setTimeout> | null = null;
let focusListenerBound = false;

/** 一批唤醒多少张卡,以及批与批之间的间隔。 */
const REVALIDATE_BATCH_SIZE = 6;
const REVALIDATE_BATCH_GAP_MS = 120;

/**
 * 分批广播:节流只压住了**频率**,压不住**扇出** —— 托盘附件数没有上限,一次性
 * 唤醒全部订阅者仍会瞬间打出 N 次 IPC(每次都要 realpath + stat)。按 6 张一批、
 * 隔 120ms 铺开,峰值压到个位数,总时长对用户无感(60 个附件也就 1.2s 内铺完)。
 */
function broadcastRevalidate(): void {
  lastRevalidateAt = Date.now();
  const queue = [...revalidateSubscribers];
  const pump = () => {
    const batch = queue.splice(0, REVALIDATE_BATCH_SIZE);
    for (const notify of batch) {
      // 期间可能有卡片卸载:退订过的就别叫了。
      if (revalidateSubscribers.has(notify)) notify();
    }
    if (queue.length > 0) setTimeout(pump, REVALIDATE_BATCH_GAP_MS);
  };
  pump();
}

/**
 * 节流是 leading + **trailing**:光掐掉窗口内的事件会把最新一次改动整个吞掉
 * (改一次 → 切回来 → 再改 → 30s 内切回来,第二次改动就看不见了,而发送用的是
 * 当前内容)。窗口内的多次 focus 合并成一次尾部补播,既不丢最新状态也不放大 IPC。
 */
function requestRevalidate(): void {
  const elapsed = Date.now() - lastRevalidateAt;
  if (elapsed >= REVALIDATE_MIN_INTERVAL_MS) {
    if (trailingTimer) {
      clearTimeout(trailingTimer);
      trailingTimer = null;
    }
    broadcastRevalidate();
    return;
  }
  if (trailingTimer) return; // 已经排好补播,后续 focus 合并进去
  trailingTimer = setTimeout(() => {
    trailingTimer = null;
    broadcastRevalidate();
  }, REVALIDATE_MIN_INTERVAL_MS - elapsed);
}

function ensureFocusListener(): void {
  if (focusListenerBound || typeof window === 'undefined') return;
  focusListenerBound = true;
  window.addEventListener('focus', requestRevalidate);
}

function rememberThumb(key: string, value: Thumb): void {
  if (thumbCache.size >= THUMB_CACHE_LIMIT && !thumbCache.has(key)) {
    const oldest = thumbCache.keys().next();
    if (!oldest.done) thumbCache.delete(oldest.value);
  }
  thumbCache.delete(key);
  thumbCache.set(key, value);
}

/**
 * 判断系统返回的是类型图标还是内容缩略图:图标画在透明画布中央,四边都是空的;
 * PDF 首页 / 视频首帧这类内容图则铺满画布。采样四边中点与四角,全透明即图标。
 * 读不到像素(解码失败等)时按内容图处理 —— 多一圈边框远好过给内容图裁错。
 */
async function looksLikeIconBitmap(dataUrl: string): Promise<boolean> {
  try {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return false;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, w, h);
    const alphaAt = (x: number, y: number) => data[(y * w + x) * 4 + 3];
    const midX = w >> 1;
    const midY = h >> 1;
    const samples: [number, number][] = [
      [0, midY], [w - 1, midY], [midX, 0], [midX, h - 1],
      [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    ];
    return samples.every(([x, y]) => alphaAt(x, y) < 8);
  } catch {
    return false;
  }
}

// ── 自绘文件图标 ──────────────────────────────────────────────────────────
//
// 类型色是内容语义色(和「这份文件是什么」绑定),不随主题翻转,属于
// docs/design-rules/DESIGN.md §10 的 theme-invariant 例外;纸张本体仍走语义
// token,所以 Light / Dark 下纸面与卡片的关系保持一致。

type IconKind = 'pdf' | 'doc' | 'sheet' | 'slide' | 'code' | 'text' | 'image' | 'plain';

/**
 * 角标色:走 themes/colors.ts 注册的 file-badge-* token(§10 theme-invariant
 * 例外族),不在组件里写死 hex —— 否则自定义主题改不动它。取值都按白字 ≥4.5:1
 * 选过,前景恒用 --file-badge-fg。
 */
const KIND_ACCENT: Record<IconKind, string | null> = {
  pdf: 'var(--file-badge-pdf)',
  doc: 'var(--file-badge-doc)',
  sheet: 'var(--file-badge-sheet)',
  slide: 'var(--file-badge-slide)',
  code: 'var(--file-badge-code)',
  text: null,
  image: null,
  plain: null,
};

/** 角标里的短标签(≤4 字符);没有角标色的类型不画角标。 */
const KIND_LABEL: Record<IconKind, string | null> = {
  pdf: 'PDF',
  doc: 'DOC',
  sheet: 'XLS',
  slide: 'PPT',
  code: '<>',
  text: null,
  image: null,
  plain: null,
};

const SHEET_EXTS = new Set(['.xls', '.xlsx', '.csv', '.tsv', '.numbers']);
const SLIDE_EXTS = new Set(['.ppt', '.pptx', '.key']);
const DOC_EXTS = new Set(['.doc', '.docx', '.rtf', '.odt', '.pages']);
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rb', '.php', '.swift', '.kt',
  '.sh', '.bash', '.zsh', '.sql', '.json', '.yaml', '.yml', '.toml', '.xml',
  '.css', '.scss', '.html', '.vue', '.svelte', '.lua',
]);

/** 按扩展名 + category 定图标类型;拿不准回落中性纸张。 */
export function pickIconKind(ext: string, category: FileCategory): IconKind {
  const e = ext.toLowerCase();
  if (e === '.pdf' || category === 'pdf') return 'pdf';
  if (SHEET_EXTS.has(e)) return 'sheet';
  if (SLIDE_EXTS.has(e)) return 'slide';
  if (DOC_EXTS.has(e)) return 'doc';
  if (CODE_EXTS.has(e)) return 'code';
  if (category === 'image') return 'image';
  if (category === 'text') return 'text';
  return 'plain';
}

/**
 * 自绘文件图标:一张带折角的纸,右下角压一枚类型色角标。
 * 纸面 / 描边走 token,只有角标带类型色。
 */
function FileGlyph({ kind }: { kind: IconKind }) {
  const accent = KIND_ACCENT[kind];
  const label = KIND_LABEL[kind];
  // viewBox 32 渲染成 32px(1:1),角标文字 10 个单位即屏幕 10px —— DESIGN.md §3
  // 的下限(Micro Label 10–13px)。此前 26px 渲染 + 7.5 单位只有约 6px,越界了。
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden focusable="false">
      {/* 纸张本体 + 折角 */}
      <path
        d="M6.5 2.5h11.2L25.5 10.3V27a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 27V4a1.5 1.5 0 0 1 1.5-1.5Z"
        fill="var(--surface-elevated)"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M17.5 2.6V9a1.5 1.5 0 0 0 1.5 1.5h6.2"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      {/* 正文示意线:没有角标的中性类型靠它表达「这是文档」 */}
      <path
        d="M9 14h13M9 17.5h13M9 21h7.5"
        stroke="var(--text-placeholder)"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity={accent ? 0.35 : 0.9}
      />
      {/* 类型角标:容纳 10px 标签,所以铺到底边整条 */}
      {accent && label ? (
        <>
          <rect x="3" y="18.5" width="26" height="13.5" rx="3" fill={accent} />
          {/* 字重 500 封顶:DESIGN.md §3「Weight restraint — 只有 400 与 500,No bold」。 */}
          <text
            x="16"
            y="28.6"
            textAnchor="middle"
            fontSize="10"
            fontWeight="500"
            letterSpacing="0.3"
            fill="var(--file-badge-fg)"
          >
            {label}
          </text>
        </>
      ) : null}
    </svg>
  );
}

// ── 组件 ─────────────────────────────────────────────────────────────────

export function AttachmentTypeThumb({
  file,
  onByteSize,
}: {
  file: AttachedFile;
  /**
   * 复核缩略图时顺带带回的**当前**字节数。`file.size` 是拖入那一刻的快照,文件在
   * 托盘期间被改写后就会跟真正发出去的内容对不上,卡片的「类型 · 大小」用这个刷新。
   */
  onByteSize?: (bytes: number) => void;
}) {
  const filePath = file.path && !file.path.startsWith('clipboard://') ? file.path : null;
  const [thumb, setThumb] = useState<Thumb | null>(() =>
    filePath ? (thumbCache.get(filePath) ?? null) : null,
  );
  // 走 ref:回调换引用不该触发重新取图(effect 只认 filePath / revalidateTick)。
  const onByteSizeRef = useRef(onByteSize);
  onByteSizeRef.current = onByteSize;

  // 附件挂在托盘上的这段时间里,用户完全可能切出去把文件改了再切回来发送 —— 只在
  // 挂载时复核一次的话,预览和大小描述的还是旧内容。窗口重新获得焦点就是这个场景
  // 的自然触发点(切到编辑器改完再切回来),比轮询或 fs.watch 都便宜。监听与节流
  // 都在模块级单例里,见 ensureFocusListener。
  const [revalidateTick, setRevalidateTick] = useState(0);
  useEffect(() => {
    if (!filePath) return;
    ensureFocusListener();
    const notify = () => setRevalidateTick((n) => n + 1);
    revalidateSubscribers.add(notify);
    return () => {
      revalidateSubscribers.delete(notify);
    };
  }, [filePath]);

  useEffect(() => {
    if (!filePath) {
      setThumb(null);
      return;
    }
    // 先用缓存顶上(可能是旧内容),再无条件向 main 复核一次:main 按 mtime+size
    // 判失效,文件被覆盖时会给回新图;之前出不了图的文件后来变得可读也能补上。
    const cached = thumbCache.get(filePath) ?? null;
    setThumb(cached);
    let cancelled = false;
    void (async () => {
      try {
        const result = await window.electronAPI.getFileThumbnail({
          path: filePath,
          size: THUMB_PX * 2,
          // 首次挂载走缓存(消闪烁);焦点复核是"用户可能刚改过这个文件"的信号,
          // 跳过正缓存重新生成,否则粗时间戳文件系统上的同尺寸改写要等 TTL 才自愈。
          revalidate: revalidateTick > 0,
        });
        if (cancelled) return;
        if (result) onByteSizeRef.current?.(result.byteSize);
        if (!result?.dataUrl) {
          // 现在拿不到图:清掉可能过期的缓存,回落自绘图标。
          thumbCache.delete(filePath);
          setThumb(null);
          return;
        }
        const next: Thumb = {
          url: result.dataUrl,
          isIcon: await looksLikeIconBitmap(result.dataUrl),
        };
        rememberThumb(filePath, next);
        if (!cancelled) setThumb(next);
      } catch (err) {
        // 取不到缩略图是常态(冷门格式 / 文件已被移走),回落图标即可,不打扰用户。
        log.debug('file thumbnail unavailable', { error: String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filePath, revalidateTick]);

  if (thumb) {
    // 图标型(dmg / zip 这类系统只给类型图标的):按原样居中显示,不裁切也不描边
    // —— 图标四周本来就是透明的,套一圈边框等于在图标外面画个空方框。
    // 内容型(PDF 首页、视频首帧这类铺满画面的):裁切填满,并给一圈 Board,
    // 否则白纸压在同样浅的底上会糊成一片(Dark 下同样区分纸白与卡片)。
    return (
      <img
        src={thumb.url}
        alt=""
        aria-hidden
        className="rounded-lg"
        style={{
          width: '100%',
          height: '100%',
          // 写成内联而不是 Tailwind 类:这几个值要跟 isIcon 一起切,内联最直白。
          objectFit: thumb.isIcon ? 'contain' : 'cover',
          objectPosition: 'top center',
          // 用 1px Board 描边而不是 inset 阴影:DESIGN.md §6 只允许 token 化的浮层
          // 阴影,in-page 元素一律靠边框区分。outline + 负 offset 画在元素内沿,
          // 不占布局也不撑大缩略区。
          outline: thumb.isIcon ? undefined : '1px solid var(--border-default)',
          outlineOffset: thumb.isIcon ? undefined : '-1px',
        }}
        draggable={false}
      />
    );
  }

  return <FileGlyph kind={pickIconKind(file.ext, file.category)} />;
}
