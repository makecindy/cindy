import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { parseChatInvitationToken } from '@cindy/device-link';
import { parseChatInviteLink } from './chatInviteIntent';
import { useChatClient } from './useChatServer';
import type { MobileChatInvitePreview } from './chatServerClient';

export interface ChatInviteSheetProps {
  visible: boolean;
  /** Omitted for the manual paste entry; external links are read without joining. */
  link?: string;
  hasOtherInvitation?: boolean;
  /** Authentication may hide the same intent without cancelling its in-memory target. */
  retainTargetWhenHidden?: boolean;
  onTargetChange?(link?: string): void;
  onClose(): void;
  /** Delivered after native dismissal, only for the account that joined. */
  onJoined(groupId: string): void;
}
type Phase = 'input' | 'reading' | 'preview' | 'joining' | 'error';
type Failure = 'format' | 'invalid' | 'expired' | 'forbidden' | 'auth' | 'network' | 'uncertain';
type State = { owner: string; phase: Phase; preview?: MobileChatInvitePreview; error?: Failure };
function failure(error: unknown): Failure {
  const code = (error as { code?: string })?.code ?? (error instanceof Error ? error.message : '');
  if (code === 'INVALID_INVITATION_LINK') return 'format';
  if (['INVITATION_NOT_FOUND', 'INVITATION_UNAVAILABLE', 'INVALID_INPUT'].includes(code)) return 'invalid';
  if (['FORBIDDEN', 'ROLE_REQUIRED', 'OWNER_REQUIRED', 'ACTOR_NOT_OWNED', 'IDENTITY_DOMAIN_MISMATCH'].includes(code)) return 'forbidden';
  if (['AUTH_REQUIRED', 'OWNER_CHANGED', 'INVALID_TOKEN', 'TOKEN_EXPIRED'].includes(code)) return 'auth';
  return 'network';
}
const inviteHasExpired = (value: MobileChatInvitePreview, now = Date.now()) => typeof value.expiresAt === 'string' && Date.parse(value.expiresAt) <= now;

