import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { BotAvatarProps } from './BotAvatar';

export type GroupMaskTrigger = 'scheduled' | 'manual' | 'always';
export interface GroupMaskSettings {
  access?: 'chat' | 'tools';
  companionId: string | null;
  enabled: boolean;
  trigger: GroupMaskTrigger;
  start: string;
  end: string;
  resumeMinutes: number;
  collectTodos: boolean;
  digest: 'daily' | 'manual';
}
export type GroupMaskStatus = 'unbound' | 'off' | 'offline' | 'paused' | 'waiting' | 'enabled';
export type GroupMaskIdentity = BotAvatarProps['bot'] & { id: string };
export const maskIdentity = (value: { id: string; name: string; avatarUrl: string | null }): GroupMaskIdentity => ({
  ...value, avatar: value.avatarUrl ?? '', avatarColor: 'violet',
});

export interface GroupMaskMention {
  messageId: string;
  threadRootId?: string;
  authorName: string;
  text: string;
  reply?: { companion: GroupMaskIdentity; text: string };
}

/** Presentation contract only. No local setting can authorize sending as a member.
 * A host adapter must own persistence, identity, cancellation and execution before
 * enabling this surface in real rooms. GroupMaskProvider supplies the server adapter.
 */
export interface GroupMaskPresentation {
  groupId: string;
  self: GroupMaskIdentity;
  companions: readonly GroupMaskIdentity[];
  settings: GroupMaskSettings;
  status: GroupMaskStatus;
  toolAccessSupported?: boolean;
  saving: boolean;
  error: boolean;
  loading: boolean;
  update: (patch: Partial<GroupMaskSettings>) => void;
  retry: () => void;
  participate: () => void;
  resume: () => void;
  stopManual: () => void;
  manualRunning: boolean;
  /** Author attribution is immutable per message, independent of today's binding. */
  attributions: Readonly<Record<string, { self: GroupMaskIdentity; companion: GroupMaskIdentity }>>;
  /** Human unread state is separate from companion processing/reply progress. */
  unreadMentions: readonly GroupMaskMention[];
  markMentionsRead: (messageIds?: readonly string[]) => void;
  requestDigest?: () => void;
  digestStatus?: 'idle' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'empty';
}

export const GroupMaskContext = createContext<GroupMaskPresentation | null>(null);
export function useGroupMask(groupId?: string) {
  const value = useContext(GroupMaskContext);
  return value && (!groupId || value.groupId === groupId) ? value : null;
}
export const GROUP_MASK_SETTINGS_PARAM = 'groupMask';

/** A human navigation acknowledges only the original that actually becomes visible. */
export function useReadLocatedMention(groupId: string) {
  const mask = useGroupMask(groupId);
  const maskRef = useRef(mask); maskRef.current = mask;
  const [located, setLocated] = useState<{ groupId: string; messageId: string; element: HTMLElement } | null>(null);
  useEffect(() => {
    if (!located || located.groupId !== groupId || typeof IntersectionObserver === 'undefined') return;
    let visible = false, done = false;
    const acknowledge = () => {
      if (done || !visible || !located.element.isConnected || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      done = true;
      const current = maskRef.current;
      if (current?.unreadMentions.some(entry => entry.messageId === located.messageId)) current.markMentionsRead([located.messageId]);
      setLocated(null);
    };
    const observer = new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRect.height > 0);
      acknowledge();
    });
    observer.observe(located.element);
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => {
      observer.disconnect();
      window.removeEventListener('focus', acknowledge);
      document.removeEventListener('visibilitychange', acknowledge);
    };
  }, [located, groupId]);
  return useCallback((messageId: string, element: HTMLElement) => setLocated({ groupId, messageId, element }), [groupId]);
}
