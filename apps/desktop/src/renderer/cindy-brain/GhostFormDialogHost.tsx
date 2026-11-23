import * as Dialog from '@radix-ui/react-dialog';
import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  ghostFormMissingRequired,
  type GhostFormAnswer,
  type GhostFormLeafField,
  type GhostFormLeafValue,
  type GhostFormListField,
  type GhostFormListItem,
  type GhostFormSpec,
  type GhostFormValues,
} from '@/../shared/ghostForm';

/**
 * GhostFormDialogHost —— form 槽的 renderer 落地(2026-11-23)。
 *
 * 插件经管子请主机弹表单(main:formSlot → ghostFormDialogBridge),这里用 Cindy 自己的
 * 弹窗外壳(.modal-scrim / .modal-panel)和标准表单组件把它画出来,遮罩盖住整个窗口。
 *
 * 版式(DESIGN.md §4 Dialog & Modal「Plugin form dialog」,用户裁决 2026-11-23):
 * - 弹窗固定高度,内容多了在正文里滚动,增删条目时弹窗不跟着变高;
 * - 字段是「左标签、右控件」的行,排得齐、占得少;
 * - 列表条目平时收成一行摘要(第一个文本字段作标题,下拉/分段的选中项作副标题),
 *   同时只展开一条编辑;新加的条目自动展开;
 * - 必填项不预留报错空位:点保存时才校验,展开第一条有问题的条目并就地提示。
 *
 * 信任边界(与确认弹窗同款):身份头(图标 + 名字)来自 main 的已装清单;插件给的文案都是
 * main 净化过的纯文本,只作文本节点渲染;点击才是答案,main 只认本窗口的回包并按原表单收口。
 * main 只投获得焦点的那个窗口、全局同时只有一个表单;dismissed = main 那边已按取消结算,这里直接收起。
 * 挂载点:App.tsx 的 ConfirmDialogProvider 内部(额外操作的二次确认要用 useConfirmDialog)。
 */

interface FormRequest {
  requestId: string;
  ghostId: string;
  ghostName: string;
  iconDataUrl?: string;
  spec: GhostFormSpec;
}

async function sendAnswer(requestId: string, answer: GhostFormAnswer): Promise<void> {
  try {
    await window.electronAPI.ghosts?.resolveForm?.(requestId, answer);
  } catch {
    // 回包失败(窗口正在关等):main 侧的窗口关闭监听与超时会按取消兜底。
  }
}

export function GhostFormDialogHost() {
  const [current, setCurrent] = useState<FormRequest | null>(null);
  const currentRef = useRef<FormRequest | null>(null);
  currentRef.current = current;

  useEffect(() => {
    const api = window.electronAPI.ghosts;
    const offRequest = api?.onFormRequest?.((payload) => {
      if (!payload || typeof payload.requestId !== 'string' || !payload.spec || !Array.isArray(payload.spec.fields)) return;
      // main 全局单飞,正常不会叠;万一叠了,旧的按取消回包,换成新的。
      const previous = currentRef.current;
      if (previous && previous.requestId !== payload.requestId) void sendAnswer(previous.requestId, { outcome: 'cancel' });
      setCurrent(payload);
    });
    const offDismiss = api?.onFormDismissed?.(({ requestId }) => {
      setCurrent((value) => (value && value.requestId === requestId ? null : value));
    });
    return () => {
      offRequest?.();
      offDismiss?.();
      const open = currentRef.current;
      if (open) void sendAnswer(open.requestId, { outcome: 'cancel' });
    };
  }, []);

  if (!current) return null;
  return (
    <GhostFormDialog
      key={current.requestId}
      request={current}
      onDone={(answer) => {
        void sendAnswer(current.requestId, answer);
        setCurrent(null);
      }}
    />
  );
}

function emptyItem(field: GhostFormListField): GhostFormListItem {
  const item: GhostFormListItem = {};
  for (const inner of field.fields) {
    item[inner.key] = inner.type === 'switch' ? false : inner.type === 'choice' ? inner.options[0].value : '';
  }
  return item;
}

