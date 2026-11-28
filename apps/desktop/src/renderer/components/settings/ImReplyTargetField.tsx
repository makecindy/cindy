/**
 * 个人 IM 机器人卡片里的「谁来回复」: Cindy(按本卡的 Agent / 模型开任务)或某位伙伴。
 *
 * 交给伙伴只改落点, 凭证留在原处: 主人私聊进伙伴的对话, 群 / 话题各一条隐藏任务, 模型、权限与
 * 记忆都来自伙伴, 所以卡片里那几块 Cindy 专用的设置(Agent / 模型、人格、行为)随之收起,
 * 选回 Cindy 原样回来。旧 preload 没有这组接口时整项不显示。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { SettingsRow } from '@/components/ui/settings-rows';
import { Select, type SelectOption } from '@/components/ui/select';
import { useBotProfiles, type BotProfile } from '@/features/bots/botStore';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import type { PersonalReplyTargetChannel } from '../../../shared/botImConnection';

import { imBotSettings } from './ImBotSection.settings-search';

const CINDY_VALUE = 'cindy';

export interface ImReplyTarget {
  /** 这台电脑支持「交给伙伴」; 不支持时卡片保持原样。 */
  supported: boolean;
  /** 当前接手的伙伴; null = Cindy。 */
  companionBotId: string | null;
  /** 接手伙伴的资料(已删除或还没读到时为 null)。 */
  companion: BotProfile | null;
  pending: boolean;
  change(companionBotId: string | null): Promise<void>;
}

function replyTargetApi() {
  const api = (window as { electronAPI?: Partial<Window['electronAPI']> }).electronAPI?.botImConnection;
  return api && typeof api.getPersonalReplyTarget === 'function' && typeof api.setPersonalReplyTarget === 'function'
    ? api
    : null;
}

export function useImReplyTarget(channel: PersonalReplyTargetChannel): ImReplyTarget {
  const { t } = useTranslation();
  const bots = useBotProfiles();
  const [supported] = useState(() => replyTargetApi() !== null);
  const [companionBotId, setCompanionBotId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const api = replyTargetApi();
    if (!api) return;
    let cancelled = false;
    const off = api.onPersonalReplyTargetChanged?.((state) => {
      if (!cancelled && state.channel === channel) setCompanionBotId(state.companionBotId);
    });
    void api.getPersonalReplyTarget!({ channel })
      .then((state) => { if (!cancelled) setCompanionBotId(state.companionBotId); })
      .catch(() => { /* 读不到按 Cindy 显示; 切换时会报真实原因。 */ });
    return () => { cancelled = true; off?.(); };
  }, [channel]);

  const change = useCallback(async (next: string | null) => {
    const api = replyTargetApi();
    if (!api || pending) return;
    setPending(true);
    try {
      const state = await api.setPersonalReplyTarget!({ channel, companionBotId: next });
      setCompanionBotId(state.companionBotId);
    } catch (error) {
      const ipcError = extractIpcError(error);
      const busy = ipcError?.code === 'PRECONDITION_FAILED'
        && ipcError.message.replace(/^\[PRECONDITION_FAILED\]\s*/, '') === 'PERSONAL_BOT_BUSY';
      toast.error(t(busy
        ? 'settings.imBot.replyTarget.busy'
        : 'settings.imBot.replyTarget.updateFailed'));
    } finally {
      setPending(false);
    }
  }, [channel, pending, t]);

  const companion = companionBotId ? bots.find((bot) => bot.id === companionBotId) ?? null : null;
  return { supported, companionBotId, companion, pending, change };
}

/** 收起态行尾的摘要: 交给伙伴时替代「Agent · 模型」。 */
export function replyTargetSummary(target: ImReplyTarget, t: (key: string, options?: Record<string, unknown>) => string): string | null {
  if (!target.supported || !target.companionBotId) return null;
  return t('settings.imBot.replyTarget.summary', {
    name: target.companion?.name ?? t('settings.imBot.replyTarget.missingCompanion'),
  });
}

export function ImReplyTargetField({ target, setting }: { target: ImReplyTarget; setting: keyof typeof imBotSettings }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const bots = useBotProfiles();
  if (!target.supported) return null;

  const selectable = bots.filter((bot) => (bot.status ?? 'active') === 'active');
  const options: SelectOption[] = [
    { value: CINDY_VALUE, label: t('settings.imBot.replyTarget.cindy') },
    ...selectable.map((bot) => ({ value: bot.id, label: bot.name })),
  ];
  if (target.companionBotId && !selectable.some((bot) => bot.id === target.companionBotId)) {
    // 接手的伙伴已暂停或被删除: 仍显示当前值, 让用户看得见并能改回。
    options.push({
      value: target.companionBotId,
      label: target.companion?.name ?? t('settings.imBot.replyTarget.missingCompanion'),
      disabled: true,
    });
  }

  const name = target.companion?.name ?? t('settings.imBot.replyTarget.missingCompanion');
  const label = t('settings.imBot.replyTarget.label');

  return (
    <>
      <SettingsRow
        wrap
        title={label}
        hint={target.companionBotId
          ? t('settings.imBot.replyTarget.companionHint', { name })
          : t('settings.imBot.replyTarget.cindyHint')}
        trailing={
          <Select
            data-setting-id={imBotSettings[setting].id}
            label={label}
            value={target.companionBotId ?? CINDY_VALUE}
            options={options}
            width="sm"
            disabled={target.pending}
            onValueChange={(value) => void target.change(value === CINDY_VALUE ? null : value)}
          />
        }
      />
      {target.companion ? (
        // 交给伙伴后模型、权限与记忆都在伙伴设置里改: 紧跟一行直达。
        <SettingsRow
          title={t('settings.imBot.replyTarget.openCompanion', { name })}
          hint={t('settings.imBot.replyTarget.companionSettingsHint')}
          chevron
          onClick={() => navigate(`/bots/${encodeURIComponent(target.companion!.id)}?settings=1`)}
        />
      ) : null}
    </>
  );
}
