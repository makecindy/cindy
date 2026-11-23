/**
 * 设置 → 模型供应商里由插件提供的供应商(插件引擎，docs/plans/acp-plugin-bridge.md)。
 *
 * 这台电脑上已启用并批准的插件声明的每个引擎占一行，接在本机供应商后面，名字后带「插件」标识；
 * 插件停用或卸载后，那一行随引擎列表一起消失。行与详情读同一份引擎列表(usePluginEngines：主进程
 * 每次变化推完整列表)，这里不另外读取，也不改动普通供应商的任何存储。
 *
 * 与普通供应商一致的部分：重命名(只在这台电脑上的显示名)、在模型选择器中隐藏、停用、逐模型开关、
 * 「允许被远程调用」与分享入口、账号用量。不同的部分照实呈现：登录和连接由插件自己管理(详情给
 * 「打开插件」，没有删除，卸载在插件页)；模型由引擎自己上报，打开详情时请插件重新上报一次(主进程
 * 按插件冷却)；不参与拖动排序、供应商组和引擎切换。
 */
import { Eye, EyeOff, MoreHorizontal, Pencil, Power, RotateCcw } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import type { GhostHarnessUsage } from '@cindy/plugin-protocol';

import { PluginEngineIcon } from '@/components/icons/PluginEngineIcon';
import { QuotaHoverCard } from '@/components/status/QuotaHoverCard';
import { pluginEngineUsageAccount } from '@/components/status/pluginEngineUsageAccount';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { usePluginEngineRemoteUseSwitch } from '@/features/plugin/PluginEngineRemoteUse';
import { ProviderShareEntryButton } from '@/features/provider-share/ProviderShareEntryButton';
import { readPluginEngineUsage } from '@/hooks/pluginEngineUsage';
import { requestPluginEnginesRefresh } from '@/hooks/usePluginEngines';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

import {
  PLUGIN_ENGINE_NAME_MAX,
  type PluginEngineModel,
  type PluginEnginePrefsInput,
  type PluginEngineView,
} from '../../../shared/pluginEngines';
import { providersSettings } from './ProvidersSection.settings-search';
import { SettingsTextInput } from './SettingsTextInput';

const AVATAR_STYLE = {
  backgroundColor: 'var(--settings-integration-avatar-bg)',
  border: '1px solid var(--settings-integration-avatar-border)',
  color: 'var(--settings-integration-avatar-icon)',
} as const;
const DIVIDER_STYLE = { borderColor: 'var(--settings-theme-card-border)' } as const;

/** 左栏分组：还在模型选择器里的、只隐藏的、已停用的(停用优先于隐藏，与普通供应商同一口径)。 */
export function pluginEngineRailGroup(engine: Pick<PluginEngineView, 'hidden' | 'suspended'>): 'active' | 'hidden' | 'suspended' {
  return engine.suspended ? 'suspended' : engine.hidden ? 'hidden' : 'active';
}

/** 写一项设置；失败时提示并返回 false。新的列表由主进程推回来，这里不改本地状态。 */
function writePluginEnginePrefs(input: PluginEnginePrefsInput, errorText: string): Promise<boolean> {
  const write = window.electronAPI?.maker?.setPluginEnginePrefs;
  if (!write) {
    toast.error(errorText);
    return Promise.resolve(false);
  }
  return write(input).then(
    () => true,
    () => {
      toast.error(errorText);
      return false;
    },
  );
}

