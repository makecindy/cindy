import { createPortal } from 'react-dom';
import type { ComponentProps } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { setHeaderProjectMenu, type HeaderProjectMenu } from '@/state/headerProjectMenu';
import { ProjectMenuItems } from './sections/ProjectNode';

export function HeaderProjectDropdown({
  request,
  ...props
}: ComponentProps<typeof ProjectMenuItems> & { request: HeaderProjectMenu }) {
  const rect = request.anchor.getBoundingClientRect();
  return createPortal(
    <DropdownMenu
      open
      onOpenChange={(open) => {
        if (!open) setHeaderProjectMenu(null);
      }}
    >
      <DropdownMenuTrigger asChild>
        <span
          aria-hidden
          style={{ position: 'fixed', left: rect.left, top: rect.bottom, pointerEvents: 'none' }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={2}
        className="min-w-[160px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (request.anchor.isConnected && document.activeElement === document.body)
            request.anchor.focus();
        }}
      >
        <ProjectMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>,
    document.body,
  );
}
