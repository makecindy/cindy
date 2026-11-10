/** The quota reveal keeps its anchor and trigger semantics, using the shared small burst. */
import { useLayoutEffect, useRef, useState } from 'react';
import { ConfettiBurst } from '../ui/ConfettiBurst';

interface QuotaResetConfettiProps {
  anchor: HTMLElement;
  onDone: () => void;
}

export function QuotaResetConfetti({ anchor, onDone }: QuotaResetConfettiProps) {
  const [origin, setOrigin] = useState<{ x: number; y: number } | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useLayoutEffect(() => {
    if (!anchor.isConnected) {
      onDoneRef.current();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setOrigin({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [anchor]);
  return origin ? (
    <ConfettiBurst origin={origin} preset="quota" zIndex={9999} onDone={onDone} />
  ) : null;
}
