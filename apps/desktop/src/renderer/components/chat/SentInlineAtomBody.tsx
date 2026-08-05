/**
 * Static projection of a sent message's structured inline atoms.
 *
 * Pending queue rows and clamped message bodies must keep the same chip
 * geometry as the final message, but their chips cannot own navigation,
 * lightbox, context-menu, or keyboard behaviour: the surrounding row or the
 * expand control owns the interaction while clipped content may sit behind a
 * line clamp.
 */
import { useTranslation } from 'react-i18next';

import type { AgentInputReference } from '../../../shared/agentInputQueue';
import type { PastedTextRange, SlashCommandRange } from '@/lib/imageRef';
import { parseChatQuoteSegments, type ChatQuoteSegment } from '@/lib/chatQuotes';
import { locateChatQuoteTextSegmentStarts, projectSentRanges, renderContent } from './UserMessage';
import { QuoteChip } from './QuoteChip';

export interface SentInlineAtomBodyProps {
  content: string;
  quotesEncoded?: boolean;
  pastedTextRanges?: readonly PastedTextRange[];
  slashCommandRanges?: readonly SlashCommandRange[];
  agentReferences?: readonly AgentInputReference[];
  workingDir?: string;
  className?: string;
}

function visibleSegments(content: string, quotesEncoded: boolean): ChatQuoteSegment[] {
  if (!content) return [];
  if (!quotesEncoded) return [{ kind: 'text', text: content }];
  const parsed = parseChatQuoteSegments(content);
  return parsed.length > 0 ? parsed : [{ kind: 'text', text: content }];
}

export function SentInlineAtomBody({
  agentReferences = [],
  className,
  content,
  pastedTextRanges = [],
  quotesEncoded = false,
  slashCommandRanges,
  workingDir = '',
}: SentInlineAtomBodyProps) {
  const { t } = useTranslation();
  const segments = visibleSegments(content, quotesEncoded);
  const segmentStarts = locateChatQuoteTextSegmentStarts(content, segments);

  return (
    <span className={className ?? 'inline-flex min-w-0 max-w-full items-center gap-1'}>
      {segments.map((segment, index) => {
        if (segment.kind === 'quote') {
          return (
            <span
              className="mx-1 inline-flex max-w-[min(240px,55vw)] select-none align-middle"
              key={`quote-${index}`}
            >
              <QuoteChip quote={segment.quote} />
            </span>
          );
        }

        const sourceStart = segmentStarts[index];
        const localPastedRanges = projectSentRanges(
          pastedTextRanges,
          sourceStart,
          segment.text.length,
        );
        const localSlashRanges =
          slashCommandRanges === undefined
            ? undefined
            : projectSentRanges(slashCommandRanges, sourceStart, segment.text.length);
        const localAgentReferences = projectSentRanges(
          agentReferences,
          sourceStart,
          segment.text.length,
        );

        return (
          <span className="min-w-0" key={`text-${index}`}>
            {renderContent(
              segment.text,
              workingDir,
              undefined,
              undefined,
              t,
              undefined,
              false,
              localPastedRanges,
              localSlashRanges,
              undefined,
              undefined,
              localAgentReferences,
              false,
            )}
          </span>
        );
      })}
    </span>
  );
}
