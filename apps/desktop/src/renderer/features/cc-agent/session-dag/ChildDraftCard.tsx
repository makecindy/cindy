import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { DEFAULT_SIZE } from './layout';
import { copy } from './copy';
import type { DagPoint } from './types';

import { DagCardSummary, type CardSummaryProps } from './DagCardSummary';

import type { CardBoxProps } from './DagResizeHandle';

type Props = CardBoxProps & CardSummaryProps & {
  id: string;
  parentId: string;
  point: DagPoint;
  question: string;
  readOnly?: boolean;
  status: 'editing' | 'legacy-draft' | 'accepted' | 'continued';
  onDragBlank: (id: string, e: PointerEvent<HTMLDivElement>) => void;
  onOpen: () => void;
  onChange: (question: string) => void;
  onCancel: () => void;
  onAsk: () => Promise<void>;
  onError: (error: unknown) => void;
};

export function ChildDraftCard({
  id,
  parentId,
  size = DEFAULT_SIZE,
  resizeHandle,
  point,
  question,
  summary,
  onSummaryChange,
  readOnly,
  status,
  onDragBlank,
  onOpen,
  onChange,
  onCancel,
  onAsk,
  onError,
}: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const statusLabel = status === 'continued' ? '已提问 · 打开本分支' : status === 'accepted' ? '已提问 · 打开分支' : '待发送 · 打开原生对话';
  useLayoutEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      data-session-dag-draft={id}
      data-parent-id={parentId}
      onPointerDown={(e) => {
        if (e.button !== 0 || busy || (e.target as Element).closest('textarea,button')) return;
        e.preventDefault(); // Keep the editor focus and selection during a body drag.
        onDragBlank(id, e);
      }}
      className="dag-card dag-draft absolute z-[2] box-border flex touch-none cursor-grab flex-col border border-border active:cursor-grabbing has-[textarea:focus-visible]:border-[var(--focus-ring)]"
      style={{ left: point.x, top: point.y, ...size }}
    >
      <DagCardSummary question={question} summary={summary} onSummaryChange={readOnly || busy ? undefined : onSummaryChange} />
      {status !== 'editing' ? (
        <button
          type="button"
          aria-label={`${statusLabel} ${question}`}
          className="dag-placeholder flex min-h-0 flex-col overflow-y-auto text-left"
          onClick={onOpen}
        >
          <span className="dag-question-surface shrink-0 whitespace-pre-wrap break-words">
            {question}
          </span>
          <span className="dag-status">{statusLabel}</span>
        </button>
      ) : (
        <>
          <div className="dag-question-surface dag-compose min-h-0">
            <Textarea
              rows={1}
              textareaRef={input}
              value={question}
              onChange={onChange}
              disabled={busy || readOnly}
              aria-label="子卡问题"
              placeholder="在这里输入问题…"
              className="dag-question-input [field-sizing:content]"
              onKeyDown={(e) => {
                if (e.key === 'Escape' && !e.nativeEvent.isComposing && !busy) {
                  e.stopPropagation();
                  onCancel();
                }
              }}
            />
          </div>
          <div className="dag-draft-actions mt-auto flex shrink-0 items-center justify-end gap-2">
            <Button
              size="sm"
              compact
              variant="secondary"
              tone="quiet"
              disabled={busy}
              onClick={onCancel}
            >
              {copy.preview.cancel}
            </Button>
            <Button
              size="sm"
              compact
              variant="primary"
              disabled={busy || readOnly || !question.trim()}
              onClick={async () => {
                if (submitting.current) return;
                submitting.current = true;
                setBusy(true);
                try {
                  await onAsk();
                } catch (error) {
                  onError(error);
                } finally {
                  submitting.current = false;
                  setBusy(false);
                }
              }}
            >
              {busy ? '提交中…' : copy.branch.ask}
            </Button>
          </div>
        </>
      )}
      {resizeHandle}
    </div>
  );
}
