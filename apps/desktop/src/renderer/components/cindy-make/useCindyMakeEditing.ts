import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Carry an explicit History → Continue choice into this visit, then consume it. */
export function useCindyMakeEditing(sessionId: string | undefined, enabled: boolean) {
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState<{ sessionId: string; messageId: string }>();
  const intent = location.state?.cindyMakeEditing;
  const navigationId =
    enabled &&
    sessionId &&
    intent?.sessionId === sessionId &&
    typeof intent.completionId === 'string' &&
    intent.completionId.length > 0
      ? intent.completionId
      : undefined;
  useEffect(() => {
    if (!sessionId || !navigationId) return;
    setEditing({ sessionId, messageId: navigationId });
    navigate(`${location.pathname}${location.search}`, {
      replace: true,
      state: { ...location.state, cindyMakeEditing: undefined },
    });
  }, [sessionId, navigationId, location.pathname, location.search, location.state, navigate]);
  return {
    dismissedId: enabled
      ? (navigationId ?? (editing?.sessionId === sessionId ? editing?.messageId : undefined))
      : undefined,
    continueEditing: (messageId: string) => {
      if (enabled && sessionId) setEditing({ sessionId, messageId });
    },
  };
}
