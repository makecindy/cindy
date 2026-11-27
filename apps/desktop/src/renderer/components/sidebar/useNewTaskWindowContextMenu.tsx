import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import { AppWindow } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { linkMenuPosition } from '@/components/chat/linkInteraction';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import { getSidebarNewWindowShortcutKey } from '@/lib/sidebarNewWindowActivation';

// Native window dragging ignores a portal's z-index. Keep the menu surface
// below the 46px titlebar / 50px invisible drag strip, including collision shifts.
const NEW_TASK_MENU_COLLISION_PADDING = { top: 58, right: 8, bottom: 8, left: 8 };

/**
 * Shared right-click / keyboard context menu for the left-sidebar New button
 * (both expanded row and collapsed rail button).
 */
export function useNewTaskWindowContextMenu(onOpenInNewWindow: () => void): {
  menuOpen: boolean;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  contextMenu: ReactElement;
} {
  const { t } = useTranslation();
  const openInNewWindowShortcut = t(getSidebarNewWindowShortcutKey());
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const restoreFocusOnCloseRef = useRef(false);

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    restoreFocusOnCloseRef.current = false;
    setMenuPos(linkMenuPosition(event));
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    restoreFocusOnCloseRef.current = false;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPos({ x: rect.left, y: rect.bottom });
  }, []);

  const contextMenu = (
    <DropdownMenu
      open={menuPos !== null}
      onOpenChange={(open) => {
        if (!open) setMenuPos(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          data-fixed-menu-anchor=""
          style={{
            position: 'fixed',
            left: menuPos?.x ?? 0,
            top: menuPos?.y ?? 0,
            width: 0,
            height: 0,
            pointerEvents: 'none',
          }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        collisionPadding={NEW_TASK_MENU_COLLISION_PADDING}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onEscapeKeyDown={() => {
          restoreFocusOnCloseRef.current = true;
        }}
        onCloseAutoFocus={(event) => {
          if (!restoreFocusOnCloseRef.current) return;
          restoreFocusOnCloseRef.current = false;
          event.preventDefault();
          if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
        }}
      >
        <DropdownMenuItem
          className={MENU_ITEM_CLASS}
          onSelect={() => {
            setMenuPos(null);
            onOpenInNewWindow();
          }}
        >
          <AppWindow size={14} className="shrink-0" aria-hidden="true" />
          {t('ccAgent.sidebar.sessionMenu.openInNewWindow')}
          <DropdownMenuShortcut aria-hidden>{openInNewWindowShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return {
    menuOpen: menuPos !== null,
    onContextMenu,
    onKeyDown,
    contextMenu,
  };
}
