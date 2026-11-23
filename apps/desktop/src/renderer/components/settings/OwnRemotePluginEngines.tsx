/**
 * 设置 → 模型供应商里「自己其他电脑开放的插件引擎」：同账号、在线、允许远程控制的电脑上，
 * 由插件提供、并在那台电脑上打开了「允许被远程调用」的引擎(docs/plans/acp-plugin-bridge.md 第三期)。
 * 也就是新建任务时模型列表里以「引擎 · 电脑名」列出的那些。
 *
 * 行式与自己其他电脑上的普通供应商(OwnRemoteProviders)相同：图标带远程角标，名字后带「插件」标识，
 * 所在电脑只写在悬停提示里；点开在右栏只读地看所在电脑、状态、那台电脑上该账号的用量与开放的模型。
 * 改名、隐藏、停用和逐模型关闭都只能在那台电脑上做，这里不提供菜单。
 *
 * 读取与模型选择器共用同一份按电脑缓存(useDevicesPluginEngines)：页面打开时向每台电脑各读一次
 * 只读的 `maker:list-plugin-engines`(15 秒内已读过的不再读)，之后只给新出现的电脑补读，不轮询。
 * 用量只在打开某一项详情、且那台电脑说明该引擎会上报用量时读，与任务里的用量标签共用一分钟内的读取。
 */
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { RemoteSourceMark } from '@/components/icons/RemoteSourceMark';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, type DataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ControllableDevice } from '@/hooks/useControllableDevices';
import { useDevicesPluginEngines, useRemotePluginEngines } from '@/hooks/usePluginEngines';
import { deviceDisplayName } from '@/lib/deviceName';
import { remotePluginEngineChoices } from '@/lib/pluginEngineSelection';
import { cn } from '@/lib/utils';

import type { PluginEngineView } from '../../../shared/pluginEngines';
import { PluginEngineUsage, PluginTag } from './PluginEngineProviders';
import { ReadOnlyProviderModelSection } from './ReadOnlyProviderModels';

export interface OwnRemotePluginEngine {
  /** 左栏选中态的键；带前缀，不会与本机引擎的键相同。 */
  key: string;
  deviceId: string;
  deviceName: string;
  engine: PluginEngineView;
}

export function ownRemotePluginEngineKey(deviceId: string, providerId: string): string {
  return `remote-engine:${deviceId}\n${providerId}`;
}

const AVATAR_STYLE = {
  backgroundColor: 'var(--settings-integration-avatar-bg)',
  border: '1px solid var(--settings-integration-avatar-border)',
  color: 'var(--settings-integration-avatar-icon)',
} as const;

/**
 * 在线的同账号电脑开放给这台电脑的插件引擎，按电脑、再按那台电脑的引擎顺序排列。
 * `devices` 用设置页已有的那份可控电脑列表(useOwnRemoteProviderList().devices)，不再另订一份。
 */
export function useOwnRemotePluginEngines(
  devices: readonly ControllableDevice[],
  active = true,
): readonly OwnRemotePluginEngine[] {
  const deviceIds = useMemo(() => active ? devices.map((device) => device.deviceId) : [], [active, devices]);
  const { catalogues, read } = useDevicesPluginEngines(deviceIds, true);
  // 这次打开页面已经读过的电脑。电脑离线后移出，再上线时重新读；换账号后全部重新读。
  const readRef = useRef<{ owner: DataOwnerGeneration; ids: Set<string> } | null>(null);
  const owner = getDataOwnerGeneration();
  useEffect(() => {
    if (readRef.current?.owner !== owner) readRef.current = { owner, ids: new Set() };
    const done = readRef.current.ids;
    for (const id of [...done]) if (!deviceIds.includes(id)) done.delete(id);
    for (const id of deviceIds) {
      if (done.has(id)) continue;
      done.add(id);
      read(id);
    }
  }, [owner, deviceIds, read]);
  return useMemo(
    () => remotePluginEngineChoices(devices, catalogues, (id, name) => deviceDisplayName(id, name))
      .flatMap((choice): OwnRemotePluginEngine[] => {
        if (!choice.deviceId) return [];
        const { deviceId, deviceName, ...engine } = choice;
        return [{
          key: ownRemotePluginEngineKey(deviceId, engine.providerId),
          deviceId,
          deviceName: deviceName ?? deviceDisplayName(deviceId),
          engine,
        }];
      }),
    [devices, catalogues],
  );
}

