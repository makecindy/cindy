import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import { draftHasContent, flushDraft, getDraft } from '@/lib/composerDraftStore';
import { makerChatStore } from '@/lib/makerChatStore';
import { getSessionDeviceId } from '@/features/device-link/remoteProjectsStore';

export function hasDagTargetDraft(id: string) {
  flushDraft(id);
  const draft = getDraft(id);
  return Boolean(draftHasContent(draft) || draft?.pendingGhostId || draft?.botGroupEdit || draft?.builtInSkillIntent);
}

type SendOptions = {
  literalText: true;
  independent: true;
  slashCommandRanges: [];
  isTargetCurrent: () => boolean;
  beforeEnqueue: () => Promise<boolean>;
  onInputCreated: (id: string) => void;
  onRemoteOptimisticFailure: () => void;
  expectedDagTip?: { answerId: string; userMessageId: string };
};
type NativeSend = (text: string, options: SendOptions) => Promise<boolean | void>;
type Target = Pick<Session, 'id' | 'userId' | 'parentSessionId' | 'forkedAtMessageId' | 'deviceLinkDeviceId' | 'remoteHostId'>;
type Receipt = 'accepted' | 'unknown' | 'rejected';

// A one-shot handoff to this workspace's child pane, never a global/current-chat sender.
export function createDagChildSend(target: Target, text: string, current: () => boolean,
  tip?: { answerId: string; userMessageId: string; stillIdleTip: (ownInput?: string) => Promise<boolean> }) {
  let settle!: (value: Receipt) => void;
  const receipt = new Promise<Receipt>(resolve => { settle = resolve; });
  let started = false, finished = false, admitted = false;
  let clientId: string | undefined;
  let unsubscribe: (() => void) | undefined;
  const finish = (value: Receipt) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    unsubscribe?.();
    settle(value);
  };
  const cancel = () => finish(admitted || (clientId && target.deviceLinkDeviceId) ? 'unknown' : 'rejected');
  let timer = setTimeout(cancel, 15_000);
  function start(session: Session, writable: () => boolean, send: NativeSend) {
    if (finished || started || session.id !== target.id) return;
    started = true;
    clearTimeout(timer);
    timer = setTimeout(cancel, 60_000);
    const valid = () => !finished && current() && writable() && session.userId === target.userId &&
      (session.parentSessionId ?? null) === (target.parentSessionId ?? null) && (session.forkedAtMessageId ?? null) === (target.forkedAtMessageId ?? null) &&
      (session.remoteHostId ?? null) === (target.remoteHostId ?? null) &&
      session.deviceLinkDeviceId === target.deviceLinkDeviceId && getSessionDeviceId(session.id) === target.deviceLinkDeviceId &&
      !hasDagTargetDraft(session.id);
    const observe = () => {
      if (!clientId || !current() || getSessionDeviceId(session.id) !== target.deviceLinkDeviceId) return;
      const row = makerChatStore.getSnapshot(session.id);
      if (row.pendingQueue.some(q => q.clientId === clientId && !q.isPendingEnqueue) ||
          row.messages.some(m => m.role === 'user' && m.clientId === clientId && !m.isPendingPersist)) finish('accepted');
    };
    void (async () => {
      if (!valid()) return finish('rejected');
      if (target.deviceLinkDeviceId) unsubscribe = makerChatStore.subscribe(session.id, observe);
      const result = await send(text, {
        literalText: true, independent: true, slashCommandRanges: [], isTargetCurrent: valid,
        ...(tip && { expectedDagTip: {answerId:tip.answerId, userMessageId:tip.userMessageId} }),
        beforeEnqueue: async () => {
          const ok = valid() && (!tip || !clientId || (await tip.stillIdleTip(clientId)) && valid());
          if (ok && clientId) admitted = true;
          return ok;
        },
        onInputCreated: id => { clientId = id; },
        onRemoteOptimisticFailure: cancel,
      });
      if (finished) return;
      if (result === true && current() && getSessionDeviceId(session.id) === target.deviceLinkDeviceId) {
        if (!clientId) finish('unknown');
        else if (!target.deviceLinkDeviceId) finish('accepted');
        else observe(); // Local outbox acceptance alone is not a remote receipt.
      } else if (result === false && tip) finish('rejected'); // Guarded local enqueue returns false only on an explicit refusal.
      else if (result === false) cancel(); // An IPC error after final admission can mean a lost reply.
      else finish('unknown');
    })().catch(() => finish('unknown'));
  }
  return { id: target.id, receipt, start, cancel, get userMessageId() { return clientId; } };
}
export type DagChildSend = ReturnType<typeof createDagChildSend>;

/** Only mount after the intended native view has resolved its own session and history. */
export function DagChildSendBridge({ request, session, writable, send }: {
  request: DagChildSend; session: Session; writable: boolean; send: NativeSend;
}) {
  const allowed = useRef(false);
  useLayoutEffect(() => {
    allowed.current = writable;
    return () => { allowed.current = false; };
  }, [request, session, writable]);
  useEffect(() => { request.start(session, () => allowed.current, send); }, [request, session, send]);
  return null;
}
