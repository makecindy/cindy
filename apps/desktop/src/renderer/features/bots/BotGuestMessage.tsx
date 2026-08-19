import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { openBotArtifactsTab } from '@/features/right-sidebar/lib/openBotArtifactsTab';
import { makeBotArtifact, type BotArtifactItem } from '../../../shared/botArtifact';
import { BotArtifactCard } from './BotArtifactCard';
import { BotAvatar } from './BotAvatar';
import { useBotDelegation } from './botDelegationLive';
import { useBotArtifactOpen } from './useBotArtifactOpen';
import { useBotProfiles } from './botStore';

export interface BotGuestDescriptor {
  botId: string;
  name: string;
  delegationId: string;
  linkedSessionId: string | null;
}

interface Props {
  guest: BotGuestDescriptor;
  content: string;
  workingDir?: string;
  /** 本条消息所在的任务；用来取这次委派回传的产物。 */
  sessionId?: string;
}

/**
 * 客座气泡：这条消息的作者不是本任务的主人，而是委派里的另一方。
 *
 * 在发起方任务里，它是目标伙伴回传的答复；在目标伙伴的主任务里，它是发起方送来的
 * 请求。两种情况共用一套外观：左侧对方的头像，气泡左上角一枚中性描边的「客座」
 * 标签——让人一眼看出「这句话是别人来串门说的」，同时不把它伪装成本任务的主人。
 *
 * 标签刻意用描边而非彩色底：对话里已经有足够多的颜色，客座是身份说明，不是状态告警。
 * 描边本身比普通气泡亮一档（`--bot-guest-border`）：「有人来串门」应该在一屏里被扫
 * 到，而不是要逐条读名字才发现。
 */
export function BotGuestMessage({ guest, content, workingDir, sessionId }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  const profile = profiles.find((item) => item.id === guest.botId);
  const { openArtifact, artifactLightboxes } = useBotArtifactOpen();
  // 发起方任务里，这条客座气泡就是「TA 交上来的东西」那一刻。产物挂在委派行上，
  // 挂到这条消息底下才是它自然的位置——否则用户得先展开协作卡才知道交了什么。
  // 目标伙伴主任务里的 guest-request（收到的请求）查不到这行，自然什么都不挂。
  const row = useBotDelegation(sessionId ?? null, guest.delegationId);
  const artifacts =
    row && row.outputArtifacts.length > 0
      ? row.outputArtifacts.map((artifact) =>
          makeBotArtifact({
            source: 'delegation',
            target: artifact.ref,
            isRef: true,
            createdAt: row.completedAt ?? row.updatedAt,
            sessionId: row.childSessionId,
            delegationId: row.id,
          }),
        )
      : [];
  const bot = {
    name: profile?.name || guest.name || guest.botId,
    avatar: profile?.avatar ?? null,
    avatarColor: profile?.avatarColor ?? null,
  };

  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-0.5 shrink-0">
        <BotAvatar bot={bot} size="sm" />
      </span>
      <div className="min-w-0 max-w-[74%] rounded-xl border border-[var(--bot-guest-border)] bg-[var(--surface-chip)] px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="truncate text-11 font-semibold text-[var(--text-secondary)]">
            {bot.name}
          </span>
          <span className="shrink-0 rounded-full border border-[var(--border-default)] px-1.5 py-px text-10 font-normal text-[var(--text-tertiary)]">
            {t('bots.collab.guestTag')}
          </span>
        </div>
        <MarkdownRenderer content={content} workingDir={workingDir ?? ''} />
        {artifacts.length > 0 ? (
          <div className="mt-2 flex flex-col gap-1.5">
            {artifacts.map((item) => (
              <BotArtifactCard
                key={item.id}
                item={item}
                deliveredBy={bot.name}
                onOpen={(target) => void openArtifact(target)}
                {...(sessionId
                  ? {
                      onReveal: (target: BotArtifactItem) =>
                        void openBotArtifactsTab(sessionId, { focusArtifactId: target.id }),
                    }
                  : {})}
              />
            ))}
            {artifactLightboxes}
          </div>
        ) : null}
        {guest.linkedSessionId ? (
          <button
            type="button"
            onClick={() =>
              navigate(
                `/bots/${encodeURIComponent(guest.botId)}/session/${encodeURIComponent(
                  guest.linkedSessionId!,
                )}`,
              )
            }
            className="mt-2 inline-flex items-center gap-1.5 text-11 text-[var(--text-tertiary)] transition-colors hover:text-[var(--text-secondary)]"
          >
            <ExternalLink size={11} aria-hidden="true" />
            {t('bots.collab.openTask', { name: bot.name })}
          </button>
        ) : null}
      </div>
    </div>
  );
}
