/**
 * useOpenWithMenu
 * ---------------------------------------------------------------------------
 * 消息流里 http(s) 链接的**右键**「打开方式」菜单:在侧边栏浏览器中打开 /
 * 在默认浏览器中打开。左键不再弹菜单——由 openUrlByPreference /
 * openHtmlFileByPreference 按用户偏好(设置 → 个性化 → 链接打开方式)直开。
 * 外部网页与内部网页(本地 HTML / localhost)是两套默认,互不影响。
 *
 * html 文件 chip 的右键不走本 hook——它们已有 useFileChipContextMenu
 * (复制 / 路径 / 目录 / 浏览器查看),「侧边栏打开 / 查看源文件」以可选项
 * 合并进那份菜单,避免同一个元素挂两份右键菜单。
 *
 * sessionId 缺失时仍可右键复制和交给系统浏览器，只省略侧边栏项。
 *
 * 视觉与交互复用 useFileChipContextMenu 的模式:Radix DropdownMenu + 光标处
 * 0×0 虚拟 trigger;menu 渲染一次挂在调用组件旁。
 */

import { useRef, useState, type ReactElement, type MouseEvent } from 'react';
import { GitPullRequest, Globe, Link2, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  MAX_STATUS_QUERIES,
  parseSessionPrUrl,
  prStatusKey,
  type SessionPrRef,
} from '@cindy/maker-shared';
import { usePrActions, usePrRefsForSession } from '@/contexts/PrRefsContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { sessionsStore } from '@/lib/sessionsStore';
import { getStickySessionDeviceId } from '@/features/device-link/stickySessionOrigin';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useSidebarTargetSessionId } from '@/features/cc-agent/embeddedSessionNavigation';
import { linkMenuPosition } from './linkInteraction';
import { openInSidebar } from './messageLinkActions';

export {
  activateMessageUrl,
  openUrlByPreference,
  isHtmlFilePath,
  openHtmlFileByPreference,
} from './messageLinkActions';

export interface UseOpenWithMenu {
  openAt: (x: number, y: number, url: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, url: string) => void;
  menu: ReactElement | null;
}

