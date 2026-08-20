import { useEffect, useMemo, useState } from 'react';
import { Archive, Bot, Plus } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { useAgentIslandActivityMap } from '@/state/agentIslandActivity';
import { useSidebarCollapsedState, useRegisterSidebarUpper } from '../feature-context';
import type { BotInboxItemView } from '../../../shared/botSessionEvents';
import { BotAvatar } from './BotAvatar';
import {
  botListSubtitle,
  formatBotListTimestamp,
  formatBotUnreadBadge,
} from './botListDisplay';
import { subscribeBotReadState } from './botReadState';
import { refreshBotProfiles, useBotProfiles, useBotUnreadCounts } from './botStore';

/** Debounce for message-driven refreshes: one turn writes many rows. */
const MESSAGE_REFRESH_DEBOUNCE_MS = 800;

/**
 * 未读药丸。用的是登记在 DESIGN.md §10 的窄作用域 token `--bot-unread-bg` /
 * `--bot-unread-fg`（双模式同值 #417CDD + 白字），不是反相 CTA：白底药丸落在选中行
 * 的浅灰选中态上会和选中态互相抢焦点，而「有新消息」在 IM 里本来就有一个所有人都
 * 认得的颜色。这个 token 只服务伙伴列表的未读徽标与待办点，不外溢到别的地方。
 */
const UNREAD_BADGE_CLASS =
  'flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[var(--bot-unread-bg)] px-1.5 text-11 font-medium leading-none text-[var(--bot-unread-fg)]';

