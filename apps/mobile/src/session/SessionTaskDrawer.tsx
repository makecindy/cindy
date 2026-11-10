import {
  cloneElement, createContext, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ComponentProps, type ReactElement, type ReactNode,
} from 'react';
import { cancelAnimation } from 'react-native-reanimated';
import { SessionListDrawer } from './SessionListDrawer';
import { NativeTaskDrawerHost, NativeHistorySlot } from './NativeResidentHistory';
import { MessageHistoryOverlay } from './RecentMessageHistories';

type DrawerProps = ComponentProps<typeof SessionListDrawer>;
type FloatingProps = DrawerProps & { overlayMounted: boolean };
type Entry = { owner: string; props: FloatingProps };
const Context = createContext<{
  publish(entry: Entry): void;
  release(owner: string): void;
} | null>(null);

/** One drawer owner outside the keyed task. Its Home survives switching tasks
 * and rotating between the column and floating native window. The task still
 * owns gesture/close/navigation state; it publishes those controls below. */
export function SessionTaskDrawerProvider({ enabled, focused, windowHeight, topInset, floatingWidth, column, children }: {
  enabled: boolean; focused: boolean; windowHeight: number; topInset: number; floatingWidth: number;
  column: ReactElement<DrawerProps>; children: ReactNode;
}) {
  const shared = enabled && !!NativeTaskDrawerHost && !!NativeHistorySlot;
  const [entry, setEntry] = useState<Entry | null>(null);
  const publish = useCallback((next: Entry) => setEntry(next), []);
  const release = useCallback((owner: string) => setEntry(current => current?.owner === owner ? null : current), []);
  const context = useMemo(() => ({ publish, release }), [publish, release]);
  // Rotation changes the docking destination immediately. Waiting for the
  // floating exit would slide this very same list away before showing it again.
  const floating = shared && entry && !column.props.persistent
    ? entry.props : null;
  const completedOwner = useRef<string | null>(null);
  useEffect(() => {
    if (!column.props.persistent || !entry?.props.overlayMounted) completedOwner.current = null;
  }, [column.props.persistent, entry]);
  const completeHandoff = useCallback(() => {
    if (!shared || !column.props.persistent || !entry?.props.overlayMounted) return;
    if (completedOwner.current === entry.owner) return;
    completedOwner.current = entry.owner;
    // Native docking has finished and the old Modal has left React ownership.
    // Complete pending navigation/accessibility cleanup exactly once, even when
    // an old route's close update arrives after this presentation handoff.
    const motion = entry.props.motion;
    if (motion) {
      cancelAnimation(motion.progress);
      cancelAnimation(motion.dragX);
      motion.tracking.value = false;
      motion.settling.value = false;
      motion.progress.value = 0;
      motion.dragX.value = 0;
    }
    entry.props.onClosed?.();
  }, [shared, column.props.persistent, entry]);
  let props: DrawerProps = {
    ...column.props,
    ...(!column.props.persistent && shared ? { width: floatingWidth, aboveSystemBar: true } : {}),
  };
  if (floating) {
    const { overlayMounted: _overlayMounted, ...drawer } = floating;
    props = { ...drawer, persistent: false };
  }
  // Blur pauses Home through its navigation focus boundary; it must not move
  // Home out of its native host while the departing screen is still visible.
  const retainedHeight = useRef(Math.max(1, windowHeight - (props.topInset ?? topInset)));
  if (focused) retainedHeight.current = Math.max(1, windowHeight - (props.topInset ?? topInset));
  // Without sharing, only the persistent column belongs to this layout. A closed
  // one would publish to the root presentation on every layout render and cover
  // the route-owned floating drawer (e.g. while its edge is being dragged).
  const drawer = shared ? cloneElement(column, {
    ...props,
    onColumnReady: completeHandoff,
    retainedHeight: retainedHeight.current,
  }) : column.props.persistent ? column : null;
  return <Context.Provider value={shared ? context : null}>
    {children}
    <MessageHistoryOverlay enabled={false}>{drawer}</MessageHistoryOverlay>
  </Context.Provider>;
}

/** Publish only actual drawer prop changes, never every message/token render.
 * Other devices and older binaries keep their original route-local drawer. */
export const SessionFloatingDrawer = memo(function SessionFloatingDrawer(props: FloatingProps) {
  const context = useContext(Context);
  const owner = useId();
  useLayoutEffect(() => { context?.publish({ owner, props }); }, [context, owner, props]);
  useLayoutEffect(() => () => context?.release(owner), [context, owner]);
  if (context) return null;
  const { overlayMounted: _overlayMounted, ...drawer } = props;
  return <SessionListDrawer {...drawer} />;
});
