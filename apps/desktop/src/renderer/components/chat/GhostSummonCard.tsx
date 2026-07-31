/**
 * GhostSummonCard — 用户气泡内的「插件召唤标注行」(chip 形态)。
 *
 * 2026-07-29 改版:此前 $指令 / 软提示兑现 / 语义召唤走「卡片即消息」合并
 * 形态(整条正文收进一张独立大卡),卡头压过一句话正文、插件调用看起来像
 * 一条系统卡片而非用户发言。现改为:正文回归普通文字气泡,召唤信息缩为
 * 气泡顶部一行 26px 标注(法阵 + 意识名 + 状态文字 + 展开 caret),由
 * UserMessage 嵌入气泡内部渲染。三种来源同形态:
 *
 * - **硬指令($指令 显式点名)**:气泡正文 = 剥掉 $token 的余文,标注行
 *   报意识名;展开区按来源双色渲染追加给模型的指令原文
 *   (commandDirectiveSegments 单一事实源):系统模板文字降透明度,意识
 *   身份卡注入的值(指令词/名称/id)全亮,用户一眼可辨"哪些字是系统说
 *   的、哪些是这段意识填的"(第三方意识的信任边界视图)。
 * - **软提示(语言提及,2026-07-14 起发送期已停止生成,仅服务历史消息)**:
 *   未兑现保持低调描边胶囊(由 UserMessage 放在气泡下方);一旦被真实
 *   ghost_call 兑现(GhostFulfillmentContext),升级为与硬指令完全同形态
 *   的标注行,区别只在展开区内容(软提示原文 vs 硬指令原文)。
 * - **语义自主召唤(semantic,无追加段)**:消息一个触发词都没命中,AI
 *   本轮仍通过 ghost_call 召唤了意识——UserMessage 据兑现关联合成
 *   semantic 展示数据,渲染同一行标注。展开区如实说明"AI 自主判断召唤、
 *   消息未追加指令"(透明性:没追加就说没追加,不伪造原文)。
 *
 * 状态文字对齐兑现事实(不撒谎):turn 进行中「调用中…」;结束后本条
 * turn 真发生过 ghost_call 的报「已调用」,没发生的只报「已完成」。
 *
 * 透明性承诺不变:追加文本对用户可见、不做暗改;$指令 徽章 / 版本号 /
 * 指令原文双色图例全部保留,收进点击展开的抽屉。
 *
 * 召唤法阵(SummonSeal)双弧几何与 2.4s 旋转动画与旧版一致(用户明确
 * 要求保留),新增终态编舞——见 SummonSeal 头注与 DESIGN.md §14.4 登记。
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Ghost } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Collapse } from '@/components/ui/collapse';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
  type GhostDirectiveDisplay,
  type GhostDirectiveSegment,
} from '@/cindy-brain/ghostCommand';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';

/**
 * 「提及 → 兑现」关联(方案 2):Map<userMessageClientId, Set<被召唤 ghostId>>。
 * MessageStream 从会话历史现算并 Provider 下发;软提示卡据此把"被兑现"的
 * 意识从徽章升级成召唤标注,状态文字据此区分「已调用/已完成」。
 * 渲染期推导、不落状态,重启幂等。
 */
export const GhostFulfillmentContext = createContext<ReadonlyMap<string, ReadonlySet<string>>>(
  new Map(),
);

/**
 * 召唤标注展示数据:发送期追加段解析出的 command / mention 之外,再加一种
 * semantic——消息没有任何追加段、AI 纯靠语义自主召唤(只有 ghostId 清单,
 * 来自兑现关联),由 UserMessage 合成。定义在本组件而非 ghostCommand.ts:
 * 它不是"追加文本的解析结果",只是渲染层的展示形态。
 */
export type GhostSummonDisplay =
  | GhostDirectiveDisplay
  | { kind: 'semantic'; ghostIds: string[] };

