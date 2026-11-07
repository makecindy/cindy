/**
 * User-selected plugin annotation. It preserves directive details without
 * attributing the assistant's later tool choices or execution state to the user.
 * Historical mentions remain quiet pills; actual calls appear in the work log.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Ghost } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SHARE_SOURCE_ATTR } from '@/lib/shareConversationImage';
import { Collapse } from '@/components/ui/collapse';
import {
  commandDirectiveSegments,
  mentionDirectiveSegments,
  type GhostDirectiveDisplay,
  type GhostDirectiveSegment,
} from '@/cindy-brain/ghostCommand';
import {
  hostCapabilityDirectiveSegments,
  type HostCapabilityDirectiveDisplay,
} from '@/cindy-brain/hostCapabilityInvocation';
import { useInstalledGhosts } from '@/cindy-brain/useInstalledGhosts';
import { isValidGhostId } from '../../../shared/ghost';
import { isValidPluginNamespace } from '@cindy/plugin-protocol';
import {
  findInstalledGhostByIdentity,
  findInstalledGhostByInstanceId,
  parsePluginInstanceId,
} from '../../../shared/pluginIdentity';

/** Only persisted user selections/mentions belong on the user's message. */
export type GhostSummonDisplay = GhostDirectiveDisplay | HostCapabilityDirectiveDisplay;

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

/** Static identity mark: execution progress belongs to the tool's own row. */
function SummonSeal({ iconDataUrl }: { iconDataUrl: string | null }) {
  return (
    <span className="relative flex h-[26px] w-[26px] shrink-0 items-center justify-center">
      <span aria-hidden="true" className="absolute inset-0">
        <svg viewBox="0 0 40 40" aria-hidden="true" className="h-full w-full">
          <circle
            cx="20"
            cy="20"
            r="19"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity={0.55}
          />
          <circle
            cx="20"
            cy="20"
            r="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1"
            opacity={0.28}
          />
        </svg>
      </span>
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
    </span>
  );
}

export function GhostSummonCard({
  directive,
  commandNamespace,
  className,
}: {
  directive: GhostSummonDisplay;
  commandNamespace?: string;
  /** 外层附加样式:UserMessage 在气泡内嵌时用它加分隔线与间距。 */
  className?: string;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // 头像按 ghostId 实时查已装清单:消息文本里只固化 id/名字,头像跟随当前
  // 安装状态(意识被卸下后自然回退幽灵图标,不缓存失效数据)。
  const installedGhosts = useInstalledGhosts();
  const ghostByInstanceId = (ghostId: string) => {
    if (isValidGhostId(ghostId)) return undefined;
    const physical = findInstalledGhostByInstanceId(installedGhosts, ghostId);
    if (physical) return physical;
    const identity = parsePluginInstanceId(ghostId);
    return identity ? findInstalledGhostByIdentity(installedGhosts, identity) : undefined;
  };
  const directiveNamespace =
    directive.kind === 'command' && directive.namespace !== undefined
      ? directive.namespace
      : commandNamespace === '@root'
        ? null
        : commandNamespace;
  const commandIdentity =
    directive.kind === 'command' &&
    (directiveNamespace === null ||
      (typeof directiveNamespace === 'string' && isValidPluginNamespace(directiveNamespace))) &&
    isValidGhostId(directive.ghostId)
      ? { namespace: directiveNamespace, ghostId: directive.ghostId }
      : null;

  const ghostForDirective = (ghostId: string) =>
    commandIdentity && ghostId === commandIdentity.ghostId
      ? findInstalledGhostByIdentity(installedGhosts, commandIdentity)
      : ghostByInstanceId(ghostId);
  const iconByGhostId = (ghostId: string): string | null =>
    ghostByInstanceId(ghostId)?.iconDataUrl ?? null;
  if (directive.kind === 'mention') {
    const soloIcon =
      directive.ghosts.length === 1 ? iconByGhostId(directive.ghosts[0].ghostId) : null;
    const names = directive.ghosts.map((g) => g.name).join(t('chat.ghostSummon.listSeparator'));
    return (
      <div {...{ [SHARE_SOURCE_ATTR]: '' }} className="flex max-w-full flex-col items-end gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          title={t(
            expanded ? 'chat.ghostSummon.collapseAria' : 'chat.ghostSummon.mentionExpandAria',
          )}
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'inline-flex max-w-full cursor-pointer items-center gap-1.5',
            'rounded-full border px-2.5 py-1 text-11',
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
            <div className="mb-1.5 text-xs leading-[1.5]" style={{ color: 'var(--text-tertiary)' }}>
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

  // ── 标注行形态:普通插件调用与 Host capability 共用外观,路由语义分开──
  const isCommand = directive.kind === 'command';
  const isHostCapability = directive.kind === 'host-capability';
  // Resolve live artwork/version without changing the persisted selection name.
  const installedGhost = ghostForDirective(directive.ghostId);
  const versionLabel = installedGhost
    ? `v${installedGhost.manifest.version.replace(/^v/i, '')}`
    : null;
  const badgeCommand = isCommand ? directive.command : undefined;
  const segments = isCommand
    ? commandDirectiveSegments(directive)
    : hostCapabilityDirectiveSegments(directive);
  const statusText = t('chat.ghostSummon.status.selected');

  // 分享图不带插件标注(同来源标签):整行连同分隔线一起移除,气泡与普通消息一致。
  return (
    <div {...{ [SHARE_SOURCE_ATTR]: '' }} className={cn('max-w-full', className)}>
      <button
        type="button"
        aria-expanded={expanded}
        title={t(
          expanded
            ? 'chat.ghostSummon.collapseAria'
            : isCommand
              ? 'chat.ghostSummon.expandAria'
              : 'chat.ghostSummon.hostCapabilityExpandAria',
        )}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'group flex max-w-full cursor-pointer select-none items-center gap-2 text-left',
          'focus-visible:rounded-lg focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-[var(--focus-ring-soft)]',
        )}
      >
        <SummonSeal iconDataUrl={installedGhost?.iconDataUrl ?? null} />
        <span
          className="min-w-0 truncate text-xs font-medium transition-colors group-hover:text-[var(--text-primary)]"
          style={{ color: 'var(--text-secondary)' }}
        >
          {directive.name}
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
                  className="shrink-0 rounded-full px-2 py-[2px] font-mono text-11 leading-none"
                  style={{ backgroundColor: 'var(--surface-chip)', color: 'var(--text-secondary)' }}
                >
                  ${badgeCommand}
                </span>
              )}
              {versionLabel && (
                <span
                  className="shrink-0 font-mono text-11 leading-none"
                  style={{ color: 'var(--text-tertiary)' }}
                >
                  {versionLabel}
                </span>
              )}
            </div>
          )}
          {segments ? (
            <>
              <div className="mb-1 text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>
                {t(
                  isCommand
                    ? 'chat.ghostSummon.directiveLabel'
                    : 'chat.ghostSummon.hostCapabilityDirectiveLabel',
                )}
              </div>
              <div
                className="mb-1.5 text-xs leading-[1.5]"
                style={{ color: 'var(--text-tertiary)' }}
              >
                {t(
                  isHostCapability
                    ? 'chat.ghostSummon.hostCapabilityLegend'
                    : 'chat.ghostSummon.legend',
                )}
              </div>
              <DirectiveSegments
                segments={segments}
                systemClassName="text-[var(--text-tertiary)]"
                injectedClassName="text-[var(--text-primary)]"
              />
            </>
          ) : null}
        </div>
      </Collapse>
    </div>
  );
}
