export interface LayoutPreviewOwner {
  id: number;
  once(event: 'destroyed' | 'render-process-gone', listener: () => void): void;
}

export function createLayoutPreviewLease(
  setActive: (active: boolean) => void,
  onOwnerGone?: () => void,
) {
  let ownerId: number | null = null;

  const releaseIfOwner = (id: number): void => {
    if (ownerId !== id) return;
    ownerId = null;
    setActive(false);
    onOwnerGone?.();
  };

  return {
    setActive(active: boolean, owner: LayoutPreviewOwner | null): void {
      if (active) {
        if (!owner) return;
        if (ownerId === owner.id) return;
        ownerId = owner.id;
        setActive(true);
        const release = (): void => releaseIfOwner(owner.id);
        owner.once('destroyed', release);
        owner.once('render-process-gone', release);
        return;
      }
      if (ownerId !== null && owner && owner.id !== ownerId) return;
      ownerId = null;
      setActive(false);
    },
  };
}

export function layoutPreviewOwnerFromEvent(event: unknown): LayoutPreviewOwner | null {
  if (!event || typeof event !== 'object' || !('sender' in event)) return null;
  const sender = (event as { sender?: Partial<LayoutPreviewOwner> }).sender;
  if (!sender || typeof sender.id !== 'number' || typeof sender.once !== 'function') return null;
  return sender as LayoutPreviewOwner;
}
