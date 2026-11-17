import { useCallback, useEffect, useRef, useState } from 'react';

/** Shared focus handoff after dragging a collapsed composer open. */
export function useComposerDragOpen(composerFocused: boolean, focus: () => void) {
  const focusRef = useRef(focus);
  focusRef.current = focus;
  // 收起态往上拖拉开：拖动中保持卡片态让输入区跟手拉高；松手拉够了就聚焦，
  // 焦点到达（或兜底超时，聚焦被拒）后交还给 composerFocused。
  const [composerDragOpen, setComposerDragOpen] = useState(false);
  const composerDragOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearComposerDragOpenTimer = useCallback(() => {
    if (composerDragOpenTimerRef.current) clearTimeout(composerDragOpenTimerRef.current);
    composerDragOpenTimerRef.current = null;
  }, []);
  useEffect(() => clearComposerDragOpenTimer, [clearComposerDragOpenTimer]);
  const handleComposerDragOpenChange = useCallback((opening: boolean) => {
    clearComposerDragOpenTimer();
    setComposerDragOpen(opening);
  }, [clearComposerDragOpenTimer]);
  const handleComposerDragOpenCommit = useCallback(() => {
    clearComposerDragOpenTimer();
    focusRef.current();
    composerDragOpenTimerRef.current = setTimeout(() => {
      composerDragOpenTimerRef.current = null;
      setComposerDragOpen(false);
    }, 800);
  }, [clearComposerDragOpenTimer]);
  useEffect(() => {
    if (!composerFocused) return;
    clearComposerDragOpenTimer();
    setComposerDragOpen(false);
  }, [clearComposerDragOpenTimer, composerFocused]);
  return { composerDragOpen, handleComposerDragOpenChange, handleComposerDragOpenCommit };
}