function RemoteEngineIcon({ engine, size }: { engine: PluginEngineView; size: number }) {
  return (
    <RemoteSourceMark markSize={size}>
      <PluginEngineIcon size={size} iconDataUrl={engine.iconDataUrl} className="" />
    </RemoteSourceMark>
  );
}

/** 左栏里的远程插件引擎行：与远程供应商同一行式，不参与拖动排序。 */
export function OwnRemotePluginEngineRows({
  entries,
  selectedKey,
  onSelect,
}: {
  entries: readonly OwnRemotePluginEngine[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div data-testid="own-remote-plugin-engines" className="flex flex-col gap-0.5">
      {entries.map((entry) => {
        const label = t('settings.providers.remote.rowLabel', { provider: entry.engine.name, device: entry.deviceName });
        const selected = selectedKey === entry.key;
        return (
          <Tip key={entry.key} text={label} side="right" contentClassName="max-w-[360px] break-words">
            <button
              type="button"
              data-testid="own-remote-plugin-engine-row"
              data-settings-search-action="Open the detail of a plugin engine on another of your computers"
              data-listed-source={`${entry.deviceId}:${entry.engine.providerId}`}
              aria-current={selected}
              aria-label={label}
              onClick={() => onSelect(entry.key)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]',
                selected
                  ? 'bg-[var(--settings-menu-bg-selected)]'
                  : 'hover:bg-[var(--settings-menu-bg-hover)]',
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={AVATAR_STYLE}>
                <RemoteEngineIcon engine={entry.engine} size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
                {entry.engine.name}
              </span>
              <PluginTag size="row" />
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: 'var(--remote-status-ready)' }}
              />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/**
 * 右栏：自己另一台电脑开放的一个插件引擎，只读。打开时与模型选择器同一时机请那台电脑的插件
 * 重新上报模型(按电脑 60 秒冷却)，新列表随复读回来。
 */
export function OwnRemotePluginEngineDetail({ entry }: { entry: OwnRemotePluginEngine }) {
  const { t } = useTranslation();
  const { engine } = entry;
  const { refresh } = useRemotePluginEngines(entry.deviceId);
  useEffect(() => {
    refresh();
  }, [refresh]);
  const models = useMemo(
    () => engine.models.map((model) => ({ id: model.id, name: model.displayName || model.id })),
    [engine.models],
  );
  return (
    <div data-testid="own-remote-plugin-engine-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3 gap-y-2">
          <div className="flex min-w-0 flex-auto basis-[220px] items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={AVATAR_STYLE}>
              <RemoteEngineIcon engine={engine} size={18} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="min-w-0 truncate text-14 font-medium leading-tight"
                  style={{ color: 'var(--settings-section-title)' }}
                >
                  {engine.name}
                </span>
                <PluginTag size="detail" />
              </div>
              <span className="truncate text-13 leading-tight" style={{ color: 'var(--settings-integration-subtitle)' }}>
                {entry.deviceName}
              </span>
            </div>
          </div>
          <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: 'var(--remote-status-ready)' }}
            />
            {t('settings.providers.remote.statusReady')}
          </span>
        </div>
      </div>

      <div
        data-testid="provider-detail-scroll"
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="shrink-0 border-t px-5 py-3" style={{ borderColor: 'var(--settings-theme-card-border)' }}>
          <p className="text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
            {t('settings.providers.remote.detailNote', { device: entry.deviceName })}
          </p>
        </div>
        {engine.reportsUsage && (
          <PluginEngineUsage key={`usage:${entry.key}`} deviceId={entry.deviceId} engineKey={engine.key} />
        )}
        <ReadOnlyProviderModelSection
          title={t('settings.providers.remote.modelsTitle')}
          models={models}
          note={models.length === 0 ? t('settings.providers.plugin.modelsEmpty') : null}
          testId="own-remote-plugin-engine-models"
        />
      </div>
    </div>
  );
}
