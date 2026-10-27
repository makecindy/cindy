import { useEffect } from 'react';
import { useConfirmDialog } from './ui/confirm-dialog-provider';

/** Reuse Cindy's modal queue, focus trap, theme and dismiss/abort behavior. */
export function LocalAgentConfirmationHost() {
  const { confirm } = useConfirmDialog();
  useEffect(() => {
    const pending = new Map<string, AbortController>();
    const api = window.electronAPI.localAgent;
    const offDismiss = api.onConfirmationDismissed(id => pending.get(id)?.abort());
    const offRequest = api.onConfirmation(request => {
      if (pending.has(request.requestId)) return;
      const controller = new AbortController();
      pending.set(request.requestId, controller);
      void (async () => {
        try {
          const approved = await confirm({
            title: request.title,
            description: request.message,
            textClassName: '[overflow-wrap:anywhere]',
            content: <p className="whitespace-pre-wrap text-13 leading-normal text-[var(--confirm-desc)] [overflow-wrap:anywhere]">{request.detail}</p>,
            describeContent: true,
            confirmText: request.confirmText,
            cancelText: request.cancelText,
          }, controller.signal);
          if (!controller.signal.aborted)
            await api.answerConfirmation(request.requestId, approved);
        } catch {
          // Main's bounded request lifecycle fails closed if the renderer is gone.
        } finally {
          pending.delete(request.requestId);
        }
      })();
    });
    return () => {
      offRequest(); offDismiss();
      for (const [id, controller] of pending) {
        controller.abort();
        void api.answerConfirmation(id, false).catch(() => {});
      }
      pending.clear();
    };
  }, [confirm]);
  return null;
}
