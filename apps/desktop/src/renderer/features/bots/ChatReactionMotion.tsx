import { useLayoutEffect, useRef } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import thumbsUp from '@/assets/chat-reactions/thumbs-up.webp';
import heart from '@/assets/chat-reactions/heart.webp';
import laugh from '@/assets/chat-reactions/laugh.webp';
import party from '@/assets/chat-reactions/party.webp';
import eyes from '@/assets/chat-reactions/eyes.webp';
import thanks from '@/assets/chat-reactions/thanks.webp';
import type { ReactionGesture } from './useChatReactions';
import './ChatReactionMotion.css';

const strips: Record<string, string> = { '👍': thumbsUp, '❤️': heart, '😂': laugh, '🎉': party, '👀': eyes, '🙏': thanks };

export function ReactionGlyph({ emoji, play = false }: { emoji: string; play?: boolean }) {
  const src = window.electronAPI?.platform === 'darwin' ? undefined : strips[emoji];
  return <span aria-hidden className="chat-reaction-glyph" data-playing={play || undefined}>
    {!play && <span className={src ? 'invisible' : undefined}>{emoji}</span>}
    {src ? <span className="chat-reaction-strip" style={{ backgroundImage: `url(${src})` }} />
      : play && <span className="chat-reaction-fallback" data-glyph={emoji} />}
  </span>;
}

export function ReactionBadgeGlyph({ emoji, gesture, onFinish }: {
  emoji: string; gesture?: ReactionGesture; onFinish?: (gesture: ReactionGesture) => void;
}) {
  return <span className="relative inline-flex">
    <ReactionGlyph emoji={emoji} />
    {gesture?.emoji === emoji && onFinish && <ChatReactionMotion gesture={gesture} onFinish={onFinish} />}
  </span>;
}

function ChatReactionMotion({ gesture, onFinish }: { gesture: ReactionGesture; onFinish: (gesture: ReactionGesture) => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  useLayoutEffect(() => {
    if (reduced) { onFinish(gesture); return; }
    const node = anchor.current;
    if (!node || !gesture.from) return;
    const rect = node.getBoundingClientRect();
    node.style.setProperty('--flight-x', `${gesture.from.x - rect.left - rect.width / 2}px`);
    node.style.setProperty('--flight-y', `${gesture.from.y - rect.top - rect.height / 2}px`);
  }, [gesture, onFinish, reduced]);
  if (reduced) return null;
  return <span ref={anchor} aria-hidden className="chat-reaction-anchor">
    <span className="chat-reaction-flight" data-from-picker={gesture.from ? '' : undefined}>
      <span className="chat-reaction-landing" onAnimationEnd={event => {
        if (event.target === event.currentTarget) onFinish(gesture);
      }}>
        <ReactionGlyph emoji={gesture.emoji} play />
      </span>
    </span>
  </span>;
}
