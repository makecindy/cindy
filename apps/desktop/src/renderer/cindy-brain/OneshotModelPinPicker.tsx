/**
 * OneshotModelPinPicker — 快问快答(text.oneshot)钉档选择器。
 *
 * 钉值是目录钉(cat: 编码的 供应商×agent×模型),清单 = 当前供应商目录的全部
 * 文本模型(主侧 cindy-prefs 同步下发)。视觉与信息层级对齐新建对话 / 开协同的
 * 模型选择器(ModelSelector):厂牌图标 + 模型名 + 折扣/订阅徽标 + 供应商分组
 * 标题 + 搜索过滤;首行恒为「跟随默认」(身份卡声明了偏好模型时如实显示声明)。
 */

import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelIconMark } from '@/components/new-chat/ModelSelector';

/** 主侧 cindy-prefs 下发的目录钉条目(与 TextOneshotPinOption 同形)。 */
export interface OneshotPinOption {
  id: string;
  label: string;
  group: string;
  providerId: string;
  agentKind: string;
  modelId: string;
  modelName: string;
  icon?: string;
  budget: boolean;
  subscription: boolean;
  /** Provider['routing'](IPC 载荷;ProviderLogoMark 的厂牌图标判定用)。 */
  routing?: import('@cindy/model-providers').Provider['routing'];
  agentSuffix?: string;
}

