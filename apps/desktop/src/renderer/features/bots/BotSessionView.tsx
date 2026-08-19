import { useEffect, useState } from 'react';
import { ArrowLeft, CircleAlert, RefreshCcw } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Spinner } from '@/components/ui/spinner';
import { CCAgentSessionView } from '@/features/cc-agent/CCAgentSessionView';
import type { ComposerBotMention } from '@/lib/fileTypes';
import { markBotRead } from './botReadState';
import type { BotChatIdentity } from './BotSessionContentHeader';
import { deliverPendingBotPersonaAck } from './botPersonaAck';
import { deliverPendingBotWelcome } from './botWelcome';

type BotSessionGate =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      mentions: ComposerBotMention[];
      identity: BotChatIdentity;
      /** True only for the Bot's own canonical chat (not a mounted channel route). */
      isCanonical: boolean;
    }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function readBotChatIdentity(bot: unknown, botId: string): BotChatIdentity {
  const candidate = (bot ?? {}) as { name?: unknown; avatar?: unknown; avatarColor?: unknown };
  return {
    id: botId,
    name: typeof candidate.name === 'string' ? candidate.name : '',
    avatar: typeof candidate.avatar === 'string' ? candidate.avatar : null,
    avatarColor: typeof candidate.avatarColor === 'string' ? candidate.avatarColor : null,
  };
}

function readBotMention(value: unknown, currentBotId: string): ComposerBotMention | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    enabled?: unknown;
    status?: unknown;
  };
  if (
    typeof candidate.id !== 'string'
    || candidate.id === currentBotId
    || typeof candidate.name !== 'string'
    || candidate.enabled === false
    || (candidate.status !== undefined && candidate.status !== 'active')
  ) {
    return null;
  }
  return {
    id: candidate.id,
    name: candidate.name,
    ...(typeof candidate.description === 'string' && candidate.description.trim()
      ? { description: candidate.description }
      : {}),
  };
}

/**
 * A Bot URL is a navigation projection, not authority to adopt an arbitrary
 * Cindy task. Check the durable Bot link before mounting the writable chat.
 */
