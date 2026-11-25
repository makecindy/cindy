import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { DagCardSummary, type CardSummaryProps } from './DagCardSummary';
import {
  Ellipsis,
  Plus,
  Link2,
  GitBranch,
  Pin,
  Unlink,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { DEFAULT_SIZE } from './layout';
import { copy } from './copy';
import { nextDagId } from './dagOperationId';
import { DagAnswerMarkdown } from './DagAnswerMarkdown';
import type { AnswerVersion, DagNode, DagReference, DagActionKind } from './types';

import type { CardBoxProps } from './DagResizeHandle';

type Props = CardBoxProps & CardSummaryProps & {
  node: DagNode;
  versions: AnswerVersion[];
  selectedVersionKey: string;
  outgoingReferences: DagReference[];
  label?: string;
  selected: boolean;
  readOnly?: boolean;
  onSelectVersion: (nodeId: string, versionKey: string) => void;
  onOpen: (node: DagNode) => void;
  onPin?: (node: DagNode) => void;
  /** Resolve only after acceptance; reject to retain the question and operation ID. */
  onResubmit?: (question: string, operationId: string) => void | Promise<void>;
  onRetryFailed?: (node: DagNode) => void | Promise<void>;
  onSaveQuestion?: (question: string) => void;
  onHistory?: (node: DagNode, kind: 'delete' | 'recall') => void;
  onPreviewAction: (nodeId: string, action: DagActionKind) => void;
  onStartBranchDrag: (id: string, event: PointerEvent<HTMLButtonElement>, tap: () => void) => void;
  consumeDragClick: (id: string) => boolean;
  onOpenReferencePicker?: (nodeId: string) => void;
  onRemoveReference: (referenceId: string) => void;
  onCardPointerDown: (id: string, event: PointerEvent<HTMLElement>) => void;
  onNudge: (id: string, dx: number, dy: number) => void;
};

const control =
  'relative grid size-7 shrink-0 place-items-center rounded-md text-[var(--text-secondary)] hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2';

export function DagNodeCard({
  node,
  size = DEFAULT_SIZE,
  resizeHandle,
  versions,
  selectedVersionKey,
  outgoingReferences,
  selected,
  readOnly,
  label,
  onSelectVersion,
  onOpen,
  onPin,
  summary,
  onSummaryChange,
  onResubmit,
  onSaveQuestion,
  onRetryFailed,
  onHistory,
  onPreviewAction,
  onStartBranchDrag,
  consumeDragClick,
  onOpenReferencePicker,
  onRemoveReference,
  onCardPointerDown,
  onNudge,
}: Props) {
  const [menu, setMenu] = useState(false);
  const current = versions.find((version) => version.key === selectedVersionKey) ?? versions[0];
  const openNode = { ...node, question: current.question, answer: current.answer };
  const [branches, setBranches] = useState(false);
  const [editor, setEditor] = useState<{ question: string; operationId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(openTimer.current), [node.id, current.key]);
  const editable = !readOnly && Boolean(onResubmit || onSaveQuestion);
  function beginEdit() {
    if (!editable || inFlight.current) return;
    setError('');
    setEditor({ question: current.question, operationId: nextDagId('retry') });
  }
  function cancelEdit() {
    if (inFlight.current) return;
    setEditor(null);
    setError('');
  }
  async function run(action: () => void | Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      setEditor(null);
    } catch (err) {
      setError(err instanceof Error ? err.message || '操作失败，请重试。' : String(err || '操作失败，请重试。'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      data-session-dag-card={node.id}
      style={{ ...size }}
      className={cn(
        'dag-card relative box-border select-none border',
        selected ? 'border-[var(--text-primary)]' : 'border-border',
      )}
      onContextMenu={(event) => {
        if ((event.target as Element).closest('input,textarea')) return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(true);
      }}
    >
      <DagCardSummary question={current.question} summary={summary} onSummaryChange={readOnly ? undefined : onSummaryChange} />
      <div
        data-dag-reading
        style={node.runState === 'failed' && !editor ? { bottom: '26px' } : undefined}
        className="absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain rounded-[inherit] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-button]:hidden"
      >
        <div className="relative flex min-h-full flex-col">
          <div
            className="flex min-w-0 flex-1 cursor-grab flex-col items-stretch text-left active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button === 0 && !(event.target as Element).closest('[data-dag-answer],button,input,textarea')) {
                onCardPointerDown(node.id, event);
              }
            }}
            onClick={(event) => {
              const target = event.target as Element;
              if (editor || target.closest('a,input,textarea,button:not([data-dag-question])')) return;
              if (event.detail !== 0) {
                const selection = window.getSelection();
                if (selection?.rangeCount && !selection.isCollapsed && selection.getRangeAt(0).intersectsNode(event.currentTarget)) return;
                if (!target.closest('[data-dag-answer]') && consumeDragClick(node.id)) return;
              }
              if (onPin && (event.ctrlKey || event.metaKey)) return;
              if (event.detail > 1) return;
              if (event.detail === 1 && editable && target.closest('[data-dag-question]')) {
                clearTimeout(openTimer.current);
                openTimer.current = setTimeout(() => onOpen(openNode), 500);
              } else onOpen(openNode);
            }}
            onDoubleClick={(event) => {
              const target = event.target as Element;
              if (editor || target.closest('a,input,textarea,button:not([data-dag-question])')) return;
              clearTimeout(openTimer.current);
              if (consumeDragClick(node.id)) return;
              if (event.ctrlKey || event.metaKey) onPin?.(openNode);
              else if (target.closest('[data-dag-question]')) beginEdit();
            }}
          >
            {editor ? (
              <div className="dag-question-surface">
                <Textarea autoFocus data-dag-question-input aria-label="编辑本卡问题" rows={2}
                  value={editor.question} disabled={busy}
                  className="dag-question-input"
                  onChange={question => setEditor({ ...editor, question })}
                  onKeyDown={e => {
                    e.stopPropagation();
                    if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.keyCode !== 229) cancelEdit();
                  }} />
                <div className="mt-1 flex justify-end gap-1">
                  <Button size="sm" compact variant="secondary" disabled={busy} onClick={cancelEdit}>取消</Button>
                  {onSaveQuestion && <Button data-dag-save-question size="sm" compact variant="secondary"
                    disabled={readOnly || busy || !editor.question.trim() || editor.question === current.question}
                    onClick={() => void run(() => onSaveQuestion(editor.question))}>仅保存</Button>}
                  <Button data-dag-resubmit size="sm" compact disabled={readOnly || busy || !onResubmit || !editor.question.trim()}
                    onClick={() => onResubmit && void run(() => onResubmit(editor.question, editor.operationId))}>
                    {busy ? '提交中…' : '重新提问'}
                  </Button>
                </div>
              </div>
            ) : <button
              data-dag-question type="button"
              title={editable ? '单击打开，双击或按 F2 编辑问题' : undefined}
              aria-label={`${copy.card.open}：${current.question}`}
              className="dag-question-surface shrink-0 cursor-grab touch-none whitespace-pre-wrap text-left [overflow-wrap:anywhere] active:cursor-grabbing focus-visible:outline focus-visible:outline-2"
              onPointerDown={e => {
                if (e.button === 0) onCardPointerDown(node.id, e);
              }}
              onKeyDown={(event) => {
                if (event.key === 'F2' && editable) { event.preventDefault(); beginEdit(); return; }
                const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
                if (delta) {
                  event.preventDefault();
                  onNudge(node.id, delta[0] * 16, delta[1] * 16);
                }
              }}
            >
              {current.question}
            </button>}
            {error && editor && <p role="alert" className="dag-meta break-words text-[var(--error-fg)]">{error}</p>}
            <DagAnswerMarkdown answer={current.answer} />
            {(node.side || label || current.manual || outgoingReferences.length > 0) && (
              <span className="dag-meta flex flex-wrap items-center gap-1 text-[var(--text-secondary)]">
                {node.side && (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch size={12} />
                    {copy.card.sideBadge}
                  </span>
                )}
                {label && (
                  <span className="min-w-0 truncate" title={label}>
                    · {label}
                  </span>
                )}
                {current.manual && (
                  <span title={copy.card.manualHint}>· {copy.card.manualRevision}</span>
                )}
                {outgoingReferences.length > 0 && (
                  <span
                    className="inline-flex items-center gap-0.5"
                    aria-label={`${copy.edge.reference} ${outgoingReferences.length}`}
                  >
                    <Link2 size={11} />
                    {outgoingReferences.length}
                  </span>
                )}
              </span>
            )}
          </div>
        </div>
      </div>
      <DropdownMenu modal={false} open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(control, 'dag-manage')}
            aria-label={copy.card.menu}
            title={copy.card.menu}
          >
            <Ellipsis size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          collisionPadding={8}
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-[min(19rem,90vw)] overflow-y-auto"
        >
          {onPin && (
            <DropdownMenuItem onSelect={() => onPin(openNode)}>
              <Pin size={14} className="mr-2" />
              {copy.card.pin}
            </DropdownMenuItem>
          )}
          {onHistory && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => onHistory(node, 'recall')}>
                <Undo2 size={14} className="mr-2" />撤回提问
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onHistory(node, 'delete')}>
                <Trash2 size={14} className="mr-2" />删除此卡及后续分支
              </DropdownMenuItem>
            </>
          )}
          {versions.length > 1 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{copy.card.history}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={current.key}
                onValueChange={(key) => onSelectVersion(node.id, key)}
              >
                {versions.map((version) => (
                  <DropdownMenuRadioItem key={version.key} value={version.key}>
                    {version.manual
                      ? `${copy.card.manualRevision} · ${new Date(version.createdAt!).toLocaleTimeString()}`
                      : copy.card.origin}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </>
          )}
          {outgoingReferences.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{copy.edge.reference}</DropdownMenuLabel>
              {outgoingReferences.map((reference) => (
                <div key={reference.id}>
                  <div className="break-words px-2 py-1 text-12">
                    <strong>{reference.snapshot.question}</strong>
                    <p className="whitespace-pre-wrap text-[var(--text-secondary)]">
                      {reference.snapshot.summary}
                    </p>
                  </div>
                  <DropdownMenuItem onSelect={() => onRemoveReference(reference.id)}>
                    <Unlink size={14} className="mr-2" />
                    {copy.card.removeReference}
                  </DropdownMenuItem>
                </div>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {node.runState === 'failed' && !editor && (
        <div className="dag-failure">
          <span role={error ? 'alert' : undefined} title={error || undefined}
            className="min-w-0 truncate text-[var(--error-fg)]">{error || '此轮失败'}</span>
          <Button data-dag-retry-failed size="sm" compact variant="secondary" disabled={readOnly || !onRetryFailed || busy}
            onClick={() => onRetryFailed && void run(() => onRetryFailed(node))}>
            {busy ? '重试中…' : '重试原问题'}
          </Button>
        </div>
      )}
      <DropdownMenu modal={false} open={branches} onOpenChange={setBranches}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="从此轮继续或旁问"
            disabled={readOnly}
            title={readOnly ? '当前只读，无法提问' : '拖回本卡：在卡底旁问；拖到空白：从本卡推进；拖到另一张历史卡：从目标卡推进并引用本卡。'}
            onPointerDown={(event) => {
              if (event.button !== 0 || event.ctrlKey) return;
              // Radix normally opens on pointerdown, before a drag can be distinguished.
              event.preventDefault();
              onStartBranchDrag(node.id, event, () => setBranches(true));
            }}
            onClick={(event) => {
              if (event.detail === 0) setBranches(true);
            }}
            className="absolute right-0 top-1/2 grid size-7 touch-none cursor-crosshair translate-x-1/2 -translate-y-1/2 place-items-center rounded-full text-[var(--text-secondary)] hover:text-foreground"
          >
            <span className="grid size-5 place-items-center rounded-full border border-border bg-popover">
              <Plus size={13} />
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem disabled={readOnly} onSelect={() => onPreviewAction(node.id, 'advance')}>
            {copy.card.advance}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={readOnly} onSelect={() => onPreviewAction(node.id, 'aside')}>
            {copy.card.aside}
          </DropdownMenuItem>
          {onOpenReferencePicker && (
            <DropdownMenuItem disabled={readOnly} onSelect={() => onOpenReferencePicker(node.id)}>{copy.card.reference}</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <span
        aria-hidden
        className="pointer-events-none absolute left-0 top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--text-tertiary)] bg-popover"
      />
      {resizeHandle}
    </div>
  );
}
