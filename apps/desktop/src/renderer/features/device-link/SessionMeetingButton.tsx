import { useCallback, useEffect, useRef, useState } from 'react';
import { Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { parseMeetingPeer, SESSION_MEETING_HOST_CHANNEL, type SessionMeetingDetail, type SessionMeetingHostCommand, type SessionMeetingHostState } from '@cindy/device-link';
import type { Session } from '@/lib/ccAgent.types';
import { useAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import { sessionMeetingErrorKey } from './sessionMeetingCompatibility';

/** Owner controls use the same task host locally and through own-device control. */
export function SessionMeetingButton({ session }: { session: Session }) {
  const { t } = useTranslation();
  const { dataOwnerId } = useAuth();
  const ownerGeneration = getDataOwnerGeneration().generation;
  const peer = session.deviceLinkDeviceId ? parseMeetingPeer(session.deviceLinkDeviceId) : null;
  const guestMeetingId = peer?.role === 'host' ? peer.meetingId : undefined;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SessionMeetingHostState | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const epoch = useRef(0);
  const host = useCallback((command: SessionMeetingHostCommand) => session.deviceLinkDeviceId
    ? window.electronAPI.deviceLink.invoke(session.deviceLinkDeviceId, SESSION_MEETING_HOST_CHANNEL, [command])
    : window.electronAPI.sessionMeeting.host(command), [session.deviceLinkDeviceId]);
  const load = useCallback(async (captured: number) => {
    const owner = getDataOwnerGeneration();
    try {
      const result: SessionMeetingHostState = guestMeetingId
        ? { available: true, detail: await window.electronAPI.sessionMeeting.account({ action: 'get', meetingId: guestMeetingId }) as SessionMeetingDetail }
        : await host({ action: 'state', sessionId: session.id }) as SessionMeetingHostState;
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) setState(result);
    } catch (error) {
      if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)
          && sessionMeetingErrorKey(error) === 'sessionMeeting.upgrade') {
        setState({ available: false, detail: null });
      }
    }
  }, [guestMeetingId, host, session.id]);
  useEffect(() => {
    const captured = ++epoch.current;
    setState(null);
    pending.current = false; setBusy(false);
    void load(captured);
    if (!open) return () => { epoch.current++; };
    const timer = setInterval(() => { if (!pending.current) void load(captured); }, 5_000);
    return () => { epoch.current++; clearInterval(timer); };
  }, [dataOwnerId, ownerGeneration, load, open]);
  const run = async (work: () => Promise<unknown>, reload = true) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const current = () => captured === epoch.current && isDataOwnerGenerationCurrent(owner);
    try { await work(); if (reload && current()) await load(captured); }
    catch (error) { if (current()) toast.error(t(sessionMeetingErrorKey(error))); }
    finally { if (captured === epoch.current) { pending.current = false; setBusy(false); } }
  };
  const detail = state?.detail?.status === 'active' ? state.detail : null;
  const invite = () => run(async () => {
    const captured = epoch.current;
    const owner = getDataOwnerGeneration();
    const result = await host({ action: 'invite', meetingId: detail!.meetingId }) as { invitation: string };
    if (captured !== epoch.current || !isDataOwnerGenerationCurrent(owner)) return;
    await navigator.clipboard.writeText(result.invitation);
    if (captured === epoch.current && isDataOwnerGenerationCurrent(owner)) toast.success(t('sessionMeeting.invitationCopied'));
  });
  return <Popover open={open} onOpenChange={(next) => { if (!pending.current) setOpen(next); }}>
    <PopoverTrigger asChild>
      <Button variant="secondary" style={WINDOW_NO_DRAG_STYLE} className="ml-2 gap-1.5 px-3" aria-label={t('sessionMeeting.title')}>
        <Users size={14} />{detail ? detail.guests.length + 1 : t('sessionMeeting.title')}
      </Button>
    </PopoverTrigger>
    <PopoverContent className="w-80 max-w-[calc(100vw-32px)] rounded-xl border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)] shadow-none"
      onEscapeKeyDown={(event) => { if (pending.current) event.preventDefault(); }}
      onInteractOutside={(event) => { if (pending.current) event.preventDefault(); }}>
      <div className="space-y-3 text-13">
        <h2 className="font-medium">{t('sessionMeeting.title')}</h2>
        {!state ? <p className="text-[var(--text-secondary)]">{t('sessionMeeting.sharing')}</p>
          : !state.available ? <p className="text-[var(--text-secondary)]">{t('sessionMeeting.upgrade')}</p>
          : !detail && !guestMeetingId ? <>
            <p className="text-[var(--text-secondary)]">{t('sessionMeeting.sharing')}</p>
            <Button loading={busy} onClick={() => void run(() => host({ action: 'open', sessionId: session.id }))}>{t('sessionMeeting.open')}</Button>
          </> : detail ? <>
            <p className="text-[var(--text-secondary)]">{t('sessionMeeting.members', { count: detail.guests.length + 1 })}</p>
            <div>{t('sessionMeeting.host')}</div>
            {detail.guests.map((member) => <div key={member.memberId} className="flex items-center justify-between gap-2">
              <span className="min-w-0 break-words">{detail.memberLabels.find((label) => label.memberId === member.memberId)?.displayName ?? member.accountId}</span>
              {!guestMeetingId && <Button variant="secondary" disabled={busy} className="shrink-0 px-3" onClick={() => void run(() => host({ action: 'remove', meetingId: detail.meetingId, memberId: member.memberId }))}>{t('sessionMeeting.remove')}</Button>}
            </div>)}
            <div className="flex flex-wrap gap-2 border-t border-[var(--border-default)] pt-3">
              {guestMeetingId ? <Button disabled={busy} onClick={() => void run(async () => { await window.electronAPI.sessionMeeting.account({ action: 'leave', meetingId: guestMeetingId }); setOpen(false); }, false)}>{t('sessionMeeting.leave')}</Button> : <>
                <Button disabled={busy || detail.guests.length >= 3} onClick={() => void invite()}>{t('sessionMeeting.invite')}</Button>
                <Button variant="secondary" disabled={busy} onClick={() => void run(() => host({ action: 'close', meetingId: detail.meetingId }))}>{t('sessionMeeting.close')}</Button>
              </>}
            </div>
          </> : <p>{t('sessionMeeting.notJoined')}</p>}
      </div>
    </PopoverContent>
  </Popover>;
}