export function useChatInvite(props: ChatInviteSheetProps) {
  const api = useChatClient();
  const [input, setInput] = useState('');
  const [state, setState] = useState<State>({ owner: api.owner, phase: 'input' });
  const target = useRef('');
  const request = useRef<{ controller: AbortController; accept: boolean; timer: ReturnType<typeof setTimeout> } | null>(null);
  const operation = useRef<{ owner: string; token: string; id: string } | null>(null);
  const receipt = useRef<{ owner: string; groupId: string } | null>(null);
  const epoch = useRef(0);
  const closedNotified = useRef(!props.visible);
  const active = useRef({ owner: api.owner, visible: props.visible });
  active.current = { owner: api.owner, visible: props.visible };
  const callbacks = useRef(props); callbacks.current = props;
  const interactive = () => active.current.visible && active.current.owner === api.owner && api.current();
  const cancelRequest = () => {
    epoch.current++;
    if (request.current) { clearTimeout(request.current.timer); request.current.controller.abort(); request.current = null; }
  };
  const run = async (accept: boolean) => {
    if (request.current || !interactive()) return;
    if (!api.enabled) { setState({ owner: api.owner, phase: 'error', error: 'auth' }); return; }
    const token = parseChatInvitationToken(target.current);
    if (!token) { setState({ owner: api.owner, phase: 'error', error: 'format' }); return; }
    if (!accept) callbacks.current.onTargetChange?.(`cindy://chat-invite/${token}`);
    // Existing members see their status first; opening never accepts the invitation again.
    if (accept && state.phase === 'preview' && state.owner === api.owner && state.preview?.joined && api.current()) {
      receipt.current = { owner: api.owner, groupId: state.preview.groupId };
      callbacks.current.onClose();
      return;
    }
    if (accept && (!state.preview || state.owner !== api.owner || (state.error !== 'uncertain' && inviteHasExpired(state.preview)))) {
      setState({ owner: api.owner, phase: 'error', error: 'expired' }); return;
    }
    const id = ++epoch.current;
    const controller = new AbortController();
    let timedOut = false;
    let rejectTimeout: (error: Error) => void = () => {};
    const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); rejectTimeout(new Error('INVITE_TIMEOUT')); }, accept ? 30_000 : 15_000);
    request.current = { controller, timer, accept };
    const current = () => epoch.current === id && interactive();
    setState(old => ({ owner: api.owner, phase: accept ? 'joining' : 'reading', ...(accept ? { preview: old.preview } : {}) }));
    try {
      let groupId: string | undefined;
      if (accept) {
        if (operation.current?.owner !== api.owner || operation.current.token !== token) operation.current = { owner: api.owner, token, id: randomUUID() };
        groupId = (await Promise.race([api.client.acceptInvite(token, operation.current.id, controller.signal), timeout])).groupId;
      } else {
        const preview = await Promise.race([api.client.previewInvite(token, controller.signal), timeout]);
        if (!current()) return;
        if (!preview.joined && inviteHasExpired(preview)) setState({ owner: api.owner, phase: 'error', error: 'expired' });
        else setState({ owner: api.owner, phase: 'preview', preview });
      }
      if (groupId && current()) {
        receipt.current = { owner: api.owner, groupId };
        callbacks.current.onClose();
      }
    } catch (error) {
      if (current()) {
        const kind = timedOut ? 'network' : failure(error);
        setState(old => ({ owner: api.owner, phase: 'error',
          error: accept && kind === 'network' ? 'uncertain' : kind,
          ...(accept && kind === 'network' ? { preview: old.preview } : {}) }));
      }
    } finally {
      clearTimeout(timer);
      if (epoch.current === id) request.current = null;
    }
  };
  // Keep only the target on account replacement; no preview/receipt/operation crosses owners.
  useEffect(() => {
    cancelRequest();
    if (receipt.current?.owner !== api.owner || props.visible) receipt.current = null;
    operation.current = null;
    // Preserve the visible content through the native dismissal animation.
    if (!props.visible) { if (!props.retainTargetWhenHidden) target.current = ''; return; }
    closedNotified.current = false;
    if (props.link !== undefined) target.current = props.link;
    if (!target.current) setInput('');
    setState({ owner: api.owner, phase: 'input' });
    if (target.current) void run(false);
    return cancelRequest;
    // Client identity is memoized by account + realm; callbacks must not restart a pending accept.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api.owner, props.visible, props.link, props.retainTargetWhenHidden]);
  const shown = state.owner === api.owner ? state : { owner: api.owner, phase: 'reading' as const };
  // Expiry remains observable while the confirmation sits open, not just on the next tap.
  useEffect(() => {
    if (shown.phase !== 'preview' || shown.preview?.joined || !shown.preview?.expiresAt) return;
    const remaining = Date.parse(shown.preview.expiresAt) - Date.now();
    if (remaining > 2_147_483_647) return;
    const timer = setTimeout(() => setState({ owner: api.owner, phase: 'error', error: 'expired' }), Math.max(0, remaining));
    return () => clearTimeout(timer);
  }, [api.owner, shown.phase, shown.preview]);
  return {
    ...shown, input, manual: props.link === undefined,
    setInput: (value: string) => { if (interactive() && !request.current?.accept) setInput(value); },
    read: () => { if (!interactive() || request.current || !input.trim()) return; target.current = parseChatInviteLink(input.trim()) ?? input; operation.current = null; void run(false); },
    retry: () => { void run(shown.error === 'uncertain'); },
    accept: () => { void run(true); },
    edit: () => { if (!interactive() || request.current?.accept) return; cancelRequest(); target.current = ''; operation.current = null;
      callbacks.current.onTargetChange?.(); setState({ owner: api.owner, phase: 'input' }); },
    close: () => { if (!interactive() || request.current?.accept) return; cancelRequest(); receipt.current = null; callbacks.current.onClose(); },
    closed: () => {
      if (!api.current() || active.current.owner !== api.owner || active.current.visible || closedNotified.current) return;
      closedNotified.current = true;
      const joined = receipt.current; receipt.current = null;
      if (joined && joined.owner === api.owner && api.current()) callbacks.current.onJoined(joined.groupId);
    },
  };
}
