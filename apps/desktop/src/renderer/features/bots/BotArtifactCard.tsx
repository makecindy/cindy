/**
 * BotArtifactCard —— 对话里的「交付物卡」。
 * ---------------------------------------------------------------------------
 * 伙伴做出来的东西在对话里不该只是一枚文件 chip:它是这次协作的结果,值得一张卡。
 * 统一 12px 圆角 / 1px 描边 / 无阴影(DESIGN.md 容器档),内容 = 类型区 + 标题 +
 * 「类型 · 规格 · 时间」,hover 才浮现动作,静止时不抢视线。
 *
 * 四型(判定见 shared/botArtifact.ts):
 *   - 图片:真缩略图(复用媒体协议地址,远程会话经 origin 改写);
 *   - 表格:**真数据**迷你小表(定稿原型的 4 行 × 3 列)。只在本机会话 + csv/tsv 时
 *     读文件头解析出来;xlsx 需要解析器、仓里没有依赖也不为此新增,远程会话读不到
 *     本机文件 —— 这两种都回退图标。**绝不画一张编的小表**;
 *   - 文档 / 演示:图标块 + 标题行。演示的页数在没有解析器的前提下拿不到,按定稿
 *     口径**省略**,不写占位。
 * 其余类型走通用文件卡(同一套骨架,换图标)。
 */

import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { isRemoteFileOrigin, toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { cn } from '@/lib/utils';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import type { BotArtifactItem } from '../../../shared/botArtifact';
import {
  artifactTimeLabel,
  botArtifactCategoryKey,
  botArtifactIcon,
  formatArtifactSize,
  parseSheetPreview,
  sheetPreviewDelimiter,
} from './botArtifactPresentation';

/**
 * 类型区一律走同一组语义 token(双模式自动成立)。**类型差异只由图标承担** ——
 * 给四型各配一个色块要么落到硬编码色(只对一种模式成立),要么把状态色借去表达
 * 分类语义,两条都违反设计规则。
 */
const TYPE_TONE = 'bg-[var(--surface-hover)] text-[var(--text-secondary)]';

/** i18n 化的相对时间。判定在 botArtifactPresentation,这里只负责查文案。 */
export function useArtifactTimeText(): (createdAt: number) => string {
  const { t, i18n } = useTranslation();
  return (createdAt: number): string => {
    const label = artifactTimeLabel(createdAt, Date.now());
    if (label.kind === 'justNow') return t('bots.artifacts.time.justNow');
    if (label.kind === 'date') {
      try {
        return new Date(label.at).toLocaleDateString(i18n.language, {
          month: 'short',
          day: 'numeric',
        });
      } catch {
        return new Date(label.at).toLocaleDateString();
      }
    }
    return t(`bots.artifacts.time.${label.kind}`, { n: label.n });
  };
}

/**
 * 图片 / 视频的预览地址;其它类型或拿不到地址返回 null。
 *
 * 视频给的是同一条地址,由调用方用 `<video>` 取首帧 —— 一柜子视频如果只显示
 * 通用图标,和一柜子没有封面的文件没有区别,而封面本来就在文件里。
 */
export function useArtifactThumbnail(item: BotArtifactItem): string | null {
  const fileCtx = useChatSessionFile();
  if (item.category !== 'image' && item.category !== 'video') return null;
  const base = item.ref ?? (item.path ? toLocalFileUrl(item.path) : null);
  if (!base) return null;
  return rewriteToRemoteMediaOrigin(
    base,
    toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
  );
}

/**
 * 迷你预览只需要开头几行。走既有的 `peek-file-header`(main 侧 64KB 硬上限 +
 * isPathAllowed 路径策略,只读),不新增 IPC、不给 renderer 新的文件读取面。
 */
const SHEET_PREVIEW_HEAD_BYTES = 16 * 1024;

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  // 头部按字节截断,尾部可能落在一个多字节字符中间 → 非 fatal 解码,坏字节变
  // 替换符;它落在被丢弃的尾行里,不会进预览。
  return new TextDecoder('utf-8').decode(bytes);
}