function EngineNameInput({ initialName, onChange }: { initialName: string; onChange: (name: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  return (
    <SettingsTextInput
      data-setting-id={providersSettings.pluginProviders.id}
      aria-label={t('settings.providers.pill.rename')}
      value={name}
      maxLength={PLUGIN_ENGINE_NAME_MAX}
      autoFocus
      onChange={(value) => {
        setName(value);
        onChange(value);
      }}
    />
  );
}

/** 重命名：只改这台电脑上的显示名；改回插件声明的名字就不再记。 */
function usePluginEngineRename(): (engine: PluginEngineView) => Promise<void> {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  return async (engine) => {
    const ownerGeneration = getDataOwnerGeneration();
    let name = engine.name;
    const confirmed = await confirm({
      title: t('settings.providers.pill.rename'),
      content: <EngineNameInput initialName={name} onChange={(next) => { name = next; }} />,
      confirmText: t('settings.providers.custom.save'),
      cancelText: t('settings.providers.custom.cancel'),
    });
    const next = name.trim();
    if (!confirmed || !isDataOwnerGenerationCurrent(ownerGeneration) || !next || next === engine.name) return;
    await writePluginEnginePrefs(
      {
        key: engine.key,
        name: next === (engine.declaredName ?? engine.name) ? null : next,
        ownerStamp: { dataOwnerId: ownerGeneration.dataOwnerId, ownerGeneration: ownerGeneration.generation },
      },
      t('settings.providers.custom.toast.saveFailed'),
    );
  };
}

/** 「插件」标识：告诉用户这一项来自插件，而不是自己添加的连接。 */
export function PluginTag({ size }: { size: 'row' | 'detail' }) {
  const { t } = useTranslation();
  return (
    <span
      data-testid="plugin-engine-provider-tag"
      className={cn(
        'shrink-0 select-none rounded-full border font-medium',
        size === 'row' ? 'px-1.5 py-px text-10' : 'flex h-[18px] items-center px-2 text-11',
      )}
      style={{ borderColor: 'var(--settings-integration-avatar-border)', color: 'var(--text-tertiary)' }}
    >
      {t('settings.providers.plugin.badge')}
    </span>
  );
}

function engineReady(engine: PluginEngineView): boolean {
  return engine.availability.state !== 'unavailable';
}

/** 左栏里由插件提供的供应商：与本机供应商同一行式，接在它们下面，不参与拖动排序。 */
export function PluginEngineProviderRows({
  engines,
  selectedKey,
  onSelect,
}: {
  engines: readonly PluginEngineView[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  const rename = usePluginEngineRename();
  if (engines.length === 0) return null;
  return (
    <div data-testid="plugin-engine-providers" className="flex flex-col gap-0.5">
      {engines.map((engine) => {
        const selected = selectedKey === engine.key;
        const label = t('settings.providers.plugin.rowTip', { provider: engine.name });
        return (
          <Tip key={engine.key} text={label} side="right" contentClassName="max-w-[360px] break-words">
            <button
              type="button"
              data-testid="plugin-engine-provider-row"
              data-settings-search-action="Open the detail of a provider that a plugin offers"
              data-plugin-engine={engine.key}
              aria-current={selected}
              aria-label={label}
              onClick={() => onSelect(engine.key)}
              onDoubleClick={() => void rename(engine)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]',
                selected
                  ? 'bg-[var(--settings-menu-bg-selected)]'
                  : 'hover:bg-[var(--settings-menu-bg-hover)]',
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={AVATAR_STYLE}>
                <PluginEngineIcon size={14} iconDataUrl={engine.iconDataUrl} className="" />
              </span>
              <span
                className="min-w-0 flex-1 truncate text-13 font-medium"
                style={{ color: engine.suspended ? 'var(--text-tertiary)' : 'var(--settings-section-title)' }}
              >
                {engine.name}
              </span>
              <PluginTag size="row" />
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: engineReady(engine) ? 'var(--remote-status-ready)' : 'var(--border-default)' }}
              />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** 一条带上边线的说明，右侧可带动作；与普通供应商的已停用 / 已隐藏说明条同一行式。 */
function NoticeRow({ testId, text, children }: { testId: string; text: string; children?: ReactNode }) {
  return (
    <div
      data-testid={testId}
      className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-3 text-13"
      style={DIVIDER_STYLE}
    >
      <span className="min-w-0 flex-1" style={{ color: 'var(--text-tertiary)' }}>{text}</span>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  );
}

/**
 * 「允许被远程调用」与分享入口：与插件详情页的卡片是同一个开关(usePluginEngineRemoteUseSwitch)，
 * 在哪一边改，另一边都跟着变。本机没有允许远程控制、或插件不支持时开关仍显示但不可用，并说明原因。
 */
function RemoteAccessRow({
  engine,
  remoteControlEnabled,
  pendingShareRequests,
  onManageShare,
}: {
  engine: PluginEngineView;
  remoteControlEnabled: boolean;
  pendingShareRequests: number;
  onManageShare: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { supported, shareSupported, enabled, busy, setEnabled } = usePluginEngineRemoteUseSwitch(engine);
  const labelId = useId();
  return (
    <div
      data-testid="plugin-engine-remote-access"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-t px-5 py-3"
      style={DIVIDER_STYLE}
    >
      <div className="flex min-w-[min(100%,240px)] flex-1 flex-col gap-1">
        <span id={labelId} className="text-13 font-medium text-[var(--text-primary)]">
          {t('settings.providers.detail.remoteAccess.label')}
        </span>
        <span className="text-12 leading-[1.4] text-[var(--text-tertiary)]">
          {!remoteControlEnabled ? (
            <>
              {t('settings.ghosts.detail.engineRemoteUse.remoteControlOff')}{' '}
              <button
                type="button"
                data-settings-search-action="Open the remote control settings"
                onClick={() => navigate('/settings?tab=remote-control')}
                className="rounded-sm text-[var(--text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {t('providerShare.entry.openRemoteControl')}
              </button>
            </>
          ) : !supported ? (
            t('settings.ghosts.detail.engineRemoteUse.unsupported')
          ) : (
            t(shareSupported
              ? 'settings.ghosts.detail.engineRemoteUse.descriptionShareable'
              : 'settings.ghosts.detail.engineRemoteUse.description')
          )}
        </span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {shareSupported ? (
          <ProviderShareEntryButton groupSize={null} pendingCount={pendingShareRequests} onOpen={onManageShare} />
        ) : null}
        <Switch
          data-setting-id={providersSettings.sharing.id}
          checked={supported && enabled}
          disabled={busy || !remoteControlEnabled || !supported}
          aria-labelledby={labelId}
          onCheckedChange={setEnabled}
        />
      </div>
    </div>
  );
}

/**
 * 引擎账号的用量：打开详情和窗口重新获得焦点时读一次(与任务里的用量标签共用一分钟内的读取)，
 * 读不到或插件没有数据时整块不出现。`deviceId` 为 null 读这台电脑；自己其他电脑开放的引擎
 * (OwnRemotePluginEngines)传那台电脑，经既有只读的 `maker:get-plugin-engine-usage` 读那台电脑的账号。
 */
export function PluginEngineUsage({ deviceId, engineKey }: { deviceId: string | null; engineKey: string }) {
  const { t, i18n } = useTranslation();
  const [reading, setReading] = useState<{ usage: GhostHarnessUsage; now: number } | null>(null);
  useEffect(() => {
    const owner = getDataOwnerGeneration();
    let active = true;
    const read = () => {
      if (document.hidden) return;
      void readPluginEngineUsage(owner, deviceId, engineKey).result.then((usage) => {
        if (!active || !isDataOwnerGenerationCurrent(owner)) return;
        setReading(usage ? { usage, now: Date.now() } : null);
      });
    };
    read();
    window.addEventListener('focus', read);
    return () => {
      active = false;
      window.removeEventListener('focus', read);
    };
  }, [deviceId, engineKey]);
  if (!reading) return null;
  return (
    <div data-testid="provider-usage-module" className="shrink-0 border-t px-1 py-2" style={DIVIDER_STYLE}>
      <QuotaHoverCard
        variant="embedded"
        nowMs={reading.now}
        account={pluginEngineUsageAccount(reading.usage, {
          title: t('quotaCard.usageTitle'), now: reading.now, language: i18n.language, t,
        })}
      />
    </div>
  );
}

function ModelRow({
  engine,
  model,
  enabled,
}: {
  engine: PluginEngineView;
  model: PluginEngineModel;
  enabled: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const name = model.displayName || model.id;
  return (
    <li
      data-plugin-engine-model={model.id}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-13"
      style={{ color: enabled ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
    >
      <span className="min-w-0 flex-1">
        <span className="block break-words">{name}</span>
        {model.id !== name && (
          <span className="block break-all text-12 font-normal" style={{ color: 'var(--text-tertiary)' }}>
            {model.id}
          </span>
        )}
      </span>
      <Switch
        data-setting-id={providersSettings.pluginProviders.id}
        checked={enabled}
        disabled={busy}
        aria-label={t('settings.providers.plugin.modelSwitchAria', { model: name })}
        onCheckedChange={(next) => {
          setBusy(true);
          void writePluginEnginePrefs(
            { key: engine.key, models: { ids: [model.id], disabled: !next } },
            t('settings.providers.models.accessWriteFailed'),
          ).finally(() => setBusy(false));
        }}
      />
    </li>
  );
}

/** 引擎列出的模型，逐个可关；关掉的收在下面的「已停用」里。引擎还没列出模型时用一句话说明。 */
function EngineModels({ engine }: { engine: PluginEngineView }) {
  const { t } = useTranslation();
  const off = engine.disabledModels ?? [];
  const total = engine.models.length + off.length;
  return (
    <div className="flex flex-col border-t" style={DIVIDER_STYLE}>
      <div className="flex shrink-0 items-baseline gap-2 px-5 pb-2 pt-3">
        <span className="text-13 font-medium" style={{ color: 'var(--settings-section-title)' }}>
          {t('settings.providers.remote.modelsTitle')}
        </span>
        {total > 0 && (
          <span className="text-12 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
            {t('settings.providers.models.modelCount', { count: engine.models.length })}
          </span>
        )}
      </div>
      {total === 0 ? (
        <p className="px-5 pb-4 text-13 leading-[1.5]" style={{ color: 'var(--text-tertiary)' }}>
          {t('settings.providers.plugin.modelsEmpty')}
        </p>
      ) : (
        <>
          <ul data-testid="plugin-engine-models" className="px-2 pb-3">
            {engine.models.map((model) => (
              <ModelRow key={model.id} engine={engine} model={model} enabled />
            ))}
          </ul>
          {off.length > 0 && (
            <div role="group" aria-label={t('settings.providers.models.disabledGroup')}>
              <span className="block px-5 pb-1 text-11 font-medium text-[var(--text-tertiary)]">
                {t('settings.providers.models.disabledGroup')}
              </span>
              <ul data-testid="plugin-engine-models-off" className="px-2 pb-3">
                {off.map((model) => (
                  <ModelRow key={model.id} engine={engine} model={model} enabled={false} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 右栏：一个由插件提供的供应商。 */
export function PluginEngineProviderDetail({
  engine,
  remoteControlEnabled,
  pendingShareRequests,
  onManageShare,
}: {
  engine: PluginEngineView;
  /** null = 还没读到：先不显示「允许被远程调用」一行，免得闪一下「未允许远程控制」。 */
  remoteControlEnabled: boolean | null;
  pendingShareRequests: number;
  onManageShare: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rename = usePluginEngineRename();
  const visibilityError = t('settings.providers.models.visibilityWriteFailed');
  const accessError = t('settings.providers.models.accessWriteFailed');
  const openPlugin = () => navigate(`/settings?tab=ghosts&ghost=${encodeURIComponent(engine.ghostId)}`);
  const unavailable = !engine.suspended && !engineReady(engine);
  // 与模型选择器同一时机：打开时请插件重新上报模型(主进程按插件冷却)，新列表随推送到达。
  useEffect(() => {
    requestPluginEnginesRefresh(engine.ghostId);
  }, [engine.ghostId]);
  const statusKey = engine.suspended
    ? 'settings.providers.pill.suspended'
    : unavailable
      ? 'newChat.pluginEngines.unavailable'
      : engine.hidden
        ? 'settings.providers.pill.hidden'
        : 'settings.providers.remote.statusReady';
  return (
    <div data-testid="plugin-engine-provider-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3 gap-y-2">
          <div className="flex min-w-0 flex-auto basis-[220px] items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" style={AVATAR_STYLE}>
              <PluginEngineIcon size={18} iconDataUrl={engine.iconDataUrl} className="" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="min-w-0 truncate text-14 font-medium leading-tight"
                  style={{ color: engine.suspended ? 'var(--text-tertiary)' : 'var(--settings-section-title)' }}
                >
                  {engine.name}
                </span>
                <PluginTag size="detail" />
              </div>
              <span className="truncate text-13 leading-tight" style={{ color: 'var(--settings-integration-subtitle)' }}>
                {engine.declaredName
                  ? t('settings.providers.plugin.declaredName', { name: engine.declaredName })
                  : engine.description || t('settings.providers.plugin.source')}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: engineReady(engine) ? 'var(--remote-status-ready)' : 'var(--border-default)' }}
              />
              {t(statusKey)}
            </span>
            <Button
              data-settings-search-action="Open the plugin that offers this provider"
              variant="secondary"
              size="md"
              onClick={openPlugin}
            >
              {t('settings.providers.plugin.openPlugin')}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Tip text={t('settings.providers.detail.moreActionsAria')}>
                  <button
                    type="button"
                    data-settings-search-action="Open the action menu of a provider that a plugin offers"
                    aria-label={t('settings.providers.detail.moreActionsAria')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--surface-hover)]"
                    style={{ color: 'var(--text-tertiary)' }}
                  >
                    <MoreHorizontal size={18} />
                  </button>
                </Tip>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void rename(engine)}>
                  <Pencil size={18} className="mr-2.5" />
                  {t('settings.providers.pill.rename')}
                </DropdownMenuItem>
                {engine.declaredName ? (
                  <DropdownMenuItem
                    onClick={() => void writePluginEnginePrefs(
                      { key: engine.key, name: null }, t('settings.providers.custom.toast.saveFailed'))}
                  >
                    <RotateCcw size={18} className="mr-2.5" />
                    {t('settings.providers.plugin.resetName')}
                  </DropdownMenuItem>
                ) : null}
                {/* 与普通供应商同一组词：隐藏只收起模型选择器里的那一项，停用是不再让新任务用它。 */}
                <DropdownMenuItem
                  onClick={() => void writePluginEnginePrefs({ key: engine.key, hidden: !engine.hidden }, visibilityError)}
                >
                  {engine.hidden ? <Eye size={18} className="mr-2.5" /> : <EyeOff size={18} className="mr-2.5" />}
                  {t(engine.hidden ? 'settings.providers.menu.showProvider' : 'settings.providers.menu.hideProvider')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => void writePluginEnginePrefs({ key: engine.key, suspended: !engine.suspended }, accessError)}
                >
                  <Power size={18} className="mr-2.5" />
                  {t(engine.suspended ? 'settings.providers.menu.enableProvider' : 'settings.providers.menu.disableProvider')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <div
        data-testid="provider-detail-scroll"
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [&>*]:shrink-0"
      >
        {!engine.suspended && (
          <div className="border-t px-5 py-3" style={DIVIDER_STYLE}>
            <p className="text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
              {t('settings.providers.plugin.note')}
            </p>
          </div>
        )}
        {engine.suspended && (
          <NoticeRow testId="plugin-engine-suspended" text={t('settings.providers.plugin.suspendedBanner')}>
            {!engine.hidden && (
              <Button
                data-settings-search-action="Hide a provider that a plugin offers instead of turning it off"
                variant="secondary"
                size="md"
                onClick={() => void writePluginEnginePrefs({ key: engine.key, hidden: true, suspended: false }, accessError)}
              >
                {t('settings.providers.button.hideInstead')}
              </Button>
            )}
            <Button
              data-settings-search-action="Turn a provider that a plugin offers on again"
              variant="secondary"
              size="md"
              onClick={() => void writePluginEnginePrefs({ key: engine.key, suspended: false }, accessError)}
            >
              {t('settings.providers.button.enableProvider')}
            </Button>
          </NoticeRow>
        )}
        {!engine.suspended && engine.hidden && (
          <NoticeRow testId="plugin-engine-hidden" text={t('settings.providers.plugin.hiddenBanner')}>
            <Button
              data-settings-search-action="Show a provider that a plugin offers in the model picker again"
              variant="secondary"
              size="md"
              onClick={() => void writePluginEnginePrefs({ key: engine.key, hidden: false }, visibilityError)}
            >
              {t('settings.providers.button.showProvider')}
            </Button>
          </NoticeRow>
        )}
        {unavailable && (
          <NoticeRow
            testId="plugin-engine-unavailable"
            text={engine.availability.message?.trim()
              ? t('settings.providers.plugin.unavailableBannerReason', { reason: engine.availability.message.trim() })
              : t('settings.providers.plugin.unavailableBanner')}
          />
        )}
        {!engine.suspended && remoteControlEnabled !== null && (
          <RemoteAccessRow
            key={engine.key}
            engine={engine}
            remoteControlEnabled={remoteControlEnabled}
            pendingShareRequests={pendingShareRequests}
            onManageShare={onManageShare}
          />
        )}
        {!engine.suspended && engine.reportsUsage && (
          <PluginEngineUsage key={`usage:${engine.key}`} deviceId={null} engineKey={engine.key} />
        )}
        {!engine.suspended && <EngineModels engine={engine} />}
      </div>
    </div>
  );
}
