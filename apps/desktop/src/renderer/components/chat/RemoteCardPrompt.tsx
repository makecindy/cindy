import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import {
  answerRemoteCardConfirm, answerRemoteCardModel, claimRemoteCardPrompt,
  getRemoteCardPrompt, routeForPicker, subscribeRemoteCardPrompts, type RemoteCardPrompt,
} from '@/cindy-brain/ghostCardActions';
import { GhostCardModelSelect } from './GhostCardModelSelect';

/**
 * A request the remote plugin made while handling this card's click. One view answers it:
 * confirmations use the app's dialog here; a model request is returned for the caller to show.
 */
export function useRemoteCardPromptFor(callId: string): Extract<RemoteCardPrompt, { kind: 'model' }> | undefined {
  const prompt = useSyncExternalStore(subscribeRemoteCardPrompts, () => getRemoteCardPrompt(callId));
  // Some card views (the detached mail editor) have no app dialog; another view of the card answers.
  const confirm = useOptionalConfirmDialog()?.confirm;
  const [owned, setOwned] = useState<RemoteCardPrompt>();
  useEffect(() => {
    if (!prompt || (prompt.kind === 'confirm' && !confirm) || !claimRemoteCardPrompt(prompt)) return;
    if (prompt.kind === 'model') {
      setOwned(prompt);
      return () => { void answerRemoteCardModel(prompt, null); };
    }
    const request = prompt.confirm;
    let active = true;
    void confirm!({
      title: request.title,
      description: request.body,
      ...(request.confirmText ? { confirmText: request.confirmText } : {}),
      ...(request.cancelText ? { cancelText: request.cancelText } : {}),
      ...(request.danger ? { confirmVariant: 'destructive' as const } : {}),
    }).then((accepted) => { if (active) void answerRemoteCardConfirm(prompt, accepted); });
    return () => { active = false; void answerRemoteCardConfirm(prompt, false); };
  }, [prompt, confirm]);
  return owned?.kind === 'model' && owned === prompt ? owned : undefined;
}

/** The plugin asked for a model; the menu opens at the card's top edge. */
export function RemoteCardModelRequest({ prompt, inDialog }: { prompt: Extract<RemoteCardPrompt, { kind: 'model' }>; inDialog?: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const chosen = useRef(false);
  const [attempt, setAttempt] = useState(0);
  if (!open) return null;
  return (
    <GhostCardModelSelect key={attempt} inDialog={inDialog}
      rect={{ top: 0, left: 0, width: 0, height: 0 }}
      initial={routeForPicker(prompt.request.initial ?? null, prompt.remote)}
      onSelect={(route) => {
        chosen.current = true;
        void answerRemoteCardModel(prompt, route).then((answer) => {
          if (answer.handled && !answer.accepted) {
            toast.error(t('chat.ghostCall.modelSelectFailed'));
            chosen.current = false;
            setAttempt((value) => value + 1);
            setOpen(true);
          }
        });
      }}
      onClose={() => {
        setOpen(false);
        if (!chosen.current) void answerRemoteCardModel(prompt, null);
      }}
    />
  );
}

