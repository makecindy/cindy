import { useBotDelegation } from './botDelegationLive';
import { BotSessionTaskLink } from './BotSessionTaskLink';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
}: {
  data?: Record<string, unknown>;
  sessionId?: string;
  attached?: boolean;
}) {
  const card = readBotCollaborationMeta(data);
  if (card?.role !== 'delegation-result' || !card.result) return null;
  return <TaskResultBody card={card} result={card.result} sessionId={sessionId} />;
}

function TaskResultBody({
  card,
  result,
  sessionId,
}: {
  card: BotCollaborationMeta;
  result: NonNullable<BotCollaborationMeta['result']>;
  sessionId?: string;
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
  const workingDir = result.workingDir ?? fileContext.workingDir;
  return (
    <div className="min-w-0 text-14 leading-6">
      <BotSessionTaskLink card={card} sessionId={sessionId} />
      <button
        type="button"
        className="ml-2 inline-flex max-w-full text-12 text-[var(--text-secondary)] underline underline-offset-4"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={() => setExpanded(!expanded)}
      >
        {t('bots.collab.viewResult')}
      </button>
      <div
        id={contentId}
        hidden={!expanded}
        className="mt-3 space-y-2 border-t border-[var(--border-default)] pt-3 text-14 text-[var(--text-primary)]"
      >
        <p className="text-12 text-[var(--text-secondary)]">
          <span>{title}</span> · <span>{t(`bots.collab.status.${result.status}`)}</span>
        </p>
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
                  ?.replace(/[[\]\\]/g, '\\$&') ?? t('bots.collab.viewResult')
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
