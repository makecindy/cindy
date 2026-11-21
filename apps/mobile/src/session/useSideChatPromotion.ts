import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';

/** Keep the menu action's receipt scoped to the same owner, device and task. */
export function useSideChatPromotion({ deviceId, sessionId, parentSessionId, maker, disabled, canPromote, onPromoted }: {
  deviceId: string;
  sessionId: string;
  parentSessionId: string | null | undefined;
  maker: Pick<MobileMakerTransport, 'promoteSideChat'>;
  disabled?: boolean;
  canPromote: boolean;
  onPromoted(): void;
}) {
  const { t } = useTranslation();
  const owner = getMobileAuthOwner();
  const scope = JSON.stringify([owner.accountKey, owner.generation, deviceId, sessionId, parentSessionId]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    pending.current = false;
    setBusy(false);
    setError(null);
    return () => { mounted.current = false; };
  }, [scope]);
  const promote = async () => {
    if (!canPromote || !parentSessionId || disabled || pending.current) return;
    const current = () => mounted.current && scopeRef.current === scope && isMobileAuthOwnerCurrent(owner);
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await maker.promoteSideChat(sessionId, parentSessionId);
      if (current()) onPromoted();
    } catch (err) {
      if (current()) setError(t(/CHANNEL_NOT_ALLOWED|UNSUPPORTED_CAPABILITY|No handler/.test(String(err))
        ? 'session.sideChat.unsupported' : 'session.sideChat.promoteFailed'));
    } finally {
      if (current()) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return { busy, error, promote };
}
