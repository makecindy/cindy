/**
 * OneshotModelPinPicker — 快问快答(text.oneshot)钉档选择器。
 *
 * 钉值是目录钉(cat: 编码的 供应商×agent×模型),清单 = 当前供应商目录的全部
 * 文本模型(主侧 cindy-prefs 同步下发)。默认选择器先让用户选择 Agent，再只展示该
 * Agent 可用的模型；设置页也可直接按供应商展示全部可用模型。选中模型后才一次性写回完整钉值。
 * 模型层视觉与信息层级对齐
 * 新建对话 / 开协同的模型选择器(ModelSelector):厂牌图标 + 模型名 + 折扣/订阅
 * 徽标 + 供应商分组标题 + 搜索过滤。第一层首行恒为「跟随默认」(身份卡声明了
 * 偏好模型时如实显示声明)。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronLeft, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelIconMark } from '@/components/new-chat/ModelSelector';
import { PROVIDER_TITLE_KEY } from '@/lib/providerDisplayName';
import { decodeCatalogModelPin } from '../../shared/catalogModelPin';

/** 主侧 cindy-prefs 下发的目录钉条目(与 TextOneshotPinOption 同形)。 */
export interface OneshotPinOption {
  id: string;
  label: string;
  group: string;
  providerId: string;
  agentKind: string;
  modelId: string;
  modelName: string;
  defaultEnabled?: boolean;
  icon?: string;
  budget: boolean;
  subscription: boolean;
  /** Provider['routing'](IPC 载荷;ProviderLogoMark 的厂牌图标判定用)。 */
  routing?: import('@cindy/model-providers').Provider['routing'];
  /** Agent used by this exact route. Older snapshots may omit it. */
  agentSuffix?: string;
  /** False for a persisted route that is no longer offered or currently usable. */
  available?: boolean;
}

function agentKindLabel(agentKind: string): string {
  return agentKind === 'claude-code' ? 'Claude Code' : agentKind === 'codex' ? 'Codex' : agentKind;
}

function preferredAgentForModel(modelId: string): string {
  return modelId.startsWith('claude') ? 'claude-code' : 'codex';
}

