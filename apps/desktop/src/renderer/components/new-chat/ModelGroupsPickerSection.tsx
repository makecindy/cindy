/**
 * 模型选择器里的模型组：用户在设置里建的模式。新任务里选中后，第一条消息发出前由 Cindy 按这个模式的规则选一个
 * 具体模型；进行中的任务里选它，当场按规则换一次(model-groups.md §5)。之后都不会自己再换；手动选普通模型即取消。
 * 出现在「模型组」一格、「全部」(不搜索时整段、搜索时只列命中的)和「收藏」(只列收藏的模式)。
 * 行样式与模型行一致：18px 图标盒、名字 14/500、说明 12 次级色，选中整行底色；行尾 ☆ 收藏。
 */
import { Settings2, Star, Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { COMPOSER_MENU_ROW, menuRowAttrs } from '@/components/ui/menu-row';
import { toggleModelGroupFavorite, useModelGroupFavorites } from '@/features/model-groups/modelGroupFavorites';
import { cn } from '@/lib/utils';

import type { ModelGroupRoute, ModelGroupSelection, ModelGroupsConfig } from '../../../shared/modelGroups';

export interface ModelGroupsPickerProps {
  config: ModelGroupsConfig;
  /** 当前选中的模式；null = 用普通模型(进行中的任务里总是 null：选一次换一次，不留选中态)。 */
  active: ModelGroupSelection | null;
  onSelect(selection: ModelGroupSelection): void;
  /** 打开设置里的「模型组」。 */
  onManage(): void;
}

interface PickerRow {
  selection: ModelGroupSelection;
  name: string;
  hint: string;
}

export function useModelGroupPickerRows(config: ModelGroupsConfig): PickerRow[] {
  const { t } = useTranslation();
  const hint = (route: ModelGroupRoute) => [
    t('modelGroups.sourceCount', { count: route.candidates.length }),
    t(`modelGroups.strategy.${route.strategy}.title`),
    route.effort ? t(`effortLevels.${route.effort}`, { defaultValue: route.effort }) : '',
  ].filter(Boolean).join(' · ');
  return config.routes.map((route) => ({ selection: { type: 'route', id: route.id }, name: route.name, hint: hint(route) }));
}

function matches(rows: readonly PickerRow[], query: string): PickerRow[] {
  const needle = query.trim().toLowerCase();
  return needle ? rows.filter((row) => `${row.name} ${row.hint}`.toLowerCase().includes(needle)) : [...rows];
}

/** 搜索命中了几行；面板用它判断搜索有没有结果。 */
export function matchModelGroupRows(rows: readonly PickerRow[], query: string): number {
  return matches(rows, query).length;
}

/** 「收藏」里有几个收藏的模式(已删除的模式不算)。 */
export function useFavoriteModelGroupCount(config: ModelGroupsConfig): number {
  const favorites = useModelGroupFavorites();
  return config.routes.filter((route) => favorites.includes(route.id)).length;
}

/**
 * 这一段放在哪里：rail = 「模型组」一格(含空态与管理入口)；all = 「全部」不搜索时整段列出；
 * search = 「全部」搜索时只列命中的；favorites = 「收藏」里只列收藏的模式。
 */
export type ModelGroupsPickerVariant = 'rail' | 'all' | 'search' | 'favorites';

export function ModelGroupIcon({ size }: { size: number }) {
  return <Waypoints size={size} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />;
}

export function ModelGroupsPickerSection({
  picker,
  query,
  onPicked,
  variant = 'rail',
}: {
  picker: ModelGroupsPickerProps;
  query: string;
  onPicked(): void;
  variant?: ModelGroupsPickerVariant;
}) {
  const { t } = useTranslation();
  const rows = useModelGroupPickerRows(picker.config);
  const favorites = useModelGroupFavorites();
  const shown = variant === 'favorites'
    ? favorites.flatMap((id) => rows.filter((row) => row.selection.id === id))
    : matches(rows, query);
  const groups = [
    { key: 'modes', label: t('modelGroups.title'), rows: shown },
  ].filter((group) => group.rows.length > 0);
  // 只有「模型组」一格显示空态与管理入口；其余位置没有可列的就不占地方。
  const searchOnly = variant !== 'rail';
  const manage = () => {
    picker.onManage();
    onPicked();
  };
  if (searchOnly && groups.length === 0) return null;
  return (
    <>
      {groups.length === 0 && (
        <div className="w-0 min-w-full px-3 py-6 text-center text-13 leading-[1.5] text-[var(--text-tertiary)]">
          {t('modelGroups.picker.empty')}
        </div>
      )}
      {groups.map((group) => (
        <div key={group.key} role="group" aria-label={group.label}>
          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta,var(--text-tertiary))]">
            <span className="truncate">{group.label}</span>
          </div>
          {group.rows.map((row) => {
            const selected = picker.active?.type === row.selection.type && picker.active.id === row.selection.id;
            const favorite = favorites.includes(row.selection.id);
            const starLabel = favorite
              ? t('newChat.modelSelector.unified.removeFavorite')
              : t('newChat.modelSelector.unified.addFavorite');
            const choose = () => {
              picker.onSelect(row.selection);
              onPicked();
            };
            return (
              <div
                key={row.selection.id}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                data-model-group={`${row.selection.type}:${row.selection.id}`}
                data-state={selected ? 'checked' : undefined}
                {...menuRowAttrs()}
                onClick={choose}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  choose();
                }}
                className={cn(
                  COMPOSER_MENU_ROW,
                  'group/row flex w-full cursor-pointer flex-col px-3 py-2',
                  selected && 'bg-sidebar-item-hover data-[menu-active]:bg-transparent',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
                    <ModelGroupIcon size={16} />
                  </span>
                  <span className="min-w-0 truncate font-medium leading-5">{row.name}</span>
                  {/* 与模型行的 ☆ 同一个样子：收藏后常亮，未收藏的悬停或键盘聚焦时出现。 */}
                  <button
                    type="button"
                    data-model-group-favorite={row.selection.id}
                    aria-pressed={favorite}
                    title={starLabel}
                    aria-label={starLabel}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleModelGroupFavorite(row.selection.id);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    className={cn(
                      'ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded-lg transition-opacity duration-[var(--motion-fast)] ease-[var(--motion-ease-out)]',
                      favorite
                        ? 'text-[var(--favorite-star)] opacity-100'
                        : 'text-[var(--text-tertiary)] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-[var(--favorite-star)]',
                    )}
                  >
                    <Star size={14} fill={favorite ? 'currentColor' : 'none'} aria-hidden />
                  </button>
                </div>
                {row.hint && (
                  <div title={row.hint} className="min-w-0 max-w-[36ch] truncate pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]">
                    {row.hint}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {!searchOnly && (
        <div
          role="option"
          aria-selected={false}
          tabIndex={0}
          data-model-groups-manage
          {...menuRowAttrs()}
          onClick={manage}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            manage();
          }}
          className={cn(COMPOSER_MENU_ROW, 'mt-1 flex w-full cursor-pointer items-center gap-2 px-3 py-2')}
        >
          <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center">
            <Settings2 size={15} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
          </span>
          <span className="min-w-0 truncate leading-5">{t('modelGroups.picker.manage')}</span>
        </div>
      )}
    </>
  );
}
