import { MessageCircleMore, Plus } from 'lucide-react';
import { useBotTranslation } from './botPronounContext';

import { cn } from '@/lib/utils';

import {
  applyImMutualExclusion,
  botChannelDisplayName,
  buildBotChannelChips,
} from './botChannelChips';
import { botChannelConnectPath } from './botChannelConnectRoutes';
import type { BotChannel, BotChannelConnection } from './botStore';

/**
 * 「自带」能力条目。
 *
 * 空头支票复核(2026-08-19):这五条都**没有**对应的 per-bot 开关,对任何伙伴都
 * 成立,所以静态列出是如实陈述,不是硬编码的假徽标。
 *   - writing / research / doing / collab —— 基座 Agent 能力,不由 profile 决定;
 *     `permissions: 'ask'` 只是多问一句,不改变「能不能做」。
 *   - schedule —— 曾经挂在 `capabilities.automation` 上,但产品裁决 2026-08-19
 *     已把自动化定为标配:`shared/botAutomationCapability.ts` 的
 *     `normalizeBotAutomation()` 在**所有**读取投影层无条件返回 `true`,开关面
 *     也已下线。因此它同样恒成立,照常展示。
 * 一旦将来 automation 恢复成真开关,这里要跟着重新按能力位过滤。
 */
const BUILTIN_ABILITY_KEYS = ['writing', 'research', 'doing', 'schedule', 'collab'] as const;

/**
 * "TA 会的" —— 自带能力墙(纯陈述,无开关)+ 可以连上的通道列表
 * (复用 toggleChannel/mountedChannelFor,单 IM 互斥用 applyImMutualExclusion 处理)。
 */
export function BotAbilityWall({
  connections,
  isChannelMounted,
  channelBusyId,
  onToggleChannel,
  onConnectAccount,
}: {
  connections: readonly BotChannelConnection[];
  isChannelMounted: (connection: BotChannelConnection) => boolean;
  channelBusyId: string | null;
  onToggleChannel: (connection: BotChannelConnection) => void;
  /** 该渠道还没有账号时,原地拉起它真实的连接流程(跳到设置里对应那张卡)。 */
  onConnectAccount: (kind: BotChannel) => void;
}) {
  const { t } = useBotTranslation();
  const chips = applyImMutualExclusion(buildBotChannelChips(connections, isChannelMounted));
  /*
    有账号的渠道才值得占一整行 —— 它有账号名要显示、有连接/断开要点。没账号的
    渠道行原来长得跟它一模一样,于是七个「还没连」的占位撑满了整块,是这一页上
    版面最大、信息量最小的一片。现在把它们收成一排「+ 渠道」小片,点一下直接落到
    该渠道真实的连接界面 —— 能做的事一点没少,占的地方少了一屏。
  */
  const connectedChips = chips.filter((chip) => chip.connection);
  const connectableChips = chips.filter((chip) => !chip.connection);

  return (
    <div>
      {/* 中文标签不写 uppercase + tracking:大写对中文无效,字距却真的被拉开,
          读起来更散。这两个小标题只需要比正文轻一档。 */}
      <p className="text-11 text-[var(--text-tertiary)]">
        {t('bots.abilityWall.builtinTitle')}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {BUILTIN_ABILITY_KEYS.map((key) => (
          <span
            key={key}
            className="rounded-full bg-[var(--surface-chip)] px-3 py-1.5 text-12 text-[var(--text-secondary)]"
          >
            {t(`bots.abilityWall.abilities.${key}`)}
          </span>
        ))}
      </div>

      {connectedChips.length > 0 ? (
        <>
          <p className="mt-5 text-11 text-[var(--text-tertiary)]">
            {t('bots.abilityWall.connectedTitle')}
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {connectedChips.map((chip) => {
              const channelName = botChannelDisplayName(chip.kind);
              const label = chip.accountLabel
                ? `${channelName} · ${chip.accountLabel}`
                : channelName;
              const blocked = Boolean(chip.blockedByImKind);
              /*
                「先断开 X」只有在这一行**本来就能连**的时候才是一句有用的话。
                账号不可路由的行断开 X 之后照样连不上 —— 对它说这句就是给了一个
                做了也没用的补救办法。互斥判定本身(blockedByImKind)保持不变,
                只收窄这句提示的出现条件。
              */
              const showImBlockedHint = blocked && !chip.disabled;
              return (
                <div
                  key={chip.id}
                  className={cn(
                    'flex items-start justify-between gap-3 rounded-xl border border-[var(--border-default)] px-3 py-2',
                    (chip.disabled || blocked) && 'opacity-60',
                  )}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 truncate text-12 text-[var(--text-primary)]">
                      <MessageCircleMore
                        size={13}
                        className="shrink-0 text-[var(--text-secondary)]"
                        aria-hidden
                      />
                      {label}
                    </span>
                    {showImBlockedHint && chip.blockedByImKind ? (
                      <span className="mt-0.5 block text-10 leading-4 text-[var(--text-tertiary)]">
                        {t('bots.abilityWall.imBlocked', {
                          channel: botChannelDisplayName(chip.blockedByImKind),
                        })}
                      </span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    disabled={chip.disabled || blocked || channelBusyId !== null}
                    onClick={() => {
                      if (chip.connection) onToggleChannel(chip.connection);
                    }}
                    className="h-7 shrink-0 rounded-full border border-[var(--border-default)] px-2.5 text-10 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] disabled:cursor-default disabled:opacity-70"
                  >
                    {/* 「挂载 / 已挂载」是实现词,而且「已挂载」把一个动作说成了状态,
                        用户看不出点下去会发生什么。定稿用的是「连接 / 断开」——两边都是
                        这个按钮真会做的事。 */}
                    {chip.connection && channelBusyId === chip.connection.id
                      ? '…'
                      : chip.mounted
                        ? t('bots.channelDisconnect')
                        : t('bots.channelConnect')}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}

      {connectableChips.length > 0 ? (
        <>
          <p className="mt-5 text-11 text-[var(--text-tertiary)]">
            {t('bots.abilityWall.connectableTitle')}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {connectableChips.map((chip) => {
              /*
                占位片只由 MOUNTABLE_BOT_CHANNEL_KINDS 生成,而 CONNECT_ROUTES 的
                类型就是 `Record<MountableBotChannelKind, …>` —— 每个占位片都必有
                入口,`connectPath === null` 结构上不可达。这里保留 null 判断只作为
                类型守卫:将来有人往 MOUNTABLE 里加渠道却忘了配路由时,宁可不给这一
                片,也不给一个点了没反应的东西。
              */
              if (botChannelConnectPath(chip.kind) === null) return null;
              return (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => onConnectAccount(chip.kind)}
                  /*
                    看得见的只有渠道名 + 一个「＋」,读屏用户只会听到「Feishu 按钮」,
                    不知道按下去会发生什么。可访问名补上动作,并且**包含**那串可见
                    文字(WCAG 2.5.3 Label in Name),语音操作说「点 Feishu」仍然命中。
                  */
                  aria-label={`${t('bots.abilityWall.connectAccount')} · ${botChannelDisplayName(chip.kind)}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-[var(--border-default)] px-3 py-1.5 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <Plus size={12} className="shrink-0" aria-hidden />
                  {botChannelDisplayName(chip.kind)}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
