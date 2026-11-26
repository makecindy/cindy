/**
 * PrLinkHoverPopover — 聊天消息内 PR / MR 链接的悬停详情浮窗。
 *
 * 与会话顶栏 GitContextBadge 共用同一套浮窗主体（PrSummaryPopoverContent）、
 * 状态缓存（PrRefsContext）与延迟节拍（300ms 进 / 300ms 出）：
 *   - 静止态零订阅、零 IPC、不改链接样式（遵守 DESIGN.md §14.5 常显下划线约束）
 *   - 鼠标悬停满 300ms 后挂载浮窗；若缓存未命中，按需向本机 / 远程补查单条 PR/MR 状态
 *   - 保持链接原有的左键/中键/修饰键打开与右键菜单语义；点击或打开右键菜单时立即收起浮窗
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { prStatusKey, type PrIdentity } from '@cindy/maker-shared';
import { isSharedTaskPeer } from '@cindy/device-link';

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { usePrActions, usePrStatuses } from '@/contexts/PrRefsContext';
import { CHAT_LINK_HOVER_SESSION_BUCKET } from '@/lib/prStatus';
import { useSessionPrCard } from '@/cindy-brain/useSessionPrCard';
import { sessionsStore } from '@/lib/sessionsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import {
  PR_SUMMARY_CLOSE_DELAY_MS,
  PR_SUMMARY_OPEN_DELAY_MS,
  PR_SUMMARY_POPOVER_CLASS,
  PrSummaryDialogs,
  PrSummaryPopoverContent,
} from '@/features/cc-agent/PrSummaryPopoverContent';
import type { PrGuidanceAction } from '@/features/cc-agent/gitContextPrVisuals';
import { useChatSessionFile } from './ChatSessionFileContext';

/** 同屏多条 PR/MR 链接间切换时，保证只展开一枚悬停浮窗且切换无缝。 */
let activeHoverClose: (() => void) | null = null;

export interface PrLinkHoverTriggerProps {
  onPointerEnter: (event: PointerEvent<HTMLAnchorElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLAnchorElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLAnchorElement>) => void;
  /** 点击激活或右键菜单弹出前调用，立即收起浮窗并抑制原地重弹。 */
  onDismiss: () => void;
}

export function PrLinkHoverPopover({
  prRef,
  sessionId,
  children,
}: {
  prRef: PrIdentity & { url: string };
  sessionId?: string;
  children: (hoverProps: PrLinkHoverTriggerProps) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [setupAction, setSetupAction] = useState<PrGuidanceAction | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerHovered = useRef(false);
  const panelHovered = useRef(false);
  const suppressHover = useRef(false);
  const cardHold = useRef({ pointer: false, focus: false, menu: false });
  const closeSelfRef = useRef<() => void>(() => undefined);

  const cancelOpen = useCallback(() => {
    if (openTimer.current !== null) clearTimeout(openTimer.current);
    openTimer.current = null;
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);

  const closeImmediate = useCallback(() => {
    cancelOpen();
    cancelClose();
    panelHovered.current = false;
    cardHold.current = { pointer: false, focus: false, menu: false };
    if (activeHoverClose === closeSelfRef.current) activeHoverClose = null;
    setOpen(false);
  }, [cancelClose, cancelOpen]);
  closeSelfRef.current = closeImmediate;

  const closeSummary = useCallback(() => {
    suppressHover.current = triggerHovered.current;
    closeImmediate();
  }, [closeImmediate]);

  const scheduleClose = useCallback(() => {
    cancelOpen();
    cancelClose();
    const hold = cardHold.current;
    if (hold.pointer || hold.focus || hold.menu) return;
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (activeHoverClose === closeSelfRef.current) activeHoverClose = null;
      setOpen(false);
    }, PR_SUMMARY_CLOSE_DELAY_MS);
  }, [cancelClose, cancelOpen]);

  const openNow = useCallback(() => {
    cancelOpen();
    cancelClose();
    if (activeHoverClose && activeHoverClose !== closeSelfRef.current) {
      activeHoverClose();
    }
    activeHoverClose = closeSelfRef.current;
    setOpen(true);
  }, [cancelClose, cancelOpen]);

  useEffect(
    () => () => {
      cancelOpen();
      cancelClose();
      if (activeHoverClose === closeSelfRef.current) activeHoverClose = null;
    },
    [cancelClose, cancelOpen],
  );

  useEffect(() => {
    if (!open) {
      cancelClose();
      panelHovered.current = false;
      cardHold.current = { pointer: false, focus: false, menu: false };
    }
  }, [cancelClose, open]);

  const handleCardHoldChange = useCallback(
    (holdKind: 'pointer' | 'focus' | 'menu', active: boolean) => {
      cardHold.current[holdKind] = active;
      if (active) cancelClose();
      else if (holdKind !== 'pointer' && !panelHovered.current && !triggerHovered.current) {
        scheduleClose();
      }
    },
    [cancelClose, scheduleClose],
  );

  const hoverProps: PrLinkHoverTriggerProps = {
    onPointerEnter: (event) => {
      if (event.pointerType !== 'mouse') return;
      triggerHovered.current = true;
      cancelClose();
      cancelOpen();
      if (suppressHover.current || setupAction !== null || settingsOpen) return;
      if (activeHoverClose && activeHoverClose !== closeSelfRef.current) {
        openNow();
      } else {
        openTimer.current = setTimeout(() => {
          openTimer.current = null;
          openNow();
        }, PR_SUMMARY_OPEN_DELAY_MS);
      }
    },
    onPointerLeave: (event) => {
      if (event.pointerType !== 'mouse') return;
      triggerHovered.current = false;
      suppressHover.current = false;
      scheduleClose();
    },
    onPointerDown: (event) => {
      cancelOpen();
      if (event.button === 2) closeSummary();
    },
    onDismiss: closeSummary,
  };

  const active = open || setupAction !== null || settingsOpen;

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) closeSummary();
      }}
    >
      <PopoverAnchor asChild>{children(hoverProps)}</PopoverAnchor>
      {active && (
        <PrLinkHoverActive
          prRef={prRef}
          sessionId={sessionId}
          open={open}
          setupAction={setupAction}
          onOpenSetup={setSetupAction}
          onCloseSetup={() => setSetupAction(null)}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
          onClose={closeSummary}
          onPanelPointerEnter={() => {
            panelHovered.current = true;
            cancelClose();
          }}
          onPanelPointerLeave={() => {
            panelHovered.current = false;
            scheduleClose();
          }}
          onCardHoldChange={handleCardHoldChange}
        />
      )}
    </Popover>
  );
}

