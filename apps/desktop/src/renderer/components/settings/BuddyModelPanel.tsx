/**
 * 伙伴用哪个模型(2026-11-26 用户裁决，方案 B「默认为主」)：一台电脑上的伙伴一般都用同一个默认模型，
 * 只有真的不一样的伙伴才单独设置。伙伴只用一个模型(或一条智能路由)，不再有备用：想要出问题时自动换来源就选智能路由。
 * 本机与其他电脑共用这一块；其他电脑上的保存经那台电脑执行，模型从那台的目录里选。
 */
import { useMemo } from 'react';

import { Select } from '@/components/ui/select';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { BotAvatar } from '@/features/bots/BotAvatar';
import { BotModelChainEditor } from '@/features/bots/BotModelChainEditor';
import { followsDefaultModel } from '@/features/bots/botModelChainPatch';
import type { BotCapabilities } from '@/features/bots/botStore';
import { useBotTranslation } from '@/features/bots/botPronounContext';
import type { MakerVendor } from '@/lib/ccAgent.types';
import type { BotModelRoute } from '../../../shared/botModelChain';
import type { ModelGroupsConfig } from '../../../shared/modelGroups';

export interface BuddyModelPanelBuddy {
  id: string;
  name: string;
  avatar: Parameters<typeof BotAvatar>[0]['bot'];
  capabilities: Pick<BotCapabilities, 'modelChainOverride' | 'modelChain'>;
}

/** 与智能路由列表里「按模型」「按供应商」同一档小标题。 */
const GROUP_LABEL = 'px-1 text-12 font-medium leading-[1.33] text-[var(--text-tertiary)]';

export function BuddyModelPanel({
  defaultChain,
  onDefaultChange,
  onDefaultRestore,
  defaultNote,
  buddies,
  onSetBuddy,
  deviceId,
  hostModelGroups,
  hiddenVendors,
  disabled = false,
  onNavigateToProviders,
}: {
  defaultChain: BotModelRoute[];
  /** 不传：这里不能改默认(那台电脑是旧版本)，改为显示 `defaultNote`。 */
  onDefaultChange?(chain: BotModelRoute[]): void;
  /** 默认模型是自定义的：给「恢复默认」，回到按产品推荐自动选。 */
  onDefaultRestore?(): void;
  defaultNote?: string;
  buddies: readonly BuddyModelPanelBuddy[];
  /** chain 为 null：改回跟随默认。 */
  onSetBuddy(id: string, chain: BotModelRoute[] | null): void;
  deviceId?: string;
  hostModelGroups?: ModelGroupsConfig;
  hiddenVendors?: MakerVendor[];
  disabled?: boolean;
  onNavigateToProviders?(): void;
}) {
  const { t } = useBotTranslation();
  const own = buddies.filter((buddy) => !followsDefaultModel(buddy.capabilities));
  const following = buddies.filter((buddy) => followsDefaultModel(buddy.capabilities));
  const addOptions = useMemo(
    () => following.map((buddy) => ({ value: buddy.id, label: buddy.name })),
    [following],
  );
  const editorProps = {
    ...(deviceId ? { deviceId } : {}),
    ...(hostModelGroups ? { hostModelGroups } : {}),
    ...(hiddenVendors ? { hiddenVendors } : {}),
    ...(onNavigateToProviders ? { onNavigateToProviders } : {}),
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SettingsCard>
        <BotModelChainEditor
          layout="settings"
          settingsRows={{
            primaryLabel: t('modelGroups.buddies.defaultLabel'),
            primaryHint: defaultNote ?? t('modelGroups.buddies.defaultHint'),
            // 伙伴的模型常带远程电脑名，标签会把它挤到看不清；恢复按钮已说明是自定义的。
            hideCustomizedBadge: true,
          }}
          value={defaultChain}
          disabled={disabled || !onDefaultChange}
          onChange={(chain) => { if (onDefaultChange && chain.length) onDefaultChange(chain); }}
          {...(onDefaultChange && onDefaultRestore ? { onRestoreDefault: onDefaultRestore } : {})}
          {...editorProps}
        />
      </SettingsCard>
      {buddies.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2">
          <div className={GROUP_LABEL}>
            {own.length > 0 && following.length > 0
              ? t('modelGroups.buddies.ownTitleWithRest', { count: following.length })
              : t('modelGroups.buddies.ownTitle')}
          </div>
          <SettingsCard>
            {own.map((buddy) => (
              <BotModelChainEditor
                key={buddy.id}
                layout="settings"
                settingsRows={{ primaryLabel: buddy.name, primaryLead: <BotAvatar bot={buddy.avatar} size="sm" /> }}
                value={buddy.capabilities.modelChain}
                disabled={disabled}
                onChange={(chain) => { if (chain.length) onSetBuddy(buddy.id, chain); }}
                onRestoreDefault={() => onSetBuddy(buddy.id, null)}
                {...editorProps}
              />
            ))}
            {following.length > 0 ? (
              <SettingsRow
                title={t('modelGroups.buddies.addOwn')}
                hint={own.length === 0 ? t('modelGroups.buddies.allFollow') : undefined}
                trailing={
                  <Select
                    label={t('modelGroups.buddies.addOwn')}
                    value=""
                    options={addOptions}
                    disabled={disabled}
                    width="sm"
                    onValueChange={(id) => { if (defaultChain.length) onSetBuddy(id, defaultChain); }}
                  />
                }
              />
            ) : null}
          </SettingsCard>
        </div>
      )}
    </div>
  );
}
