/**
 * 伙伴设置 →「消息平台」: 这位伙伴自己的 IM 机器人。
 *
 * 用户在平台(Telegram BotFather / 飞书开放平台 / 企业微信 / 钉钉 / Discord)自己申请机器人,
 * 把凭证填在这里, 这个机器人就是这位伙伴: 主人私聊进伙伴主任务, 群 / 话题 / 外部用户私聊各一条隐藏专线,
 * 同一伙伴的所有渠道共享记忆(规则见 docs/product-rules/cindy-bots-runtime.md)。
 * 与 设置 → IM 机器人 里那份个人 bot 各用各的凭证; 添加时也可以把那份个人 bot 一次性移过来
 * (个人 bot 随之清空)。远端伙伴没有这一页。
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Briefcase, Gamepad2, MessageSquare, Plus, Send, Zap, type LucideIcon } from 'lucide-react';

import { AttentionDot } from '@/components/sidebar/AttentionDot';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { FormField } from '@/components/ui/form-field';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { formatRelative } from '@/hooks/useRelativeTime';
import { extractIpcError } from '@/utils/ipcError';
import type {
  BotImAdoptablePersonalBot,
  BotImChannel,
  BotImConnectionAddInput,
  BotImConnectionGroup,
  BotImConnectionLane,
  BotImConnectionListPayload,
  BotImConnectionView,
  BotImFeishuService,
  BotImGroupActivationMode,
} from '../../../shared/botImConnection';
import { useBotTranslation } from './botPronounContext';
import type { BotProfile } from './botStore';
import {
  addBotImConnection,
  adoptPersonalBot,
  botImConnectionGroupsSupported,
  botImConnectionLanesSupported,
  listBotImConnectionGroups,
  listBotImConnectionLanes,
  listAdoptablePersonalBots,
  maskBotImContextId,
  removeBotImConnection,
  resetBotImConnectionLane,
  setBotImConnectionGroupActivation,
  useBotImConnections,
} from './botImConnectionClient';

const BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const OWNER_USER_ID_PATTERN = /^\d{4,20}$/;
const DISCORD_OWNER_ID_PATTERN = /^\d{17,20}$/;

const CHANNEL_ICON: Record<BotImChannel, LucideIcon> = {
  telegram: Send,
  feishu: MessageSquare,
  wecom: Briefcase,
  dingtalk: Zap,
  discord: Gamepad2,
};

function ChannelIcon({ channel }: { channel: BotImChannel }) {
  const Icon = CHANNEL_ICON[channel];
  return <Icon size={18} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />;
}

type StatusTone = 'connected' | 'pending' | 'off' | 'error';

function statusPresentation(view: BotImConnectionView): { key: string; tone: StatusTone; detail?: string } {
  switch (view.status.kind) {
    case 'connected':
      return { key: 'connected', tone: 'connected' };
    case 'connecting':
      return { key: 'connecting', tone: 'pending' };
    case 'offline':
      return { key: 'offline', tone: 'off' };
    case 'conflict':
      return { key: 'conflict', tone: 'error' };
    case 'error':
      return { key: 'error', tone: 'error', detail: view.status.reason };
    default:
      return { key: 'idle', tone: 'off' };
  }
}

const STATUS_DOT: Record<StatusTone, string> = {
  connected: 'var(--settings-badge-connected)',
  pending: 'var(--settings-badge-needs-config)',
  off: 'var(--settings-badge-needs-config)',
  error: 'var(--error-fg)',
};
const STATUS_TEXT: Record<StatusTone, string> = {
  connected: 'var(--settings-badge-connected-text)',
  pending: 'var(--text-tertiary)',
  off: 'var(--text-tertiary)',
  error: 'var(--error-fg)',
};

export function BotChannelsPage({ bot }: { bot: BotProfile }) {
  const { t } = useBotTranslation();
  const { payload, loading, apply } = useBotImConnections();
  const { confirm } = useConfirmDialog();
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const mine = (payload?.connections ?? []).filter((item) => item.botId === bot.id);

  const platformName = (view: Pick<BotImConnectionView, 'channel' | 'service'>) =>
    view.channel === 'feishu'
      ? t(view.service === 'lark' ? 'bots.channels.platform.lark' : 'bots.channels.platform.feishu')
      : t(`bots.channels.platform.${view.channel}`);
  const identityLabel = (view: BotImConnectionView) => {
    // Telegram 显示 @用户名; Discord 显示 bot 标签; 其它渠道只露平台身份的脱敏片段。
    if (view.channel === 'telegram') {
      return view.identity.username ? `@${view.identity.username}` : (view.botContextId ?? '');
    }
    if (view.channel === 'discord' && view.identity.username) return view.identity.username;
    return view.botContextId ? maskBotImContextId(view.botContextId) : '';
  };

  const remove = async (view: BotImConnectionView) => {
    if (removingId) return;
    const ok = await confirm({
      title: t('bots.channels.removeConfirm.title', { platform: platformName(view) }),
      description: t('bots.channels.removeConfirm.description', { name: bot.name }),
      confirmText: t('bots.channels.removeConfirm.confirm'),
      cancelText: t('bots.channels.removeConfirm.cancel'),
      confirmVariant: 'destructive',
    });
    if (!ok) return;
    setRemovingId(view.id);
    try {
      apply(await removeBotImConnection(view.id));
    } catch {
      await confirm({
        title: t('bots.channels.removeConfirm.failed'),
        confirmText: t('bots.channels.removeConfirm.ok'),
        showCancel: false,
      });
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <section className="flex flex-col gap-4 pt-3" aria-label={t('bots.channels.title')}>
      {loading && !payload ? (
        <div className="flex justify-center py-6 text-[var(--text-tertiary)]">
          <Spinner size={16} />
        </div>
      ) : mine.length > 0 ? (
        <ul className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]">
          {mine.map((view) => {
            const status = statusPresentation(view);
            const identity = identityLabel(view);
            return (
              <li
                key={view.id}
                className="border-b border-[var(--border-default)] px-4 py-3 last:border-b-0"
              >
                <div className="flex min-h-8 items-center gap-3">
                <ChannelIcon channel={view.channel} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-14 text-[var(--text-primary)]">{platformName(view)}</p>
                  <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
                    {identity ? (
                      <>
                        <span className="min-w-0 truncate">{identity}</span>
                        <span aria-hidden className="text-[var(--text-tertiary)]">
                          ·
                        </span>
                      </>
                    ) : null}
                    <span
                      className="inline-flex min-w-0 shrink items-center gap-1.5"
                      style={{ color: STATUS_TEXT[status.tone] }}
                      title={status.detail}
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: STATUS_DOT[status.tone] }}
                      />
                      <span className="truncate">
                        {t(`bots.channels.status.${status.key}`)}
                        {status.detail ? ` · ${status.detail}` : ''}
                      </span>
                    </span>
                  </p>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  tone="quiet"
                  size="sm"
                  compact
                  loading={removingId === view.id}
                  disabled={removingId !== null && removingId !== view.id}
                  aria-label={t('bots.channels.removeAria', { platform: platformName(view) })}
                  onClick={() => void remove(view)}
                >
                  {t('bots.channels.remove')}
                </Button>
                </div>
                {view.channel === 'telegram' && view.botContextId && botImConnectionGroupsSupported() ? (
                  <ConnectionGroups connectionId={view.id} botName={bot.name} />
                ) : null}
                {view.botContextId && botImConnectionLanesSupported() ? (
                  <ConnectionLanes connectionId={view.id} botName={bot.name} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-1 text-13 leading-[1.5] text-[var(--text-secondary)]">
          {t('bots.channels.empty', { name: bot.name })}
        </p>
      )}
      <div>
        <Button type="button" variant="secondary" size="md" onClick={() => setAdding(true)}>
          <Plus size={14} aria-hidden />
          {t('bots.channels.add.button')}
        </Button>
      </div>
      <p className="px-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
        {t('bots.channels.externalNote', { name: bot.name })}
      </p>
      <p className="px-1 text-12 leading-[1.5] text-[var(--text-tertiary)]">
        {t('bots.channels.sharedMemoryNote', { name: bot.name })}
      </p>
      {adding ? (
        <BotChannelAddDialog bot={bot} onApplied={apply} onOpenChange={setAdding} />
      ) : null}
    </section>
  );
}

/**
 * 一条 Telegram 连接的「群聊」小节: 机器人进过的群 + 每群参与模式(仅 @ / 全响应)。
 * 与 设置 → IM 机器人 的同名设置各管各的 bot; 乐观更新, 保存失败回读正本并提示。
 */