function PrLinkHoverActive({
  prRef,
  sessionId,
  open,
  setupAction,
  onOpenSetup,
  onCloseSetup,
  settingsOpen,
  onSettingsOpenChange,
  onClose,
  onPanelPointerEnter,
  onPanelPointerLeave,
  onCardHoldChange,
}: {
  prRef: PrIdentity & { url: string };
  sessionId?: string;
  open: boolean;
  setupAction: PrGuidanceAction | null;
  onOpenSetup: (action: PrGuidanceAction) => void;
  onCloseSetup: () => void;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onClose: () => void;
  onPanelPointerEnter: () => void;
  onPanelPointerLeave: () => void;
  onCardHoldChange: (kind: 'pointer' | 'focus' | 'menu', active: boolean) => void;
}) {
  const { t } = useTranslation();
  const fileCtx = useChatSessionFile();
  const effectiveSessionId = sessionId ?? fileCtx.sessionId;
  const cacheSessionId = effectiveSessionId ?? CHAT_LINK_HOVER_SESSION_BUCKET;
  const session = effectiveSessionId ? sessionsStore.findById(effectiveSessionId) : undefined;
  const deviceLinkDeviceId =
    (fileCtx.origin.kind === 'device' ? fileCtx.origin.deviceId : undefined) ??
    session?.deviceLinkDeviceId ??
    (effectiveSessionId ? getStickySessionDeviceId(effectiveSessionId) : undefined);
  const remoteHostId =
    (fileCtx.origin.kind === 'ssh' ? fileCtx.origin.remoteHostId : undefined) ??
    session?.remoteHostId ??
    null;
  const readOnly = session?.source === 'review';
  const canManage = !isSharedTaskPeer(deviceLinkDeviceId ?? '');

  const key = prStatusKey(prRef);
  const { statuses } = usePrStatuses(cacheSessionId);
  const status = statuses.get(key);
  const prActions = usePrActions();
  const { provider, host, owner, repo, prNumber } = prRef;

  useEffect(() => {
    if (!open) return;
    prActions.ensurePrStatus?.(
      cacheSessionId,
      { provider, host, owner, repo, prNumber },
      deviceLinkDeviceId ?? undefined,
    );
  }, [cacheSessionId, deviceLinkDeviceId, host, open, owner, prActions, prNumber, provider, repo]);

  const prCard = useSessionPrCard(
    effectiveSessionId ?? '',
    key,
    Boolean(effectiveSessionId) && (open || settingsOpen) && canManage && !readOnly,
  );
  useEffect(() => {
    if (!prCard || (status?.ok && (status.status === 'merged' || status.status === 'closed'))) {
      onSettingsOpenChange(false);
    }
  }, [onSettingsOpenChange, prCard, status]);

  return (
    <>
      <PrSummaryDialogs
        prRef={prRef}
        sessionId={effectiveSessionId}
        setupAction={setupAction}
        onCloseSetup={onCloseSetup}
        settingsOpen={settingsOpen}
        onSettingsOpenChange={onSettingsOpenChange}
        prCard={prCard}
      />
      {open && (
        <PopoverContent
          onPointerEnter={(event) => {
            if (event.pointerType !== 'mouse') return;
            onPanelPointerEnter();
          }}
          onPointerLeave={(event) => {
            if (event.pointerType !== 'mouse') return;
            onPanelPointerLeave();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onClose();
            }
          }}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          side="bottom"
          align="start"
          collisionPadding={8}
          className={PR_SUMMARY_POPOVER_CLASS}
          aria-label={t(
            prRef.provider === 'gitlab'
              ? 'ccAgent.gitContext.pr.gitlab.summaryAria'
              : 'ccAgent.gitContext.pr.summaryAria',
            { number: prRef.prNumber },
          )}
        >
          <PrSummaryPopoverContent
            prRef={prRef}
            status={status}
            sessionId={effectiveSessionId}
            remoteHostId={remoteHostId}
            deviceLinkDeviceId={deviceLinkDeviceId}
            readOnly={readOnly}
            canManage={canManage}
            prCard={prCard}
            onClose={onClose}
            onOpenSetup={onOpenSetup}
            onOpenSettings={() => onSettingsOpenChange(true)}
            onCardHoldChange={onCardHoldChange}
          />
        </PopoverContent>
      )}
    </>
  );
}
