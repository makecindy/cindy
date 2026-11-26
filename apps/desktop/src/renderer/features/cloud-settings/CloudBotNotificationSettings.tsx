import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { WecomGroupNotificationSectionView } from '@/components/settings/WecomBotSection';
import { FeishuBotNotificationSectionView } from '@/components/settings/FeishuBotNotificationSection';
import { DiscordLifecycleSettings } from '@/components/settings/DiscordBotSection';
import type { ManagementItem, ManagementResult } from '../../../shared/settingsManagement';
import {
  LIFECYCLE_ANNOUNCEMENT_FIELD,
  WECOM_GROUP_MESSAGE_FIELD,
  WECOM_GROUP_WEBHOOK_FIELD,
} from '../../../shared/cloudBotNotifications';

type Action = ManagementItem['actions'][number];
type Phase = Extract<ManagementResult, { kind: 'operation' }>['phase'];

/** Target settings-domain values shown in the same notification sections. */
export interface CloudBotNotificationPreferences {
  /** `undefined` while the target does not report the domain (e.g. no webhook yet). */
  wecomEnabled?: boolean;
  feishuSessionEnabled?: boolean;
  setWecomEnabled(enabled: boolean): Promise<void>;
  setFeishuSessionEnabled(enabled: boolean): Promise<void>;
  /** Re-read the domains after a management action changed what the target reports. */
  refresh(): void;
}

/** Target-scoped controllers for the local notification sections of a personal bot card. */
export function CloudBotNotificationSettings({
  channel,
  item,
  targetName,
  webhookDraft,
  preferences,
  disabled,
  pending,
  runSettled,
}: {
  channel: 'wecom' | 'feishu' | 'discord';
  item: ManagementItem;
  targetName: string;
  /** Typed WeCom webhook, owned by the parent so a list reload keeps it. */
  webhookDraft?: [string, (next: string) => void];
  preferences?: CloudBotNotificationPreferences;
  disabled: boolean;
  pending: boolean;
  runSettled(item: ManagementItem, action: Action, values: Record<string, string>): Promise<Phase>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const action = (intent: Action['intent']) => item.actions.find((a) => a.intent === intent);
  const settle = async (next: Action | undefined, values: Record<string, string> = {}) => {
    if (!next || disabled || pending) throw new Error('UNAVAILABLE');
    const phase = await runSettled(item, next, values);
    if (phase !== 'succeeded') throw new Error(phase);
  };
  const lifecycle = action('edit')?.fields.find((f) => f.name === LIFECYCLE_ANNOUNCEMENT_FIELD);
  const setLifecycle = (enabled: boolean) =>
    void settle(action('edit'), { [LIFECYCLE_ANNOUNCEMENT_FIELD]: enabled ? 'on' : 'off' }).catch(
      () => toast.error(t('hostSettings.saveFailed')),
    );
  const write = async (save: () => Promise<void>) => {
    setSaving(true);
    try {
      await save();
    } finally {
      setSaving(false);
    }
  };

  let view;
  if (channel === 'wecom')
    view = (
      <WecomGroupNotificationSectionView
        webhookDraft={webhookDraft}
        hint={t('cloudSettings.wecomGroupHint', { name: targetName })}
        wecomGroup={{
          configured: item.status === 'connected',
          // Unreported before a webhook exists; the native switch is disabled then anyway.
          enabled: preferences?.wecomEnabled === true,
          maskedKey: item.detail,
          busy: pending || saving,
          setEnabled: (enabled) =>
            write(async () => {
              if (!preferences || preferences.wecomEnabled === undefined)
                throw new Error('UNAVAILABLE');
              await preferences.setWecomEnabled(enabled);
            }),
          saveAndTest: async (webhookUrl, message) => {
            await settle(action('create'), {
              [WECOM_GROUP_WEBHOOK_FIELD]: webhookUrl,
              [WECOM_GROUP_MESSAGE_FIELD]: message,
            });
            preferences?.refresh();
          },
          test: (message) => settle(action('sync'), { [WECOM_GROUP_MESSAGE_FIELD]: message }),
          clear: async () => {
            await settle(action('delete'));
            preferences?.refresh();
          },
        }}
      />
    );
  else if (channel === 'feishu')
    view = (
      <FeishuBotNotificationSectionView
        ownerBound={item.status === 'connected'}
        lifecycleAnnouncement={lifecycle?.value === 'on'}
        setLifecycleAnnouncement={setLifecycle}
        sessionNotifyEnabled={preferences?.feishuSessionEnabled === true}
        sessionDisabled={preferences?.feishuSessionEnabled === undefined || saving}
        setSessionNotifyEnabled={(enabled) =>
          void write(() => preferences!.setFeishuSessionEnabled(enabled)).catch(() =>
            toast.error(t('hostSettings.saveFailed')),
          )
        }
        disabled={pending}
      />
    );
  else
    view = (
      <DiscordLifecycleSettings
        controller={{
          lifecycleAnnouncement: lifecycle?.value === 'on',
          setLifecycleAnnouncement: setLifecycle,
        }}
      />
    );
  // A native fieldset disables every control while the target is offline or busy;
  // `contents` keeps the card's own spacing exactly as on the local page.
  return (
    <fieldset disabled={disabled || pending} className="contents">
      {view}
    </fieldset>
  );
}
