import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { Check, PenLine, Search } from 'lucide-react';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Input, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { extractIpcError } from '@/utils/ipcError';
import {
  BOT_MEMORY_BODY_MAX_BYTES,
  BOT_MEMORY_CHANGED,
  BOT_MEMORY_TITLE_MAX,
  BOT_MEMORY_TYPES,
  type BotMemoryDetail,
  type BotMemorySummary,
} from '../../../shared/botMemory';
import { useBotTranslation } from './botPronounContext';

const SEARCH_DEBOUNCE_MS = 200;
const SAVE_DEBOUNCE_MS = 800;

type View =
  { kind: 'list' } | { kind: 'detail'; filename: string } | { kind: 'edit'; filename: string };
type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'conflict';

const memoryApi = () => window.electronAPI.localDb.bots.memory;
const isConflict = (error: unknown) => {
  const ipc = extractIpcError(error);
  return ipc?.code === 'PRECONDITION_FAILED' && ipc.message.includes(BOT_MEMORY_CHANGED);
};
const normalizeTitle = (title: string) => title.replace(/\s+/g, ' ').trim();
const bodyTooLong = (body: string) =>
  new TextEncoder().encode(body.trim()).length > BOT_MEMORY_BODY_MAX_BYTES;

function useDateLabels() {
  const { t, i18n } = useBotTranslation();
  return useMemo(() => {
    const dayKey = (value: Date) => value.toDateString();
    const locale = i18n?.language;
    const dateFormat = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    const timeFormat = new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
    const day = (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return dayKey(date) === dayKey(new Date()) ? t('bots.memory.today') : dateFormat.format(date);
    };
    const stamp = (iso: string) => {
      const date = new Date(iso);
      if (Number.isNaN(date.getTime())) return '';
      return `${day(iso)} ${timeFormat.format(date)}`;
    };
    return { day, stamp };
  }, [i18n?.language, t]);
}

/**
 * 伙伴设置里的「记忆」页:列表(分组 / 搜索)→ 详情 → 编辑。
 * 返回与离开由上层设置页的返回键驱动:`backRef` 先在页内回退,`leaveRef` 保证离开前落盘。
 */
export function BotMemorySettings({
  botId,
  botName,
  memoryEnabled,
  onMemoryEnabledChange,
  backRef,
  leaveRef,
}: {
  botId: string;
  botName: string;
  memoryEnabled: boolean;
  onMemoryEnabledChange: (enabled: boolean) => void;
  backRef: MutableRefObject<(() => Promise<boolean>) | null>;
  leaveRef: MutableRefObject<(() => Promise<boolean>) | null>;
}) {
  const { t } = useBotTranslation();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [detail, setDetail] = useState<BotMemoryDetail | null>(null);
  const editorRef = useRef<{ flush: () => Promise<boolean> } | null>(null);

  const openDetail = useCallback((filename: string) => setView({ kind: 'detail', filename }), []);
  // Stable: the detail view reloads whenever these identities change.
  const showList = useCallback(() => setView({ kind: 'list' }), []);

  useEffect(() => {
    backRef.current = async () => {
      if (view.kind === 'edit') {
        if (!(await (editorRef.current?.flush() ?? Promise.resolve(true)))) return true;
        setView({ kind: 'detail', filename: view.filename });
        return true;
      }
      if (view.kind === 'detail') {
        setView({ kind: 'list' });
        return true;
      }
      return false;
    };
    leaveRef.current = async () => (await editorRef.current?.flush()) ?? true;
    return () => {
      backRef.current = null;
      leaveRef.current = null;
    };
  }, [backRef, leaveRef, view]);

  if (view.kind === 'list') {
    return (
      <MemoryList
        botId={botId}
        memoryEnabled={memoryEnabled}
        onMemoryEnabledChange={onMemoryEnabledChange}
        onOpen={openDetail}
      />
    );
  }
  if (view.kind === 'edit' && detail?.filename === view.filename) {
    return (
      <MemoryEditor
        botId={botId}
        botName={botName}
        initial={detail}
        editorRef={editorRef}
        onSaved={setDetail}
        onDone={() => setView({ kind: 'detail', filename: view.filename })}
      />
    );
  }
  return (
    <MemoryDetail
      botId={botId}
      botName={botName}
      filename={view.filename}
      onLoaded={setDetail}
      onEdit={() => setView({ kind: 'edit', filename: view.filename })}
      onDeleted={() => {
        setDetail(null);
        setView({ kind: 'list' });
        toast.success(t('bots.memory.deleted'));
      }}
      onMissing={showList}
    />
  );
}

