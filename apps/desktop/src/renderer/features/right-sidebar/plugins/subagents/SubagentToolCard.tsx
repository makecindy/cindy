/**
 * SubagentToolCard — foldable tool-call card for the Subagent conversation.
 *
 * Why this exists instead of reusing the main session's `ToolCallCard`:
 *  - `ToolCallCard` consumes `ChatSessionFileContext`. Outside `MessageStream`
 *    the context falls back to its "local origin, empty workingDir" default, so
 *    the card would treat a *remote* Subagent's file paths as paths on this
 *    machine — the file chip and TextLightbox would resolve and read the wrong
 *    filesystem. The panel already draws that boundary explicitly elsewhere
 *    (`allowPrivilegedLinks` is false for device-link / SSH tasks).
 *  - Its Edit/DiffView and preview-chip affordances need the real structured
 *    tool input. The durable transcript only carries a *truncated serialized*
 *    copy of the arguments, so those affordances would be built on partial data.
 *
 * So this card keeps the same visual vocabulary (chevron + name(keyParam) +
 * folded input/result on the shared `--msg-tool-card-*` tokens, `Collapse`
 * animation per DESIGN.md §14.4) and drops every session-only capability.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, LoaderCircle, Wrench } from 'lucide-react';

import { Collapse } from '@/components/ui/collapse';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

interface SubagentToolCardProps {
  /** One-line summary, e.g. `read(/tmp/a.ts)`. */
  summary: string;
  toolName?: string;
  /** Serialized (already truncated) tool arguments. */
  inputJson?: string;
  /** Result text; absent while the call is still running. */
  result?: string;
  isError: boolean;
  /** False while the matching tool-execution end frame has not arrived. */
  done: boolean;
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value) as unknown, null, 2);
  } catch {
    // Truncated payloads are no longer valid JSON — show them verbatim.
    return value;
  }
}

const BLOCK_CLASS = 'max-h-64 select-text overflow-auto whitespace-pre-wrap break-words '
  + 'rounded-lg border border-[var(--msg-code-block-border)] bg-[var(--msg-code-block-bg)] '
  + 'p-2 font-mono text-11 leading-4 text-[var(--msg-tool-card-text)]';

export function SubagentToolCard({
  summary,
  toolName,
  inputJson,
  result,
  isError,
  done,
}: SubagentToolCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const label = summary.trim() || toolName || t('rightSidebar.subagents.tool.fallbackName');
  const hasBody = Boolean(inputJson) || Boolean(result?.trim());
  return (
    <div className="flex w-full justify-start">
      <div className="max-w-full overflow-hidden rounded-xl border border-[var(--msg-tool-card-border)] bg-[var(--msg-tool-card-bg)]">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          data-subagent-tool-card={done ? (isError ? 'failed' : 'done') : 'running'}
          className="flex w-full select-none items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          <ChevronRight
            size={13}
            aria-hidden="true"
            className={cn(
              'shrink-0 text-[var(--msg-tool-card-chevron)] transition-transform',
              expanded && 'rotate-90',
            )}
          />
          {done ? (
            <Wrench
              size={13}
              aria-hidden="true"
              className={cn(
                'shrink-0',
                isError ? 'text-[var(--error-fg)]' : 'text-[var(--msg-tool-card-chevron)]',
              )}
            />
          ) : (
            <Spinner
              icon={LoaderCircle}
              size={13}
              spinning
              className="shrink-0 text-[var(--msg-tool-card-chevron)]"
              aria-label={t('rightSidebar.subagents.tool.running')}
            />
          )}
          <span className="min-w-0 flex-1 truncate font-mono text-12 leading-4 text-[var(--msg-tool-card-text)]">
            {label}
          </span>
          {isError ? (
            <span className="shrink-0 text-10 leading-4 text-[var(--error-fg)]">
              {t('rightSidebar.subagents.tool.failed')}
            </span>
          ) : null}
        </button>
        <Collapse open={expanded}>
          <div className="border-t border-[var(--msg-tool-card-border)] px-3 py-2">
            {inputJson ? (
              <div className={result?.trim() ? 'mb-2' : undefined}>
                <div className="mb-1 select-none text-10 leading-4 text-[var(--msg-tool-card-chevron)]">
                  {t('rightSidebar.subagents.tool.input')}
                </div>
                <pre className={BLOCK_CLASS}>{prettyJson(inputJson)}</pre>
              </div>
            ) : null}
            {result?.trim() ? (
              <div>
                <div className="mb-1 select-none text-10 leading-4 text-[var(--msg-tool-card-chevron)]">
                  {t('rightSidebar.subagents.tool.result')}
                </div>
                <pre className={BLOCK_CLASS}>{result}</pre>
              </div>
            ) : null}
            {hasBody ? null : (
              <p className="text-11 leading-4 text-[var(--text-tertiary)]">
                {done
                  ? t('rightSidebar.subagents.tool.noDetails')
                  : t('rightSidebar.subagents.tool.running')}
              </p>
            )}
          </div>
        </Collapse>
      </div>
    </div>
  );
}
