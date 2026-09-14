/**
 * Host-rendered model preferences for Cindy abilities declared by a Plugin.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Sparkles } from 'lucide-react';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ModelIconMark } from '@/components/new-chat/ModelSelector';
import { OneshotModelPinPicker, type OneshotPinOption } from '@/cindy-brain/OneshotModelPinPicker';

/** 跟随默认在 select 里的哨兵值(覆盖表里"没有这项"= 跟随默认)。 */
const FOLLOW_DEFAULT_VALUE = '__default__';

interface MediaModelOption {
  id: string;
  modelId: string;
  label: string;
  providerId: string;
  providerName: string;
  routing?: import('@cindy/model-providers').Provider['routing'];
}

/** 媒体模型沿用原来的轻量下拉，只在模型名前补来源 Provider 图标。 */
function MediaModelPicker({
  value,
  defaultModel,
  options,
  onChange,
  ariaLabel,
  dense,
}: {
  value?: string;
  defaultModel: MediaModelOption;
  options: readonly MediaModelOption[];
  onChange: (pin: string | null) => void;
  ariaLabel: string;
  dense?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const current = value
    ? options.find((option) => option.id === value) ??
      options.find((option) => option.providerId === 'xd' && option.modelId === value) ??
      options.find((option) => option.modelId === value)
    : undefined;
  const staleValue = value && !current ? value : null;
  const selected = current ?? defaultModel;
  const selectable = options.filter((option) => option.id !== defaultModel.id);
  const triggerLabel =
    current?.label ??
    staleValue ??
    t('settings.ghosts.detail.cindyPrefs.defaultOption', { model: defaultModel.label });

  const select = (pin: string | null): void => {
    if (pin !== value) onChange(pin);
    setOpen(false);
  };

  const optionClass = (active: boolean): string =>
    cn(
      'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors',
      'hover:bg-[var(--model-item-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      dense ? 'text-12 leading-5' : 'text-13 leading-5',
      active && 'bg-[var(--model-item-hover)]',
    );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          className={cn(
            'flex h-8 w-[300px] max-w-[60%] min-w-0 shrink items-center gap-2 rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] py-0 pl-3 pr-2.5 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
            dense ? 'text-12' : 'text-13',
          )}
        >
          {!staleValue && (
            <ModelIconMark
              providerId={selected.providerId}
              name={selected.providerName}
              routing={selected.routing}
              withMargin={false}
              dense
            />
          )}
          <span className="min-w-0 flex-1 truncate text-left">{triggerLabel}</span>
          <ChevronDown size={13} className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[300px] overflow-hidden rounded-xl border border-[var(--model-dropdown-border)] bg-[var(--model-dropdown-bg)] p-1 shadow-[var(--shadow-menu)]"
      >
        <div role="listbox" aria-label={ariaLabel} className="max-h-[300px] overflow-y-auto">
          <button
            type="button"
            role="option"
            aria-selected={value === undefined}
            className={optionClass(value === undefined)}
            onClick={() => select(null)}
          >
            <ModelIconMark
              providerId={defaultModel.providerId}
              name={defaultModel.providerName}
              routing={defaultModel.routing}
              withMargin={false}
              dense
            />
            <span className="min-w-0 flex-1 truncate text-[var(--model-item-text)]">
              {t('settings.ghosts.detail.cindyPrefs.defaultOption', { model: defaultModel.label })}
            </span>
            {value === undefined && (
              <Check size={15} className="shrink-0 text-[var(--model-item-check)]" />
            )}
          </button>
          {selectable.map((option) => {
            const active = value === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={active}
                title={option.providerName}
                className={optionClass(active)}
                onClick={() => select(option.id)}
              >
                <ModelIconMark
                  providerId={option.providerId}
                  name={option.providerName}
                  routing={option.routing}
                  withMargin={false}
                  dense
                />
                <span className="min-w-0 flex-1 truncate text-[var(--model-item-text)]">
                  {option.label}
                </span>
                {active && <Check size={15} className="shrink-0 text-[var(--model-item-check)]" />}
              </button>
            );
          })}
          {staleValue && (
            <button
              type="button"
              role="option"
              aria-selected
              className={optionClass(true)}
              onClick={() => select(staleValue)}
            >
              <span className="min-w-0 flex-1 truncate text-[var(--model-item-text)]">
                {staleValue}
              </span>
              <Check size={15} className="shrink-0 text-[var(--model-item-check)]" />
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Ghost 申请的每项 Cindy 能力一行,可钉后端(供应商×模型)。
 * Settings 详情与 Plugin 详情共用这一份实现,避免两个入口产生不同配置口径。
 */
export function CindyCapabilityPrefs({
  ghostId,
  capabilities,
  appearance = 'settings',
}: {
  ghostId: string;
  /** 能力键全名列表(image.generate / video.edit …,来自身份卡详单)。 */
  capabilities: readonly string[];
  /** Plugin detail aligns the fallback editor with the shared Plugin surface. */
  appearance?: 'settings' | 'plugin';
}) {
  const { t } = useTranslation();
  const [prefs] = useState(() => window.electronAPI.ghosts.cindyPrefsSync(ghostId));
  const [overrides, setOverrides] = useState<Record<string, string>>(prefs.overrides);

  const handleChange = useCallback(
    async (capability: string, value: string) => {
      const model = value === FOLLOW_DEFAULT_VALUE ? null : value;
      const prev = overrides;
      setOverrides((current) => {
        const next = { ...current };
        if (model === null) delete next[capability];
        else next[capability] = model;
        return next;
      });
      try {
        const result = await window.electronAPI.ghosts.setCindyPref(ghostId, capability, model);
        setOverrides(result.overrides);
        return true;
      } catch {
        setOverrides(prev);
        toast.error(t('settings.ghosts.errors.generic'));
        return false;
      }
    },
    [ghostId, overrides, t],
  );

  return (
    <div
      className={cn(
        'cindy-capability-prefs min-w-0 max-w-full flex flex-col gap-3 rounded-xl border px-5 py-4',
        appearance === 'plugin'
          ? 'border-[color-mix(in_srgb,var(--border-default)_72%,transparent)] bg-[color-mix(in_srgb,var(--surface-elevated)_82%,var(--surface))]'
          : 'border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]',
      )}
    >
      <div className="flex items-center gap-2">
        <Sparkles size={14} className="text-[var(--text-tertiary)]" />
        <p
          className={cn(
            'font-medium text-[var(--text-primary)]',
            appearance === 'plugin' ? 'text-14 leading-[1.571]' : 'text-13',
          )}
        >
          {t('settings.ghosts.detail.cindyPrefs.title')}
        </p>
      </div>
      <p
        className={cn(
          'text-[var(--text-tertiary)]',
          appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
        )}
      >
        {t('settings.ghosts.detail.cindyPrefs.desc')}
      </p>
      {capabilities.map((capability) => {
        // 按能力键的类目取对应清单。少一个分支的后果不是少个下拉,而是拿
        // **图像模型清单**去填一个文本能力——用户存进去的值链路根本不认。
        const isText = capability.startsWith('text.');
        const kind =
          capability === 'video.edit'
            ? prefs.videoEdit
            : capability.startsWith('video.')
              ? prefs.video
              : isText
                ? prefs.text
                : capability.startsWith('embed.')
                  ? prefs.embed
                  : capability === 'image.edit'
                    ? prefs.imageEdit
                    : prefs.image;
        // 目录没给这个类目任何模型 = 能力暂不可用:行照旧显示(插件确实申请了
        // 这项能力),但右侧不给下拉,改一句不可点的灰字,不拿旧型号冒充可选。
        const defaultModel = kind.defaultModel;
        const unavailable = kind.options.length === 0 || defaultModel === null;
        // 文本类例外:目录清单空(含凭证过滤后为空)但用户已有一个 text pin 时,
        // 仍要能把它清掉/改掉——unavailable 的灰字会锁死坏 pin(Codex 2026-08-06
        // P1)。此时渲染选择器,只露出「跟随默认」与 stale 行。
        const textPinUnavailable = isText
          ? unavailable && overrides[capability] === undefined
          : unavailable;
        // 文本类:身份卡声明了偏好模型时,"跟随默认"行如实说出实际路由
        // (插件声明优先于系统链;用户在下面的钉档永远最大)。
        const declaredModel = isText ? (prefs.text?.declaredModel ?? null) : null;
        const current = overrides[capability];
        const selectValue =
          current && current !== defaultModel?.id ? current : FOLLOW_DEFAULT_VALUE;
        if (isText) {
          // 快问快答:目录全量文本模型的富列表选择器(图标/折扣与订阅徽标/分组/
          // 搜索,对齐新建对话的模型选择器)。
          const textOptions: readonly OneshotPinOption[] = prefs.text?.options ?? [];
          // 存量轻量档位钉(目录扩展前钉下的合法值)回显友好名,不当 stale 露 id。
          const legacyPinLabel = current
            ? (prefs.text?.utilityProfiles?.find((p) => p.id === current)?.label ?? null)
            : null;
          return (
            <div
              key={capability}
              className="cindy-capability-row flex min-w-0 items-center justify-between gap-4"
            >
              <span
                className={cn(
                  'min-w-0 text-[var(--text-secondary)]',
                  appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                )}
              >
                {t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
              </span>
              {textPinUnavailable ? (
                <span
                  className={cn(
                    'cindy-capability-empty min-w-0 truncate text-[var(--text-tertiary)]',
                    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                  )}
                >
                  {t('settings.ghosts.detail.cindyPrefs.noModels')}
                </span>
              ) : (
                <OneshotModelPinPicker
                  value={selectValue === FOLLOW_DEFAULT_VALUE ? undefined : selectValue}
                  defaultLabel={defaultModel?.label ?? ''}
                  declaredLabel={declaredModel?.label ?? null}
                  legacyPinLabel={legacyPinLabel}
                  options={textOptions}
                  onChange={(pin) => handleChange(capability, pin ?? FOLLOW_DEFAULT_VALUE)}
                  ariaLabel={t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
                  dense={appearance !== 'plugin'}
                />
              )}
            </div>
          );
        }

        // image/video 保持原有轻量下拉，只用 Provider 图标区分同名模型的不同来源。
        if (!capability.startsWith('embed.')) {
          const mediaOptions = kind.options as unknown as readonly MediaModelOption[];
          const mediaDefault = defaultModel as unknown as MediaModelOption;
          return (
            <div
              key={capability}
              className="cindy-capability-row flex min-w-0 items-center justify-between gap-4"
            >
              <span
                className={cn(
                  'min-w-0 text-[var(--text-secondary)]',
                  appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                )}
              >
                {t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
              </span>
              {unavailable && current === undefined ? (
                <span
                  className={cn(
                    'cindy-capability-empty min-w-0 truncate text-[var(--text-tertiary)]',
                    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                  )}
                >
                  {t('settings.ghosts.detail.cindyPrefs.noModels')}
                </span>
              ) : unavailable ? (
                <button
                  type="button"
                  className={cn(
                    'shrink-0 text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                  )}
                  onClick={() => void handleChange(capability, FOLLOW_DEFAULT_VALUE)}
                >
                  {t('settings.defaults.restore')}
                </button>
              ) : (
                <MediaModelPicker
                  value={selectValue === FOLLOW_DEFAULT_VALUE ? undefined : selectValue}
                  defaultModel={mediaDefault}
                  options={mediaOptions}
                  onChange={(pin) => handleChange(capability, pin ?? FOLLOW_DEFAULT_VALUE)}
                  ariaLabel={t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
                  dense={appearance !== 'plugin'}
                />
              )}
            </div>
          );
        }

        // embed 类目继续使用原生 select。
        const options: { id: string; label: string; group?: string }[] = kind.options;
        const selectable = options.filter((o) => o.id !== defaultModel?.id);
        const groupNames: string[] = [];
        for (const o of selectable) {
          const g = o.group ?? '';
          if (!groupNames.includes(g)) groupNames.push(g);
        }
        // 覆盖值已不在当前清单(目录演进/形态更替):如实显示原值,不假装跟随默认。
        const staleOverride =
          current &&
          selectValue !== FOLLOW_DEFAULT_VALUE &&
          !selectable.some((o) => o.id === current)
            ? current
            : null;
        return (
          <div
            key={capability}
            className="cindy-capability-row flex min-w-0 items-center justify-between gap-4"
          >
            <span
              className={cn(
                'min-w-0 text-[var(--text-secondary)]',
                appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
              )}
            >
              {t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
            </span>
            {unavailable ? (
              <span
                className={cn(
                  'cindy-capability-empty min-w-0 truncate text-[var(--text-tertiary)]',
                  appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                )}
              >
                {t('settings.ghosts.detail.cindyPrefs.noModels')}
              </span>
            ) : (
              <select
                value={selectValue}
                onChange={(event) => void handleChange(capability, event.target.value)}
                aria-label={t(`settings.ghosts.detail.cindyPrefs.cap.${capability}`)}
                className={cn(
                  'cindy-capability-select h-8 w-[300px] max-w-[60%] min-w-0 shrink appearance-none rounded-full border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)] py-0 pl-3 pr-8 text-[var(--settings-input-text)] outline-none focus:ring-2 focus:ring-[var(--focus-ring-soft)]',
                  appearance === 'plugin' ? 'text-13 leading-5' : 'text-12',
                )}
              >
                <option value={FOLLOW_DEFAULT_VALUE}>
                  {t('settings.ghosts.detail.cindyPrefs.defaultOption', {
                    model: defaultModel.label,
                  })}
                </option>
                {groupNames.map((groupName) =>
                  groupName === '' ? (
                    selectable
                      .filter((o) => (o.group ?? '') === '')
                      .map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
                      ))
                  ) : (
                    <optgroup key={groupName} label={groupName}>
                      {selectable
                        .filter((o) => o.group === groupName)
                        .map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.label}
                          </option>
                        ))}
                    </optgroup>
                  ),
                )}
                {staleOverride ? <option value={staleOverride}>{staleOverride}</option> : null}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}
