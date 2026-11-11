import { useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Link2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { linkMenuPosition } from './linkInteraction';

export interface LinkMenuAction {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  run: () => void | Promise<void>;
}

/** Shared open-actions → copy-link menu for message URLs and internal links. */
export function useLinkContextMenu(href: string, actions: LinkMenuAction[]) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [state, setState] = useState<{
    x: number;
    y: number;
    href: string;
    actions: LinkMenuAction[];
  } | null>(null);
  const onContextMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    setState({ ...linkMenuPosition(event), href, actions });
  };
  const run = async (action: () => void | Promise<void>) => {
    setState(null);
    try {
      await action();
    } catch {
      toast.error(t('chat.markdownRenderer.openLinkFailed'));
    }
  };
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
        onClick={(event) => event.stopPropagation()}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true });
        }}
      >
        {state?.actions.map((action) => (
          <DropdownMenuItem key={action.label} onClick={() => void run(action.run)}>
            {action.icon}
            {action.label}
            {action.shortcut ? (
              <DropdownMenuShortcut aria-hidden>{action.shortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        ))}
        {state?.actions.length ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem
          onClick={() => {
            const value = state?.href;
            setState(null);
            if (value === undefined) return;
            void navigator.clipboard.writeText(value).then(
              () => toast.success(t('chat.markdownRenderer.linkCopied')),
              () => toast.error(t('chat.media.copyFailed')),
            );
          }}
        >
          <Link2 className="mr-2 h-4 w-4" />
          {t('chat.markdownRenderer.copyLink')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return { onContextMenu, menu };
}
