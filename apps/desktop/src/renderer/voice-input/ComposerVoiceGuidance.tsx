import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Editor } from '@tiptap/core';
import { makerChatStore } from '@/lib/makerChatStore';
import { isComposerBlankPointerTarget } from '@/components/new-chat/composerBlankPointerFocus';
import {
  claimComposerVoiceGuidance,
  COMPOSER_VOICE_GUIDANCE_CHANGED,
} from './composerVoiceGuidanceHistory';

/** Teaching lives in the toolbar's existing gap; it never replaces task guidance. */
export function ComposerVoiceGuidance({
  editor,
  sessionId,
  eligible,
  recommendationPending = false,
  text,
}: {
  editor: Editor | null;
  sessionId?: string;
  eligible: boolean;
  text: string;
  recommendationPending?: boolean;
}) {
  const labelRef = useRef<HTMLSpanElement>(null);
  const [placement, setPlacement] = useState({ fits: false, right: 0 });
  const [intended, setIntended] = useState(false);
  const [visible, setVisible] = useState(false);
  const subscribe = useCallback(
    (listener: () => void) =>
      sessionId ? makerChatStore.subscribe(sessionId, listener) : () => {},
    [sessionId],
  );
  const getBusy = useCallback(() => {
    if (!sessionId) return true;
    const s = makerChatStore.getLightSnapshot(sessionId);
    return Boolean(
      s.agentStatus.isRunning ||
      s.isStreaming ||
      s.pendingPermission ||
      s.pendingAskUser ||
      s.pendingPlanReview ||
      s.pendingPluginSetup ||
      s.pendingIssueConfirm ||
      s.pendingInputHandoff ||
      s.pendingRenameSessionsConfirm ||
      s.pendingGhostGrantConfirm ||
      s.pendingRemoteDesktopConfirmation ||
      s.pendingQueue.length ||
      s.usageLimitWait ||
      s.credentialSwitchWait,
    );
  }, [sessionId]);
  const busy = useSyncExternalStore(subscribe, getBusy, () => true);
  const canIntend = eligible && !busy && placement.fits;
  const canShow = canIntend && !recommendationPending;
  const canIntendRef = useRef(canIntend);
  canIntendRef.current = canIntend;
  const canShowRef = useRef(canShow);
  canShowRef.current = canShow;

  useLayoutEffect(() => {
    const label = labelRef.current;
    const toolbar = label?.parentElement;
    const left = label?.previousElementSibling;
    const right = label?.nextElementSibling;
    if (!label || !toolbar || !left || !right) return;
    const measure = () => {
      const end = right.getBoundingClientRect().left;
      const fits =
        end - left.getBoundingClientRect().right >= label.getBoundingClientRect().width + 16;
      const offset = toolbar.getBoundingClientRect().right - end + 8;
      setPlacement((old) =>
        old.fits === fits && old.right === offset ? old : { fits, right: offset },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const node of [toolbar, left, right, label]) observer.observe(node);
    return () => observer.disconnect();
  }, [text]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    setIntended(false);
    setVisible(false);
    const dom = editor.view.dom;
    const card = dom.closest('[data-split-group-composer-drop-target]');
    if (!card) return;
    let tabNavigation = false;
    const dismiss = () => {
      setIntended(false);
      setVisible(false);
    };
    const keydown = (event: KeyboardEvent) => {
      tabNavigation = event.key === 'Tab';
      if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) dismiss();
    };
    const pointerdown = () => {
      tabNavigation = false;
      dismiss();
    };
    const pointerup = (event: PointerEvent) => {
      if (event.button !== 0 || !editor.isFocused || !canIntendRef.current) return;
      if (
        (event.target instanceof Element && dom.contains(event.target)) ||
        isComposerBlankPointerTarget(event.target, card, dom, event)
      )
        setIntended(true);
    };
    const focus = () => {
      if (tabNavigation && canIntendRef.current) setIntended(true);
      tabNavigation = false;
    };
    const hidden = () => {
      if (document.hidden) dismiss();
    };
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('pointerdown', pointerdown, true);
    card.addEventListener('pointerup', pointerup as EventListener);
    dom.addEventListener('focus', focus);
    dom.addEventListener('blur', dismiss);
    dom.addEventListener('beforeinput', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener(COMPOSER_VOICE_GUIDANCE_CHANGED, dismiss);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('keydown', keydown, true);
      window.removeEventListener('pointerdown', pointerdown, true);
      card.removeEventListener('pointerup', pointerup as EventListener);
      dom.removeEventListener('focus', focus);
      dom.removeEventListener('blur', dismiss);
      dom.removeEventListener('beforeinput', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener(COMPOSER_VOICE_GUIDANCE_CHANGED, dismiss);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [editor, sessionId]);

  useEffect(() => {
    if (!canShow) {
      setVisible(false);
      return;
    }
    if (!intended) return;
    let hide: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      if (
        !editor?.isFocused ||
        document.hidden ||
        !canShowRef.current ||
        !claimComposerVoiceGuidance()
      )
        return;
      setVisible(true);
      hide = setTimeout(() => {
        setVisible(false);
        setIntended(false);
      }, 5_000);
    }, 2_000);
    return () => {
      clearTimeout(timer);
      clearTimeout(hide);
    };
  }, [canShow, intended, editor, sessionId]);

  return (
    <span
      ref={labelRef}
      data-testid="composer-voice-guidance"
      data-visible={visible && canShow ? 'true' : 'false'}
      aria-hidden={!visible || !canShow}
      className="pointer-events-none absolute top-1/2 -translate-y-1/2 whitespace-nowrap text-12 text-[var(--text-tertiary)] transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] motion-reduce:transition-none"
      style={{ right: placement.right, opacity: visible && canShow ? 1 : 0 }}
    >
      {text}
    </span>
  );
}
