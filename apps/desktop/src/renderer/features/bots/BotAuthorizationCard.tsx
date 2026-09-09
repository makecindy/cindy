import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PluginSetupPrompt } from '@/components/new-chat/PluginSetupPrompt';
import { readBotAuthorizationCard } from '../../../shared/botAuthorization';
import { isRemoteSessionSticky, makerApiForSticky } from '@/lib/makerTransport';
import type { PluginSetupCommandInFlight } from '@/lib/makerChatStore';

/** Same composable form for Host and plugin accounts, rendered in the transcript. */
export function BotAuthorizationCardView({
  data,
  sessionId,
}: {
  data?: Record<string, unknown>;
  sessionId?: string;
}) {
  const card = readBotAuthorizationCard(data);
  if (!card || card.sessionId !== sessionId) return null;
  return (
    <AuthorizationBody key={`${card.snapshot.requestId}:${card.snapshot.revision}`} card={card} />
  );
}
function AuthorizationBody({
  card,
}: {
  card: NonNullable<ReturnType<typeof readBotAuthorizationCard>>;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<PluginSetupCommandInFlight | null>(null);
  const [failed, setFailed] = useState(false);
  const remote = isRemoteSessionSticky(card.sessionId);
  return (
    <div className="my-2 max-w-xl">
      <PluginSetupPrompt
        pending={card.snapshot}
        compact
        viewerState="expanded"
        onViewerStateChange={() => {}}
        remote={remote}
        commandInFlight={busy}
        onCommand={(requestId, action, actionId, values) => {
          if (busy || (isRemoteSessionSticky(card.sessionId) && action !== 'cancel')) return;
          setFailed(false);
          setBusy({ requestId, action, actionId });
          const command =
            action === 'submit_form' && actionId && values && !remote
              ? window.electronAPI.maker.submitPluginSetupInline({
                  requestId,
                  actionId,
                  expectedRevision: card.snapshot.revision,
                  value: values.value,
                })
              : makerApiForSticky(card.sessionId).resolveInteraction(requestId, {
                  kind: 'plugin_setup',
                  action: action === 'cancel' ? 'cancel' : 'run_action',
                  ...(actionId ? { actionId } : {}),
                  expectedRevision: card.snapshot.revision,
                });
          void command
            .then((result) => {
              if (result && 'accepted' in result && !result.accepted) setFailed(true);
            })
            .catch(() => setFailed(true))
            .finally(() => setBusy(null));
        }}
      />
      {failed ? (
        <p role="alert" className="mt-2 text-13 text-[var(--error-fg)]">
          {t('newChat.pluginSetup.error.ACTION_FAILED')}
        </p>
      ) : null}
    </div>
  );
}
