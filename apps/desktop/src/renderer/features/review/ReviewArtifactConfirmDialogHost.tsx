import { useEffect } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import type { ReviewArtifactConfirmRequest } from '../../../shared/reviewArtifactConfirm';

function isConfirmRequest(value: unknown): value is ReviewArtifactConfirmRequest {
  if (!value || typeof value !== 'object') return false;
  const request = value as Partial<ReviewArtifactConfirmRequest>;
  return (
    typeof request.requestId === 'string' &&
    request.requestId.length > 0 &&
    typeof request.title === 'string' &&
    typeof request.message === 'string' &&
    typeof request.detail === 'string' &&
    typeof request.allowText === 'string' &&
    typeof request.cancelText === 'string' &&
    Array.isArray(request.items) &&
    request.items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        typeof item.label === 'string' &&
        ((item.kind === 'external-path' && typeof item.path === 'string') ||
          (item.kind === 'inline' && typeof item.inlineLabel === 'string')),
    )
  );
}

/** Renders Main-owned Review consent in Cindy's shared confirm dialog. */
export function ReviewArtifactConfirmDialogHost() {
  const { confirm } = useConfirmDialog();

  useEffect(() => {
    const pending = new Map<string, AbortController>();
    const unsubscribeRequest = window.electronAPI.maker.onReviewArtifactConfirmRequest((raw) => {
      const requestId =
        raw && typeof raw === 'object' && typeof raw.requestId === 'string' ? raw.requestId : null;
      if (!isConfirmRequest(raw)) {
        if (requestId) {
          void window.electronAPI.maker
            .resolveReviewArtifactConfirm(requestId, false)
            .catch(() => {});
        }
        return;
      }

      const controller = new AbortController();
      pending.get(raw.requestId)?.abort();
      pending.set(raw.requestId, controller);
      void (async () => {
        let confirmed = false;
        try {
          confirmed = await confirm(
            {
              title: raw.title,
              description: raw.message,
              content: (
                <div className="text-13 leading-relaxed text-[var(--confirm-desc)]">
                  <p>{raw.detail}</p>
                  <ul className="mt-3 space-y-2">
                    {raw.items.map((item, index) => (
                      <li key={`${item.kind}:${index}`} className="flex min-w-0 gap-2">
                        <span aria-hidden="true" className="shrink-0">
                          •
                        </span>
                        <div className="min-w-0">
                          <div className="break-words text-[var(--confirm-title)]">
                            {item.label}
                            {item.kind === 'inline' && item.inlineLabel
                              ? ` (${item.inlineLabel})`
                              : null}
                          </div>
                          {item.kind === 'external-path' && item.path ? (
                            <div
                              className="mt-0.5 select-text break-all font-mono text-xs"
                              dir="ltr"
                            >
                              {item.path}
                            </div>
                          ) : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
              maxWidth: 560,
              confirmText: raw.allowText,
              cancelText: raw.cancelText,
              describeContent: true,
            },
            controller.signal,
          );
        } finally {
          if (pending.get(raw.requestId) === controller) pending.delete(raw.requestId);
          if (controller.signal.aborted) return;
          try {
            await window.electronAPI.maker.resolveReviewArtifactConfirm(raw.requestId, confirmed);
          } catch {
            // Main times out fail-closed if this window disappears mid-response.
          }
        }
      })();
    });
    const unsubscribeDismiss = window.electronAPI.maker.onReviewArtifactConfirmDismiss((raw) => {
      if (!raw || typeof raw.requestId !== 'string') return;
      pending.get(raw.requestId)?.abort();
      pending.delete(raw.requestId);
    });
    return () => {
      unsubscribeRequest();
      unsubscribeDismiss();
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    };
  }, [confirm]);

  return null;
}
