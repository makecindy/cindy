import { useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronUp, CornerDownRight, Link2 } from 'lucide-react';
import './dagExtensions.css';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { nextDagId } from './dagOperationId';
import { DagAnswerMarkdown } from './DagAnswerMarkdown';
import type { DagAside, DagNode, ReferenceSnapshot } from './types';

// These surfaces belong to their card in graph coordinates, not a portal or a chat pane.
const panel = 'dag-extension';
const inputClass = 'min-h-7 w-full resize-none text-13';
export const asidePanelHeight = (hasHistory: boolean) => (hasHistory ? 184 : 98);
export const REFERENCE_PANEL_HEIGHT = 216;
const stop = (e: { stopPropagation(): void }) => e.stopPropagation();

export type AsideInput = { question: string; operation: string };
export function DagInlineAside({
  entries,
  turns,
  input,
  onInput,
  onAsk,
  onCollapse,
  readOnly,
}: {
  entries: DagAside[];
  turns: ReadonlyMap<string, DagNode>;
  readOnly?: boolean;
  input?: AsideInput;
  onInput: (input: AsideInput) => void;
  onAsk: (question: string, operation: string) => Promise<void>;
  onCollapse: () => void;
}) {
  const [question, setQuestion] = useState(input?.question ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const operation = useRef(input?.operation ?? '');
  function updateQuestion(value: string) {
    setQuestion(value);
    onInput({ question: value, operation: operation.current });
  }
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      role="region"
      aria-label="旁问"
      data-dag-aside
      data-dag-reading
      className={`${panel} flex flex-col gap-1 overflow-y-auto overscroll-contain`}
      style={{ height: asidePanelHeight(entries.length > 0) }}
      onPointerDown={stop}
      onDoubleClick={stop}
    >
      <div className="dag-extension-title">
        <CornerDownRight aria-hidden size={14} />
        <strong>旁问</strong>
        <button
          type="button"
          className="dag-extension-fold"
          aria-label="收起旁问"
          title="收起旁问"
          disabled={busy}
          onClick={onCollapse}
        >
          <ChevronUp aria-hidden size={15} />
        </button>
      </div>
      <div
        data-dag-reading
        className="dag-aside-history min-h-0 flex-1 select-text overflow-auto overscroll-contain"
        aria-live="polite"
      >
        {entries.map((entry) => {
          const item = turns.get(JSON.stringify([entry.sessionId, entry.userMessageId]));
          return (
            <article key={entry.id} className="pb-1">
              <div className="whitespace-pre-wrap break-words font-semibold">
                {entry.question || item?.question}
              </div>
              {item?.answer && <DagAnswerMarkdown answer={item.answer} />}
              {item?.runState === 'failed' ? (
                <span>旁问未完成，请查看原生对话中的错误。</span>
              ) : (
                !item?.answer && <span className="text-muted-foreground">已提问，等待回答…</span>
              )}
            </article>
          );
        })}
      </div>
      {error && (
        <div role="alert" className="text-[var(--text-danger)]">
          {error}
        </div>
      )}
      {!readOnly && (
        <form
          className="dag-aside-input"
          onSubmit={async (e) => {
            e.preventDefault();
            if (inFlight.current || !question.trim()) return;
            inFlight.current = true;
            setBusy(true);
            setError('');
            try {
              operation.current ||= nextDagId('aside');
              onInput({ question, operation: operation.current });
              await onAsk(question.trim(), operation.current);
              operation.current = '';
              updateQuestion('');
            } catch (err) {
              setError(err instanceof Error ? err.message : '未确认发送；已保留问题。');
            } finally {
              inFlight.current = false;
              setBusy(false);
            }
          }}
        >
          <Textarea
            aria-label="旁问问题"
            placeholder="在这里旁问…"
            rows={2}
            textareaRef={field}
            className={inputClass}
            disabled={busy}
            value={question}
            onChange={updateQuestion}
          />
          <button
            type="submit"
            className="dag-aside-submit"
            title="发送旁问"
            aria-label="发送旁问"
            aria-busy={busy}
            disabled={busy || !question.trim()}
          >
            <ArrowUp aria-hidden size={16} />
          </button>
        </form>
      )}
    </section>
  );
}

export function DagInlineReference({
  snapshot,
  targetId,
  candidates,
  readOnly,
  onCancel,
  onAsk,
}: {
  snapshot: ReferenceSnapshot;
  targetId?: string;
  candidates: DagNode[];
  readOnly?: boolean;
  onCancel: () => void;
  onAsk: (target: DagNode, snapshot: ReferenceSnapshot, question: string) => Promise<boolean>;
}) {
  const [target, select] = useState(targetId ?? '');
  const [summary, setSummary] = useState(snapshot.summary);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, []);
  return (
    <form
      aria-label="引用并提问"
      data-dag-reference-editor
      data-dag-reading
      onPointerDown={stop}
      className={`${panel} flex flex-col gap-1 overflow-y-auto overscroll-contain [&>*]:shrink-0`}
      style={{ height: REFERENCE_PANEL_HEIGHT }}
      onSubmit={async (e) => {
        e.preventDefault();
        const node = candidates.find((n) => n.id === target);
        if (readOnly || guard.current || !node || !summary.trim() || !question.trim()) return;
        guard.current = true;
        setBusy(true);
        setError('');
        try {
          if (!(await onAsk(node, { ...snapshot, summary: summary.trim() }, question.trim())))
            setError('未确认发送，已保留输入。');
        } catch (err) {
          setError(err instanceof Error ? err.message : '未确认发送，已保留输入。');
        } finally {
          guard.current = false;
          setBusy(false);
        }
      }}
    >
      <div className="dag-extension-title">
        <Link2 aria-hidden size={14} />
        <strong className="truncate" title={snapshot.question}>
          引用：{snapshot.question}
        </strong>
      </div>
      {!targetId && (
        <select
          aria-label="引用目标"
          value={target}
          disabled={busy || readOnly}
          onChange={(e) => select(e.target.value)}
        >
          <option value="">选择从哪张卡继续</option>
          {candidates.map((n) => (
            <option value={n.id} key={n.id}>
              {n.question}
            </option>
          ))}
        </select>
      )}
      <label className="dag-reference-field">
        摘要快照
        <Textarea
          aria-label="摘要快照"
          rows={2}
          className={inputClass}
          disabled={busy || readOnly}
          value={summary}
          onChange={setSummary}
        />
      </label>
      <label className="dag-reference-field">
        新问题
        <Textarea
          textareaRef={field}
          aria-label="新问题"
          rows={2}
          placeholder="带上这段引用提问…"
          className={inputClass}
          disabled={busy || readOnly}
          value={question}
          onChange={setQuestion}
        />
      </label>
      {error && (
        <div role="alert" className="text-[var(--text-danger)]">
          {error}
        </div>
      )}
      <div className="dag-reference-actions mt-auto flex justify-end gap-1">
        <Button
          type="button"
          compact
          size="sm"
          variant="secondary"
          tone="quiet"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button
          type="submit"
          compact
          size="sm"
          variant="primary"
          disabled={busy || readOnly || !target || !summary.trim() || !question.trim()}
        >
          提问
        </Button>
      </div>
    </form>
  );
}
