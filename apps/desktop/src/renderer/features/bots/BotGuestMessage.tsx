import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { BotAvatar } from './BotAvatar';
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
}

/**
 * 客座气泡：这条消息的作者不是本任务的主人，而是委派里的另一方。
 *
 * 在发起方任务里，它是目标伙伴回传的答复；在目标伙伴的主任务里，它是发起方送来的
 * 请求。两种情况共用一套外观：左侧对方的头像，气泡左上角一枚中性描边的「客座」
 * 标签——让人一眼看出「这句话是别人来串门说的」，同时不把它伪装成本任务的主人。
 *
 * 标签刻意用描边而非彩色底：对话里已经有足够多的颜色，客座是身份说明，不是状态告警。
 */
export function BotGuestMessage({ guest, content, workingDir }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const profiles = useBotProfiles();
  const profile = profiles.find((item) => item.id === guest.botId);
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
      <div className="min-w-0 max-w-[74%] rounded-xl border border-[var(--border-default)] bg-[var(--surface-chip)] px-3.5 py-2.5">
        <div className="mb-1.5 flex items-center gap-1.5">
          <span className="truncate text-11 font-semibold text-[var(--text-secondary)]">
            {bot.name}
          </span>
          <span className="shrink-0 rounded-full border border-[var(--border-default)] px-1.5 py-px text-10 font-normal text-[var(--text-tertiary)]">
            {t('bots.collab.guestTag')}
          </span>
        </div>
        <MarkdownRenderer content={content} workingDir={workingDir ?? ''} />
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
