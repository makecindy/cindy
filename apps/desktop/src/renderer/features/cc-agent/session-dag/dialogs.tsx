/** Only destructive native history operations need a confirmation dialog. */
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@/components/ui/button';

const PANEL =
  'modal-panel fixed inset-0 z-[10000] m-auto h-fit max-h-[85vh] w-[min(520px,92vw)] overflow-y-auto rounded-lg border border-border bg-popover p-4 shadow-lg';
const SCRIM = 'modal-scrim fixed inset-0 z-[10000] bg-black/40';

function DialogShell({
  open,
  onOpenChange,
  title,
  children,
  modal = true,
}: {
  modal?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      <Dialog.Portal>
        <Dialog.Overlay className={SCRIM} />
        <Dialog.Content className={PANEL} aria-describedby={undefined}>
          <Dialog.Title className="mb-3 text-15 font-medium">{title}</Dialog.Title>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function NativeHistoryDialog({
  kind,
  details,
  requiresStop,
  canConfirm,
  error,
  busy,
  onCancel,
  onConfirm,
}: {
  kind: 'delete' | 'recall';
  details: string[];
  requiresStop?: boolean;
  canConfirm: boolean;
  error: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell
      open
      onOpenChange={open => { if (!open && !busy) onCancel(); }}
      title={kind === 'delete' ? '删除此卡及后续分支' : '撤回提问'}
    >
      <p className="mb-2 text-12 text-[var(--text-secondary)]">
        {!error && !details.length ? '正在核对原生对话记录…' : '确认前请核对范围。此操作不会撤销工具已经修改的文件或已发送到外部的内容。'}
      </p>
      <ul className="mb-2 list-disc space-y-1 pl-5 text-12">
        {details.map((line, i) => <li key={i} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{line}</li>)}
      </ul>
      {requiresStop && <p className="mb-2 text-12 text-[var(--text-warning)]">此操作会先停止并移除正在进行的回合。</p>}
      {error && <p role="alert" className="mb-2 text-12 text-[var(--text-danger)]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onCancel}>取消</Button>
        <Button variant="secondary" size="sm" disabled={busy || !details.length || !canConfirm} onClick={onConfirm}>
          {busy ? '正在核对…' : kind === 'delete' ? '确认删除' : '确认撤回'}
        </Button>
      </div>
    </DialogShell>
  );
}