function ConnectionGroups({ connectionId, botName }: { connectionId: string; botName: string }) {
  const { t } = useBotTranslation();
  const [groups, setGroups] = useState<BotImConnectionGroup[] | null>(null);
  const [error, setError] = useState<'load' | 'save' | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void listBotImConnectionGroups(connectionId)
      .then((payload) => {
        if (!cancelled) setGroups(payload.groups);
      })
      .catch(() => {
        if (!cancelled) setError('load');
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, reloadToken]);

  const setMode = useCallback(
    (chatId: string, mode: BotImGroupActivationMode) => {
      const revision = ++latest.current;
      setGroups((current) =>
        current ? current.map((g) => (g.chatId === chatId ? { ...g, activation: mode } : g)) : current,
      );
      setError(null);
      void setBotImConnectionGroupActivation(connectionId, chatId, mode)
        .then((payload) => {
          if (revision === latest.current) setGroups(payload.groups);
        })
        .catch(() => {
          if (revision !== latest.current) return;
          setError('save');
          void listBotImConnectionGroups(connectionId)
            .then((payload) => {
              if (revision === latest.current) setGroups(payload.groups);
            })
            .catch(() => undefined);
        });
    },
    [connectionId],
  );

  if (groups === null && error !== 'load') return null;
  if (groups !== null && groups.length === 0 && error === null) return null;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
      <div className="text-12 font-medium text-[var(--text-primary)]">{t('bots.channels.groups.title')}</div>
      <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
        {t('bots.channels.groups.hint', { name: botName })}
      </p>
      {error !== null ? (
        <p className="flex items-center gap-2 text-12 text-[var(--text-danger)]">
          <span>{t(error === 'load' ? 'bots.channels.groups.loadFailed' : 'bots.channels.groups.saveFailed')}</span>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t('bots.channels.groups.retry')}
          </button>
        </p>
      ) : null}
      {(groups ?? []).map((group) => (
        <div key={group.chatId} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-12 text-[var(--text-primary)]">{group.chatName || group.chatId}</div>
            <div className="text-11 text-[var(--text-tertiary)]">{group.chatId}</div>
          </div>
          <SegmentedControl
            aria-label={`${group.chatName || group.chatId} · ${t('bots.channels.groups.title')}`}
            value={group.activation}
            onValueChange={(mode) => setMode(group.chatId, mode)}
            height={30}
            optionHeight={24}
            optionClassName="text-11"
            options={(['mention', 'always'] as const).map((mode) => ({
              value: mode,
              label: t(`bots.channels.groups.mode.${mode}`),
            }))}
          />
        </div>
      ))}
    </div>
  );
}