/** 展开区正文:按来源双色渲染分段(injected = 意识注入值,高亮)。 */
function DirectiveSegments({
  segments,
  systemClassName,
  injectedClassName,
}: {
  segments: GhostDirectiveSegment[];
  systemClassName: string;
  injectedClassName: string;
}) {
  return (
    <div className="select-text whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-[length:calc(var(--app-code-font-size)_-_1px)] leading-[1.5]">
      {segments.map((seg, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 分段由模板确定性生成,顺序稳定。
        <span key={idx} className={seg.injected ? injectedClassName : systemClassName}>
          {seg.text}
        </span>
      ))}
    </div>
  );
}

/** 法阵终态编舞:缺口收拢时长(旋转中;DESIGN.md §14.4 登记的一次性瞬态)。 */
const SEAL_CLOSE_MS = 600;
/** 法阵终态编舞:光晕荡开 + ✓ 弹出时长,结束后摘除旋转(满圆旋转不可见,零跳变)。 */
const SEAL_SETTLE_MS = 900;

type SealPhase = 'running' | 'closing' | 'settling' | 'done';

/**
 * motion-reduce 下终态编舞整段跳过(不只是 CSS 层禁动画):JS 状态机也不走
 * closing/settling 计时,直接落 done 帧——否则 ✓ 要等 600ms 计时器才出现,
 * 与「直接落终态帧」的承诺不符(review 反馈)。jsdom 等无 matchMedia 环境
 * 视为不减动效。
 */
const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * 幽灵印记(召唤法阵):两道反向圆弧环,环心是意识头像(声明了 icon 时),
 * 否则回退通用幽灵图标;圆弧走 currentColor 随主题文本色。
 *
 * 双弧几何(外弧 83/17 · 内弧 39/61)与 running 旋转(2.4s 匀速,挂 HTML
 * wrapper 而非 SVG,规则 7 compositor-only)保持旧版原样。终态编舞
 * (2026-07-29,DESIGN.md §14.4 登记)解决"完成后缺口留在原地像卡死":
 *
 *   running(旋转) → closing(仍在旋转中,两道弧缺口收拢至满圆,600ms
 *   一次性 stroke-dasharray 过渡,globals.css .summon-seal-arc) →
 *   settling(fulfilled 时光晕从法阵荡开一圈 + ✓ 在头像角弹出;满圆旋转
 *   不可见,此刻摘除旋转动画零跳变) → done(静态)。
 *
 * 语义自洽:缺口 = 进行中,满圆 = turn 结束。✓ 与光晕只在 fulfilled(本轮
 * 真发生过 ghost_call)时出现——$指令 被取消 / AI 最终没调插件的,环中性
 * 闭合、不放成功徽标,与状态文字「已完成」一致(不伪造成功,review 反馈)。
 * 历史消息挂载时已非 running,直接渲 done 静态帧、零动画(规则 7);
 * motion-reduce 下旋转/过渡/光晕全部禁用(globals.css 白名单)且 JS 状态机
 * 直落终态帧。
 */
