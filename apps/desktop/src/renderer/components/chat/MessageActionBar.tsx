/**
 * MessageActionBar
 * ---------------------------------------------------------------------------
 * Hover-revealed action bar for chat messages (V1.2 spec).
 *
 * Layout:
 *   - Bar gap 2px, align-items: center
 *   - Order is `align`-driven:
 *       align="left"  → [CopyBtn][ForkBtn][MoreMenu][TimeText][CostText] (assistant)
 *       align="right" → [TimeText][CopyBtn][ForkBtn][EditBtn][MoreMenu] (user)
 *   - Action buttons are 24×24; More uses a pill trigger and a 12px menu
 *     containing message deep-link copy and single-message deletion.
 *   - Icon lucide 14×14, color #737373 (Light) / #a3a3a3 (Dark)
 *     hover color #262626 (Light) / #ffffff (Dark)
 *   - Time text 12px Inter normal, color INVERTED from icon (#a3a3a3 / #737373)
 *
 * Visibility (controlled by parent hover container):
 *   - visible=true  → opacity 1 (mounted, no fade-in per spec)
 *   - visible=false → opacity 0 + pointer-events-none, parent owns 200ms
 *     debounce + 150ms fade-out lifecycle
 *
 * Copy click:
 *   - Writes copyText to clipboard, swaps icon to Check.
 *   - Bar does NOT auto-fade — appearance/disappearance is driven entirely by
 *     hover. Check icon resets to Copy when hover leaves (next hover-in shows
 *     the default Copy icon again).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Ellipsis,
  Link2,
  MessageSquarePlus,
  Pencil,
  Share,
  Split,
  Trash2,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { formatAbsolute, useRelativeTime } from '@/hooks/useRelativeTime';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { formatCompactTokens, formatTurnCostMoney } from '@/lib/usageFormat';
import { buildTurnUsageTooltipLines } from '@/lib/turnUsageTooltip';
import type { TurnUsageDetails } from '../../../shared/turnUsageDetails';
import {
  legacyUsdMoney,
  type RegionalMoney,
} from '../../../shared/regionalMoney';

interface MessageActionBarProps {
  createdAt?: string;
  /** Plaintext that will hit the clipboard on copy click. */
  copyText: string;
  /** Message deep link (`cindy://session/<id>?message=<clientId>`) copied by
   *  the More menu's "copy current conversation link" item. */
  copyLinkText?: string;
  /** Bar alignment + button order: 'left' = assistant, 'right' = user. */
  align: 'left' | 'right';
  /** Whether the parent message is currently hovered. Drives the entire
   *  fade lifecycle internally so quick re-enters don't replay from 0. */
  hovered: boolean;
  /** When provided, render a Fork button (user messages fork *before* the
   *  question; assistant messages fork *through* the reply's turn — the
   *  parent decides whether to wire it). Returning a promise keeps the
   *  loading state alive until resolve/reject. The bar dims to opacity 0.6 +
   *  pointer-events:none for the duration; the Fork icon is replaced with a
   *  spinning Loader2. */
  onFork?: () => Promise<void>;
  /** Insert this message's anchored conversation link into the active composer. */
  onAddToChat?: () => void;
  /** 进入「分享为图片」选择模式并预选本条。放在复制按钮右边(产品指定位置)。 */
  onShareAsImage?: () => void;
  /** When provided, the More menu exposes single-message deletion. The
   *  parent owns confirmation + persistence; the promise keeps the action
   *  bar disabled until the flow resolves. */
  onDelete?: () => Promise<void>;
  /** When provided, render an Edit (Pencil) button (last user message only).
   *  Click is fire-and-forget — the parent owns the inline edit lifecycle. */
  onEdit?: () => void;
  /** When provided, render a Rewind (Undo2) button (user messages only).
   *  Click is fire-and-forget — the parent owns the dialog lifecycle and
   *  signals the loading state via `rewindInFlight`. */
  onRewind?: () => void;
  /** External "rewind in flight" signal — controls icon swap (Undo2 → Loader2)
   *  and bar dim. Owned by the parent because the in-flight period spans the
   *  Preview Dialog's open lifetime + commit, which the bar doesn't manage. */
  rewindInFlight?: boolean;
  /** Per-turn 费用 (USD) — 仅该轮最后一条 assistant 有值, 时间旁显示。 */
  turnMoney?: RegionalMoney;
  turnCostUsd?: number;
  turnCostIsEstimate?: boolean;
  /** User-visible cumulative cost for the surrounding user round. */
  userTurnMoney?: RegionalMoney;
  userTurnCostUsd?: number;
  userTurnCostIsEstimate?: boolean;
  /** Per-turn token/cache 明细。旧消息没有时 tooltip 保持旧文案。 */
  turnUsageDetails?: TurnUsageDetails;
}

