/**
 * ToolCallCard
 * ---------------------------------------------------------------------------
 * F-MSG-3: Foldable Tool Call card with chevron toggle.
 *
 * Collapsed: chevron-right + wrench emoji + ToolName(keyParam)
 * Expanded:  chevron-down  + full JSON input + tool_result output
 *            (Edit tools render DiffView instead of JSON — F-MSG-6)
 */

import { useRef, useState } from 'react';
import { ChevronRight, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn, basename } from '@/lib/utils';
import { shouldOpenTextLightboxForOrigin } from '@/lib/filePreview';
import { resolveToolFilePath } from '@/lib/localPathResolver';
import { useChatSessionFile } from './ChatSessionFileContext';
import { Collapse } from '@/components/ui/collapse';
import { Tip } from '@/components/ui/tooltip';
import { DiffView } from './DiffView';
import { TextLightbox } from './TextLightbox';
import {
  formatToolResultCompactionBytes,
  parseToolResultCompactionMarker,
} from '@cindy/maker-shared/tool-result-compaction';

// text-lightbox F1: only these 4 tools get the preview entry chip-row.
// Bash/Grep/Glob etc. are explicitly out of scope per the spec's 非目标 list.
const TEXT_LIGHTBOX_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit']);

/**
 * text-lightbox F1: extract the file_path(s) from a tool input. Read/Write/
 * Edit each have a single `file_path`; MultiEdit also has a single `file_path`
 * (the edits array shares one target file). Returns the path verbatim as the
 * model emitted it — may be RELATIVE (resolved against the session workingDir
 * at the click site via resolveToolFilePath).
 *
 * Currently the extraction logic is identical for all four tools (`file_path`
 * key on the input record), so we don't branch on toolName — but the caller
 * already pre-filters via `TEXT_LIGHTBOX_TOOLS`, so adding the param here
 * would just be ceremony.
 */
function extractTextFilePaths(input: unknown): string[] {
  const inp = input as Record<string, unknown> | null;
  if (!inp) return [];
  const fp = inp.file_path;
  if (typeof fp === 'string' && fp) return [fp];
  return [];
}

interface ToolCallCardProps {
  toolName: string;
  toolInput: unknown;
  /** One-line summary like "Read(auth.ts)" */
  summary: string;
  /** tool_result content (string or structured) — undefined if result hasn't arrived yet */
  toolResult?: string;
}

/**
 * Tool name -> key param for the summary line (F5.5 mapping).
 */
