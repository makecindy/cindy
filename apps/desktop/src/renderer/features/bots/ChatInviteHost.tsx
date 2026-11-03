import { useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChatInviteDialog } from './ChatInviteDialog';

// An invitation is a navigation intent, not account data. Keep only its target
// in memory through login/owner remounts; every new dialog re-previews as the
// current account and still requires explicit acceptance.
let pending: readonly string[] = [];
/** Stands in for a clicked link whose token was unreadable; never a valid 43-character token. */
const MALFORMED = 'malformed';
const listeners = new Set<() => void>();
const getSnapshot = () => pending;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function enqueue(entry: string): void {
  if (pending.includes(entry)) return;
  pending = [...pending, entry];
  for (const listener of listeners) listener();
}

export function requestChatInvite(token: string): void {
  if (/^[A-Za-z0-9_-]{43}$/.test(token)) enqueue(token);
}

/** A clicked invitation link was truncated or altered: say so instead of ignoring the click. */
export function reportMalformedChatInvite(): void {
  enqueue(MALFORMED);
}

function dismiss(token: string): void {
  pending = pending.filter(value => value !== token);
  for (const listener of listeners) listener();
}

/** One confirmation at a time, regardless of which page received the deep link. */
export function ChatInviteHost() {
  const [token] = useSyncExternalStore(subscribe, getSnapshot);
  const navigate = useNavigate();
  if (token === MALFORMED) return <ChatInviteDialog key={token} malformedLink onClose={() => dismiss(token)} />;
  return token ? <ChatInviteDialog key={token} initialLink={`cindy://chat-invite/${token}`}
    onClose={() => dismiss(token)}
    onJoined={(id, configureMask) => navigate(`/bots/groups/${encodeURIComponent(id)}${configureMask ? '?groupSettings=1&groupMask=1' : ''}`)} /> : null;
}