export function useOpenWithMenu({ sessionId }: { sessionId?: string }): UseOpenWithMenu {
  const { t } = useTranslation();
  const [state, setState] = useState<{
    x: number;
    y: number;
    url: string;
    sessionId?: string;
    owner: ReturnType<typeof getDataOwnerGeneration>;
  } | null>(null);
  const sidebarTargetSessionId = useSidebarTargetSessionId(sessionId);
  const triggerRef = useRef<HTMLElement | null>(null);
  const refs = usePrRefsForSession(sessionId ?? '');
  const { invalidateRemotePrRefs } = usePrActions();
  const adding = useRef(false);
  const [busy, setBusy] = useState(false);
  const pr = state ? parseSessionPrUrl(state.url) : null;
  const activeRefs = refs.filter(
    (ref) => ref.removedAt == null && ref.associationSource !== 'legacy',
  );
  const associatedIndex = pr
    ? activeRefs.findIndex((ref) => prStatusKey(ref) === prStatusKey(pr))
    : -1;
  const alreadyAdded = associatedIndex >= 0;
  const inHeader = alreadyAdded && associatedIndex < MAX_STATUS_QUERIES;

  async function handleAddPr(): Promise<void> {
    if (
      !sessionId ||
      !pr ||
      alreadyAdded ||
      adding.current ||
      state?.sessionId !== sessionId ||
      !isDataOwnerGenerationCurrent(state.owner)
    )
      return;
    const requestSessionId = sessionId;
    const owner = state.owner;
    const input = { sessionId: requestSessionId, action: 'add' as const, url: pr.url };
    adding.current = true;
    setBusy(true);
    setState(null);
    try {
      let session = sessionsStore.findById(requestSessionId);
      let deviceId = session?.deviceLinkDeviceId ?? getStickySessionDeviceId(requestSessionId);
      if (!deviceId && !session) {
        // Absence from the list is not proof of local ownership. Confirm the row
        // before any write; a missing/disconnected remote task must not fall back.
        session = await window.electronAPI.localDb.sessions.get(requestSessionId);
        if (!session) throw new Error('Task unavailable');
        deviceId = session.deviceLinkDeviceId ?? getStickySessionDeviceId(requestSessionId);
      }
      if (!isDataOwnerGenerationCurrent(owner)) return;
      let result: unknown;
      if (deviceId) {
        result = await window.electronAPI.deviceLink.invoke(
          deviceId,
          'git-context:pr-refs:manage',
          [input],
        );
        if (isDataOwnerGenerationCurrent(owner)) invalidateRemotePrRefs(requestSessionId);
      } else {
        result = await window.electronAPI.gitContext.managePrRefs(input);
      }
      if (isDataOwnerGenerationCurrent(owner)) {
        // Manage returns sorted rows including removed entries, unlike the refs cache.
        const visible =
          !Array.isArray(result) ||
          (result as SessionPrRef[])
            .filter((ref) => ref.removedAt == null && ref.associationSource !== 'legacy')
            .slice(0, MAX_STATUS_QUERIES)
            .some((ref) => prStatusKey(ref) === prStatusKey(pr));
        if (visible) toast.success(t('chat.markdownRenderer.prAddedToHeader'));
        else toast.info(t('chat.markdownRenderer.prSavedNotInHeader'));
      }
    } catch (error) {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      const code = extractIpcError(error)?.code;
      const key =
        code === 'ALREADY_EXISTS'
          ? 'duplicate'
          : code === 'INVALID_PARAMS'
            ? 'invalidUrl'
            : code === 'PRECONDITION_FAILED'
              ? 'verifyFailed'
              : code === 'UNSUPPORTED_CAPABILITY' || code === 'DEVICE_LINK_CHANNEL_NOT_ALLOWED'
                ? 'unsupported'
                : code === 'NOT_FOUND'
                  ? 'notFound'
                  : 'failed';
      toast.error(t(`ccAgent.gitContext.pr.manage.errors.${key}`));
    } finally {
      adding.current = false;
      setBusy(false);
    }
  }

  const openAt = (x: number, y: number, url: string): void => {
    setState({ x, y, url, sessionId, owner: getDataOwnerGeneration() });
  };
  const onContextMenu = (event: MouseEvent<HTMLElement>, url: string) => {
    event.preventDefault();
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    const { x, y } = linkMenuPosition(event);
    openAt(x, y, url);
  };

  async function handleOpenInSidebar(): Promise<void> {
    const target = state;
    setState(null);
    if (!target || !sidebarTargetSessionId) return;
    await openInSidebar(sidebarTargetSessionId, target.url, t);
  }

  async function handleOpenInDefaultBrowser(): Promise<void> {
    const target = state;
    setState(null);
    if (!target) return;
    try {
      const res = await window.electronAPI.openExternal(target.url);
      if (!res.success) toast.error(t('chat.markdownRenderer.openLinkFailed'));
    } catch {
      toast.error(t('chat.markdownRenderer.openLinkFailed'));
    }
  }

  async function handleCopyLink(): Promise<void> {
    const target = state;
    setState(null);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.url);
      toast.success(t('chat.markdownRenderer.linkCopied'));
    } catch {
      toast.error(t('chat.media.copyFailed'));
    }
  }

  const menu = (
    <DropdownMenu
      open={state !== null}
      onOpenChange={(open) => {
        if (!open) setState(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-fixed-menu-anchor
          style={{
            position: 'fixed',
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        // 同 useFileChipContextMenu:menu portal 到 body 但 React 合成事件仍沿
        // React 树冒泡,不拦会触发外层元素的 onClick。
        onClick={(e) => e.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
        }}
      >
        {sidebarTargetSessionId ? (
          <DropdownMenuItem onClick={handleOpenInSidebar}>
            <PanelRight className="mr-2 h-4 w-4" />
            {t('chat.markdownRenderer.openInSidebarBrowser')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={handleOpenInDefaultBrowser}>
          <Globe className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.openInDefaultBrowser')}
          <DropdownMenuShortcut aria-hidden>
            {t('chat.markdownRenderer.shiftClick')}
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        {sessionId && pr ? (
          <DropdownMenuItem onClick={handleAddPr} disabled={alreadyAdded || busy}>
            <GitPullRequest className="mr-2 h-4 w-4" />
            {t(
              alreadyAdded
                ? inHeader
                  ? 'chat.markdownRenderer.prAlreadyInHeader'
                  : 'chat.markdownRenderer.prAssociatedNotInHeader'
                : 'chat.markdownRenderer.addPrToHeader',
            )}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleCopyLink}>
          <Link2 className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.copyLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return { openAt, onContextMenu, menu };
}