function BotsSidebarContent() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { botId } = useParams();
  const bots = useBotProfiles();
  const unreadByBotId = useBotUnreadCounts();
  const activeBots = bots.filter((bot) => bot.status !== 'archived');
  const archivedBots = bots.filter((bot) => bot.status === 'archived');
  const collapsed = useSidebarCollapsedState();
  const [attentionByBotId, setAttentionByBotId] = useState<Record<string, number>>({});
  const now = Date.now();

  /*
    「正在输入…」的信号来源：灵动岛活动镜像(state/agentIslandActivity)。
    **没有新增 IPC** —— 主进程本来就在广播这份 per-session 快照，任务列表的
    SessionCard 用的也是它，这里只是多一个读者。

    为什么选它而不是 makerChatStore 的全局 running 快照：
     - 它是全量推送，主进程持有状态机，窗口在一次 turn 中途冷启动也补得回来；
       makerChatStore 的分片要等该会话**下一个**事件到达才materialize，长工具
       调用期间会是空的。
     - 它与灵动岛开关无关，非 macOS 上服务也以 headless 方式跑着照常广播
       (main/agent-island/service.ts 的 publish 两条分支都会 emit)。
     - 依赖轻：只吃 shared 里的类型，不用把整个聊天 store 拖进侧栏。

    刻意**不**挂 useSessionRunningStatus —— 那个 hook 还负责完成/出错角标与系统
    通知的状态机，在这里再挂一份会把那些副作用发两遍。
  */
  const islandActivity = useAgentIslandActivityMap();
  const isBotWorking = (bot: { canonicalSessionId?: string | null; sessions: Array<{ id: string }> }): boolean => {
    // 委派干活发生在子任务,不在主任务。只看 canonical 的话,目标伙伴侧栏会一直是
    // 静默的,发起方却在等 —— 这正是「目标侧执行过程黑洞」在列表上的样子。
    if (bot.canonicalSessionId && islandActivity.get(bot.canonicalSessionId)?.phase === 'running') {
      return true;
    }
    return bot.sessions.some((session) => islandActivity.get(session.id)?.phase === 'running');
  };

  // 曾经这里还按 bot 逐个拉 `getBotHealth` 只为在行尾画一个状态图标。图标下线之后
  // 这一轮 N 次 IPC 也一起下线——列表不再为一个不显示的东西查询。

  useEffect(() => {
    let cancelled = false;
    const load = async (targetBotId?: string) => {
      const targets = targetBotId ? bots.filter((bot) => bot.id === targetBotId) : bots;
      const settled = await Promise.allSettled(
        targets.map(
          async (bot) =>
            [bot.id, await window.electronAPI.maker.botInbox.list(bot.id, 100)] as const,
        ),
      );
      if (cancelled) return;
      setAttentionByBotId((previous) => {
        const next = { ...previous };
        for (const result of settled) {
          if (result.status !== 'fulfilled') continue;
          const [id, items] = result.value as readonly [string, BotInboxItemView[]];
          next[id] = items.filter(
            (item) =>
              item.status === 'pending' || item.status === 'processing' || item.status === 'failed',
          ).length;
        }
        return next;
      });
    };
    void load();
    const unsubscribe = window.electronAPI.maker.botInbox.onChanged((payload) => {
      void load(payload.botId);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [bots]);

  // A chat list has to move when a message lands. There is no Bot-scoped
  // message push, so reuse the existing localDb message broadcast and only
  // refresh when the row belongs to a Bot task (a normal Cindy chat must not
  // make the Bots list re-query).
  useEffect(() => {
    const botSessionIds = new Set<string>();
    for (const bot of bots) {
      if (bot.canonicalSessionId) botSessionIds.add(bot.canonicalSessionId);
      for (const session of bot.sessions) botSessionIds.add(session.id);
    }
    if (botSessionIds.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const subscribe = window.electronAPI?.localDb?.messages?.onCreated;
    if (typeof subscribe !== 'function') return;
    const unsubscribe = subscribe((payload: unknown) => {
      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId;
      if (typeof sessionId !== 'string' || !botSessionIds.has(sessionId)) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshBotProfiles();
      }, MESSAGE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe?.();
    };
  }, [bots]);

  // Unread counts are computed main-side against the read positions this
  // renderer owns, so a read position moving (the user opened a Bot chat, or
  // kept watching one) has to re-ask for the list. Same debounce as the
  // message feed: a streaming turn advances the position row by row.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeBotReadState(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refreshBotProfiles();
      }, MESSAGE_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-2 px-2 pt-3">
        <button
          type="button"
          onClick={() => navigate('/bots')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover"
          aria-label={t('bots.title')}
        >
          <Bot size={16} />
        </button>
        <button
          type="button"
          onClick={() => navigate('/bots/roster')}
          className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover"
          aria-label={t('bots.add')}
        >
          <Plus size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pt-2">
      {/* 小节头与伙伴行的正文左边缘对齐:容器 12px + 行内 10px = 22px。 */}
      <div className="flex items-center justify-between px-2.5 pb-2">
        <div className="flex items-center gap-2 text-12 font-medium text-[var(--sidebar-list-muted)]">
          <Bot size={14} />
          <span>{t('bots.title')}</span>
        </div>
        {/* 小节头只留「加一个」。导入下沉到创建面板的文字链与「设置 › 伙伴」——
            它一年用一次,不该常年占着这行最贵的位置。 */}
        <button
          type="button"
          onClick={() => navigate('/bots/roster')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--sidebar-list-muted)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--sidebar-nav-text)]"
          aria-label={t('bots.add')}
        >
          <Plus size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {activeBots.length === 0 && archivedBots.length === 0 ? (
          <button
            type="button"
            onClick={() => navigate('/bots/roster')}
            // 定稿 `.side-empty{padding:12px 14px}`。原来的 `mx-1 w-[calc(100%-8px)]`
            // 让空态卡比它下面的伙伴行窄 8px,两种状态切换时左边缘会跳。
            className="flex w-full flex-col items-start gap-1 rounded-xl border border-dashed border-[var(--border-default)] px-3.5 py-3 text-left text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <span className="font-medium text-[var(--text-primary)]">{t('bots.emptyTitle')}</span>
            <span>{t('bots.emptyDescription')}</span>
          </button>
        ) : (
          <div className="flex flex-col gap-1">
            {activeBots.map((bot) => {
              const selected = bot.id === botId;
              const attention = attentionByBotId[bot.id] ?? 0;
              const unread = unreadByBotId[bot.id] ?? 0;
              const subtitle = botListSubtitle(bot);
              // TA 正在回话时，第二行临时让位给「正在输入…」——聊天列表里这一行
              // 回答的是「TA 现在怎么样」，进行中比上一句说过什么更要紧。回合一
              // 结束就落回最新消息预览，不留痕。
              const typing = isBotWorking(bot);
              const subtitleText = typing
                ? t('bots.list.typing')
                : subtitle.kind === 'placeholder'
                  ? t('bots.list.startChat')
                  : subtitle.text;
              const timestamp = formatBotListTimestamp(bot.lastMessageAt, now);
              // The selected pill is a light/dark gray fill, not an inverse one,
              // so muted text on it would sit at a far lower contrast than on
              // the sidebar background. Dim by opacity there, use the sidebar's
              // tertiary token everywhere else.
              const mutedClass = selected ? 'opacity-70' : 'text-[var(--sidebar-list-muted)]';
              return (
                <div
                  key={bot.id}
                  className={cn(
                    'group relative flex w-full items-center rounded-xl transition-colors',
                    selected
                      ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                      : 'text-[var(--sidebar-nav-text)] hover:bg-sidebar-item-hover',
                  )}
                >
                  {/* 定稿原型 `.row-open{padding:8px 10px;gap:10px}`:整行只有这一个
                      可点区域,左右内边距对称。行尾曾经还挂过一列齿轮/状态图标,
                      它下线后 `pr-2` 的占位残留了下来 —— 右边比左边窄一截,
                      单看不出问题,和左侧头像一比就是歪的。数值基线见
                      __tests__/botsSidebarSpacing.test.ts。 */}
                  <button
                    type="button"
                    onClick={() => navigate(`/bots/${bot.id}`)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-2.5 py-2 text-left"
                  >
                    {/* 40px。28px 会让两行式行高塌成一行的观感——头像撑不住两行文字,
                        整行读起来像一条被拉高的单行列表。 */}
                    <BotAvatar bot={bot} size="md" />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-14 leading-5',
                            unread > 0 ? 'font-medium' : 'font-normal',
                          )}
                          title={bot.name}
                        >
                          {bot.name}
                        </span>
                        {/* 产品裁决 2026-08-18:侧栏行不挂「放手做」⚠。伙伴列表是
                            聊天列表,不是权限看板;风险表达留在设置里的能力陈列。 */}
                        {timestamp ? (
                          <span className={cn('shrink-0 text-11', mutedClass)}>
                            {timestamp}
                          </span>
                        ) : null}
                      </span>
                      <span className="flex items-center gap-2">
                        {/* 未读时不加 mutedClass:第二行跟着提到一级色,「有新消息」在
                            一屏里靠亮度就能被扫到,不用先读数字。 */}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-12 leading-4',
                            // 「正在输入…」是个过程说明,不是消息内容:斜体 + 三级色,
                            // 哪怕这一行有未读也不跟着提到一级——否则一个瞬时状态
                            // 会比真正的新消息还抢眼。
                            typing
                              ? cn('italic', mutedClass)
                              : unread > 0
                                ? 'font-medium'
                                : mutedClass,
                          )}
                          title={subtitleText}
                        >
                          {subtitleText}
                        </span>
                        {/* Unread messages own the numeric badge (IM convention:
                            the count answers "how much have I not seen"). A
                            pending inbox todo is a second, weaker signal — when
                            both are live it degrades to a dot so the row never
                            shows two competing counts; its number stays in the
                            label. 两者都长在第二行的右端(定稿 `.row-l2` 的
                            justify-between 位),不再另开一列。 */}
                        {unread > 0 ? (
                          <span
                            className={UNREAD_BADGE_CLASS}
                            aria-label={t('bots.list.unread', { count: unread })}
                          >
                            {formatBotUnreadBadge(unread)}
                          </span>
                        ) : null}
                        {attention > 0 ? (
                          unread > 0 ? (
                            <span
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--bot-unread-bg)]"
                              aria-label={t('bots.inbox.sidebarAttention', { count: attention })}
                            />
                          ) : (
                            <span
                              className={UNREAD_BADGE_CLASS}
                              aria-label={t('bots.inbox.sidebarAttention', { count: attention })}
                            >
                              {formatBotUnreadBadge(attention)}
                            </span>
                          )
                        ) : null}
                      </span>
                    </span>
                  </button>
                  {/* 行内不再挂 health 图标(recovering / attention / paused)。一行
                      右侧同时出现「未读数 + 待办点 + 状态图标」时,三处右对齐元素
                      互相抢注意力,而这一行本来只该回答「有没有新消息」。异常态仍有
                      出口:待办点(收件箱)与 TA 的设置页「健康与历史」。
                      行内也不再挂齿轮:进设置的入口收敛到对话顶栏(伙伴名字 / 头像,
                      以及顶栏右侧的齿轮)。一个功能一个入口。 */}
                </div>
              );
            })}
            {archivedBots.length > 0 ? (
              <div className="mt-3 border-t border-[var(--border-default)] pt-3">
                <div className="mb-1 flex items-center gap-2 px-2.5 text-10 font-medium text-[var(--sidebar-list-muted)]">
                  <Archive size={12} />
                  <span>{t('bots.lifecycle.archivedBots')}</span>
                </div>
                {archivedBots.map((bot) => {
                  const selected = bot.id === botId;
                  return (
                    <button
                      type="button"
                      key={bot.id}
                      onClick={() => navigate(`/bots/${bot.id}?settings=1`)}
                      className={cn(
                        'group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
                        selected
                          ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
                          : 'text-[var(--sidebar-list-muted)] hover:bg-sidebar-item-hover',
                      )}
                    >
                      <BotAvatar bot={bot} size="sm" className="opacity-70" />
                      <span className="min-w-0 flex-1 truncate text-13 font-medium" title={bot.name}>
                        {bot.name}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export function BotsSidebar() {
  const content = useMemo(() => <BotsSidebarContent />, []);
  useRegisterSidebarUpper(content);
  return null;
}