/** 条目摘要:第一个单行文本字段作标题;下拉与分段的选中项(按字段顺序)作副标题。 */
function itemSummary(field: GhostFormListField, item: GhostFormListItem): { title: string; detail: string } {
  const titleField = field.fields.find((inner) => inner.type === 'text');
  const title = titleField && typeof item[titleField.key] === 'string' ? (item[titleField.key] as string).trim() : '';
  const detail = field.fields
    .filter((inner) => inner.type === 'select' || inner.type === 'choice')
    .map((inner) => (inner.type === 'select' || inner.type === 'choice')
      ? inner.options.find((option) => option.value === item[inner.key])?.label ?? ''
      : '')
    .filter(Boolean)
    .join(' · ');
  return { title, detail };
}

/** 左标签、右控件的一行(FormField 保留 label / 说明 / 报错的关联;报错落在控件下方)。 */
const ROW_CLASS =
  'grid grid-cols-[104px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 [&>div:first-child]:min-h-9 [&>div:first-child]:items-center [&>div:nth-child(3)]:col-start-2 max-[520px]:grid-cols-1 max-[520px]:[&>div:nth-child(3)]:col-start-1';

function GhostFormDialog({ request, onDone }: { request: FormRequest; onDone: (answer: GhostFormAnswer) => void }) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { spec, ghostName, iconDataUrl } = request;
  const baseId = useId();
  const [values, setValues] = useState<GhostFormValues>(() => structuredClone(spec.values));
  // 列表条目的稳定 key(增删时其余条目不重建、焦点不乱跳)。
  const nextRowKey = useRef(0);
  const [rowKeys, setRowKeys] = useState<Record<string, number[]>>(() => {
    const keys: Record<string, number[]> = {};
    for (const field of spec.fields) {
      if (field.type !== 'list') continue;
      const items = Array.isArray(spec.values[field.key]) ? (spec.values[field.key] as GhostFormListItem[]) : [];
      keys[field.key] = items.map(() => nextRowKey.current++);
    }
    return keys;
  });
  // 每个列表同时只展开一条;只有一条时直接展开。
  const [expanded, setExpanded] = useState<Record<string, number | null>>(() => {
    const open: Record<string, number | null> = {};
    for (const [key, keys] of Object.entries(rowKeys)) open[key] = keys.length === 1 ? keys[0] : null;
    return open;
  });
  const [showErrors, setShowErrors] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const missing = new Set(showErrors ? ghostFormMissingRequired(spec.fields, values) : []);
  const leafId = (key: string) => `${baseId}-${key}`;
  const itemId = (listKey: string, rowKey: number, key: string) => `${baseId}-${listKey}-${rowKey}-${key}`;
  const focusLater = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  const setLeaf = (key: string, value: GhostFormLeafValue) => setValues((prev) => ({ ...prev, [key]: value }));
  const setItemLeaf = (listKey: string, index: number, key: string, value: GhostFormLeafValue) =>
    setValues((prev) => {
      const items = [...((prev[listKey] as GhostFormListItem[]) ?? [])];
      items[index] = { ...items[index], [key]: value };
      return { ...prev, [listKey]: items };
    });

  const addItem = (field: GhostFormListField) => {
    const rowKey = nextRowKey.current++;
    setValues((prev) => ({ ...prev, [field.key]: [...((prev[field.key] as GhostFormListItem[]) ?? []), emptyItem(field)] }));
    setRowKeys((prev) => ({ ...prev, [field.key]: [...(prev[field.key] ?? []), rowKey] }));
    setExpanded((prev) => ({ ...prev, [field.key]: rowKey }));
    focusLater(itemId(field.key, rowKey, field.fields[0].key));
  };
  const removeItem = (field: GhostFormListField, index: number) => {
    setValues((prev) => ({ ...prev, [field.key]: ((prev[field.key] as GhostFormListItem[]) ?? []).filter((_, i) => i !== index) }));
    setRowKeys((prev) => ({ ...prev, [field.key]: (prev[field.key] ?? []).filter((_, i) => i !== index) }));
    setExpanded((prev) => ({ ...prev, [field.key]: null }));
    focusLater(`${baseId}-${field.key}-add`);
  };

  const save = () => {
    const unfilled = ghostFormMissingRequired(spec.fields, values);
    if (unfilled.length) {
      setShowErrors(true);
      const [listKey, index, key] = unfilled[0].split('.');
      if (key === undefined) {
        focusLater(leafId(listKey));
      } else {
        const rowKey = rowKeys[listKey]?.[Number(index)] ?? -1;
        setExpanded((prev) => ({ ...prev, [listKey]: rowKey }));
        focusLater(itemId(listKey, rowKey, key));
      }
      return;
    }
    onDone({ outcome: 'submit', values });
  };

  const runAction = async () => {
    const action = spec.action;
    if (!action) return;
    if (action.confirm) {
      setConfirming(true);
      const ok = await confirm({
        title: action.text,
        description: action.confirm,
        confirmText: action.text,
        ...(action.danger ? { confirmVariant: 'destructive' as const } : {}),
      });
      setConfirming(false);
      if (!ok) return;
    }
    onDone({ outcome: 'action' });
  };

  /** 不走 FormField 的控件(分段、开关)也用同一行版式;label 用 id 关联。 */
  const plainRow = (id: string, label: string, control: ReactNode) => (
    <div key={id} className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 max-[520px]:grid-cols-1 max-[520px]:gap-y-1">
      <span id={`${id}-label`} className="text-13 font-medium text-[var(--settings-section-title)]">{label}</span>
      <div className="flex min-h-9 min-w-0 items-center">{control}</div>
    </div>
  );

  const renderLeaf = (field: GhostFormLeafField, value: GhostFormLeafValue | undefined, id: string, invalid: boolean, onChange: (value: GhostFormLeafValue) => void) => {
    const error = invalid ? t('settings.ghosts.form.required') : undefined;
    switch (field.type) {
      case 'text':
      case 'textarea':
        return (
          <FormField key={id} id={id} label={field.label} hint={field.hint ?? undefined} error={error} required={field.required} className={ROW_CLASS}>
            {(control) =>
              field.type === 'text' ? (
                <Input {...control} surface="ivory" value={typeof value === 'string' ? value : ''} onChange={onChange}
                  placeholder={field.placeholder ?? undefined} maxLength={field.maxLength} />
              ) : (
                <Textarea {...control} surface="ivory" rows={2} value={typeof value === 'string' ? value : ''} onChange={onChange}
                  placeholder={field.placeholder ?? undefined} maxLength={field.maxLength} />
              )
            }
          </FormField>
        );
      case 'select':
        return (
          <FormField key={id} id={id} label={field.label} hint={field.hint ?? undefined} error={error} required={field.required} className={ROW_CLASS}>
            {(control) => (
              <Select {...control} width="full" label={field.placeholder ?? field.label} value={typeof value === 'string' ? value : ''}
                options={field.options} onValueChange={onChange} />
            )}
          </FormField>
        );
      case 'choice':
        return plainRow(id, field.label, (
          <SegmentedControl
            aria-label={field.label}
            value={typeof value === 'string' ? value : field.options[0].value}
            onValueChange={onChange}
            // 第一个选项带字段 id,打开时若它是第一个字段就能聚焦到。
            options={field.options.map((option, index) => ({ value: option.value, label: option.label, ...(index === 0 ? { id } : {}) }))}
          />
        ));
      case 'switch':
        return plainRow(id, field.label, (
          <Switch id={id} aria-labelledby={`${id}-label`} checked={value === true} onCheckedChange={(checked) => onChange(checked === true)} />
        ));
    }
  };

  const renderList = (field: GhostFormListField) => {
    const items = Array.isArray(values[field.key]) ? (values[field.key] as GhostFormListItem[]) : [];
    const keys = rowKeys[field.key] ?? [];
    return (
      <section key={field.key} className="flex min-w-0 flex-col gap-2" aria-labelledby={`${baseId}-${field.key}-label`}>
        <h3 id={`${baseId}-${field.key}-label`} className="text-13 font-medium text-[var(--settings-section-title)]">
          {field.label}
          {items.length > 0 && <span className="ml-1.5 font-normal text-[var(--text-tertiary)]">{items.length}</span>}
        </h3>
        {field.hint && <p className="text-12 leading-snug text-[var(--form-field-hint)]">{field.hint}</p>}
        {items.map((item, index) => {
          const rowKey = keys[index] ?? index;
          const open = expanded[field.key] === rowKey;
          const summary = itemSummary(field, item);
          const fallbackTitle = t('settings.ghosts.form.itemTitle', { label: field.itemLabel, index: index + 1 });
          const incomplete = field.fields.some((inner) => missing.has(`${field.key}.${index}.${inner.key}`));
          const head = (
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
              <span className={cn('truncate text-13 font-medium', summary.title ? 'text-[var(--settings-section-title)]' : 'text-[var(--text-tertiary)]')}>
                {summary.title || fallbackTitle}
              </span>
              {!open && (incomplete || summary.detail) && (
                <span className={cn('truncate text-12', incomplete ? 'text-[var(--error-fg)]' : 'text-[var(--settings-section-desc)]')}>
                  {incomplete ? t('settings.ghosts.form.incomplete') : summary.detail}
                </span>
              )}
            </span>
          );
          return (
            <div key={rowKey} className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--surface)]">
              <div className="flex min-w-0 items-center gap-2 py-1.5 pl-3 pr-1.5">
                <button
                  type="button"
                  className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-lg outline-none"
                  aria-expanded={open}
                  onClick={() => setExpanded((prev) => ({ ...prev, [field.key]: open ? null : rowKey }))}
                >
                  {head}
                  <ChevronDown size={16} aria-hidden="true"
                    className={cn('shrink-0 text-[var(--text-tertiary)] transition-transform duration-[var(--motion-fast)] motion-reduce:transition-none', open && 'rotate-180')} />
                </button>
                {open && (
                  <Tip text={t('settings.ghosts.form.removeItem')}>
                    <Button variant="secondary" size="md" className="w-8 shrink-0 px-0"
                      aria-label={t('settings.ghosts.form.removeNamed', { name: summary.title || fallbackTitle })}
                      onClick={() => removeItem(field, index)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </Button>
                  </Tip>
                )}
              </div>
              {open && (
                <div className="flex flex-col gap-3 border-t border-[var(--settings-theme-card-border)] p-3">
                  {field.fields.map((inner) =>
                    renderLeaf(inner, item[inner.key], itemId(field.key, rowKey, inner.key), missing.has(`${field.key}.${index}.${inner.key}`),
                      (value) => setItemLeaf(field.key, index, inner.key, value)))}
                </div>
              )}
            </div>
          );
        })}
        {items.length < field.maxItems && (
          <Button id={`${baseId}-${field.key}-add`} variant="secondary" className="gap-1.5 self-start" onClick={() => addItem(field)}>
            <Plus size={14} aria-hidden="true" />
            {field.addText ?? t('settings.ghosts.form.addItem')}
          </Button>
        )}
      </section>
    );
  };

  /** 打开时聚焦主要输入:先找顶层文字/下拉,再找展开条目里的第一项,最后才落到开关、分段或「添加」。 */
  const firstFocusable = () => {
    const isInput = (f: { type: string }) => f.type === 'text' || f.type === 'textarea' || f.type === 'select';
    const topInput = spec.fields.find(isInput);
    if (topInput) return leafId(topInput.key);
    for (const field of spec.fields) {
      if (field.type !== 'list') continue;
      const open = expanded[field.key];
      if (open !== null && open !== undefined) return itemId(field.key, open, (field.fields.find(isInput) ?? field.fields[0]).key);
    }
    const first = spec.fields[0];
    return first.type === 'list' ? `${baseId}-${first.key}-add` : leafId(first.key);
  };

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open && !confirming) onDone({ outcome: 'cancel' }); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-modal" />
        <Dialog.Content
          // 打开期间可能再弹全局确认框(额外操作的二次确认),面板与遮罩同在 modal 层,按 DOM 顺序叠放。
          // 固定高度:增删条目时弹窗不跟着变高,正文自己滚动。
          className="modal-panel fixed inset-0 z-modal m-auto flex h-[min(640px,85vh)] w-[min(600px,calc(100vw-32px))] flex-col outline-none [&_button:focus-visible]:outline-none [&_button:focus-visible]:ring-2 [&_button:focus-visible]:ring-[var(--focus-ring)]"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById(firstFocusable())?.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (confirming || event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="flex shrink-0 flex-col gap-1 p-4 pb-3">
            {/* 身份头:来自已装清单,插件写不了 */}
            <span className="inline-flex min-w-0 items-center gap-1.5">
              {iconDataUrl && <img src={iconDataUrl} alt="" draggable={false} className="h-4 w-4 shrink-0 rounded-[4px] object-cover" />}
              <span className="truncate text-12 font-medium leading-snug text-[var(--text-tertiary)]">{ghostName}</span>
            </span>
            <div className="flex min-w-0 items-baseline gap-2">
              <Dialog.Title className="min-w-0 truncate text-18 font-medium text-[var(--settings-section-title)]">{spec.title}</Dialog.Title>
              {spec.description ? (
                <Dialog.Description className="min-w-0 truncate text-13 text-[var(--settings-section-desc)]">{spec.description}</Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{t('settings.ghosts.form.srDescription', { name: ghostName })}</Dialog.Description>
              )}
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto border-y border-[var(--border-default)] px-4 py-4">
            {spec.fields.map((field) =>
              field.type === 'list'
                ? renderList(field)
                : renderLeaf(field, values[field.key] as GhostFormLeafValue | undefined, leafId(field.key), missing.has(field.key),
                    (value) => setLeaf(field.key, value)))}
          </div>
          {/* 额外操作(如「删除关注」)不是提交表单:单独放在底部左侧,取消与保存留在右侧(DESIGN.md §4 Dialog & Modal) */}
          <div className="flex shrink-0 flex-wrap items-center gap-2.5 p-4">
            {spec.action && (spec.action.icon === 'trash' ? (
              // 图标按钮:文案作为悬停提示与读屏名字(DESIGN.md §4 Buttons 的正方形用法)。
              <Tip text={spec.action.text}>
                <Button variant="secondary" size="lg" palette="confirmation" tone={spec.action.danger ? 'danger' : 'default'}
                  className="w-9 shrink-0 px-0" aria-label={spec.action.text} disabled={confirming} onClick={() => void runAction()}>
                  <Trash2 size={16} aria-hidden="true" />
                </Button>
              </Tip>
            ) : (
              <Button variant="secondary" size="lg" palette="confirmation" tone={spec.action.danger ? 'danger' : 'default'}
                disabled={confirming} onClick={() => void runAction()}>
                {spec.action.text}
              </Button>
            ))}
            <div className="ml-auto flex flex-wrap justify-end gap-2.5">
              <Button variant="secondary" size="lg" palette="confirmation" disabled={confirming} onClick={() => onDone({ outcome: 'cancel' })}>
                {spec.cancelText ?? t('settings.ghosts.form.cancel')}
              </Button>
              <Button variant="primary" size="lg" palette="confirmation" className="min-w-[96px]" disabled={confirming} onClick={save}>
                {spec.submitText ?? t('settings.ghosts.form.save')}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