/** 状态在后台会变(正在回复 → 空闲): 页面开着时隔一会儿重读一次, 窗口不可见时不读。 */
const LANES_REFRESH_MS = 20_000;

const LANE_KIND_KEY: Record<BotImConnectionLane['kind'], string> = {
  'owner-dm': 'ownerDm',
  group: 'group',
  topic: 'topic',
  'guest-dm': 'guestDm',
};

/**
 * 一条连接的「隐藏任务」小节: 主人私聊(伙伴主任务)、每个群 / 话题与其他人的私聊各一行,
 * 显示状态、最近活动和当前上下文里的消息数; 卡住时可以让某一条重新开始(同一条任务,
 * 记录保留, 下一条消息换干净的上下文)。隐藏任务没有自己的任务页, 所以这里不提供打开。
 */
function ConnectionLanes({ connectionId, botName }: { connectionId: string; botName: string }) {
  const { t } = useBotTranslation();
  const { confirm } = useConfirmDialog();
  const [lanes, setLanes] = useState<BotImConnectionLane[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'done' | 'failed'; text: string } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const resettingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listBotImConnectionLanes(connectionId)
        .then((payload) => {
          if (cancelled) return;
          setLanes(payload.lanes);
          setLoadFailed(false);
          setNow(Date.now());
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
    };
    load();
    const timer = setInterval(() => {
      if (!document.hidden && !resettingRef.current) load();
    }, LANES_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connectionId, reloadToken]);

  const laneName = (lane: BotImConnectionLane) =>
    lane.kind === 'owner-dm' ? t('bots.channels.lanes.ownerName') : lane.name || lane.chatId || '';

  const reset = async (lane: BotImConnectionLane) => {
    if (resettingRef.current) return;
    const name = laneName(lane);
    const ok = await confirm({
      title: t('bots.channels.lanes.resetConfirm.title', { lane: name }),
      description: t(
        lane.kind === 'owner-dm'
          ? 'bots.channels.lanes.resetConfirm.ownerDescription'
          : 'bots.channels.lanes.resetConfirm.description',
        { name: botName },
      ),
      confirmText: t('bots.channels.lanes.resetConfirm.confirm'),
      cancelText: t('bots.channels.lanes.resetConfirm.cancel'),
    });
    if (!ok) return;
    resettingRef.current = true;
    setResettingId(lane.sessionId);
    setNotice(null);
    try {
      const payload = await resetBotImConnectionLane(connectionId, lane.sessionId);
      setLanes(payload.lanes);
      setNow(Date.now());
      setNotice({ tone: 'done', text: t('bots.channels.lanes.resetDone', { lane: name }) });
    } catch {
      setNotice({ tone: 'failed', text: t('bots.channels.lanes.resetFailed') });
      setReloadToken((value) => value + 1);
    } finally {
      resettingRef.current = false;
      setResettingId(null);
    }
  };

  if (lanes === null && !loadFailed) return null;
  const others = (lanes ?? []).filter((lane) => lane.kind !== 'owner-dm');
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-[var(--border-default)] pt-3">
      <div className="text-12 font-medium text-[var(--text-primary)]">{t('bots.channels.lanes.title')}</div>
      <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
        {t('bots.channels.lanes.hint', { name: botName })}
      </p>
      {loadFailed ? (
        <p className="flex items-center gap-2 text-12 text-[var(--text-danger)]">
          <span>{t('bots.channels.lanes.loadFailed')}</span>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            {t('bots.channels.groups.retry')}
          </button>
        </p>
      ) : null}
      {(lanes ?? []).map((lane) => {
        const name = laneName(lane);
        const meta = [
          // 同一个群的几个话题同名: 种类后跟话题 id 末几位区分。
          lane.kind === 'topic' && lane.threadId
            ? `${t('bots.channels.lanes.kind.topic')} ${lane.threadId.slice(-6)}`
            : t(`bots.channels.lanes.kind.${LANE_KIND_KEY[lane.kind]}`),
          lane.state === 'running'
            ? t('bots.channels.lanes.state.running')
            : lane.state === 'failed'
              ? t('bots.channels.lanes.state.failed')
              : null,
          lane.lastActivityAt !== null
            ? formatRelative(lane.lastActivityAt, Math.max(now, lane.lastActivityAt), t)
            : t('bots.channels.lanes.noActivity'),
          lane.lastActivityAt !== null
            ? t('bots.channels.lanes.messageCount', { count: lane.contextMessageCount })
            : null,
        ].filter((part): part is string => !!part);
        return (
          <div key={lane.sessionId} className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 truncate text-12 text-[var(--text-primary)]" title={name}>
                  {name}
                </span>
                {lane.state === 'running' ? (
                  <Spinner size={12} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
                ) : lane.state === 'failed' ? (
                  <AttentionDot tone="error" />
                ) : null}
              </div>
              <div className="text-11 leading-[1.5] text-[var(--text-tertiary)]">{meta.join(' · ')}</div>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="md"
              compact
              loading={resettingId === lane.sessionId}
              disabled={resettingId !== null && resettingId !== lane.sessionId}
              aria-label={t('bots.channels.lanes.resetAria', { lane: name })}
              onClick={() => void reset(lane)}
            >
              {t('bots.channels.lanes.reset')}
            </Button>
          </div>
        );
      })}
      {lanes !== null && others.length === 0 ? (
        <p className="text-11 leading-[1.5] text-[var(--text-tertiary)]">
          {t('bots.channels.lanes.empty', { name: botName })}
        </p>
      ) : null}
      {notice ? (
        <p
          role="status"
          className={cn(
            'text-12 leading-[1.5]',
            notice.tone === 'failed' ? 'text-[var(--text-danger)]' : 'text-[var(--text-secondary)]',
          )}
        >
          {notice.text}
        </p>
      ) : null}
    </div>
  );
}

