import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BOT_TASK_CARD_CLASS, BotTaskCardHeader } from './BotTaskCardHeader';
import { useBotDelegation } from './botDelegationLive';
import type { BotCollaborationMeta } from '../../../shared/botCollaboration';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import {
  ChatSessionFileProvider,
  useChatSessionFile,
} from '@/components/chat/ChatSessionFileContext';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

/** Frozen result data; legacy receipts may read the existing task title only. */
export function BotSessionTaskResultCard({
  data,
  sessionId,
  attached = false,
}: {
  data?: Record<string, unknown>;
  sessionId?: string;
  attached?: boolean;
}) {
  const card = readBotCollaborationMeta(data);
  if (card?.role !== 'delegation-result' || !card.result) return null;
  return <TaskResultBody card={card} result={card.result} sessionId={sessionId} attached={attached} />;
}

function TaskResultBody({
  card,
  result,
  sessionId,
  attached,
}: {
  card: BotCollaborationMeta;
  result: NonNullable<BotCollaborationMeta['result']>;
  sessionId?: string;
  attached: boolean;
}) {
  const { t } = useTranslation();
  const fileContext = useChatSessionFile();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { row } = useBotDelegation(
    result.title?.trim() ? null : (sessionId ?? card.parentSessionId),
    card.delegationId,
  );
  const title =
    result.title?.trim() ||
    row?.title?.trim() ||
    card.objective.trim().split('\n')[0] ||
    t('bots.collab.backgroundTask');
  const statusClass =
    result.status === 'completed'
      ? 'text-[var(--status-success)]'
      : result.status === 'cancelled'
        ? 'text-[var(--text-tertiary)]'
        : 'text-[var(--error-fg)]';
  const workingDir = result.workingDir ?? fileContext.workingDir;
  return (
    <div className={attached ? "w-full min-w-0 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3" : BOT_TASK_CARD_CLASS}>
      <BotTaskCardHeader
        title={title}
        status={t(`bots.collab.status.${result.status}`)}
        statusClass={statusClass}
      />
      <Button
        variant="secondary"
        size="md"
        className="mt-2.5 min-w-[104px] max-w-full gap-1.5 px-3"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        <FileText size={14} aria-hidden="true" />
        {t('bots.collab.viewResult')}
      </Button>
      <div
        id={contentId}
        hidden={!expanded}
        className="mt-3 space-y-2 border-t border-[var(--border-default)] pt-3 text-14 text-[var(--text-primary)]"
      >
        <ChatSessionFileProvider
          value={{ ...fileContext, workingDir, sessionId: card.childSessionId ?? undefined }}
        >
          {result.text ? (
            <MarkdownRenderer
              workingDir={workingDir}
              currentSessionId={card.childSessionId ?? undefined}
              content={result.text}
            />
          ) : (
            <p className="whitespace-pre-wrap break-words">{t('bots.collab.noWrittenResult')}</p>
          )}
          {result.artifacts.map((artifact) => (
            <MarkdownRenderer
              key={artifact.absolutePath}
              workingDir={workingDir}
              currentSessionId={card.childSessionId ?? undefined}
              content={`[${
                artifact.absolutePath
                  .split(/[\\/]/)
                  .pop()
                  ?.replace(/[\[\]\\]/g, '\\$&') ?? t('bots.collab.viewResult')
              }](<${encodeURI(artifact.absolutePath).replace(/[<>?#]/g, encodeURIComponent)}>)`}
            />
          ))}
        </ChatSessionFileProvider>
        {result.error && (
          <details>
            <summary className="flex min-h-11 cursor-pointer items-center rounded-xl text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2">
              {t('appError.details')}
            </summary>
            <p className="whitespace-pre-wrap break-words text-12 text-[var(--text-secondary)]">
              {result.error}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
