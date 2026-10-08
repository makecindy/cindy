import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatInviteDialog } from './ChatInviteDialog';

// An invitation is a navigation intent, not account data. Keep only its target
// in memory through login/owner remounts; every new dialog re-previews as the
// current account and still requires explicit acceptance.
let pending: readonly string[] = [];
const listeners = new Set<() => void>();
const getSnapshot = () => pending;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function requestChatInvite(token: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || pending.includes(token)) return;
  pending = [...pending, token];
  for (const listener of listeners) listener();
}

function dismiss(token: string): void {
  pending = pending.filter(value => value !== token);
  for (const listener of listeners) listener();
}

/** One confirmation at a time, regardless of which page received the deep link. */
export function ChatInviteHost() {
  const [token] = useSyncExternalStore(subscribe, getSnapshot);
  const navigate = useNavigate();
  return token ? <ChatInviteDialog key={token} initialLink={`cindy://chat-invite/${token}`}
    onClose={() => dismiss(token)}
    onJoined={id => navigate(`/bots/groups/${encodeURIComponent(id)}`)} /> : null;
}