export function OneshotModelPinPicker({
  value,
  defaultLabel,
  declaredLabel,
  legacyPinLabel,
  options,
  onChange,
  ariaLabel,
  dense,
}: {
  /** 当前钉值;undefined = 跟随默认。 */
  value?: string;
  /** 系统默认链链首的展示文案(未声明偏好时"跟随默认"行用)。 */
  defaultLabel: string;
  /** 身份卡声明的偏好模型文案(声明存在时"跟随默认"行如实显示它)。 */
  declaredLabel: string | null;
  /** 存量轻量档位钉(目录扩展前钉下的合法档位键)的展示名;null/缺省 = 不是档位钉。 */
  legacyPinLabel?: string | null;
  options: readonly OneshotPinOption[];
  /** null = 清除钉档(恢复跟随默认)。 */
  onChange: (pin: string | null) => void;
  ariaLabel: string;
  /** 紧凑字号(设置页 12px;插件详情页 13px)。 */
  dense?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const current = value ? options.find((o) => o.id === value) : undefined;
  // 覆盖值已不在当前清单(目录演进):如实显示原值,不假装跟随默认。
  // 存量档位钉不是 stale——它合法且仍可路由,只是不再能新建,展示友好名。
  const staleValue = value && !current && !legacyPinLabel ? value : null;
  const triggerLabel = current?.label
    ?? legacyPinLabel
    ?? staleValue
    ?? (declaredLabel
      ? t('settings.ghosts.detail.cindyPrefs.defaultOptionDeclared', { model: declaredLabel })
      : t('settings.ghosts.detail.cindyPrefs.defaultOption', { model: defaultLabel }));

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.modelName.toLowerCase().includes(q)
        || o.modelId.toLowerCase().includes(q)
        || o.group.toLowerCase().includes(q),
    );
  }, [options, query]);

  const groups = useMemo(() => {
    const names: string[] = [];
    for (const o of filtered) {
      if (!names.includes(o.group)) names.push(o.group);
    }
    return names.map((name) => ({ name, items: filtered.filter((o) => o.group === name) }));
  }, [filtered]);

  const select = (pin: string | null): void => {
    // 点中的就是当前值(含 stale 行):只收起,不回写——stale 的目录钉已不在
    // 白名单里,回写必被 INVALID_PARAMS 拒成「操作失败」toast,且同值回写
    // 本来就是无操作。
    if (pin === value) {
      setOpen(false);
      return;
    }
    onChange(pin);
    setOpen(false);
  };

  const rowClass = (active: boolean): string =>
    cn(
      'flex w-full cursor-pointer items-center justify-between rounded-[8px] px-3 py-2 text-left',
      'transition-colors duration-100 hover:bg-[var(--model-item-hover)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      active && 'bg-[var(--model-item-hover)]',
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={cn(
            'flex h-8 w-[300px] max-w-[60%] min-w-0 shrink cursor-pointer appearance-none items-center justify-between gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] py-0 pl-3 pr-2.5 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
            dense ? 'text-12' : 'text-13',
          )}
        >
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[320px] overflow-hidden rounded-[12px] border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-2 shadow-[var(--shadow-menu)]"
      >
        <div className="flex flex-col gap-1.5">
          {/* 搜索框 —— 药丸样式,与模型选择器同。 */}
          <div className="flex items-center gap-2 rounded-full border border-[var(--model-dropdown-border)] bg-[var(--surface)] px-3 py-[7px]">
            <Search size={16} className="shrink-0 text-[var(--text-tertiary)]" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('settings.ghosts.detail.cindyPrefs.searchPlaceholder')}
              aria-label={t('settings.ghosts.detail.cindyPrefs.searchPlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-14 text-[var(--model-item-text)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div
            role="listbox"
            aria-label={ariaLabel}
            className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto overscroll-contain"
          >
            {/* 「跟随默认」行(声明了偏好模型时如实显示声明内容)。搜索态也保留:
                它是唯一能清除钉档的行。 */}
            <button
              type="button"
              role="option"
              aria-selected={value === undefined}
              className={rowClass(value === undefined)}
              onClick={() => select(null)}
            >
              <span className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                {declaredLabel
                  ? t('settings.ghosts.detail.cindyPrefs.defaultOptionDeclared', { model: declaredLabel })
                  : t('settings.ghosts.detail.cindyPrefs.defaultOption', { model: defaultLabel })}
              </span>
              {value === undefined && (
                <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
              )}
            </button>

            {groups.length === 0 ? (
              <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
                {t('newChat.modelSelector.search.noResults')}
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.name} role="group" aria-label={g.name}>
                  <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
                  <div className="truncate px-3 pb-0.5 pt-1 text-11 font-medium text-[var(--text-tertiary)]">
                    {g.name}
                  </div>
                  {g.items.map((o) => {
                    const active = value === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-pin-id={o.id}
                        className={rowClass(active)}
                        onClick={() => select(o.id)}
                      >
                        <span className="flex min-w-0 flex-1 items-center gap-2.5">
                          <ModelIconMark
                            icon={o.icon}
                            providerId={o.providerId}
                            name={o.group}
                            routing={o.routing}
                            colorClass="text-[var(--text-secondary)]"
                            withMargin={false}
                            dense
                          />
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                              {o.modelName}
                            </span>
                            {o.agentSuffix && (
                              <span className="shrink-0 text-13 font-normal text-[var(--text-tertiary)]">
                                {o.agentSuffix}
                              </span>
                            )}
                          </span>
                          <span className="ml-auto flex shrink-0 items-center gap-1.5">
                            {o.subscription && (
                              <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-11 font-medium text-[var(--text-secondary)]">
                                {t('settings.providers.models.subscription')}
                              </span>
                            )}
                            {o.budget && (
                              <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--accent-cta-bg)] px-2 py-[1px] text-11 font-medium leading-[1.45] text-[var(--accent-pure-cta-fg)]">
                                {t('settings.ghosts.detail.cindyPrefs.budgetBadge')}
                              </span>
                            )}
                          </span>
                        </span>
                        {active && (
                          <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))
            )}

            {/* 覆盖值已不在当前清单(目录演进):如实显示原值,可选回。 */}
            {staleValue && query.trim() === '' && (
              <div role="group" aria-label={staleValue}>
                <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
                <button
                  type="button"
                  role="option"
                  aria-selected
                  className={rowClass(true)}
                  onClick={() => select(staleValue)}
                >
                  <span className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                    {staleValue}
                  </span>
                  <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
                </button>
              </div>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