export function BotSessionView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId, sessionId } = useParams();
  const [reloadVersion, setReloadVersion] = useState(0);
  const [gate, setGate] = useState<BotSessionGate>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    if (!botId || !sessionId) {
      setGate({ kind: 'unavailable' });
      return () => {
        cancelled = true;
      };
    }
    setGate({ kind: 'loading' });
    void Promise.all([
      window.electronAPI.localDb.bots.get(botId),
      window.electronAPI.localDb.bots.list(),
    ])
      .then(([bot, bots]) => {
        if (cancelled) return;
        if (!bot || typeof bot !== 'object') {
          setGate({ kind: 'unavailable' });
          return;
        }
        const sessions = (bot as { sessions?: unknown }).sessions;
        const profileStatus = (bot as { status?: unknown }).status;
        const found =
          profileStatus === 'active' &&
          Array.isArray(sessions) &&
          sessions.some((row) => {
            if (!row || typeof row !== 'object') return false;
            const projection = row as { id?: unknown; kind?: unknown; status?: unknown };
            return (
              projection.id === sessionId &&
              (projection.kind === 'chat' || projection.kind === 'route') &&
              projection.status === 'active'
            );
          });
        if (!found) {
          setGate({ kind: 'unavailable' });
          return;
        }
        setGate({
          kind: 'ready',
          // 欢迎语只属于主任务:渠道路由任务是「别处的对话被接进来」,
          // 在那里冒出一句自我介绍是插话,不是打招呼。
          isCanonical: (bot as { canonicalSessionId?: unknown }).canonicalSessionId === sessionId,
          identity: readBotChatIdentity(bot, botId),
          mentions: Array.isArray(bots)
            ? bots
                .map((candidate) => readBotMention(candidate, botId))
                .filter((candidate): candidate is ComposerBotMention => candidate !== null)
            : [],
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGate({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [botId, reloadVersion, sessionId]);

  // Opening the conversation is what marks it read, and staying in it keeps it
  // read: while this view is mounted every row that lands in the task advances
  // the read position, so a reply the user is watching arrive never turns into
  // an unread badge behind their back.
  useEffect(() => {
    if (gate.kind !== 'ready' || !botId || !sessionId) return;
    markBotRead(botId);
    const subscribe = window.electronAPI?.localDb?.messages?.onCreated;
    if (typeof subscribe !== 'function') return;
    const unsubscribe = subscribe((payload: unknown) => {
      const incoming = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (incoming !== sessionId) return;
      markBotRead(botId);
    });
    return () => {
      unsubscribe?.();
    };
  }, [botId, gate.kind, sessionId]);

  // 入伙即打招呼:创建时寄存的欢迎语,在 TA 的主任务第一次真正打开时落成一条
  // assistant 消息。幂等三重保险见 botWelcome.ts;这里只负责「什么时候交付」。
  const welcomeReady = gate.kind === 'ready' && gate.isCanonical;
  useEffect(() => {
    if (!welcomeReady || !botId || !sessionId) return;
    void deliverPendingBotWelcome(botId, sessionId, {
      listMessages: (id) => window.electronAPI.localDb.messages.list(id, { limit: 1 }),
      createMessage: (id, body) => window.electronAPI.localDb.messages.create(id, body),
      // params 必须透传:`bots.welcome.generic` / `withRole` 里带 {{name}}、
      // {{description}}。i18next 默认 skipOnVariables=true,缺变量时**原样保留**
      // 占位符而不是报错,所以漏传的后果是伙伴张嘴第一句就是「嗨,我是{{name}}。」
      // ——自己写的伙伴与部分 AI 生成伙伴 100% 命中。与下面 personaAck 同款签名。
      translate: (key, params) => t(key, params),
    });
  }, [botId, sessionId, t, welcomeReady]);

  // 调完性格,TA 用新口气回一句。与打招呼同一条注入路径,区别只有一个:确认消息
  // 本来就发生在一段已有的对话里,所以不看任务空不空,幂等全交给 clientId
  // (见 botPersonaAck.ts)。
  useEffect(() => {
    if (!welcomeReady || !botId || !sessionId) return;
    void deliverPendingBotPersonaAck(botId, sessionId, {
      createMessage: (id, body) => window.electronAPI.localDb.messages.create(id, body),
      translate: (key, params) => t(key, params),
    });
  }, [botId, sessionId, t, welcomeReady]);

  if (gate.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <Spinner
          size={20}
          className="text-[var(--text-tertiary)]"
          role="status"
          aria-label={t('ccAgent.common.loading')}
        />
      </main>
    );
  }
  if (gate.kind !== 'ready' || !sessionId) {
    const failed = gate.kind === 'error';
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert
            size={24}
            className="mx-auto text-[var(--text-danger)]"
            aria-hidden
          />
          <h1 className="mt-3 text-16 font-medium text-[var(--text-primary)]">
            {t(failed ? 'bots.sessionLoadFailedTitle' : 'bots.sessionUnavailableTitle')}
          </h1>
          <p className="mt-2 break-words text-12 leading-5 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
            {failed ? t('bots.sessionLoadFailedDescription') : t('bots.sessionUnavailableDescription')}
          </p>
          {failed && gate.message ? (
            <p className="mt-3 max-h-24 overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--surface)] px-3 py-2 text-left text-11 text-[var(--text-danger)] [overflow-wrap:anywhere]">
              {gate.message}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => navigate(botId ? `/bots/${botId}` : '/bots')}
              className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
            >
              <ArrowLeft size={14} />
              {t('bots.backToBot')}
            </button>
            {failed ? (
              <button
                type="button"
                onClick={() => setReloadVersion((value) => value + 1)}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--accent-cta-bg)] px-3 text-12 font-medium text-[var(--accent-pure-cta-fg)]"
              >
                <RefreshCcw size={14} />
                {t('bots.retry')}
              </button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }
  return <CCAgentSessionView botMentions={gate.mentions} botIdentity={gate.identity} />;
}
