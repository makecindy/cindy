import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * For dialogs whose caller unmounts them in a completion/cancel callback. Let
 * Radix Presence finish the CSS exit before handing control back to that caller.
 * No timers: reduced motion and animation completion remain owned by Radix.
 */
export function useDialogExit(returnFocusRef?: RefObject<HTMLElement | null>) {
  const [open, setOpen] = useState(true);
  const openerRef = useRef<HTMLElement | null>(null);
  const completionRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const close = useCallback((completion: () => void) => {
    // An in-flight save can settle after the caller externally unmounted us.
    if (!mountedRef.current) { completion(); return; }
    if (completionRef.current) return;
    completionRef.current = completion;
    setOpen(false);
  }, []);

  const onOpenAutoFocus = useCallback(() => {
    openerRef.current = document.activeElement instanceof HTMLElement
      && document.activeElement !== document.body ? document.activeElement : null;
  }, []);

  const onCloseAutoFocus = useCallback((event: Event) => {
    // These dialogs have no Radix Trigger. Its default would focus a null ref.
    event.preventDefault();
    const target = openerRef.current?.isConnected ? openerRef.current : returnFocusRef?.current;
    if (target?.isConnected) target.focus({ preventScroll: true });
    const completion = completionRef.current;
    completionRef.current = null;
    completion?.();
  }, [returnFocusRef]);

  return { open, close, onOpenAutoFocus, onCloseAutoFocus };
}
