import { useEffect, useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { BotChatIdentity } from './BotSessionContentHeader';

function readBotChatIdentity(bot: unknown, botId: string): BotChatIdentity | null {
  if (!bot || typeof bot !== 'object') return null;
  const candidate = bot as { name?: unknown; avatar?: unknown; avatarColor?: unknown };
  return {
    id: botId,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    avatar: typeof candidate.avatar === 'string' ? candidate.avatar : null,
    avatarColor: typeof candidate.avatarColor === 'string' ? candidate.avatarColor : null,
  };
}

/** Historical Bot transcripts are reviewable but never writable from the history route. */
export function BotHistorySessionView() {
  const { t } = useTranslation();
  const { botId, sessionId } = useParams();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  /**
   * 归档的对话里,那个伙伴仍然是那个伙伴:气泡挂 TA 的头像,顶栏是 TA 的 lockup。
   * 这个视图本来就已经查过 `bots.history(botId)` 确认归属,顺手把身份取回来即可
   * ——只读路径,不影响任何写入。
   */
  const [identity, setIdentity] = useState<BotChatIdentity | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!botId || !sessionId) {
      setAllowed(false);
      return () => {
        cancelled = true;
      };
    }
    void window.electronAPI.localDb.bots
      .history(botId)
      .then((rows) => {
        if (cancelled) return;
        const found = rows.some(
          (row) =>
            !!row &&
            typeof row === 'object' &&
            'id' in row &&
            typeof (row as { id?: unknown }).id === 'string' &&
            (row as { id: string }).id === sessionId,
        );
        setAllowed(found);
      })
      .catch(() => {
        if (!cancelled) setAllowed(false);
      });
    // 身份是装饰,拿不到就退回没有头像的只读历史——不因为它失败挡住整页。
    void window.electronAPI.localDb.bots
      .get(botId)
      .then((bot) => {
        if (!cancelled) setIdentity(readBotChatIdentity(bot, botId));
      })
      .catch(() => {
        if (!cancelled) setIdentity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, sessionId]);

  if (allowed === null) {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <p className="text-13 text-[var(--text-secondary)]">{t('ccAgent.common.loading')}</p>
      </main>
    );
  }
  if (!allowed || !sessionId) {
    return <Navigate to={botId ? `/bots/${botId}?settings=1` : '/bots'} replace />;
  }
  return <CCAgentSessionView readOnly {...(identity ? { botIdentity: identity } : {})} />;
}
