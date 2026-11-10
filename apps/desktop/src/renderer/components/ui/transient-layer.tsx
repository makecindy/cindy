import * as React from 'react';

const OPEN_EVENT = 'cindy:transient-layer-open';
const NO_ANCESTORS: readonly symbol[] = [];
const ParentLayers = React.createContext(NO_ANCESTORS);
export const TriggerTooltipBlocked = React.createContext(false);

type OpenProps = { open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void };
type Layer = ReturnType<typeof useTransientLayer>;
const CurrentLayer = React.createContext<Layer | null>(null);

/**
 * One active branch of transient panels per document. Only open layers listen;
 * React context carries ancestry across portals, so a child keeps its parents
 * but replaces its siblings. No page needs to enumerate its panels.
 * Dialogs are not transient panels and retain their existing lifecycle.
 */
export function useTransientLayer({
  open: controlledOpen,
  defaultOpen = false,
  onOpenChange,
}: OpenProps) {
  const [localOpen, setLocalOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? localOpen;
  const [id] = React.useState(() => Symbol('transient-layer'));
  const parents = React.useContext(ParentLayers);
  const path = React.useMemo(() => [...parents, id], [parents, id]);
  const replaced = React.useRef(false);
  const propsRef = React.useRef({ controlledOpen, onOpenChange });
  propsRef.current = { controlledOpen, onOpenChange };
  const announceOpen = React.useCallback(() => {
    document.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: path }));
  }, [path]);
  const changeOpen = React.useCallback(
    (next: boolean) => {
      if (next) {
        replaced.current = false;
        // Close before mounting/autofocusing the new panel, including pointer events
        // stopped by a message bubble. Radix retains ownership of outside click/Esc.
        announceOpen();
      }
      if (propsRef.current.controlledOpen === undefined) setLocalOpen(next);
      propsRef.current.onOpenChange?.(next);
    },
    [announceOpen],
  );

  React.useLayoutEffect(() => {
    if (!open) return;
    replaced.current = false;
    const onOtherOpen = (event: Event) => {
      const next = (event as CustomEvent<readonly symbol[]>).detail;
      if (next.includes(id) || path.includes(next[next.length - 1])) return;
      // A replaced layer must not restore focus over the new layer's autofocus.
      replaced.current = true;
      changeOpen(false);
    };
    document.addEventListener(OPEN_EVENT, onOtherOpen);
    announceOpen();
    return () => document.removeEventListener(OPEN_EVENT, onOtherOpen);
  }, [open, id, path, changeOpen, announceOpen]);

  const onCloseAutoFocus = React.useCallback((event: Event) => {
    if (replaced.current) event.preventDefault();
  }, []);
  return { open, onOpenChange: changeOpen, path, onCloseAutoFocus };
}

/** Root state also suppresses hints around its trigger, regardless of Tip/asChild ordering. */
export function TransientLayerRoot({
  layer,
  children,
}: {
  layer: Layer;
  children: React.ReactNode;
}) {
  return (
    <CurrentLayer.Provider value={layer}>
      <TriggerTooltipBlocked.Provider value={layer.open}>{children}</TriggerTooltipBlocked.Provider>
    </CurrentLayer.Provider>
  );
}

/** Panel contents establish actual nesting; tooltips inside the panel still work. */
export function TransientLayerContent({ children }: { children: React.ReactNode }) {
  const layer = React.useContext(CurrentLayer);
  const parents = React.useContext(ParentLayers);
  return (
    <ParentLayers.Provider value={layer?.path ?? parents}>
      <TriggerTooltipBlocked.Provider value={false}>{children}</TriggerTooltipBlocked.Provider>
    </ParentLayers.Provider>
  );
}

export function useTransientCloseAutoFocus(onCloseAutoFocus?: (event: Event) => void) {
  const layer = React.useContext(CurrentLayer);
  return (event: Event) => {
    layer?.onCloseAutoFocus(event);
    // Replacement must also suppress callers that focus the old trigger themselves.
    if (!event.defaultPrevented) onCloseAutoFocus?.(event);
  };
}

/** Shared primitive roots keep their original controlled/defaultOpen API. */
export function withTransientLayer<Props extends OpenProps>(Root: React.ComponentType<Props>) {
  function TransientRoot(props: Props) {
    const layer = useTransientLayer(props);
    return (
      <TransientLayerRoot layer={layer}>
        <Root {...props} open={layer.open} onOpenChange={layer.onOpenChange} />
      </TransientLayerRoot>
    );
  }
  TransientRoot.displayName = `Transient${Root.displayName ?? 'Root'}`;
  return TransientRoot;
}