function displayProviderGroup(
  option: Pick<OneshotPinOption, 'providerId' | 'group'>,
  t: (key: string) => string,
): string {
  const titleKey = PROVIDER_TITLE_KEY[option.providerId];
  return titleKey ? t(titleKey) : option.group;
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
  defaultOptionLabel,
  searchPlaceholder,
  noResultsLabel,
  unavailableLabel,
  budgetLabel,
  subscriptionLabel,
  disabled,
  groupByProvider = false,
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
  /** Generic settings surfaces can supply their own automatic-route copy. */
  defaultOptionLabel?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  unavailableLabel?: string;
  budgetLabel?: string;
  subscriptionLabel?: string;
  disabled?: boolean;
  /** Show all routable models in provider groups without exposing the Agent rail. */
  groupByProvider?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const current = value ? options.find((o) => o.id === value) : undefined;
  // 覆盖值已不在当前清单(目录演进):如实显示原值,不假装跟随默认。
  // 存量档位钉不是 stale——它合法且仍可路由,只是不再能新建,展示友好名。
  const staleValue = value && !current && !legacyPinLabel ? value : null;
  const staleRoute = staleValue ? decodeCatalogModelPin(staleValue) : null;
  const automaticLabel =
    defaultOptionLabel ??
    (declaredLabel
      ? t('settings.ghosts.detail.cindyPrefs.defaultOptionDeclared', { model: declaredLabel })
      : t('settings.ghosts.detail.cindyPrefs.defaultOption', { model: defaultLabel }));
  const triggerLabel =
    (groupByProvider && current
      ? `${current.modelName} · ${displayProviderGroup(current, t)}`
      : current?.label) ??
    legacyPinLabel ??
    staleValue ??
    automaticLabel;

  const visibleOptions = useMemo(() => {
    const visible: OneshotPinOption[] = [];
    const indexByRouteName = new Map<string, number>();
    for (const option of options) {
      if (option.available === false && option.id !== value) continue;
      const routeName = groupByProvider
        ? `${option.providerId}\n${option.modelId.trim().toLowerCase()}`
        : `${option.providerId}\n${option.agentKind}\n${option.modelName.trim().toLowerCase()}`;
      const existingIndex = indexByRouteName.get(routeName);
      if (existingIndex === undefined) {
        indexByRouteName.set(routeName, visible.length);
        visible.push(option);
        continue;
      }
      const existing = visible[existingIndex]!;
      const preferredRoute =
        groupByProvider &&
        option.agentKind === preferredAgentForModel(option.modelId) &&
        existing.agentKind !== preferredAgentForModel(existing.modelId);
      const replacesUnavailableRoute = existing.available === false && option.available !== false;
      if (
        option.id === value ||
        replacesUnavailableRoute ||
        (existing.id !== value && preferredRoute)
      ) {
        visible[existingIndex] = option;
      }
    }
    return visible;
  }, [groupByProvider, options, value]);

  const agentChoices = useMemo(() => {
    const kinds: string[] = [];
    for (const option of visibleOptions) {
      if (!kinds.includes(option.agentKind)) kinds.push(option.agentKind);
    }
    if (staleRoute && !kinds.includes(staleRoute.agentKind)) kinds.push(staleRoute.agentKind);
    return kinds.map((kind) => ({ kind, label: agentKindLabel(kind) }));
  }, [staleRoute, visibleOptions]);

  const currentAgent = current?.agentKind ?? staleRoute?.agentKind ?? null;
  const selectedAgentLabel = selectedAgent ? agentKindLabel(selectedAgent) : '';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!groupByProvider && !selectedAgent) return [];
    const visible = groupByProvider
      ? visibleOptions
      : visibleOptions.filter((option) => option.agentKind === selectedAgent);
    if (!q) return visible;
    return visible.filter(
      (o) =>
        o.modelName.toLowerCase().includes(q) ||
        o.modelId.toLowerCase().includes(q) ||
        displayProviderGroup(o, t).toLowerCase().includes(q),
    );
  }, [groupByProvider, query, selectedAgent, t, visibleOptions]);

  const groups = useMemo(() => {
    const names: string[] = [];
    for (const o of filtered) {
      const name = displayProviderGroup(o, t);
      if (!names.includes(name)) names.push(name);
    }
    return names.map((name) => ({
      name,
      items: filtered.filter((o) => displayProviderGroup(o, t) === name),
    }));
  }, [filtered, t]);

  useEffect(() => {
    if (open && (groupByProvider || selectedAgent)) searchRef.current?.focus();
  }, [groupByProvider, open, selectedAgent]);

  const select = (pin: string | null): void => {
    // 点中的就是当前值(含 stale 行):只收起,不回写——stale 的目录钉已不在
    // 白名单里,回写必被 INVALID_PARAMS 拒成「操作失败」toast,且同值回写
    // 本来就是无操作。
    if (pin === value || (pin === null && value === undefined)) {
      setOpen(false);
      setSelectedAgent(null);
      setQuery('');
      return;
    }
    onChange(pin);
    setOpen(false);
    setSelectedAgent(null);
    setQuery('');
  };

  const rowClass = (active: boolean): string =>
    cn(
      'flex w-full cursor-pointer items-center justify-between rounded-[8px] px-3 py-2 text-left',
      'transition-colors duration-100 hover:bg-[var(--model-item-hover)]',
      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      active && 'bg-[var(--model-item-hover)]',
    );

  const modelRows = (
    <>
      {groups.length === 0 &&
      !(
        staleValue &&
        (groupByProvider || staleRoute?.agentKind === selectedAgent) &&
        query.trim() === ''
      ) ? (
        <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
          {noResultsLabel ?? t('newChat.modelSelector.search.noResults')}
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
              const unavailable = o.available === false;
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-pin-id={o.id}
                  aria-disabled={unavailable}
                  className={cn(rowClass(active), unavailable && 'opacity-60')}
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
                      {unavailable && (
                        <span className="shrink-0 text-11 font-normal text-[var(--text-tertiary)]">
                          {unavailableLabel ?? t('settings.auxiliaryModels.unavailable')}
                        </span>
                      )}
                    </span>
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      {o.subscription && (
                        <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--surface-chip)] px-2 py-[1px] text-11 font-medium text-[var(--text-secondary)]">
                          {subscriptionLabel ?? t('settings.providers.models.subscription')}
                        </span>
                      )}
                      {o.budget && (
                        <span className="inline-flex shrink-0 items-center rounded-full bg-[var(--accent-cta-bg)] px-2 py-[1px] text-11 font-medium leading-[1.45] text-[var(--accent-pure-cta-fg)]">
                          {budgetLabel ?? t('settings.ghosts.detail.cindyPrefs.budgetBadge')}
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

      {staleValue &&
        (groupByProvider || staleRoute?.agentKind === selectedAgent) &&
        query.trim() === '' && (
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
    </>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (disabled && next) return;
        setOpen(next);
        if (!next) {
          setSelectedAgent(null);
          setQuery('');
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            'flex h-8 min-w-0 shrink cursor-pointer appearance-none items-center justify-between gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] py-0 pl-3 pr-2.5 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
            groupByProvider ? 'w-full max-w-full' : 'w-[300px] max-w-[60%]',
            'disabled:cursor-not-allowed disabled:opacity-60',
            dense ? 'text-12' : 'text-13',
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">{triggerLabel}</span>
            {current?.available === false && (
              <span className="shrink-0 text-11 text-[var(--text-tertiary)]">
                {unavailableLabel ?? t('settings.auxiliaryModels.unavailable')}
              </span>
            )}
          </span>
          <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
        className="w-[320px] overflow-hidden rounded-[12px] border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-2 shadow-[var(--shadow-menu)]"
      >
        <div className="flex flex-col gap-1.5">
          {groupByProvider ? (
            <>
              <button
                type="button"
                role="option"
                aria-selected={value === undefined}
                className={rowClass(value === undefined)}
                onClick={() => select(null)}
              >
                <span className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                  {automaticLabel}
                </span>
                {value === undefined && (
                  <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
                )}
              </button>
              <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
              <div className="flex items-center gap-2 rounded-full border border-[var(--model-dropdown-border)] bg-[var(--surface)] px-3 py-[7px]">
                <Search size={16} className="shrink-0 text-[var(--text-tertiary)]" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    searchPlaceholder ?? t('settings.ghosts.detail.cindyPrefs.searchPlaceholder')
                  }
                  aria-label={
                    searchPlaceholder ?? t('settings.ghosts.detail.cindyPrefs.searchPlaceholder')
                  }
                  className="min-w-0 flex-1 bg-transparent text-14 text-[var(--model-item-text)] outline-none placeholder:text-[var(--text-tertiary)]"
                />
              </div>
              <div
                role="listbox"
                aria-label={ariaLabel}
                className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto overscroll-contain"
              >
                {modelRows}
              </div>
            </>
          ) : selectedAgent === null ? (
            <div
              role="listbox"
              aria-label={ariaLabel}
              className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto overscroll-contain"
            >
              <button
                type="button"
                role="option"
                aria-selected={value === undefined}
                className={rowClass(value === undefined)}
                onClick={() => select(null)}
              >
                <span className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                  {automaticLabel}
                </span>
                {value === undefined && (
                  <Check size={15} className="ml-2 shrink-0 text-[var(--model-item-check)]" />
                )}
              </button>

              {agentChoices.length === 0 ? (
                <div className="px-3 py-6 text-center text-13 text-[var(--text-tertiary)]">
                  {noResultsLabel ?? t('newChat.modelSelector.search.noResults')}
                </div>
              ) : (
                <div role="group" aria-label={t('settings.auxiliaryModels.chooseAgent')}>
                  <div className="mx-1 my-1 h-px bg-[var(--model-dropdown-border)]" />
                  <div className="truncate px-3 pb-0.5 pt-1 text-11 font-medium text-[var(--text-tertiary)]">
                    {t('settings.auxiliaryModels.chooseAgent')}
                  </div>
                  {agentChoices.map((agent) => {
                    const active = currentAgent === agent.kind;
                    return (
                      <button
                        key={agent.kind}
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-agent-kind={agent.kind}
                        className={rowClass(active)}
                        onClick={() => {
                          setSelectedAgent(agent.kind);
                          setQuery('');
                        }}
                      >
                        <span className="min-w-0 truncate text-14 font-medium leading-5 text-[var(--model-item-text)]">
                          {agent.label}
                        </span>
                        <ChevronDown
                          size={15}
                          className="-rotate-90 shrink-0 text-[var(--text-tertiary)]"
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <>
              <button
                type="button"
                aria-label={t('settings.auxiliaryModels.backToAgents')}
                className="flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left text-13 font-medium text-[var(--model-item-text)] hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                onClick={() => {
                  setSelectedAgent(null);
                  setQuery('');
                }}
              >
                <ChevronLeft size={15} className="shrink-0 text-[var(--text-tertiary)]" />
                <span className="truncate">{selectedAgentLabel}</span>
              </button>

              <div className="flex items-center gap-2 rounded-full border border-[var(--model-dropdown-border)] bg-[var(--surface)] px-3 py-[7px]">
                <Search size={16} className="shrink-0 text-[var(--text-tertiary)]" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={
                    searchPlaceholder ?? t('settings.ghosts.detail.cindyPrefs.searchPlaceholder')
                  }
                  aria-label={
                    searchPlaceholder ?? t('settings.ghosts.detail.cindyPrefs.searchPlaceholder')
                  }
                  className="min-w-0 flex-1 bg-transparent text-14 text-[var(--model-item-text)] outline-none placeholder:text-[var(--text-tertiary)]"
                />
              </div>

              <div
                role="listbox"
                aria-label={`${ariaLabel}: ${selectedAgentLabel}`}
                className="flex max-h-[300px] flex-col gap-0.5 overflow-y-auto overscroll-contain"
              >
                {modelRows}
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