function SummonSeal({
  iconDataUrl,
  running,
  fulfilled,
}: {
  iconDataUrl: string | null;
  running?: boolean;
  /** 本轮是否真调过该插件:成功徽标(✓/光晕)的唯一开关,中性终态只闭环。 */
  fulfilled?: boolean;
}) {
  const [phase, setPhase] = useState<SealPhase>(running ? 'running' : 'done');
  // 本次挂载期间是否亲历过 running:只有亲历者播终态编舞,历史消息静态落帧。
  const livedRunningRef = useRef(Boolean(running));
  useEffect(() => {
    if (running) {
      livedRunningRef.current = true;
      setPhase('running');
      return;
    }
    if (!livedRunningRef.current) return undefined;
    if (prefersReducedMotion()) {
      setPhase('done');
      return undefined;
    }
    setPhase('closing');
    const settleTimer = window.setTimeout(() => setPhase('settling'), SEAL_CLOSE_MS);
    const doneTimer = window.setTimeout(() => setPhase('done'), SEAL_CLOSE_MS + SEAL_SETTLE_MS);
    return () => {
      window.clearTimeout(settleTimer);
      window.clearTimeout(doneTimer);
    };
  }, [running]);

  const spinning = phase === 'running' || phase === 'closing';
  const closed = phase !== 'running';
  const showTick = Boolean(fulfilled) && (phase === 'settling' || phase === 'done');

  return (
    <span className="relative flex h-[26px] w-[26px] shrink-0 items-center justify-center">
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-0',
          spinning && 'animate-[spin_2.4s_linear_infinite] motion-reduce:animate-none',
        )}
      >
        <svg viewBox="0 0 40 40" aria-hidden="true" className="h-full w-full">
          <circle
            className="summon-seal-arc"
            cx="20"
            cy="20"
            r="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity={closed ? 0.55 : 0.45}
            pathLength="100"
            strokeDasharray={closed ? '100 0' : '83 17'}
            strokeLinecap="round"
            transform="rotate(120 20 20)"
          />
          <circle
            className="summon-seal-arc"
            cx="20"
            cy="20"
            r="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            opacity={closed ? 0.28 : 0.22}
            pathLength="100"
            strokeDasharray={closed ? '100 0' : '39 61'}
            strokeLinecap="round"
            transform="rotate(-40 20 20)"
          />
        </svg>
      </span>
      {fulfilled && phase === 'settling' && (
        <span
          aria-hidden="true"
          className="summon-seal-halo pointer-events-none absolute inset-0 rounded-full border"
          style={{ borderColor: 'var(--card-status-done)' }}
        />
      )}
      {iconDataUrl ? (
        <img
          src={iconDataUrl}
          alt=""
          draggable={false}
          className="h-4 w-4 rounded-full object-cover"
        />
      ) : (
        <Ghost size={12} strokeWidth={1.75} aria-hidden="true" />
      )}
      {showTick && (
        <span
          aria-hidden="true"
          className={cn(
            'absolute -bottom-px -right-px flex h-[11px] w-[11px] items-center justify-center rounded-full',
            'border border-[var(--msg-user-bg)]',
            // 弹出动画只给亲历编舞的挂载;历史静态直显(both 保持终帧,
            // motion-reduce 下动画禁用、自然落在 scale(1))。
            livedRunningRef.current && 'summon-seal-tick-pop',
          )}
          style={{ backgroundColor: 'var(--card-status-done)' }}
        >
          <Check
            size={7}
            strokeWidth={3}
            className="text-[var(--completion-badge-fg)]"
            aria-hidden="true"
          />
        </span>
      )}
    </span>
  );
}