// Total time the bar lingers after hover-leave before opacity drops to 0.
// Acts as a debounce — quick re-enters within this window cancel the fade
// without resetting opacity, so the bar stays steady at full visibility.
const LEAVE_DEBOUNCE_MS = 250;

export function MessageActionBar({
  createdAt,
  copyText,
  copyLinkText,
  align,
  hovered,
  onFork,
  onAddToChat,
  onShareAsImage,
  onDelete,
  onEdit,
  onRewind,
  rewindInFlight = false,
  turnMoney,
  turnCostUsd,
  turnCostIsEstimate = false,
  userTurnMoney,
  userTurnCostUsd,
  userTurnCostIsEstimate = false,
  turnUsageDetails,
}: MessageActionBarProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [forking, setForking] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Radix restores focus to the trigger when a menu closes. Programmatic
  // focus restoration is treated as `:focus-visible` by Chromium even when
  // the user opened/closed the menu with a pointer, leaving an unwanted blue
  // ring behind. Track the latest menu interaction modality so pointer flows
  // can skip restoration while keyboard flows keep their focus indicator.
  const menuInteractionFromPointerRef = useRef(false);
  // Fork has its own visible button. Menu-owned actions still dim and block
  // the whole bar; Fork keeps the More trigger available while it runs.
  const inFlight = forking || deleting || rewindInFlight;
  const moreInFlight = deleting || rewindInFlight;
  // `visible` is the actual opacity driver. It tracks `hovered` with a
  // trailing debounce so the bar fades out smoothly (CSS handles the
  // opacity interpolation from current value, not from 1).
  const [visible, setVisible] = useState(hovered);
  const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (hovered) {
      // Hover enter — kill any pending fade-out and snap to visible.
      // CSS transition naturally interpolates from whatever opacity the
      // element currently sits at (mid-fade values are fine).
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
      setVisible(true);
      return;
    }
    // Hover leave — schedule fade after debounce, but don't change opacity yet.
    if (leaveTimerRef.current) clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = setTimeout(() => {
      setVisible(false);
      leaveTimerRef.current = null;
    }, LEAVE_DEBOUNCE_MS);
    return () => {
      if (leaveTimerRef.current) {
        clearTimeout(leaveTimerRef.current);
        leaveTimerRef.current = null;
      }
    };
  }, [hovered]);

  // Reset the copy icon on the *next* hover-enter, not on hover-leave.
  // Resetting at leave-time would visually swap ✓ → Copy mid-fade-out
  // (looks like the icon "snapped back"). By tying the reset to the rising
  // edge of `hovered`, the bar fades out still showing ✓, then the next
  // hover starts cleanly with the default Copy icon.
  const prevHoveredRef = useRef(hovered);
  useEffect(() => {
    if (hovered && !prevHoveredRef.current && copied) {
      setCopied(false);
    }
    prevHoveredRef.current = hovered;
  }, [hovered, copied]);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(copyText);
        setCopied(true);
      } catch {
        // Clipboard may be unavailable; fail silently — UX falls back to
        // the user noticing nothing happened.
      }
    },
    [copyText],
  );

  const handleFork = useCallback(
    async () => {
      if (!onFork || forking) return;
      setForking(true);
      try {
        await onFork();
      } catch {
        // useForkAtMessage already maps the error to a user-facing toast.
      } finally {
        // Reset regardless of outcome — caller toasts on failure, and on
        // success we usually navigate away anyway so unmount handles it.
        setForking(false);
      }
    },
    [onFork, forking],
  );

  const handleCopyLink = useCallback(
    async () => {
      if (!copyLinkText) return;
      try {
        await navigator.clipboard.writeText(copyLinkText);
        toast.success(t('chat.messageActionBar.linkCopied'));
      } catch {
        toast.warning(t('chat.messageActionBar.copyLinkFailed'));
      }
    },
    [copyLinkText, t],
  );

  const handleDelete = useCallback(async () => {
    if (!onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete();
    } catch {
      // useDeleteMessage already maps persistence failures to a user-facing toast.
    } finally {
      setDeleting(false);
    }
  }, [deleting, onDelete]);

  const relText = useRelativeTime(createdAt, { hovered });
  const absText = formatAbsolute(createdAt);
  const Icon = copied ? Check : Copy;

  const copyBtn = (
    <button
      key="copy"
      type="button"
      onClick={handleCopy}
      className={cn(
        'group flex h-[24px] w-[24px] items-center justify-center',
        'rounded-[4px] border-none bg-transparent outline-none cursor-pointer',
        'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
      )}
      aria-label={t('chat.messageActionBar.copy')}
    >
      <Icon
        size={14}
        strokeWidth={2}
        className={cn(
          'text-[var(--cmd-palette-item-meta)]',
          !copied && 'group-hover:text-[var(--msg-assistant-text)]',
          'transition-colors duration-150',
        )}
      />
    </button>
  );

  // 分享为图片 — 紧贴复制右侧。点击进入选择模式并预选本条,后续勾选与出口都在
  // 底部操作条上完成(ShareSelectionBar),所以这里是纯 fire-and-forget。
  const shareBtn = onShareAsImage && (
    <Tooltip.Root key="share">
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShareAsImage();
          }}
          disabled={inFlight}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-full border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors disabled:cursor-default',
          )}
          aria-label={t('chat.shareImage.entry')}
        >
          {/* iOS 同款分享形状(托盘 + 上箭头,对应 SF Symbols 的
              square.and.arrow.up);lucide 的 Share2 是三点连线的通用款,不用。 */}
          <Share
            size={14}
            strokeWidth={2}
            className={cn(
              'text-[var(--cmd-palette-item-meta)]',
              'group-hover:text-[var(--msg-assistant-text)]',
              'transition-colors duration-150',
            )}
          />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('chat.shareImage.entry')}</Tooltip.Content>
    </Tooltip.Root>
  );

  const forkBtn = onFork && (
    <Tooltip.Root key="fork">
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void handleFork();
          }}
          disabled={inFlight}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-lg border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
            'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:cursor-default',
          )}
          aria-label={t('chat.messageActionBar.fork')}
        >
          {forking ? (
            <Spinner size={14} strokeWidth={2} className="text-[var(--cmd-palette-item-meta)]" />
          ) : (
            <Split
              size={14}
              strokeWidth={2}
              className={cn(
                'text-[var(--cmd-palette-item-meta)]',
                'group-hover:text-[var(--msg-assistant-text)]',
                'transition-colors duration-150',
              )}
            />
          )}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('chat.messageActionBar.fork')}</Tooltip.Content>
    </Tooltip.Root>
  );

  const timeText = relText && (
    <Tooltip.Root key="time">
      <Tooltip.Trigger asChild>
        <time
          dateTime={createdAt}
          className={cn(
            'inline-flex h-[24px] items-center text-[12px] font-normal whitespace-nowrap',
            // Optical adjustment: nudge time text down 0.5px so its visual
            // mid-line aligns with the lucide Copy icon glyph center.
            'relative top-[0.5px]',
            // 视觉分组:user 侧(right)时间在最左、后面跟 4 个操作图标
            // ([copy][fork][edit][more],彼此 gap-0.5=2px 是一组)。时间与图标组
            // 之间额外 +6px(共 8px),让"元信息 | 操作组"两段读起来是独立分组
            // —— 与 assistant 侧 costText 的 ml-1.5 同一间距语言。
            align === 'right' && 'mr-1.5',
            'text-[var(--settings-section-desc)] cursor-default',
          )}
        >
          {relText}
        </time>
      </Tooltip.Trigger>
      {absText && (
        <Tooltip.Content>
          <span className="whitespace-pre-line">{absText}</span>
        </Tooltip.Content>
      )}
    </Tooltip.Root>
  );

  // 用户轮累计优先；没有新字段的历史消息继续显示原始 SDK 分段成本。
  const effectiveTurnMoney =
    turnMoney ??
    (typeof turnCostUsd === 'number' && turnCostUsd > 0
      ? legacyUsdMoney(turnCostUsd)
      : undefined);
  const effectiveUserTurnMoney =
    userTurnMoney ??
    (typeof userTurnCostUsd === 'number' && userTurnCostUsd > 0
      ? legacyUsdMoney(userTurnCostUsd)
      : undefined);
  const displayedMoney = effectiveUserTurnMoney ?? effectiveTurnMoney;
  const displayedCostIsEstimate = effectiveUserTurnMoney
    ? userTurnCostIsEstimate
    : turnCostIsEstimate;
  const isUserTurnTotal = effectiveUserTurnMoney != null;

  // 费用 — 样式与 timeText 完全一致(12px + 同色 + 0.5px 光学修正)。
  // 仅 assistant(align='left')会拿到值;估算值(Codex 折算)表达为 token 价值。
  const turnCostTooltipNode =
    displayedMoney && displayedMoney.amount > 0 && turnUsageDetails ? (
      <span className="whitespace-pre-line">
        {buildTurnUsageTooltipLines({
          details: turnUsageDetails,
          t,
          money: displayedMoney,
          isEstimate: displayedCostIsEstimate,
          ...(isUserTurnTotal ? { title: t('chat.messageActionBar.userTurnCostDetailsTitle') } : {}),
        }).join('\n')}
      </span>
    ) : (
      t(
        displayedCostIsEstimate
          ? 'chat.messageActionBar.turnCostEstimated'
          : 'chat.messageActionBar.turnCost',
      )
    );

  // 时间戳之后那一格的排版口径:与 timeText 同为 12px 次要文本 + 0.5px 光学修正;
  // bar 的 gap-0.5(2px)对两段相邻文本太挤,额外 6px 左距(共 8px)让「时间 | 用量」
  // 读成两个独立信息组。金额与 token 回退共用同一套 —— 换的是内容,不是位置。
  const metaTextClassName = cn(
    'inline-flex h-[24px] items-center text-[12px] font-normal whitespace-nowrap',
    'relative top-[0.5px]',
    'ml-1.5',
    'text-[var(--settings-section-desc)] cursor-default',
  );

  const costText = displayedMoney && displayedMoney.amount > 0 && (
    <Tooltip.Root key="cost">
      <Tooltip.Trigger asChild>
        <span className={metaTextClassName}>
          {displayedCostIsEstimate
            ? t('chat.messageActionBar.turnCostEstimatedValue', {
                cost: formatTurnCostMoney(displayedMoney),
              })
            : formatTurnCostMoney(displayedMoney)}
        </span>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {turnCostTooltipNode}
      </Tooltip.Content>
    </Tooltip.Root>
  );

  // 金额缺席时的回退:显示本轮 token 总量。成因可能是网关目录整体不下发价格、
  // 模型不在价表、或订阅估值也 miss —— 对用户都一样,这一格不该因此空着。
  // 钱算不出来不代表用量算不出来:明细由 main 在 turn 结束时落库,与金额同源。
  const tokensText = !(displayedMoney && displayedMoney.amount > 0) &&
    turnUsageDetails &&
    turnUsageDetails.totalTokens > 0 && (
      <Tooltip.Root key="tokens">
        <Tooltip.Trigger asChild>
          <span className={metaTextClassName}>
            {t('chat.messageActionBar.turnTokens', {
              tokens: formatCompactTokens(turnUsageDetails.totalTokens),
            })}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Content>
          <span className="whitespace-pre-line">
            {buildTurnUsageTooltipLines({ details: turnUsageDetails, t }).join('\n')}
          </span>
        </Tooltip.Content>
      </Tooltip.Root>
    );

  // Edit (Pencil) button — last user message only. Enters the inline edit
  // state owned by UserMessage; keep it disabled while any message action is
  // in flight so editing cannot race with Fork's history read or a menu action.
  const editBtn = onEdit && align === 'right' && (
    <Tooltip.Root key="edit">
      <Tooltip.Trigger asChild>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          disabled={inFlight}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-[4px] border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors disabled:cursor-default',
          )}
          aria-label={t('chat.messageActionBar.edit')}
        >
          <Pencil
            size={14}
            strokeWidth={2}
            className={cn(
              'text-[var(--cmd-palette-item-meta)]',
              'group-hover:text-[var(--msg-assistant-text)]',
              'transition-colors duration-150',
            )}
          />
        </button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('chat.messageActionBar.edit')}</Tooltip.Content>
    </Tooltip.Root>
  );

  // Rewind、链接复制与单条删除收进 More 菜单；Fork 与复制同级外显。
  // 面板/行几何遵守 12px container + 8px inner-control 两档圆角。
  const canRewind = Boolean(onRewind && align === 'right');
  const moreMenu = (onAddToChat || copyLinkText || canRewind || onDelete) && (
    <DropdownMenu key="more" open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={() => {
            menuInteractionFromPointerRef.current = true;
          }}
          onKeyDown={() => {
            menuInteractionFromPointerRef.current = false;
          }}
          disabled={moreInFlight}
          className={cn(
            'group flex h-[24px] w-[24px] items-center justify-center',
            'rounded-full border-none bg-transparent outline-none cursor-pointer',
            'hover:bg-[var(--cmd-palette-item-hover)] transition-colors',
            'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            'data-[state=open]:bg-[var(--cmd-palette-item-hover)] disabled:cursor-default',
          )}
          aria-label={t('chat.messageActionBar.moreActions')}
        >
          {moreInFlight ? (
            <Spinner size={14} strokeWidth={2} className="text-[var(--cmd-palette-item-meta)]" />
          ) : (
            <Ellipsis
              size={14}
              strokeWidth={2}
              className={cn(
                'text-[var(--cmd-palette-item-meta)]',
                'group-hover:text-[var(--msg-assistant-text)]',
                'transition-colors duration-150',
              )}
            />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align === 'left' ? 'start' : 'end'}
        sideOffset={4}
        onPointerDownCapture={() => {
          menuInteractionFromPointerRef.current = true;
        }}
        onPointerDownOutside={() => {
          menuInteractionFromPointerRef.current = true;
        }}
        onKeyDownCapture={() => {
          menuInteractionFromPointerRef.current = false;
        }}
        onCloseAutoFocus={(event) => {
          if (menuInteractionFromPointerRef.current) event.preventDefault();
        }}
        className={cn(
          'min-w-[184px] rounded-xl border border-[var(--cmd-palette-border)]',
          'bg-[var(--cmd-palette-bg)] p-1 text-[var(--cmd-palette-item-text)] shadow-none',
        )}
      >
        {onAddToChat && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.stopPropagation();
              onAddToChat();
            }}
            className="h-8 cursor-pointer select-none rounded-lg px-2 text-sm focus:bg-[var(--cmd-palette-item-hover)]"
          >
            <MessageSquarePlus size={14} strokeWidth={2} className="mr-2 shrink-0" />
            {t('chat.quote.addToChat')}
          </DropdownMenuItem>
        )}
        {copyLinkText && (
          <DropdownMenuItem
            onSelect={(event) => {
              event.stopPropagation();
              void handleCopyLink();
            }}
            className="h-8 cursor-pointer select-none rounded-lg px-2 text-sm focus:bg-[var(--cmd-palette-item-hover)]"
          >
            <Link2 size={14} strokeWidth={2} className="mr-2 shrink-0" />
            {t('chat.messageActionBar.copyLink')}
          </DropdownMenuItem>
        )}
        {canRewind && (
          <DropdownMenuItem
            disabled={rewindInFlight}
            onSelect={(event) => {
              event.stopPropagation();
              if (!rewindInFlight) onRewind?.();
            }}
            className="h-8 cursor-pointer select-none rounded-lg px-2 text-sm focus:bg-[var(--cmd-palette-item-hover)]"
          >
            <Undo2 size={14} strokeWidth={2} className="mr-2 shrink-0" />
            {t('chat.messageActionBar.rewind')}
          </DropdownMenuItem>
        )}
        {onDelete && (
          <>
            {(onAddToChat || copyLinkText || canRewind) && (
              <DropdownMenuSeparator className="my-1 h-px bg-[var(--cmd-palette-border)]" />
            )}
            <DropdownMenuItem
              disabled={deleting}
              onSelect={(event) => {
                event.stopPropagation();
                void handleDelete();
              }}
              className={cn(
                'h-8 cursor-pointer select-none rounded-lg px-2 text-sm',
                'text-[hsl(var(--destructive))] focus:bg-[var(--cmd-palette-item-hover)]',
              )}
            >
              <Trash2 size={14} strokeWidth={2} className="mr-2 shrink-0" />
              {t('chat.messageActionBar.delete')}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // align='left'  → [copy][share][fork][more][time][cost]   (assistant)
  // align='right' → [time][copy][share][fork][edit][more]   (user)
  const items =
    align === 'left'
      ? [copyBtn, shareBtn, forkBtn, moreMenu, timeText, costText || tokensText]
      : [timeText, copyBtn, shareBtn, forkBtn, editBtn, moreMenu];

  return (
    <div
      // 操作栏是纯交互件:分享图片的光栅化会按这个标记整条剔除,不进产物。
      {...{ [SHARE_EXCLUDE_ATTR]: '' }}
      className={cn(
        'flex items-center gap-0.5',
        align === 'right' ? 'justify-end' : 'justify-start',
        // 250ms is long enough to perceive the fade without dragging.
        // Hover re-enters mid-fade interpolate from the current opacity
        // (browser CSS transition behavior — no replay from 0).
        'transition-opacity duration-[250ms] ease-out',
        visible || menuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none',
        // Menu-owned actions dim the entire bar and block clicks. Fork only
        // disables its own button so More remains available.
        moreInFlight && 'opacity-60 pointer-events-none',
      )}
    >
      {items}
    </div>
  );
}
