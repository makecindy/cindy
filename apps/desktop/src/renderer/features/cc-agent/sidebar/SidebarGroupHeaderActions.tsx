import type { ComponentProps, ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { SidebarRightStatusIndicator } from './SidebarRightStatusIndicator';

export function SidebarGroupHeaderActions({ status, menuOpen, hasActions = true, children }: {
  status?: ComponentProps<typeof SidebarRightStatusIndicator>['kind'] | null;
  menuOpen: boolean;
  hasActions?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="group/slot ml-auto grid h-6 shrink-0 grid-cols-[max-content] items-center justify-items-end">
      {status && (
        <div className={cn(
          'col-start-1 row-start-1 flex items-center transition-opacity duration-[120ms]',
          hasActions && 'group-hover:opacity-0 group-has-[:focus-visible]/slot:opacity-0',
          hasActions && menuOpen && 'opacity-0',
        )}>
          <SidebarRightStatusIndicator kind={status} isActive={false} />
        </div>
      )}
      {/* Keep the actions in flow so revealing them never moves any click target. */}
      {hasActions && (
        <div className={cn(
          'col-start-1 row-start-1 flex h-6 items-center gap-0.5',
          !menuOpen && 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100',
        )}>
          {children}
        </div>
      )}
    </div>
  );
}
