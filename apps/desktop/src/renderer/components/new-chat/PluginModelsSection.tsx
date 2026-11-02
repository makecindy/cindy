/**
 * PluginModelsSection — 模型选择器里插件提供的模型。
 * ---------------------------------------------------------------------------
 * 名称和说明都来自插件发布的模型，这里不写任何文案。列表是主进程读好的落盘内容，渲染时不调用
 * 插件。选中后新任务第一条消息发出前问一次插件用哪个真实模型，之后任务不再换；手动选普通模型
 * 即取消。行样式与模型行一致：18px 图标盒、名字 14/500、说明 12 次级色，选中整行底色不加勾。
 */
import { Plug } from 'lucide-react';

import { COMPOSER_MENU_ROW, menuRowAttrs } from '@/components/ui/menu-row';
import { cn } from '@/lib/utils';
import type { GhostPickerModel } from '../../../shared/ghost';

export interface PluginModelsPickerProps {
  models: readonly GhostPickerModel[];
  /** 当前选中的插件模型；null = 用普通模型。 */
  active: GhostPickerModel | null;
  onSelect(model: GhostPickerModel): void;
}

/** 跟随选择器搜索框；面板也用它判断搜索有没有结果。 */
export function matchPluginModels(models: readonly GhostPickerModel[], query: string): readonly GhostPickerModel[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return models;
  return models.filter((model) =>
    [model.name, model.description, model.pluginName].some((text) => text?.toLowerCase().includes(needle)));
}

/** 插件图标：加载不到时回落通用图标由调用方决定是否有 pluginIcon，这里只负责尺寸。 */
export function PluginModelIcon({ model, size }: { model: GhostPickerModel; size: number }) {
  if (!model.pluginIcon) return <Plug size={size} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />;
  return (
    <img
      src={model.pluginIcon}
      alt=""
      aria-hidden
      draggable={false}
      style={{ width: size, height: size }}
      className="shrink-0 rounded-[4px]"
    />
  );
}

export function PluginModelsSection({
  picker,
  query,
  onPicked,
}: {
  picker: PluginModelsPickerProps;
  query: string;
  onPicked(): void;
}) {
  const visible = matchPluginModels(picker.models, query);
  const groups = new Map<string, GhostPickerModel[]>();
  for (const model of visible) groups.set(model.pluginId, [...(groups.get(model.pluginId) ?? []), model]);
  if (groups.size === 0) return null;
  return (
    <>
      {[...groups.entries()].map(([pluginId, models]) => (
        <div key={pluginId} role="group" aria-label={models[0]!.pluginName}>
          <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-12 font-medium leading-[1.33] text-[var(--cmd-palette-item-meta,var(--text-tertiary))]">
            <span className="truncate">{models[0]!.pluginName}</span>
          </div>
          {models.map((model) => {
            const selected = picker.active?.pluginId === pluginId && picker.active.id === model.id;
            const choose = () => {
              picker.onSelect(model);
              onPicked();
            };
            return (
              <div
                key={model.id}
                role="option"
                aria-selected={selected}
                tabIndex={0}
                data-plugin-model={`${pluginId}:${model.id}`}
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
                    <PluginModelIcon model={model} size={16} />
                  </span>
                  <span className="min-w-0 truncate font-medium leading-5">{model.name}</span>
                </div>
                {model.description && (
                  <div
                    title={model.description}
                    className="min-w-0 max-w-[36ch] truncate pl-[26px] pt-px text-12 font-normal leading-[1.4] text-[var(--text-secondary)]"
                  >
                    {model.description}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
