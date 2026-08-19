/**
 * BotArtifactCard —— 对话里的「交付物卡」。
 * ---------------------------------------------------------------------------
 * 伙伴做出来的东西在对话里不该只是一枚文件 chip:它是这次协作的结果,值得一张卡。
 * 统一 12px 圆角 / 1px 描边 / 无阴影(DESIGN.md 容器档),内容 = 类型区 + 标题 +
 * 「类型 · 规格 · 时间」,hover 才浮现动作,静止时不抢视线。
 *
 * 四型(判定见 shared/botArtifact.ts):
 *   - 图片:真缩略图(复用媒体协议地址,远程会话经 origin 改写);
 *   - 文档 / 表格 / 演示:图标块 + 标题行。**表格不做假的迷你预览** —— 真数据
 *     预览需要解析 xlsx/csv,超出本批范围,画一张编的小表是骗人;
 *   - 演示的页数在没有解析器的前提下拿不到,按定稿口径**省略**,不写占位。
 * 其余类型走通用文件卡(同一套骨架,换图标)。
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
import { toLocalFileUrl } from '@/lib/localPathResolver';
import { toRemoteMediaOrigin } from '@/lib/sessionFileOrigin';
import { cn } from '@/lib/utils';
import { rewriteToRemoteMediaOrigin } from '../../../shared/remoteMediaUrl';
import type { BotArtifactItem } from '../../../shared/botArtifact';
import {
  artifactTimeLabel,
  botArtifactCategoryKey,
  botArtifactIcon,
  formatArtifactSize,
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

/** 图片缩略图地址;非图片或拿不到地址返回 null。 */
export function useArtifactThumbnail(item: BotArtifactItem): string | null {
  const fileCtx = useChatSessionFile();
  if (item.category !== 'image') return null;
  const base = item.ref ?? (item.path ? toLocalFileUrl(item.path) : null);
  if (!base) return null;
  return rewriteToRemoteMediaOrigin(
    base,
    toRemoteMediaOrigin(fileCtx.origin, fileCtx.workingDir),
  );
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
          className="block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <img
            src={thumbnail}
            alt={item.name}
            onError={() => setThumbnailFailed(true)}
            className="max-h-[220px] w-full border-b border-[var(--border-default)] bg-[var(--surface-hover)] object-contain"
          />
        </button>
      ) : null}
      <div className="flex items-center gap-3 px-3 py-2.5">
        {showThumbnail ? null : (
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