export function GhostSummonCard({
  directive,
  running,
  messageClientId,
  className,
}: {
  directive: GhostSummonDisplay;
  /** 本条消息触发的 turn 是否仍在执行(法阵旋转与「调用中…」的唯一开关)。 */
  running?: boolean;
  /** 本条用户消息的 clientId(查"提及 → 兑现"关联;状态文字与软提示升级用)。 */
  messageClientId?: string;
  /** 外层附加样式:UserMessage 在气泡内嵌时用它加分隔线与间距。 */
  className?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // 头像按 ghostId 实时查已装清单:消息文本里只固化 id/名字,头像跟随当前
  // 安装状态(意识被卸下后自然回退幽灵图标,不缓存失效数据)。
  const installedGhosts = useInstalledGhosts();
  const iconByGhostId = (ghostId: string): string | null =>
    installedGhosts.find((g) => g.manifest.id === ghostId)?.iconDataUrl ?? null;
  // 「提及 → 兑现」:本条消息触发的那一轮,AI 真召唤了哪些意识。
  const fulfillment = useContext(GhostFulfillmentContext);
  const fulfilledIds = messageClientId ? fulfillment.get(messageClientId) : undefined;
  // 软提示的兑现子集(方案 2):AI 真调了才算,只提及没调的不升级(不撒谎)。
  const fulfilled =
    directive.kind === 'mention' && fulfilledIds
      ? directive.ghosts.filter((g) => fulfilledIds.has(g.ghostId))
      : [];

  if (directive.kind === 'mention' && fulfilled.length === 0) {
    const soloIcon = directive.ghosts.length === 1 ? iconByGhostId(directive.ghosts[0].ghostId) : null;
    const names = directive.ghosts
      .map((g) => g.name)
      .join(t('chat.ghostSummon.listSeparator'));
    return (
      <div className="flex max-w-full flex-col items-end gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          title={t(expanded ? 'chat.ghostSummon.collapseAria' : 'chat.ghostSummon.mentionExpandAria')}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'inline-flex max-w-full cursor-pointer items-center gap-1.5',
            'rounded-full border px-2.5 py-1 text-[11px]',
            'transition-colors hover:text-foreground focus-visible:outline-none',
            'focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]',
          )}
          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}
        >
          {soloIcon ? (
            <img
              src={soloIcon}
              alt=""
              draggable={false}
              className="h-[14px] w-[14px] shrink-0 rounded-full object-cover"
            />
          ) : (
            <Ghost size={12} strokeWidth={1.75} aria-hidden="true" className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{t('chat.ghostSummon.mention', { names })}</span>
        </button>
        {/* 父容器 gap-1.5 与 -mt-1.5 恒等相消,间距改由内层 pt-1.5 承担
            (在 overflow-hidden 里随高度动画),挂载/卸载瞬间零跳变。 */}
        <Collapse open={expanded} className="-mt-1.5" innerClassName="pt-1.5">
          <div
            className="max-w-full rounded-[12px] border px-3 py-2"
            style={{ borderColor: 'var(--border-default)' }}
          >
            <div
              className="mb-1.5 text-xs leading-[1.5]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('chat.ghostSummon.legend')}
            </div>
            <DirectiveSegments
              segments={mentionDirectiveSegments(directive.ghosts)}
              systemClassName="text-[var(--text-tertiary)]"
              injectedClassName="text-[var(--text-secondary)]"
            />
          </div>
        </Collapse>
      </div>
    );
  }

  // ── 标注行形态:硬指令 / 软提示被兑现 / 语义自主召唤(三者完全同形态)──
  const isCommand = directive.kind === 'command';
  // 标注承载的意识:硬指令固定一个;兑现态取被真实召唤的子集;semantic 只有
  // ghostId,名字/指令词从已装清单实时解析(已卸下回退 ghostId)。
  // 多意识时名字并列、法阵取第一个。
  const cardGhosts: Array<{ name: string; ghostId: string; command?: string }> = isCommand
    ? [{ name: directive.name, ghostId: directive.ghostId, command: directive.command }]
    : directive.kind === 'mention'
      ? fulfilled
      : directive.ghostIds.map((id) => {
          const g = installedGhosts.find((x) => x.manifest.id === id);
          return {
            name: g?.manifest.name ?? id,
            ghostId: id,
            ...(g?.manifest.command ? { command: g.manifest.command } : {}),
          };
        });
  // 兜底:空清单不渲(semantic 由 UserMessage 保证非空,此处防御性短路)。
  if (cardGhosts.length === 0) return null;
  // 命中已装意识时取实时安装态(头像/版本号);已卸下则都不显示,
  // 与消息文本里固化的 id/名字解耦(不缓存失效数据)。
  const installedGhost = installedGhosts.find((g) => g.manifest.id === cardGhosts[0].ghostId);
  // 版本号统一 v 前缀展示(身份卡 version 是自由字符串,作者已带 v 时不重复);
  // 多意识并列时不展示(版本归属不明)。
  const versionLabel =
    cardGhosts.length === 1 && installedGhost
      ? `v${installedGhost.manifest.version.replace(/^v/i, '')}`
      : null;
  const cardNames = cardGhosts.map((g) => g.name).join(t('chat.ghostSummon.listSeparator'));
  // $指令 徽章:单意识且声明了指令词才有(软提示兑现的意识可能没有 command)。
  const badgeCommand = cardGhosts.length === 1 ? cardGhosts[0].command : undefined;
  // 展开区正文:与实际发送字节同源(commandDirectiveSegments /
  // mentionDirectiveSegments 是各自模板的单一事实源);semantic 没有追加段,
  // 展开区改为如实说明(segments = null)。
  const segments = isCommand
    ? commandDirectiveSegments(directive)
    : directive.kind === 'mention'
      ? mentionDirectiveSegments(directive.ghosts)
      : null;
  // 状态文字对齐兑现事实:mention 兑现态/semantic 由构造保证真调过;硬指令
  // 查兑现关联,AI 最终没调的只说「已完成」,不替 AI 撒谎。
  const anyFulfilled =
    !isCommand || cardGhosts.some((g) => Boolean(fulfilledIds?.has(g.ghostId)));
  const statusText = running
    ? t('chat.ghostSummon.status.running')
    : anyFulfilled
      ? t('chat.ghostSummon.status.called')
      : t('chat.ghostSummon.status.done');

  return (
    <div className={cn('max-w-full', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        title={t(
          expanded
            ? 'chat.ghostSummon.collapseAria'
            : isCommand
              ? 'chat.ghostSummon.expandAria'
              : directive.kind === 'mention'
                ? 'chat.ghostSummon.mentionExpandAria'
                : 'chat.ghostSummon.semanticExpandAria',
        )}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'group flex max-w-full cursor-pointer select-none items-center gap-2 text-left',
          'focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        <SummonSeal
          iconDataUrl={installedGhost?.iconDataUrl ?? null}
          running={running}
          fulfilled={anyFulfilled}
        />
        <span
          className="min-w-0 truncate text-xs font-medium transition-colors group-hover:text-[var(--text-primary)]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {cardNames}
        </span>
        <span className="shrink-0 text-xs" style={{ color: 'var(--text-tertiary)' }}>
          {statusText}
        </span>
        <ChevronDown
          size={13}
          aria-hidden="true"
          className={cn('shrink-0 opacity-60 transition-transform', expanded && 'rotate-180')}
        />
      </button>
      <Collapse open={expanded}>
        <div
          className="mt-2 rounded-[12px] border px-3 py-2.5"
          style={{ borderColor: 'var(--border-default)' }}
        >
          {(badgeCommand || versionLabel) && (
            <div className="mb-2 flex items-center gap-2">
              {badgeCommand && (
                <span
                  className="shrink-0 rounded-full px-2 py-[2px] font-mono text-[11px] leading-none"
                  style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
                >
                  ${badgeCommand}
                </span>
              )}
              {versionLabel && (
                <span
                  className="shrink-0 font-mono text-[11px] leading-none"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {versionLabel}
                </span>
              )}
            </div>
          )}
          {segments ? (
            <>
              <div
                className="mb-1 text-xs font-medium"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t(
                  isCommand
                    ? 'chat.ghostSummon.directiveLabel'
                    : 'chat.ghostSummon.mentionDirectiveLabel',
                )}
              </div>
              <div
                className="mb-1.5 text-xs leading-[1.5]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t('chat.ghostSummon.legend')}
              </div>
              <DirectiveSegments
                segments={segments}
                systemClassName="text-[var(--text-tertiary)]"
                injectedClassName="text-[var(--text-primary)]"
              />
            </>
          ) : (
            /* semantic:没有追加段,如实说明来由(不伪造"指令原文")。 */
            <div
              className="text-xs leading-[1.5]"
              style={{ color: 'var(--text-tertiary)' }}
            >
              {t('chat.ghostSummon.semanticNote')}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}
