/**
 * ConversationStream — renders a Subagent transcript the way the main session
 * renders a conversation: the same `UserMessage` / `AssistantMessage` components
 * for prose, a foldable card per tool call, nothing else in the reading flow.
 *
 * A parent entry produced by a steer / follow-up / resume control carries a
 * small chip above the bubble so the user can tell "I said this" from "the
 * parent task's original assignment"; the bubble itself stays identical to the
 * session's, per the ruling that one signal is enough.
 */

import { useTranslation } from 'react-i18next';

import { AssistantMessage } from '@/components/chat/AssistantMessage';
import { UserMessage } from '@/components/chat/UserMessage';
import type { SubagentConversationItem } from './subagentConversation';
import { SubagentToolCard } from './SubagentToolCard';

interface ConversationStreamProps {
  items: readonly SubagentConversationItem[];
  workdir: string;
  /**
   * False when this run belongs to another machine (device-link / SSH), where
   * `workdir` is a remote path. The bubbles below are the same components the
   * main session uses and default to trusting their content, so the boundary
   * has to be carried in explicitly — the same contract the legacy detail view
   * uses for its `MarkdownRenderer`.
   */
  allowPrivilegedLinks: boolean;
  /** Assistant item allowed to mount the hover action bar (the settled tail). */
  actionBarItemId?: string | null;
}

function isoTime(occurredAt: number): string | undefined {
  return Number.isFinite(occurredAt) && occurredAt > 0
    ? new Date(occurredAt).toISOString()
    : undefined;
}

export function ConversationStream({
  items,
  workdir,
  allowPrivilegedLinks,
  actionBarItemId = null,
}: ConversationStreamProps) {
  const { t } = useTranslation();
  return (
    <>
      {items.map((item) => {
        if (item.kind === 'tool') {
          return (
            <SubagentToolCard
              key={item.id}
              summary={item.summary}
              toolName={item.toolName}
              inputJson={item.inputJson}
              result={item.result}
              isError={item.isError}
              done={item.done}
            />
          );
        }
        if (item.kind === 'parent') {
          return (
            <div key={item.id}>
              {item.controlAction ? (
                <div className="mb-1 flex justify-end">
                  <span className="inline-flex select-none items-center rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-10 leading-4 text-[var(--text-secondary)]">
                    {t(`rightSidebar.subagents.controlBadges.${item.controlAction}`)}
                  </span>
                </div>
              ) : null}
              <UserMessage
                workingDir={workdir}
                allowPrivilegedLinks={allowPrivilegedLinks}
                content={item.content}
                createdAt={isoTime(item.occurredAt)}
              />
            </div>
          );
        }
        return (
          <AssistantMessage
            key={item.id}
            workingDir={workdir}
            allowPrivilegedLinks={allowPrivilegedLinks}
            content={item.content}
            createdAt={isoTime(item.occurredAt)}
            agentKind="pi"
            showActionBar={item.id === actionBarItemId}
          />
        );
      })}
    </>
  );
}