const KEY_PARAM_MAP: Record<string, string[]> = {
  Read: ['file_path', 'path'],
  Edit: ['file_path'],
  Write: ['file_path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
};

export function getToolSummary(toolName: string, input: unknown): string {
  const inp = input as Record<string, unknown> | null;
  if (!inp) return `${toolName}()`;

  const paramKeys = KEY_PARAM_MAP[toolName];
  if (paramKeys) {
    for (const key of paramKeys) {
      if (inp[key]) {
        const val = String(inp[key]);
        const display = val.length > 60 ? val.slice(0, 57) + '...' : val;
        return `${toolName}(${display})`;
      }
    }
  }

  return `${toolName}()`;
}

export function ToolCallCard({ toolName, toolInput, summary, toolResult }: ToolCallCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const compactedToolResult = parseToolResultCompactionMarker(toolResult);
  const displayedToolResult = compactedToolResult
    ? t('chat.toolResultCompacted', {
        size: formatToolResultCompactionBytes(compactedToolResult.originalBytes),
      })
    : toolResult;
  // 会话文件来源:remote 时文件 chip 点击走远程分流(取回缓存副本),不直打本机 fs。
  const fileCtx = useChatSessionFile();
  // text-lightbox F1/F3: open TextLightbox on chip click.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  // text-lightbox F6: ref to the chip <button> currently driving the
  // lightbox, so close can return focus to it. Single ref is enough — only
  // one lightbox can be open at a time per card.
  const activeChipRef = useRef<HTMLButtonElement | null>(null);

  const isEditTool = toolName === 'Edit';
  const inp = toolInput as Record<string, unknown> | null;

  // text-lightbox F1/F2: collect previewable file paths for the chip-row.
  const previewablePaths = TEXT_LIGHTBOX_TOOLS.has(toolName) ? extractTextFilePaths(toolInput) : [];

  // Check if Edit tool has old_string/new_string for diff rendering
  const canRenderDiff =
    isEditTool && inp && typeof inp.old_string === 'string' && typeof inp.new_string === 'string';

  return (
    <div className="flex w-full justify-start">
      <div
        className={cn(
          'rounded-[12px] border border-[var(--msg-tool-card-border)]',
          'bg-[var(--msg-tool-card-bg)]',
          'overflow-hidden',
          'max-w-full',
        )}
      >
        {/* Collapsed header — always visible */}
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className={cn(
            'flex w-full items-center gap-2',
            'px-[14px] py-[10px]',
            'cursor-pointer select-none',
            'hover:opacity-80 transition-opacity',
          )}
        >
          <ChevronRight
            size={14}
            className={cn(
              'shrink-0 text-[var(--msg-tool-card-chevron)]',
              'transition-transform duration-[var(--motion-fast,150ms)]',
              expanded && 'rotate-90',
            )}
          />
          <span className="text-13 leading-normal">🔧</span>
          <span
            className={cn(
              'font-mono text-13 leading-normal',
              'text-[var(--msg-tool-card-text)]',
              'truncate',
            )}
          >
            {summary}
          </span>
        </button>

        {/* Expanded content */}
        <Collapse open={expanded}>
          <div className="border-t border-[var(--msg-tool-card-border)] px-[14px] py-[10px]">
            {/* text-lightbox F1/F2: Chip-Row preview entry — only for the 4
                supported tools. Click → open TextLightbox. */}
            {previewablePaths.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-1.5">
                {previewablePaths.map((p, idx) => (
                  <Tip key={`prev-${idx}-${p}`} text={p} mono>
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.stopPropagation();
                        const btn = e.currentTarget;
                        // 模型可能给相对 file_path(见 AgentActionRow onActivate
                        // 注释)—— 先按会话 workingDir 补成绝对路径再预览。
                        const abs = resolveToolFilePath(p, fileCtx.workingDir);
                        if (!(await shouldOpenTextLightboxForOrigin(fileCtx, abs))) return;
                        // F6 focus return: stash the clicked chip so the
                        // lightbox can restore focus on close.
                        activeChipRef.current = btn;
                        setPreviewPath(abs);
                      }}
                      className={cn(
                        'inline-flex items-center gap-1.5',
                        'h-7 px-2.5 py-1.5',
                        'rounded-[9999px]',
                        'bg-[var(--msg-tool-card-bg)]',
                        'border border-[var(--msg-tool-card-border)]',
                        'text-13 font-medium',
                        'text-[var(--msg-tool-card-text)]',
                        'hover:bg-[var(--msg-code-inline-bg)]',
                        'transition-colors max-w-[280px]',
                        'cursor-pointer',
                      )}
                    >
                      <FileText size={14} className="shrink-0 text-[var(--msg-tool-card-chevron)]" />
                      <span className="truncate">{basename(p)}</span>
                    </button>
                  </Tip>
                ))}
              </div>
            )}
            {/* Input section */}
            {canRenderDiff ? (
              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-[var(--msg-tool-card-chevron)]">
                  Diff
                </div>
                <DiffView
                  oldString={inp.old_string as string}
                  newString={inp.new_string as string}
                />
                {typeof inp.file_path === 'string' && inp.file_path && (
                  <div className="mt-1 font-mono text-xs text-[var(--msg-tool-card-chevron)] select-text">
                    {inp.file_path}
                  </div>
                )}
              </div>
            ) : (
              <div className="mb-3">
                <div className="mb-1 text-xs font-medium text-[var(--msg-tool-card-chevron)]">
                  Input
                </div>
                <pre
                  className={cn(
                    'overflow-x-auto rounded-[12px] border border-[var(--msg-code-block-border)]',
                    'bg-[var(--msg-code-block-bg)] p-3',
                    'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]',
                    'text-[var(--msg-tool-card-text)]',
                    // App-shell sets user-select:none globally (globals.css L12).
                    // Mirror message-bubble / TextLightbox by opting tool-card
                    // input/result content back into selectable text so users
                    // can copy commands, file paths, JSON snippets, etc.
                    'select-text',
                  )}
                >
                  {JSON.stringify(toolInput, null, 2)}
                </pre>
              </div>
            )}

            {/* Result section */}
            {displayedToolResult && (
              <div>
                <div className="mb-1 text-xs font-medium text-[var(--msg-tool-card-chevron)]">
                  Result
                </div>
                <pre
                  className={cn(
                    'overflow-x-auto rounded-[12px] border border-[var(--msg-code-block-border)]',
                    'bg-[var(--msg-code-block-bg)] p-3',
                    'font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]',
                    'text-[var(--msg-tool-card-text)]',
                    'max-h-[300px] overflow-y-auto',
                    'select-text',
                  )}
                >
                  {displayedToolResult}
                </pre>
              </div>
            )}
          </div>
        </Collapse>
      </div>
      {/* text-lightbox F3/F6 — Lightbox is mounted via Portal so its position
          is independent of the card's transform/overflow. */}
      {previewPath && (
        <TextLightbox
          filePath={previewPath}
          fileName={basename(previewPath)}
          triggerRef={activeChipRef}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  );
}
