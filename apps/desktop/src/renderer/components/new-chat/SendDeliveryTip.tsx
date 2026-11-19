/**
 * SendDeliveryTip — 任务运行中、有草稿时，发送键上的「排队 / 插话」提示。
 * ---------------------------------------------------------------------------
 * 平时不占界面：鼠标在发送键上停留、键盘聚焦、右键或触屏长按时才出现。
 *   - 两行：下面一行永远是默认方式（紧挨发送键，就是点击和发送键会做的事），
 *     上面一行是另一种方式；点哪一行，这一条就按哪种方式发。
 *   - Enter 是发送键时，按住修饰键（⌘ / Ctrl）高亮滑到另一种方式，发送键图标随之变化；
 *     修饰键+Enter、修饰键+点击都按另一种方式发这一条。
 *   - 左侧「对调」把另一种方式设为默认：两行原地交换，不发送。
 *
 * 外观沿用悬停提示的深底（--tooltip-bg / --tooltip-text），见 SendDeliveryTip.css。
 * 内容可点，所以底层是 Popover 而不是纯文本的 Tip；打开和点击都不移动焦点，
 * 光标始终留在输入框里。规则登记在 DESIGN.md §14.6。
 */
import { ArrowUpDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import type { ComposerFollowUpBehavior } from '@/hooks/useComposerFollowUpPreference';
import { hasComposerModifier } from '@/voice-input/composerShortcut';

import './SendDeliveryTip.css';

/** 与 Tip 的默认悬停延迟一致：直接点发送的人看不到它。 */
const HOVER_OPEN_MS = 500;
const HOVER_CLOSE_MS = 150;
/** 与语音键的长按阈值一致。 */
const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;
const NOW_DEFAULT_NOTE_MS = 1600;

type Row = 'default' | 'alternate';
/** hover 随鼠标离开关闭；focus 随失焦关闭；pinned（右键 / 长按）留到点别处或 Esc。 */
type OpenReason = 'hover' | 'focus' | 'pinned';

export interface SendDeliveryTipProps {
  /** 只有任务运行中、有可发送内容、当前界面支持插话时才有两种方式可选。 */
  enabled: boolean;
  defaultMode: ComposerFollowUpBehavior;
  /**
   * Enter 是发送键时为 true：修饰键+Enter 与修饰键+点击按另一种方式发。
   * 修饰键+Enter 本身是发送键时为 false，另一种方式只能点提示里的那一行。
   */
  modifierSendsAlternate: boolean;
  platform: string | undefined;
  onSend: (mode: ComposerFollowUpBehavior) => void;
  onDefaultChange: (mode: ComposerFollowUpBehavior) => void;
  /** 提示打开且指向另一种方式时为 true，发送键据此换图标。 */
  onAlternatePreviewChange: (active: boolean) => void;
  /** 发送键（外面可以包着 Tip）；必须能接收 ref 与事件。 */
  children: ReactElement;
}

function isFocusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  try {
    return target.matches(':focus-visible');
  } catch {
    return true;
  }
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function SendDeliveryTip({
  enabled,
  defaultMode,
  modifierSendsAlternate,
  platform,
  onSend,
  onDefaultChange,
  onAlternatePreviewChange,
  children,
}: SendDeliveryTipProps) {
  const { t } = useTranslation();
  const alternateMode: ComposerFollowUpBehavior = defaultMode === 'steer' ? 'queue' : 'steer';

  const [openReason, setOpenReason] = useState<OpenReason | null>(null);
  const [touch, setTouch] = useState(false);
  const [anchorHovered, setAnchorHovered] = useState(false);
  const [pointerRow, setPointerRow] = useState<Row | null>(null);
  const [focusRow, setFocusRow] = useState<Row | null>(null);
  const [modifierHeld, setModifierHeld] = useState(false);
  const [swapHot, setSwapHot] = useState(false);
  const [nowDefault, setNowDefault] = useState(false);
  const [swapTurns, setSwapTurns] = useState(0);

  const anchorRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const swapRef = useRef<HTMLButtonElement | null>(null);
  const rowRefs = useRef<Partial<Record<ComposerFollowUpBehavior, HTMLButtonElement | null>>>({});
  const timers = useRef<{ hover?: number; close?: number; press?: number; note?: number }>({});
  const suppressClickRef = useRef(false);
  const pressOriginRef = useRef<{ x: number; y: number } | null>(null);
  const lastPointerTypeRef = useRef('mouse');
  const pendingFocusRef = useRef<ComposerFollowUpBehavior | null>(null);
  const layoutRef = useRef<{ mode: ComposerFollowUpBehavior; tops: Partial<Record<ComposerFollowUpBehavior, number>> } | null>(null);

  const open = enabled && openReason !== null;
  const active: Row = pointerRow ?? focusRow ?? (modifierHeld && modifierSendsAlternate ? 'alternate' : 'default');
  const previewAlternate = open && active === 'alternate';
  const swapPreview = swapHot && !nowDefault;

  const close = useCallback(() => {
    window.clearTimeout(timers.current.hover);
    window.clearTimeout(timers.current.close);
    window.clearTimeout(timers.current.note);
    setOpenReason(null);
    setAnchorHovered(false);
    setTouch(false);
    setPointerRow(null);
    setFocusRow(null);
    setModifierHeld(false);
    setSwapHot(false);
    setNowDefault(false);
  }, []);

  const openAs = useCallback((reason: OpenReason, viaTouch = false) => {
    window.clearTimeout(timers.current.hover);
    window.clearTimeout(timers.current.close);
    setOpenReason(reason);
    setTouch(viaTouch);
  }, []);

  const focusTrigger = useCallback(() => {
    anchorRef.current?.querySelector('button')?.focus();
  }, []);

  // 发送后草稿清空、任务结束或切到不能插话的界面：提示跟着收起。
  useEffect(() => {
    if (enabled) return;
    window.clearTimeout(timers.current.press);
    close();
  }, [enabled, close]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      window.clearTimeout(pending.hover);
      window.clearTimeout(pending.close);
      window.clearTimeout(pending.press);
      window.clearTimeout(pending.note);
    };
  }, []);

  // 悬停等待和打开期间都跟随修饰键；窗口失活时直接收起。
  useEffect(() => {
    if (!enabled || (!anchorHovered && !open)) return undefined;
    const syncModifier = (event: globalThis.KeyboardEvent) => setModifierHeld(hasComposerModifier(event, platform));
    window.addEventListener('keydown', syncModifier, true);
    window.addEventListener('keyup', syncModifier, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', syncModifier, true);
      window.removeEventListener('keyup', syncModifier, true);
      window.removeEventListener('blur', close);
    };
  }, [enabled, anchorHovered, open, platform, close]);

  useEffect(() => {
    onAlternatePreviewChange(previewAlternate);
  }, [previewAlternate, onAlternatePreviewChange]);
  useEffect(() => () => onAlternatePreviewChange(false), [onAlternatePreviewChange]);

  // 键盘从发送键按 ↑ 进入提示：等内容挂上后把焦点放到对应那一行。
  useEffect(() => {
    if (!open || !pendingFocusRef.current) return;
    rowRefs.current[pendingFocusRef.current]?.focus();
    pendingFocusRef.current = null;
  });

  // 改默认 = 两行对调。记下上一次各行的位置，对调后让它们从原位滑到新位。
  useLayoutEffect(() => {
    const tops: Partial<Record<ComposerFollowUpBehavior, number>> = {};
    for (const mode of ['queue', 'steer'] as const) {
      const row = rowRefs.current[mode];
      if (row) tops[mode] = row.offsetTop;
    }
    const previous = layoutRef.current;
    if (open && previous && previous.mode !== defaultMode && !prefersReducedMotion()) {
      for (const mode of ['queue', 'steer'] as const) {
        const row = rowRefs.current[mode];
        const from = previous.tops[mode];
        const to = tops[mode];
        if (!row || from === undefined || to === undefined || from === to || typeof row.animate !== 'function') continue;
        const motionStyle = getComputedStyle(row);
        const durationToken = motionStyle.getPropertyValue('--motion-enter').trim();
        const duration = parseFloat(durationToken) * (durationToken.endsWith('ms') ? 1 : 1000);
        row.animate([{ transform: `translateY(${from - to}px)` }, { transform: 'none' }], {
          duration: Number.isFinite(duration) ? duration : 0,
          easing: motionStyle.getPropertyValue('--motion-ease-out').trim() || 'linear',
        });
      }
    }
    layoutRef.current = open ? { mode: defaultMode, tops } : null;
  });

  const scheduleHoverClose = () => {
    if (openReason !== 'hover') return;
    window.clearTimeout(timers.current.close);
    timers.current.close = window.setTimeout(close, HOVER_CLOSE_MS);
  };

  const endNowDefaultNote = () => {
    window.clearTimeout(timers.current.note);
    setNowDefault(false);
  };

  // ── 发送键上的事件 ─────────────────────────────────────────────────────────
  const onAnchorPointerEnter = (event: PointerEvent<HTMLElement>) => {
    window.clearTimeout(timers.current.close);
    // 按着键拖进来的是语音长按「松手发送」，不是悬停。
    if (!enabled || openReason || event.pointerType !== 'mouse' || event.buttons !== 0) return;
    setAnchorHovered(true);
    setModifierHeld(hasComposerModifier(event, platform));
    window.clearTimeout(timers.current.hover);
    timers.current.hover = window.setTimeout(() => openAs('hover'), HOVER_OPEN_MS);
  };
  const onAnchorPointerLeave = (event: PointerEvent<HTMLElement>) => {
    setAnchorHovered(false);
    window.clearTimeout(timers.current.hover);
    if (event.pointerType === 'mouse') scheduleHoverClose();
  };
  const onAnchorPointerDown = (event: PointerEvent<HTMLElement>) => {
    lastPointerTypeRef.current = event.pointerType;
    suppressClickRef.current = false;
    window.clearTimeout(timers.current.hover);
    window.clearTimeout(timers.current.press);
    if (!enabled || event.pointerType === 'mouse') return;
    pressOriginRef.current = { x: event.clientX, y: event.clientY };
    timers.current.press = window.setTimeout(() => {
      // 长按只打开提示；松手不发送，再点具体哪一行才发。
      suppressClickRef.current = true;
      openAs('pinned', true);
    }, LONG_PRESS_MS);
  };
  const onAnchorPointerMove = (event: PointerEvent<HTMLElement>) => {
    const origin = pressOriginRef.current;
    if (!origin) return;
    if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > LONG_PRESS_SLOP_PX) {
      window.clearTimeout(timers.current.press);
      pressOriginRef.current = null;
    }
  };
  const onAnchorPointerEnd = () => {
    window.clearTimeout(timers.current.press);
    pressOriginRef.current = null;
  };
  const onAnchorContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!enabled) return;
    event.preventDefault();
    window.clearTimeout(timers.current.press);
    const viaTouch = lastPointerTypeRef.current !== 'mouse';
    if (viaTouch) suppressClickRef.current = true;
    openAs('pinned', viaTouch);
  };
  const onAnchorClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };
  const onAnchorClick = () => {
    if (openReason) close();
  };
  const onAnchorFocus = (event: FocusEvent<HTMLElement>) => {
    if (enabled && !openReason && isFocusVisible(event.target)) openAs('focus');
  };
  const onAnchorBlur = (event: FocusEvent<HTMLElement>) => {
    if (openReason !== 'focus') return;
    if (event.relatedTarget instanceof Node && contentRef.current?.contains(event.relatedTarget)) return;
    close();
  };
  const onAnchorKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!enabled || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    // 离发送键最近的是默认那一行。
    const row = rowRefs.current[defaultMode];
    if (open && row) row.focus();
    else {
      pendingFocusRef.current = defaultMode;
      openAs(openReason === 'pinned' ? 'pinned' : 'focus');
    }
  };

  // ── 提示里的事件 ───────────────────────────────────────────────────────────
  const onContentKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const focused = document.activeElement;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      const next = focused === rowRefs.current[defaultMode] ? alternateMode : defaultMode;
      rowRefs.current[next]?.focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      swapRef.current?.focus();
    } else if (event.key === 'ArrowRight' && focused === swapRef.current) {
      event.preventDefault();
      rowRefs.current[defaultMode]?.focus();
    } else if (event.key === 'Tab') {
      // 提示挂在 body 末尾：先把焦点还给发送键，Tab 再从那里继续走。
      focusTrigger();
      close();
    } else if (event.key === 'Escape') {
      // 这次 Esc 只收起提示，不能再传给输入框当成「停止任务」。
      event.stopPropagation();
      event.nativeEvent.stopPropagation();
    }
  };
  const onContentBlur = (event: FocusEvent<HTMLElement>) => {
    if (openReason !== 'focus') return;
    const next = event.relatedTarget;
    if (next instanceof Node && (contentRef.current?.contains(next) || anchorRef.current?.contains(next))) return;
    close();
  };

  const sendAs = (mode: ComposerFollowUpBehavior) => {
    close();
    onSend(mode);
  };
  const swapDefault = () => {
    setPointerRow(null);
    setNowDefault(true);
    setSwapTurns((turns) => turns + 1);
    window.clearTimeout(timers.current.note);
    timers.current.note = window.setTimeout(() => setNowDefault(false), NOW_DEFAULT_NOTE_MS);
    onDefaultChange(alternateMode);
  };

  const modifierKey = platform === 'darwin' ? '⌘' : 'Ctrl';
  const modifierAria = platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter';
  const keysOf = (row: Row): { caps: string[]; aria: string } | null => {
    const sendsWithEnter = row === 'default' ? modifierSendsAlternate : false;
    if (sendsWithEnter) return { caps: ['↵'], aria: 'Enter' };
    if (row === 'default' || modifierSendsAlternate) return { caps: [modifierKey, '↵'], aria: modifierAria };
    return null;
  };

  const renderRow = (mode: ComposerFollowUpBehavior, row: Row) => {
    // 另一种方式那行在指向「对调」时写明这一下会做什么；对调之后默认行确认一下。
    // 两句都常驻在同一格里、只切换透明度：提示的宽度不会因为换字而跳动。
    const noteShown = row === 'alternate' ? swapPreview : nowDefault;
    const keys = keysOf(row);
    return (
      <button
        key={mode}
        ref={(element) => {
          rowRefs.current[mode] = element;
        }}
        type="button"
        role="menuitem"
        tabIndex={-1}
        className="send-delivery-row"
        data-row={row}
        data-mode={mode}
        data-active={active === row ? '' : undefined}
        data-note={noteShown ? '' : undefined}
        aria-keyshortcuts={keys?.aria}
        onClick={() => sendAs(mode)}
        onPointerMove={(event) => {
          if (event.pointerType === 'mouse' && pointerRow !== row) setPointerRow(row);
        }}
        onFocus={() => setFocusRow(row)}
        onBlur={() => setFocusRow(null)}
      >
        <span className="send-delivery-label">{t(`settings.composer.followUp.options.${mode}`)}</span>
        <span className="send-delivery-hint">
          {/* 极窄窗口加长文案时这句会省略，完整内容留在原生 title 里。 */}
          <span data-layer="hint" title={t(`newChat.sendDelivery.${mode}Hint`)}>
            {t(`newChat.sendDelivery.${mode}Hint`)}
          </span>
          <span data-layer="note" aria-hidden>
            {t(row === 'alternate' ? 'newChat.sendDelivery.setDefault' : 'newChat.sendDelivery.nowDefault')}
          </span>
        </span>
        {keys && (
          <span className="send-delivery-keys" aria-hidden>
            {keys.caps.map((cap) => (
              <kbd key={cap}>{cap}</kbd>
            ))}
          </span>
        )}
      </button>
    );
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <PopoverAnchor
        asChild
        ref={anchorRef as Ref<HTMLDivElement>}
        onPointerEnter={onAnchorPointerEnter}
        onPointerLeave={onAnchorPointerLeave}
        onPointerDown={onAnchorPointerDown}
        onPointerMove={onAnchorPointerMove}
        onPointerUp={onAnchorPointerEnd}
        onPointerCancel={onAnchorPointerEnd}
        onContextMenu={onAnchorContextMenu}
        onClickCapture={onAnchorClickCapture}
        onClick={onAnchorClick}
        onFocus={onAnchorFocus}
        onBlur={onAnchorBlur}
        onKeyDown={onAnchorKeyDown}
      >
        {children}
      </PopoverAnchor>
      <PopoverContent
        ref={contentRef}
        role="menu"
        aria-label={t('newChat.sendDelivery.menuAria')}
        side="top"
        align="end"
        sideOffset={6}
        // 让默认行的 ↵ 键帽正好落在发送键正上方。
        alignOffset={-4}
        collisionPadding={8}
        data-touch={touch ? '' : undefined}
        data-preview={swapPreview ? '' : undefined}
        className="send-delivery-tip z-[60] w-max border-0 bg-[var(--tooltip-bg)] p-1 text-13 text-[var(--tooltip-text)]"
        // 打开、关闭都不动焦点：光标留在输入框里，发完可以接着打字。
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => {
          if (contentRef.current?.contains(document.activeElement)) focusTrigger();
        }}
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={() => window.clearTimeout(timers.current.close)}
        onPointerLeave={() => {
          setPointerRow(null);
          setSwapHot(false);
          endNowDefaultNote();
          scheduleHoverClose();
        }}
        onKeyDown={onContentKeyDown}
        onBlur={onContentBlur}
      >
        <button
          ref={swapRef}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="send-delivery-swap"
          data-hot={swapPreview ? '' : undefined}
          aria-label={t(
            alternateMode === 'steer' ? 'newChat.sendDelivery.switchToSteer' : 'newChat.sendDelivery.switchToQueue',
          )}
          onClick={swapDefault}
          onPointerEnter={(event) => {
            if (event.pointerType !== 'mouse') return;
            setPointerRow(null);
            setSwapHot(true);
          }}
          onPointerLeave={() => {
            setSwapHot(false);
            endNowDefaultNote();
          }}
          onFocus={(event) => {
            if (isFocusVisible(event.target)) setSwapHot(true);
          }}
          onBlur={() => setSwapHot(false)}
        >
          <ArrowUpDown aria-hidden size={13} strokeWidth={2} style={{ transform: `rotate(${swapTurns * 180}deg)` }} />
        </button>
        <div className="send-delivery-rows">
          <span aria-hidden className="send-delivery-glide" data-on={active} />
          {renderRow(alternateMode, 'alternate')}
          {renderRow(defaultMode, 'default')}
        </div>
      </PopoverContent>
    </Popover>
  );
}
