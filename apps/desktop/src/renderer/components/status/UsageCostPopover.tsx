import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useUsageCostDetails } from '@/hooks/useUsageCostDetails';
import { UsageCostDetails } from './UsageCostDetails';

/** Hover previews and a click pins the same panel, including on touch devices. */
export function UsageCostPopover({
  sessionId,
  clientId,
  label,
  className,
  fallback,
}: {
  sessionId?: string;
  clientId?: string;
  label: ReactNode;
  className?: string;
  fallback?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressFocus = useRef(false);
  const rows = useUsageCostDetails(sessionId, open, clientId);
  const clear = () => clearTimeout(timer.current);
  const close = () => {
    clear();
    pinned.current = false;
    setOpen(false);
  };
  const leave = () => {
    clear();
    if (!pinned.current) timer.current = setTimeout(() => setOpen(false), 220);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(close, [sessionId, clientId]);
  return (
    <Popover
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={className}
          onPointerEnter={(e) => {
            if (e.pointerType === 'mouse') {
              clear();
              timer.current = setTimeout(() => setOpen(true), 250);
            }
          }}
          onPointerLeave={leave}
          onFocus={() => {
            if (!suppressFocus.current) setOpen(true);
          }}
          onBlur={leave}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            clear();
            pinned.current = true;
            setOpen(true);
          }}
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-[calc(100vw-24px)] max-h-[min(70vh,520px)] overflow-y-auto"
        onPointerEnter={clear}
        onPointerLeave={leave}
        onFocusCapture={clear}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={() => {
          suppressFocus.current = true;
          queueMicrotask(() => {
            suppressFocus.current = false;
          });
        }}
      >
        {sessionId ? (
          <>
            <UsageCostDetails rows={rows} />
            {fallback ? (
              <div className="mt-3 border-t pt-3 text-12 text-[var(--text-secondary)]">
                {fallback}
              </div>
            ) : null}
          </>
        ) : (
          fallback
        )}
      </PopoverContent>
    </Popover>
  );
}
