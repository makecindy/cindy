/**
 * ScriptCapabilityMultiSelect — script 任务「允许调用的能力」多选下拉
 * ---------------------------------------------------------------------------
 * 能力目录来自 @cindy/maker-scheduler 的 SCRIPT_CAPABILITIES(与引擎校验白名单
 * 同源):host 侧新增能力后本选择器自动出现新项,label / 描述走 i18n,缺译时
 * 回退显示原始能力 id(保证新能力先可用后翻译)。
 *
 * 交互:点击 trigger 展开,面板内搜索框过滤(命中 label / 描述 / id),点选项
 * 切换勾选、面板保持展开(多选惯例);面板宽度绑定 trigger 宽度(docs/design-rules/cindy-design-system.md §4)。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, ChevronDown, Search } from 'lucide-react';

// ⚠ 必须走 /types 子路径:主入口("@cindy/maker-scheduler")会连带导出 engine
// (node:events 的 EventEmitter),renderer 侧 Vite externalize 后模块求值即白屏。
import { SCRIPT_CAPABILITIES, type ScriptCapability } from '@cindy/maker-scheduler/types';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface Props {
  value: ScriptCapability[];
  onChange: (next: ScriptCapability[]) => void;
}

type CapabilityRuntimeState =
  | 'ok'
  | 'ghost-missing'
  | 'ghost-asleep'
  | 'ghost-needs-setup'
  | 'ghost-needs-reauth'
  | 'ghost-blocked'
  | 'ghost-degraded';
interface CapabilityRuntimeStatus {
  state: CapabilityRuntimeState;
  ghostName?: string;
}

/** 能力警告的 state → i18n 后缀;新增 state 在此登记,避免嵌套三元漂移。 */
const CAPABILITY_WARN_I18N_SUFFIX: Record<Exclude<CapabilityRuntimeState, 'ok'>, string> = {
  'ghost-missing': 'ghostMissing',
  'ghost-asleep': 'ghostAsleep',
  'ghost-needs-setup': 'ghostNeedsSetup',
  'ghost-needs-reauth': 'ghostNeedsReauth',
  'ghost-blocked': 'ghostBlocked',
  'ghost-degraded': 'ghostDegraded',
};

export function ScriptCapabilityMultiSelect({ value, onChange }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // 运行时可用性(意识装入/唤醒态):只做警示装饰,不过滤清单——建任务时的
  // 意识状态不代表任务触发时的状态。探测失败静默降级为"不标注"。
  const [runtimeStatuses, setRuntimeStatuses] = useState<Record<string, CapabilityRuntimeStatus>>(
    {},
  );
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.maker.schedule
      .scriptCapabilityStatus()
      .then((result) => {
        if (cancelled) return;
        const next: Record<string, CapabilityRuntimeStatus> = {};
        for (const s of result.statuses)
          next[s.capability] = { state: s.state, ghostName: s.ghostName };
        setRuntimeStatuses(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // 选项表按语言解析一次(label/desc 各一次 t 查表),搜索/勾选触发的重渲不再逐项重查
  const options = useMemo(
    () =>
      SCRIPT_CAPABILITIES.map((id) => {
        const key = id.replace('.', '_');
        return {
          id,
          label: t(`scheduler.editor.script.capabilities.${key}`, { defaultValue: id }),
          desc: t(`scheduler.editor.script.capabilityDescs.${key}`, { defaultValue: '' }),
        };
      }),
    [t],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.id.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        o.desc.toLowerCase().includes(q),
    );
  }, [query, options]);

  const toggle = (id: ScriptCapability) => {
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  const labelById = useMemo(() => new Map(options.map((o) => [o.id, o.label])), [options]);
  const summary = value.length
    ? value.map((id) => labelById.get(id) ?? id).join(', ')
    : t('scheduler.editor.script.capabilitiesPlaceholder');

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQuery('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t('scheduler.editor.script.capabilitiesLabel')}
          className={cn(
            'flex h-10 w-full items-center justify-between gap-2 rounded-full border border-[var(--settings-input-border)] bg-transparent px-4 text-sm',
            value.length
              ? 'text-[var(--settings-input-text)]'
              : 'text-[var(--settings-input-placeholder)]',
          )}
        >
          <span className="truncate text-left">{summary}</span>
          <ChevronDown size={14} className="shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className={cn(
          // z-[10010]:宿主弹窗(ScheduleFormDialog)整体在 z-[10000],默认 z-50 会被盖住
          'z-[10010] w-[var(--radix-popover-trigger-width)] rounded-xl border border-[var(--cmd-palette-border)] bg-popover p-0 text-popover-foreground',
          'shadow-[var(--shadow-menu)]',
        )}
      >
        <div className="flex items-center gap-2 border-b border-[var(--cmd-palette-border)] px-3 py-2">
          <Search size={13} className="shrink-0 text-[var(--cmd-palette-item-meta)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('scheduler.editor.script.capabilitiesSearch')}
            className="h-6 w-full bg-transparent text-xs text-[var(--settings-input-text)] placeholder-[var(--settings-input-placeholder)] outline-none"
          />
        </div>
        <div className="max-h-[220px] overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="px-3 py-2 text-xs text-[var(--cmd-palette-item-meta)]">
              {t('scheduler.editor.script.capabilitiesEmpty')}
            </div>
          )}
          {filtered.map((option) => {
            const selected = value.includes(option.id);
            const warn = runtimeStatuses[option.id];
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggle(option.id)}
                className={cn(
                  'flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                  'hover:bg-[var(--confirm-btn-secondary-hover)]',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    selected
                      ? 'border-transparent bg-[var(--lightbox-cta-bg)] text-[var(--lightbox-cta-fg)]'
                      : 'border-[var(--cmd-palette-border)] text-transparent',
                  )}
                >
                  <Check size={11} strokeWidth={3} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-xs font-medium text-[var(--msg-assistant-text)]">
                    {option.label}
                  </span>
                  {option.desc && (
                    <span className="text-11 leading-[1.4] text-[var(--cmd-palette-item-meta)]">
                      {option.desc}
                    </span>
                  )}
                  {warn && warn.state !== 'ok' && (
                    <span className="flex items-center gap-1 text-11 leading-[1.4] text-[var(--error-fg)]">
                      <AlertTriangle size={11} className="shrink-0" />
                      {t(
                        `scheduler.editor.script.capabilityWarn.${
                          CAPABILITY_WARN_I18N_SUFFIX[warn.state]
                        }`,
                        { name: warn.ghostName ?? '' },
                      )}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
