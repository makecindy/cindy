import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { readBotCollaborationMeta } from '../../../shared/botCollaboration';
import { ChatSessionFileProvider, useChatSessionFile } from '@/components/chat/ChatSessionFileContext';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

/** A frozen execution receipt; expanding it never restarts or fetches the task. */
export function BotSessionTaskResultCard({ data }: { data?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const fileContext = useChatSessionFile();
  const card = readBotCollaborationMeta(data);
  if (card?.role !== 'delegation-result' || !card.result) return null;
  const { result } = card;
  const workingDir = result.workingDir ?? fileContext.workingDir;
  return (
    <details className="my-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-14 text-[var(--text-primary)]">
      <summary className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl px-3 py-2 focus-visible:outline focus-visible:outline-2">
        <FileText size={16} className="shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{card.objective}</span>
        <span className="shrink-0 text-12 text-[var(--text-secondary)]">{t(`bots.collab.status.${result.status}`)}</span>
        <span className="shrink-0 text-12">{t('bots.collab.viewResult')}</span>
      </summary>
      <div className="space-y-2 border-t border-[var(--border-default)] px-3 py-3">
        <ChatSessionFileProvider value={{ ...fileContext, workingDir, sessionId: card.childSessionId ?? undefined }}>
          {result.text
            ? <MarkdownRenderer workingDir={workingDir} currentSessionId={card.childSessionId ?? undefined} content={result.text} />
            : <p className="whitespace-pre-wrap break-words">{t('bots.collab.noWrittenResult')}</p>}
          {result.artifacts.map((artifact) => (
            <MarkdownRenderer key={artifact.absolutePath} workingDir={workingDir} currentSessionId={card.childSessionId ?? undefined}
              content={`[${artifact.absolutePath.split(/[\\/]/).pop()?.replace(/[\[\]\\]/g, '\\$&') ?? t('bots.collab.viewResult')}](<${encodeURI(artifact.absolutePath).replace(/[<>?#]/g, encodeURIComponent)}>)`} />
          ))}
        </ChatSessionFileProvider>
        {result.error && <details>
          <summary className="flex min-h-11 cursor-pointer items-center rounded-xl text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2">{t('appError.details')}</summary>
          <p className="whitespace-pre-wrap break-words text-12 text-[var(--text-secondary)]">{result.error}</p>
        </details>}
      </div>
    </details>
  );
}
