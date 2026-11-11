import { useTranslation } from 'react-i18next';
import { resolveRemoteText } from '@cindy/device-link';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import type { useSessionResourceCards } from './useSessionResourceCards';

/** Host text is rendered as text, including fallback content from newer primitives. */
export function SessionResourceCards({
  state,
}: {
  state: ReturnType<typeof useSessionResourceCards>;
}) {
  const { t, i18n } = useTranslation();
  const cards = state.resources.filter(
    (resource) => resource.blocks.length || resource.actions.length,
  );
  if (!cards.length && !state.blocked && !state.failed) return null;
  const status = !state.connected
    ? t('cindyMake.remote.offline')
    : state.failed
      ? t('cindyMake.remote.failed')
      : t('cindyMake.remote.syncing');
  return (
    <div className="max-h-[40vh] w-full space-y-3 overflow-y-auto rounded-xl border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)] p-4 text-14 text-[var(--text-primary)]">
      {cards.map((resource) => {
        const title = resolveRemoteText(resource.display.title, i18n.language);
        const body =
          resource.blocks.map((block) => block.fallbackMarkdown).join('\n\n') ||
          resolveRemoteText(resource.display.subtitle ?? '', i18n.language);
        const detail =
          body === title
            ? ''
            : body.startsWith(title + '\n\n')
              ? body.slice(title.length + 2)
              : body;
        const busy = resource.blocks.some(
          (block) => block.primitive === 'session-controls' && block.data?.busy,
        );
        return (
          <section key={JSON.stringify(resource.ref)} aria-label={title} className="space-y-3">
            <div className="flex items-center gap-2" role="status">
              {busy && state.fresh ? <Spinner size={16} /> : null}
              <p className="min-w-0 break-words font-medium">{title}</p>
            </div>
            {detail ? (
              <p className="whitespace-pre-wrap break-words text-13 text-[var(--text-secondary)]">
                {detail}
              </p>
            ) : null}
            {resource.actions.length ? (
              <div className="flex flex-wrap gap-2">
                {resource.actions.map((action) => (
                  <Button
                    key={action.id}
                    variant="secondary"
                    className="h-auto min-h-8 max-w-full whitespace-normal py-1"
                    disabled={state.readOnly || !state.fresh || !!state.pending || action.disabled}
                    loading={state.pending === action.id}
                    onClick={() => void state.act(resource, action.id)}
                  >
                    {resolveRemoteText(action.label, i18n.language)}
                  </Button>
                ))}
              </div>
            ) : null}
          </section>
        );
      })}
      {!state.fresh || state.failed ? (
        <div className="flex flex-wrap items-center gap-3" role="status">
          {state.connected && !state.failed ? <Spinner size={16} /> : null}
          <p className="text-13 text-[var(--text-secondary)]">{status}</p>
          {state.failed ? (
            <Button
              variant="secondary"
              disabled={!state.connected || !!state.pending}
              onClick={state.refresh}
            >
              {t('cindyMake.remote.refresh')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
