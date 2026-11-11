import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';

/** Mounted only while a local task's permission menu is open. No polling or automatic retry. */
export function PluginWriteAccessRecovery({ sessionId, onGranted }: {
  sessionId: string;
  onGranted?: (mode: 'acceptEdits' | 'auto') => void;
}) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(false);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    let active = true;
    mounted.current = true;
    setAvailable(false);
    void window.electronAPI.maker.getPluginWriteAccessRecovery(sessionId)
      .then(result => { if (active) setAvailable(result.available); })
      .catch(() => { if (active) setAvailable(false); });
    return () => { active = false; mounted.current = false; };
  }, [sessionId]);
  if (!available) return null;
  return <Button variant="secondary" tone="quiet" className="mt-1 w-full justify-start" disabled={pending} onClick={async () => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    try {
      const result = await window.electronAPI.maker.retryPluginWriteAccess(sessionId);
      if (!mounted.current) return;
      if (result.granted && result.mode) {
        setAvailable(false);
        onGranted?.(result.mode);
      }
    } catch {
      if (mounted.current) toast.error(t('newChat.chatInput.permissionSwitchFailed'));
    } finally {
      busy.current = false;
      if (mounted.current) setPending(false);
    }
  }}>{t('newChat.chatInput.retryPluginWriteAccess')}</Button>;
}
