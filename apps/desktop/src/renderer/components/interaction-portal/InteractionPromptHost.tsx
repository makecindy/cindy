/**
 * InteractionPromptHost — wrap your interaction cards (Permission / AskUser
 * / Plan) with this. If a `<InteractionPromptSlot />` is mounted elsewhere
 * AND `hasInteraction` is truthy, the children get portaled to the slot and
 * the `placeholder` is rendered in-place instead. Otherwise children render
 * inline, unchanged from before this component existed.
 *
 * Why hasInteraction is a separate prop (rather than checking children !=
 * null): the cards themselves are wrapped in conditionals at the call site
 * (`pendingPlanReview ? <PlanViewerCard/> : pendingPermission ? ...`). Even
 * with no pending interaction, `children` is technically a non-null React
 * fragment containing the falsey ternary tail. Forwarding ALL of that to
 * the portal is wasteful (creates an empty slot div on screen). Letting the
 * caller pass an explicit `hasInteraction` flag keeps the gate cheap.
 */

import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { useInteractionPromptSlot } from './useInteractionPromptSlot';

export interface InteractionPromptHostProps {
  /**
   * True when there's a pending interaction request. Drives both portal
   * activation and visibility of `placeholder`. When false, children render
   * inline regardless of slot presence.
   */
  hasInteraction: boolean;
  /** The card(s) to render — typically a `pending* ? <Card/> : ...` chain. */
  children: ReactNode;
  /**
   * Rendered in-place when the cards have been portaled out. Use this to
   * tell the user "your input went elsewhere" — e.g. "等待你在文档区回复…".
   * Optional; if omitted, the inline render slot becomes empty when portaling.
   */
  placeholder?: ReactNode;
}

export function InteractionPromptHost({
  hasInteraction,
  children,
  placeholder,
}: InteractionPromptHostProps) {
  // 模块级 slot 信号(useSyncExternalStore,并发渲染安全)。返回 HTMLElement | null。
  const slot = useInteractionPromptSlot();

  if (!hasInteraction || !slot) {
    return <>{children}</>;
  }

  return (
    <>
      {createPortal(children, slot)}
      {placeholder ?? null}
    </>
  );
}
