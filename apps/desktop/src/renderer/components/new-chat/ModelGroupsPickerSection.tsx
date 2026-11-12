/**
 * 模型选择器「模型组」一格里的内容：用户在设置里建的路线。选中后新任务第一条消息发出前
 * 由 Cindy 按这一项的规则选一个具体模型，之后任务不再换；手动选普通模型即取消。
 * 行样式与模型行一致：18px 图标盒、名字 14/500、说明 12 次级色，选中整行底色。
 */
import { Settings2, Waypoints } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { COMPOSER_MENU_ROW, menuRowAttrs } from '@/components/ui/menu-row';
import { cn } from '@/lib/utils';

import type { ModelGroupRoute, ModelGroupSelection, ModelGroupsConfig } from '../../../shared/modelGroups';

export interface ModelGroupsPickerProps {
  config: ModelGroupsConfig;
  /** 当前选中的路线；null = 用普通模型。 */
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

export function ModelGroupIcon({ size }: { size: number }) {
  return <Waypoints size={size} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />;
}

export function ModelGroupsPickerSection({
  picker,
  query,
  onPicked,
  /** 「全部」里的搜索结果：只列命中的行，不显示空态与管理入口。 */
  searchOnly = false,
}: {
  picker: ModelGroupsPickerProps;
  query: string;
  onPicked(): void;
  searchOnly?: boolean;
}) {
  const { t } = useTranslation();
  const rows = useModelGroupPickerRows(picker.config);
  const groups = [
    { key: 'routes', label: t('modelGroups.routes'), rows: matches(rows, query) },
  ].filter((group) => group.rows.length > 0);
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