const PLATFORMS: ReadonlyArray<BotImChannel> = ['telegram', 'feishu', 'wecom', 'dingtalk', 'discord'];

/** 个人 bot 给人看的身份: Telegram @用户名 / Discord 标签原样, 其它平台的 id 打码。 */
function adoptableIdentity(item: BotImAdoptablePersonalBot): string | undefined {
  if (!item.identity) return undefined;
  if (item.channel === 'telegram' || item.channel === 'discord') return item.identity;
  return maskBotImContextId(item.identity);
}

/** 添加弹窗里「使用已设置的机器人 / 填写新的凭证」二选一的一行(与平台选项同一套样式)。 */
function SourceOption({
  checked,
  disabled,
  title,
  detail,
  onSelect,
}: {
  checked: boolean;
  disabled: boolean;
  title: string;
  detail?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        'flex min-h-11 w-full min-w-0 flex-col items-start justify-center gap-0.5 rounded-xl border px-3 py-2 text-left outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
        'disabled:cursor-not-allowed',
        checked
          ? 'border-[var(--accent-cta-bg-pure)] bg-[var(--model-item-hover)]'
          : 'border-[var(--border-default)] enabled:hover:bg-[var(--model-item-hover)]',
      )}
    >
      <span className={cn('text-13 leading-[1.5]', checked ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]')}>
        {title}
      </span>
      {detail ? (
        <span className="max-w-full truncate text-12 leading-[1.5] text-[var(--text-secondary)]">{detail}</span>
      ) : null}
    </button>
  );
}