/** 表格交付物的真实迷你预览;拿不到(非 csv/tsv、远程会话、读失败)返回 null。 */
export function useSheetMiniPreview(item: BotArtifactItem): string[][] | null {
  const fileCtx = useChatSessionFile();
  const remote = isRemoteFileOrigin(fileCtx.origin);
  const delimiter = item.category === 'sheet' ? sheetPreviewDelimiter(item.ext) : null;
  const filePath = item.path;
  const [rows, setRows] = useState<string[][] | null>(null);

  useEffect(() => {
    setRows(null);
    if (!delimiter || !filePath || remote) return;
    const peek = window.electronAPI?.peekFileHeader;
    if (typeof peek !== 'function') return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await peek({ filePath, bytes: SHEET_PREVIEW_HEAD_BYTES });
        if (cancelled || !result.success || !result.data) return;
        const parsed = parseSheetPreview(decodeBase64Utf8(result.data), delimiter, {
          truncated: result.actualBytes < result.totalSize,
        });
        if (!cancelled && parsed.length > 0) setRows(parsed);
      } catch {
        // 预览是锦上添花:读不到就退回图标,不弹错、不留半张空表。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [delimiter, filePath, remote]);

  return rows;
}

interface Props {
  item: BotArtifactItem;
  onOpen: (item: BotArtifactItem) => void;
  /** 「在仓库中查看」。不传则不渲染该动作(仓库面板内部就不需要再跳自己)。 */
  onReveal?: ((item: BotArtifactItem) => void) | undefined;
  /**
   * 「由 {name} 交付」。只在这张卡挂在**别人**的气泡底下时给 —— 本轮自己产出的
   * 文件不需要再说一遍是谁做的。
   */
  deliveredBy?: string | undefined;
  className?: string;
}

export function BotArtifactCard({ item, onOpen, onReveal, deliveredBy, className }: Props) {
  const { t } = useTranslation();
  const timeText = useArtifactTimeText();
  const thumbnail = useArtifactThumbnail(item);
  const sheetPreview = useSheetMiniPreview(item);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const Icon = botArtifactIcon(item.category);

  const size = formatArtifactSize(item.sizeBytes);
  const meta = [
    t(botArtifactCategoryKey(item.category)),
    size,
    timeText(item.createdAt),
    deliveredBy ? t('bots.artifacts.deliveredBy', { name: deliveredBy }) : '',
  ]
    .filter((part) => part.length > 0)
    .join(' · ');

  const actions = (
    <div className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none">
      <button
        type="button"
        onClick={() => onOpen(item)}
        className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-[3px] text-11 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        {t('bots.artifacts.open')}
      </button>
      {onReveal ? (
        <button
          type="button"
          onClick={() => onReveal(item)}
          className="rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-[3px] text-11 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {t('bots.artifacts.reveal')}
        </button>
      ) : null}
    </div>
  );

  const showThumbnail = thumbnail !== null && !thumbnailFailed;
  const showSheetPreview = !showThumbnail && sheetPreview !== null && sheetPreview.length > 0;

  return (
    <div
      data-testid="bot-artifact-card"
      data-artifact-category={item.category}
      className={cn(
        'group relative max-w-[440px] overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)]',
        className,
      )}
    >
      {showThumbnail ? (
        <button
          type="button"
          onClick={() => onOpen(item)}
          aria-label={t('bots.artifacts.open')}
          className="relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {item.category === 'video' ? (
            <>
              {/*
                真首帧,不画假封面。`#t=0.1` 让浏览器把解码位置停在第 0.1 秒并渲染
                那一帧 —— 停在 0 秒有些编码取不到画面,出来是全黑。`preload=metadata`
                只取够画一帧的数据,不拉整段;不给 controls,这里是封面不是播放器,
                点击仍然走下面那个「打开」。取不到帧就 onError 退回图标(showThumbnail
                会转 false),和表格预览同一个原则:要么真的,要么不出。
              */}
              <video
                src={`${thumbnail}#t=0.1`}
                muted
                playsInline
                preload="metadata"
                aria-hidden="true"
                onError={() => setThumbnailFailed(true)}
                className="max-h-[220px] w-full border-b border-[var(--border-default)] bg-[var(--surface-hover)] object-contain"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                {/*
                  实心徽标,不是半透明蒙层。首帧什么颜色都可能,半透明的话对比度
                  完全不可控;而「在蒙层上的文字色」本仓没有这个 token,不为一个
                  播放标记去造一个。实心 chip 用的是到处都在用的那套面色。
                */}
                <span className="flex size-10 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)]">
                  <Play size={15} className="ml-0.5 text-[var(--text-primary)]" fill="currentColor" />
                </span>
              </span>
            </>
          ) : (
            <img
              src={thumbnail}
              alt={item.name}
              onError={() => setThumbnailFailed(true)}
              className="max-h-[220px] w-full border-b border-[var(--border-default)] bg-[var(--surface-hover)] object-contain"
            />
          )}
        </button>
      ) : null}
      {showSheetPreview ? (
        // 装饰性预览:同一份数据的权威入口是下面的「打开」,这里不做第二个可交互
        // 落点(按钮里嵌表格既是无效 HTML,也会多出一个读屏噪音节点)。
        <div
          aria-hidden="true"
          data-testid="bot-artifact-sheet-preview"
          className="border-b border-[var(--border-default)] bg-[var(--surface-hover)] px-3 py-1.5"
        >
          {sheetPreview.map((cells, rowIndex) => (
            <div
              key={rowIndex}
              className={cn(
                'grid grid-cols-3 gap-2 py-[3px]',
                rowIndex === 0
                  ? 'border-b border-[var(--border-default)] text-[var(--text-secondary)]'
                  : 'text-[var(--text-tertiary)]',
              )}
            >
              {cells.map((cell, columnIndex) => (
                <span key={columnIndex} className="truncate text-10">
                  {cell}
                </span>
              ))}
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {showThumbnail || showSheetPreview ? null : (
          <span
            aria-hidden="true"
            className={cn(
              'flex size-[38px] shrink-0 items-center justify-center rounded-lg',
              TYPE_TONE,
            )}
          >
            <Icon size={16} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-13 text-[var(--text-primary)]" title={item.name}>
            {item.name}
          </span>
          <span className="mt-0.5 block truncate text-11 text-[var(--text-tertiary)]">{meta}</span>
        </span>
        {actions}
      </div>
    </div>
  );
}