function MemoryList({
  botId,
  memoryEnabled,
  onMemoryEnabledChange,
  onOpen,
}: {
  botId: string;
  memoryEnabled: boolean;
  onMemoryEnabledChange: (enabled: boolean) => void;
  onOpen: (filename: string) => void;
}) {
  const { t } = useBotTranslation();
  const { day } = useDateLabels();
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<BotMemorySummary[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const search = query.trim();
    const run = () => {
      memoryApi()
        .list(botId, search || undefined)
        .then((next) => {
          if (cancelled) return;
          setEntries(next);
          if (!search) setTotal(next.length);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    const timer = search ? setTimeout(run, SEARCH_DEBOUNCE_MS) : null;
    if (!timer) run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [botId, query, reload]);

  const groups = BOT_MEMORY_TYPES.map((type) => ({
    type,
    items: (entries ?? []).filter((entry) => entry.type === type),
  })).filter((group) => group.items.length);

  return (
    <div className="flex flex-col gap-4 pt-1">
      <div className="flex min-h-[52px] items-center justify-between gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3">
        <div className="min-w-0">
          <p className="text-14 text-[var(--text-primary)]">{t('bots.memory.enabled')}</p>
          {!memoryEnabled ? (
            <p className="mt-0.5 text-12 text-[var(--text-secondary)]">
              {t('bots.memory.disabledHint')}
            </p>
          ) : null}
        </div>
        <Switch
          checked={memoryEnabled}
          onCheckedChange={onMemoryEnabledChange}
          aria-label={t('bots.memory.enabled')}
        />
      </div>
      {failed ? (
        <div
          className="flex flex-col items-center gap-3 py-10 text-13 text-[var(--text-secondary)]"
          role="alert"
        >
          {t('bots.memory.loadFailed')}
          <Button variant="secondary" size="md" onClick={() => setReload((value) => value + 1)}>
            {t('commonUi.retry')}
          </Button>
        </div>
      ) : entries === null ? (
        <div className="flex justify-center py-10">
          <Spinner size={16} />
        </div>
      ) : total === 0 && !query.trim() ? (
        <p className="py-12 text-center text-13 text-[var(--text-secondary)]">
          {t('bots.memory.empty')}
        </p>
      ) : (
        <div className={cn('flex flex-col gap-4', !memoryEnabled && 'opacity-60')}>
          <div className="relative">
            <Search
              size={14}
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-[var(--text-tertiary)]"
            />
            <Input
              size="md"
              value={query}
              onChange={setQuery}
              ariaLabel={t('bots.memory.search')}
              placeholder={t('bots.memory.search')}
              inputClassName="pl-8"
            />
          </div>
          {groups.length ? (
            groups.map((group) => (
              <section key={group.type} aria-label={t(`bots.memory.types.${group.type}`)}>
                <h3 className="flex items-baseline gap-1.5 px-1 pb-2 text-12 font-medium text-[var(--text-secondary)]">
                  {t(`bots.memory.types.${group.type}`)}
                  <span className="font-normal tabular-nums text-[var(--text-tertiary)]">
                    {group.items.length}
                  </span>
                </h3>
                <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
                  {group.items.map((entry) => (
                    <button
                      key={entry.filename}
                      type="button"
                      onClick={() => onOpen(entry.filename)}
                      className="block w-full border-b border-[var(--border-default)] px-4 py-3 text-left last:border-b-0 hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                    >
                      <span className="flex items-start gap-3">
                        <span className="min-w-0 flex-1 break-words text-14 font-medium leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]">
                          {entry.title}
                        </span>
                        <span className="shrink-0 pt-0.5 text-11 tabular-nums text-[var(--text-tertiary)]">
                          {day(entry.updatedAt)}
                        </span>
                      </span>
                      <span className="mt-1 line-clamp-2 break-words text-12 leading-[1.55] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                        {entry.preview}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          ) : (
            <p className="py-12 text-center text-13 text-[var(--text-secondary)]">
              {t('bots.memory.noResults')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function MemoryDetail({
  botId,
  botName,
  filename,
  onLoaded,
  onEdit,
  onDeleted,
  onMissing,
}: {
  botId: string;
  botName: string;
  filename: string;
  onLoaded: (detail: BotMemoryDetail) => void;
  onEdit: () => void;
  onDeleted: () => void;
  onMissing: () => void;
}) {
  const { t } = useBotTranslation();
  const { stamp } = useDateLabels();
  const { confirm } = useConfirmDialog();
  const [detail, setDetail] = useState<BotMemoryDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    memoryApi()
      .read(botId, filename)
      .then((next) => {
        if (cancelled) return;
        setDetail(next);
        onLoaded(next);
        setFailed(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (extractIpcError(error)?.code === 'NOT_FOUND') onMissing();
        else setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, filename, reload, onLoaded, onMissing]);

  const remove = async () => {
    if (!detail || busy) return;
    const ok = await confirm({
      presentation: 'standard',
      title: t('bots.memory.deleteTitle'),
      description: t('bots.memory.deleteDescription', { name: botName, title: detail.title }),
      confirmText: t('bots.memory.delete'),
      cancelText: t('bots.memory.cancel'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await memoryApi().delete({ botId, filename, expectedUpdatedAt: detail.updatedAt });
      onDeleted();
    } catch (error) {
      if (isConflict(error)) {
        setChanged(true);
        setReload((value) => value + 1);
      } else if (extractIpcError(error)?.code === 'NOT_FOUND') {
        onDeleted();
      } else {
        toast.error(t('bots.memory.deleteFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  if (failed) {
    return (
      <div
        className="flex flex-col items-center gap-3 py-10 text-13 text-[var(--text-secondary)]"
        role="alert"
      >
        {t('bots.memory.loadFailed')}
        <Button variant="secondary" size="md" onClick={() => setReload((value) => value + 1)}>
          {t('commonUi.retry')}
        </Button>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="flex justify-center py-10">
        <Spinner size={16} />
      </div>
    );
  }
  return (
    <article className="pt-2">
      {changed ? (
        <p
          className="mb-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-12 text-[var(--text-secondary)]"
          role="status"
        >
          {t('bots.memory.changedTitle', { name: botName })}
        </p>
      ) : null}
      <h3 className="break-words text-16 font-medium leading-[1.45] text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {detail.title}
      </h3>
      <p className="mt-1.5 text-12 text-[var(--text-secondary)]">
        {t(`bots.memory.types.${detail.type}`)} ·{' '}
        {t('bots.memory.updated', { time: stamp(detail.updatedAt) })}
      </p>
      <div className="mt-4 text-14 leading-[1.75] text-[var(--text-primary)]">
        <MarkdownRenderer workingDir="" content={detail.body} allowPrivilegedLinks={false} />
      </div>
      <div className="mt-6 flex items-center gap-2 border-t border-[var(--border-default)] pt-4">
        <Button variant="secondary" size="md" onClick={onEdit} disabled={busy}>
          <PenLine size={14} aria-hidden="true" />
          {t('bots.memory.edit')}
        </Button>
        <span className="flex-1" />
        <Button
          variant="secondary"
          tone="quiet"
          size="md"
          onClick={() => void remove()}
          loading={busy}
        >
          {t('bots.memory.delete')}
        </Button>
      </div>
    </article>
  );
}

function MemoryEditor({
  botId,
  botName,
  initial,
  editorRef,
  onSaved,
  onDone,
}: {
  botId: string;
  botName: string;
  initial: BotMemoryDetail;
  editorRef: MutableRefObject<{ flush: () => Promise<boolean> } | null>;
  onSaved: (detail: BotMemoryDetail) => void;
  onDone: () => void;
}) {
  const { t } = useBotTranslation();
  const { confirm } = useConfirmDialog();
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [state, setState] = useState<SaveState>('idle');
  const [latest, setLatest] = useState<BotMemoryDetail | null>(null);
  const saved = useRef(initial);
  const draft = useRef({ title: initial.title, body: initial.body });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const blocked = useRef(false);

  const invalid = !title.trim() || !body.trim() || bodyTooLong(body);
  // 与主进程保存时的规范化一致,避免只差空白的标题永远算作未保存。
  const isDirty = () =>
    normalizeTitle(draft.current.title) !== saved.current.title ||
    draft.current.body.trim() !== saved.current.body;
  const isValid = () =>
    Boolean(draft.current.title.trim() && draft.current.body.trim()) &&
    !bodyTooLong(draft.current.body);

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (inFlight.current) return inFlight.current;
    if (blocked.current) return false;
    if (!isDirty()) return true;
    if (!isValid()) return false;
    const run = (async () => {
      setState('saving');
      try {
        // Edits made while a save is in flight must also reach disk before leaving.
        while (isDirty()) {
          if (!isValid()) {
            setState('idle');
            return false;
          }
          const next = { ...draft.current };
          const result = await memoryApi().update({
            botId,
            filename: saved.current.filename,
            title: next.title,
            body: next.body,
            expectedUpdatedAt: saved.current.updatedAt,
          });
          saved.current = result;
          onSaved(result);
        }
        setState('saved');
        return true;
      } catch (error) {
        if (isConflict(error)) {
          blocked.current = true;
          setState('conflict');
          setLatest(
            await memoryApi()
              .read(botId, saved.current.filename)
              .catch(() => null),
          );
        } else {
          setState('error');
        }
        return false;
      }
    })();
    inFlight.current = run;
    try {
      return await run;
    } finally {
      inFlight.current = null;
    }
  }, [botId, onSaved]);

  // 离开编辑:能保存就保存;保存不了(冲突、超限、写入失败)时由用户决定放弃还是留下。
  const settle = useCallback(async (): Promise<boolean> => {
    if (await save()) return true;
    return confirm({
      presentation: 'standard',
      title: t('bots.memory.unsavedTitle'),
      description: t('bots.memory.unsavedDescription'),
      confirmText: t('bots.memory.discard'),
      cancelText: t('bots.memory.continueEditing'),
    });
  }, [confirm, save, t]);
  useEffect(() => {
    editorRef.current = { flush: settle };
    return () => {
      editorRef.current = null;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [editorRef, settle]);

  const edit = (patch: Partial<{ title: string; body: string }>) => {
    draft.current = { ...draft.current, ...patch };
    if (patch.title !== undefined) setTitle(patch.title);
    if (patch.body !== undefined) setBody(patch.body);
    if (blocked.current) return;
    setState('idle');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), SAVE_DEBOUNCE_MS);
  };

  // 冲突时最新内容可能没读到;两个选择都先确保拿到它,读不到就留在原处。
  const resolveLatest = async () => {
    const next =
      latest ??
      (await memoryApi()
        .read(botId, saved.current.filename)
        .catch(() => null));
    if (!next) toast.error(t('bots.memory.loadFailed'));
    return next;
  };
  const useLatest = async () => {
    const next = await resolveLatest();
    if (!next) return;
    blocked.current = false;
    saved.current = next;
    draft.current = { title: next.title, body: next.body };
    setTitle(next.title);
    setBody(next.body);
    onSaved(next);
    setLatest(null);
    setState('idle');
  };
  const keepMine = async () => {
    const next = await resolveLatest();
    if (!next) return;
    blocked.current = false;
    // 用户看过最新内容后仍选择自己的版本:以最新版本为比对基准重新保存。
    saved.current = next;
    setLatest(null);
    await save();
  };

  return (
    <div className="flex flex-col gap-3 pt-2">
      {state === 'conflict' ? (
        <div
          className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
          role="alert"
        >
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('bots.memory.changedTitle', { name: botName })}
          </p>
          {latest ? (
            <p className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-12 leading-[1.55] text-[var(--text-secondary)]">
              {latest.body}
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onClick={() => void useLatest()}>
              {t('bots.memory.useLatest')}
            </Button>
            <Button variant="secondary" tone="quiet" size="sm" onClick={() => void keepMine()}>
              {t('bots.memory.keepMine')}
            </Button>
          </div>
        </div>
      ) : null}
      <label className="block">
        <span className="mb-1.5 ml-1 block text-12 text-[var(--text-secondary)]">
          {t('bots.memory.titleLabel')}
        </span>
        <Input
          size="md"
          value={title}
          maxLength={BOT_MEMORY_TITLE_MAX}
          onChange={(value) => edit({ title: value })}
          error={!title.trim()}
        />
      </label>
      <label className="block">
        <span className="mb-1.5 ml-1 block text-12 text-[var(--text-secondary)]">
          {t('bots.memory.bodyLabel')}
        </span>
        <Textarea
          rows={10}
          value={body}
          onChange={(value) => edit({ body: value })}
          error={!body.trim() || bodyTooLong(body)}
          className="min-h-[220px] resize-y text-14 leading-[1.75]"
        />
      </label>
      {bodyTooLong(body) ? (
        <p className="ml-1 text-12 text-[var(--text-danger)]" role="alert">
          {t('bots.memory.tooLong')}
        </p>
      ) : null}
      <div className="mt-1 flex items-center justify-end gap-3">
        {state === 'saving' ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]"
          >
            <Spinner size={12} /> {t('bots.autosave.saving')}
          </span>
        ) : state === 'saved' ? (
          <span
            role="status"
            className="inline-flex items-center gap-1 text-11 text-[var(--text-tertiary)]"
          >
            <Check size={12} /> {t('bots.autosave.saved')}
          </span>
        ) : state === 'error' ? (
          <span role="alert" className="text-11 text-[var(--text-danger)]">
            {t('bots.memory.saveFailed')}
          </span>
        ) : null}
        <Button
          variant="secondary"
          size="md"
          disabled={state === 'conflict'}
          onClick={() =>
            void (async () => {
              if (invalid && isDirty()) return;
              if (await save()) onDone();
            })()
          }
        >
          {t('bots.memory.done')}
        </Button>
      </div>
    </div>
  );
}