function BotChannelAddDialog({
  bot,
  onApplied,
  onOpenChange,
}: {
  bot: BotProfile;
  onApplied: (next: BotImConnectionListPayload) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useBotTranslation();
  const [channel, setChannel] = useState<BotImChannel>('telegram');
  const [token, setToken] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [service, setService] = useState<BotImFeishuService>('feishu');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  // 企业微信 / 钉钉 / Discord 各自的两格: 字段名跟平台的叫法走, 互不串用。
  const [wecomBotId, setWecomBotId] = useState('');
  const [wecomSecret, setWecomSecret] = useState('');
  const [dingtalkAppKey, setDingtalkAppKey] = useState('');
  const [dingtalkAppSecret, setDingtalkAppSecret] = useState('');
  const [discordToken, setDiscordToken] = useState('');
  const [discordOwnerUserId, setDiscordOwnerUserId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  // 设置 → IM 机器人 里已配好的个人 bot: 这个平台有时默认「使用已设置的机器人」。
  const [adoptable, setAdoptable] = useState<BotImAdoptablePersonalBot[]>([]);
  const [source, setSource] = useState<'existing' | 'manual'>('existing');
  const existing = adoptable.find((item) => item.channel === channel) ?? null;
  const useExisting = existing !== null && source === 'existing';

  const refreshAdoptable = useCallback(() => {
    void listAdoptablePersonalBots()
      .then((next) => setAdoptable(next.bots))
      .catch(() => setAdoptable([]));
  }, []);
  useEffect(refreshAdoptable, [refreshAdoptable]);

  useEffect(() => {
    setError(null);
    setSource('existing');
  }, [channel]);

  const filled = (...values: string[]) => values.every((value) => value.trim().length > 0);
  const canSubmit = useExisting
    ? true
    : channel === 'telegram'
      ? filled(token, ownerUserId)
      : channel === 'feishu'
        ? filled(appId, appSecret)
        : channel === 'wecom'
          ? filled(wecomBotId, wecomSecret)
          : channel === 'dingtalk'
            ? filled(dingtalkAppKey, dingtalkAppSecret)
            : filled(discordToken, discordOwnerUserId);

  const buildInput = (): BotImConnectionAddInput | string => {
    switch (channel) {
      case 'telegram': {
        const trimmedToken = token.trim();
        const trimmedOwner = ownerUserId.trim();
        if (!BOT_TOKEN_PATTERN.test(trimmedToken)) return t('bots.channels.add.errors.invalidToken');
        if (!OWNER_USER_ID_PATTERN.test(trimmedOwner)) return t('bots.channels.add.errors.invalidOwner');
        return { botId: bot.id, channel: 'telegram', token: trimmedToken, ownerUserId: trimmedOwner };
      }
      case 'feishu': {
        const trimmedAppId = appId.trim();
        const trimmedSecret = appSecret.trim();
        if (!trimmedAppId || !trimmedSecret) return t('bots.channels.add.errors.invalidFeishu');
        return { botId: bot.id, channel: 'feishu', appId: trimmedAppId, appSecret: trimmedSecret, service };
      }
      case 'wecom': {
        const trimmedBotId = wecomBotId.trim();
        const trimmedSecret = wecomSecret.trim();
        if (!trimmedBotId || !trimmedSecret) return t('bots.channels.add.errors.invalidWecom');
        return { botId: bot.id, channel: 'wecom', wecomBotId: trimmedBotId, secret: trimmedSecret };
      }
      case 'dingtalk': {
        const trimmedKey = dingtalkAppKey.trim();
        const trimmedSecret = dingtalkAppSecret.trim();
        if (!trimmedKey || !trimmedSecret) return t('bots.channels.add.errors.invalidDingtalk');
        return { botId: bot.id, channel: 'dingtalk', appKey: trimmedKey, appSecret: trimmedSecret };
      }
      case 'discord': {
        const trimmedToken = discordToken.trim();
        const trimmedOwner = discordOwnerUserId.trim();
        if (!trimmedToken || /\s/.test(trimmedToken)) return t('bots.channels.add.errors.invalidDiscordToken');
        if (!DISCORD_OWNER_ID_PATTERN.test(trimmedOwner)) return t('bots.channels.add.errors.invalidDiscordOwner');
        return { botId: bot.id, channel: 'discord', token: trimmedToken, ownerUserId: trimmedOwner };
      }
    }
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!canSubmit || busyRef.current) return;
    const input = useExisting ? null : buildInput();
    if (typeof input === 'string') {
      setError(input);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = input ? await addBotImConnection(input) : await adoptPersonalBot({ botId: bot.id, channel });
      onApplied(next);
      onOpenChange(false);
    } catch (failure) {
      const ipc = extractIpcError(failure);
      const message = ipc?.message ?? '';
      if (message.includes('PERSONAL_BOT_NOT_CONFIGURED')) {
        // 个人 bot 在别处被清掉了: 刷新后这个平台回到填写凭证。
        refreshAdoptable();
        setError(t('bots.channels.add.errors.personalBotGone'));
      } else if (message.includes('TOKEN_IN_USE') || message.includes('APP_IN_USE')) {
        setError(t('bots.channels.add.errors.conflict'));
      } else if (ipc?.code === 'NOT_FOUND' || message.includes('BOT_INACTIVE')) {
        setError(t('bots.channels.add.errors.botUnavailable', { name: bot.name }));
      } else if (message.includes('CONNECT_FAILED')) {
        const marker = 'CONNECT_FAILED: ';
        const reason = message.slice(message.indexOf(marker) + marker.length).trim();
        setError(t('bots.channels.add.errors.connectFailed', { reason: reason || '…' }));
      } else {
        setError(t('bots.channels.add.errors.failed'));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !busyRef.current && onOpenChange(open)}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (busyRef.current) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            if (!firstOptionRef.current) return;
            event.preventDefault();
            firstOptionRef.current.focus();
          }}
          className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(480px,calc(100vw-32px))] flex-col p-4 outline-none"
        >
          <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)}>
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
              {t('bots.channels.add.title', { name: bot.name })}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-13 leading-[1.5] text-[var(--confirm-desc)]">
              {t('bots.channels.add.description')}
            </Dialog.Description>

            <div
              role="radiogroup"
              aria-label={t('bots.channels.add.platformLabel')}
              className="mt-4 grid grid-cols-3 gap-2"
            >
              {PLATFORMS.map((item, index) => {
                const checked = item === channel;
                return (
                  <button
                    key={item}
                    ref={index === 0 ? firstOptionRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    disabled={busy}
                    onClick={() => setChannel(item)}
                    className={cn(
                      'flex min-h-11 min-w-0 items-center justify-center gap-2 rounded-xl border px-3 text-13 outline-none transition-colors',
                      'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
                      'disabled:cursor-not-allowed',
                      checked
                        ? 'border-[var(--accent-cta-bg-pure)] bg-[var(--model-item-hover)] text-[var(--text-primary)]'
                        : 'border-[var(--border-default)] text-[var(--text-secondary)] enabled:hover:bg-[var(--model-item-hover)]',
                    )}
                  >
                    <ChannelIcon channel={item} />
                    <span className="truncate">{t(`bots.channels.platform.${item}`)}</span>
                  </button>
                );
              })}
            </div>

            {/* 两字段 + 两行提示的高度；切换平台时对话框不随提示行数上下跳。 */}
            <div className="mt-4 flex min-h-48 flex-col gap-3 overflow-y-auto">
              {existing ? (
                <div
                  role="radiogroup"
                  aria-label={t('bots.channels.add.source.label')}
                  className="flex flex-col gap-2"
                >
                  <SourceOption
                    checked={useExisting}
                    disabled={busy}
                    title={t('bots.channels.add.source.existing')}
                    detail={adoptableIdentity(existing)}
                    onSelect={() => setSource('existing')}
                  />
                  <SourceOption
                    checked={!useExisting}
                    disabled={busy}
                    title={t('bots.channels.add.source.manual')}
                    onSelect={() => setSource('manual')}
                  />
                </div>
              ) : null}
              {useExisting ? (
                <p className="px-1 text-12 leading-[1.5] text-[var(--text-secondary)]">
                  {t('bots.channels.add.source.moveNote', { name: bot.name })}
                </p>
              ) : channel === 'telegram' ? (
                <>
                  <FormField label={t('bots.channels.add.telegram.tokenLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        secret
                        mono
                        value={token}
                        onChange={setToken}
                        placeholder={t('bots.channels.add.telegram.tokenPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        secretTipContentClassName="z-[10001]"
                      />
                    )}
                  </FormField>
                  <FormField
                    label={t('bots.channels.add.telegram.ownerLabel')}
                    hint={t('bots.channels.add.telegram.ownerHint', { name: bot.name })}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        mono
                        value={ownerUserId}
                        onChange={setOwnerUserId}
                        placeholder={t('bots.channels.add.telegram.ownerPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    )}
                  </FormField>
                </>
              ) : channel === 'feishu' ? (
                <>
                  <FormField label={t('bots.channels.add.feishu.serviceLabel')}>
                    {(control) => (
                      <Select
                        id={control.id}
                        label={t('bots.channels.add.feishu.serviceLabel')}
                        value={service}
                        options={[
                          { value: 'feishu', label: t('bots.channels.platform.feishu') },
                          { value: 'lark', label: t('bots.channels.platform.lark') },
                        ]}
                        onValueChange={(next) => setService(next === 'lark' ? 'lark' : 'feishu')}
                        disabled={busy}
                      />
                    )}
                  </FormField>
                  <FormField label={t('bots.channels.add.feishu.appIdLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        mono
                        value={appId}
                        onChange={setAppId}
                        placeholder={t('bots.channels.add.feishu.appIdPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    )}
                  </FormField>
                  <FormField label={t('bots.channels.add.feishu.appSecretLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        secret
                        mono
                        value={appSecret}
                        onChange={setAppSecret}
                        placeholder={t('bots.channels.add.feishu.appSecretPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        secretTipContentClassName="z-[10001]"
                      />
                    )}
                  </FormField>
                </>
              ) : channel === 'wecom' ? (
                <>
                  <FormField label={t('bots.channels.add.wecom.botIdLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        mono
                        value={wecomBotId}
                        onChange={setWecomBotId}
                        placeholder={t('bots.channels.add.wecom.botIdPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    )}
                  </FormField>
                  <FormField
                    label={t('bots.channels.add.wecom.secretLabel')}
                    hint={t('bots.channels.add.wecom.ownerHint', { name: bot.name })}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        secret
                        mono
                        value={wecomSecret}
                        onChange={setWecomSecret}
                        placeholder={t('bots.channels.add.wecom.secretPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        secretTipContentClassName="z-[10001]"
                      />
                    )}
                  </FormField>
                </>
              ) : channel === 'dingtalk' ? (
                <>
                  <FormField label={t('bots.channels.add.dingtalk.appKeyLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        mono
                        value={dingtalkAppKey}
                        onChange={setDingtalkAppKey}
                        placeholder={t('bots.channels.add.dingtalk.appKeyPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    )}
                  </FormField>
                  <FormField
                    label={t('bots.channels.add.dingtalk.appSecretLabel')}
                    hint={t('bots.channels.add.dingtalk.ownerHint', { name: bot.name })}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        secret
                        mono
                        value={dingtalkAppSecret}
                        onChange={setDingtalkAppSecret}
                        placeholder={t('bots.channels.add.dingtalk.appSecretPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        secretTipContentClassName="z-[10001]"
                      />
                    )}
                  </FormField>
                </>
              ) : (
                <>
                  <FormField label={t('bots.channels.add.discord.tokenLabel')}>
                    {(control) => (
                      <Input
                        {...control}
                        secret
                        mono
                        value={discordToken}
                        onChange={setDiscordToken}
                        placeholder={t('bots.channels.add.discord.tokenPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                        secretTipContentClassName="z-[10001]"
                      />
                    )}
                  </FormField>
                  <FormField
                    label={t('bots.channels.add.discord.ownerLabel')}
                    hint={t('bots.channels.add.discord.ownerHint', { name: bot.name })}
                  >
                    {(control) => (
                      <Input
                        {...control}
                        mono
                        value={discordOwnerUserId}
                        onChange={setDiscordOwnerUserId}
                        placeholder={t('bots.channels.add.discord.ownerPlaceholder')}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={busy}
                      />
                    )}
                  </FormField>
                </>
              )}
            </div>

            {error ? (
              <p role="alert" className="mt-3 text-12 text-[var(--error-fg)]">
                {error}
              </p>
            ) : null}

            <div className="mt-5 flex shrink-0 flex-wrap justify-end gap-2.5">
              <Dialog.Close asChild>
                <Button type="button" variant="secondary" palette="confirmation" size="lg" disabled={busy}>
                  {t('bots.cancel')}
                </Button>
              </Dialog.Close>
              <Button
                type="submit"
                variant="cta"
                palette="confirmation"
                size="lg"
                loading={busy}
                disabled={!canSubmit || busy}
              >
                {t(busy ? 'bots.channels.add.connecting' : 'bots.channels.add.confirm')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
