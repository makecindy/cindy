import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard } from 'react-native';
import { useRouter } from 'expo-router';
import { useIsFocused } from 'expo-router/react-navigation';
import { remoteSessionStore } from './remoteSessionStore';
import { goBackGuarded } from '@/utils/backGuard';

/** Follow-ups use the ordinary task page. Keep deletion handling independent of
 * presentation, without introducing a second message host or keyboard layout. */
export function SideChatTaskBoundary({ children, deviceId, sessionId, enabled }: {
  children: ReactNode;
  deviceId: string;
  sessionId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const focused = useIsFocused();
  const [removed, setRemoved] = useState(false);
  const returned = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    return remoteSessionStore.onSessionRemoved((ownerDeviceId, removedSessionId) => {
      if (ownerDeviceId === deviceId && removedSessionId === sessionId) setRemoved(true);
    });
  }, [deviceId, enabled, sessionId]);
  useEffect(() => {
    // A hidden route waits for focus so deletion never pops a different screen.
    if (!focused || !removed || returned.current) return;
    returned.current = true;
    Keyboard.dismiss();
    goBackGuarded(router);
  }, [focused, removed, router]);
  return removed ? null : children;
}
