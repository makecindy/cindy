/**
 * 「交付物」右栏面板 —— 每个伙伴自己的仓库。
 * ---------------------------------------------------------------------------
 * 数据是主进程的只读投影(local-db:bots:artifacts):委派回传的产物 + 该伙伴名下
 * 会话里做出来的文件 + 消息附件,按时间倒序、去重、存在性过滤后给到这里。
 *
 * 实时性:**不新增推送 channel**。开面板时拉一次,并复用两条既有推送做重拉 ——
 * 委派状态变化(maker:bot-delegation:changed)与该会话新消息落库
 * (local-db:messages:created)。粒度因此是「事件驱动的整表重拉」,不是逐件增量;
 * 伙伴在**别的**会话里做出来的东西要等下一次这两个事件或重新开面板才出现。
 *
 * device-link 远程会话:投影 channel 不在远程 allowlist 里,本批不支持,面板显式
 * 说明而不是给一个永远空的列表。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, LoaderCircle, Package, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import {
  BOT_ARTIFACT_FILTERS,
  botArtifactCategoryKey,
  botArtifactIcon,
  countBotArtifactsByCategory,
  filterBotArtifacts,
} from '@/features/bots/botArtifactPresentation';
import { useArtifactThumbnail, useArtifactTimeText } from '@/features/bots/BotArtifactCard';
import { useBotArtifactOpen } from '@/features/bots/useBotArtifactOpen';
import type { BotArtifactCategory, BotArtifactItem } from '../../../../../shared/botArtifact';
import type { TabKindHostContext } from '../../types';
import type { BotArtifactsState } from './index';

interface Props {
  state: BotArtifactsState;
  ctx: TabKindHostContext;
  active?: boolean;
  shellVisible?: boolean;
}

function normalizeFilter(raw: string | null | undefined): BotArtifactCategory | 'all' {
  return BOT_ARTIFACT_FILTERS.includes((raw ?? 'all') as BotArtifactCategory | 'all')
    ? ((raw ?? 'all') as BotArtifactCategory | 'all')
    : 'all';
}

function ArtifactGridCard({
  item,
  highlighted,
  onOpen,
}: {
  item: BotArtifactItem;
  highlighted: boolean;
  onOpen: (item: BotArtifactItem) => void;
}) {
  const { t } = useTranslation();
  const timeText = useArtifactTimeText();
  const thumbnail = useArtifactThumbnail(item);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const Icon = botArtifactIcon(item.category);
  const showThumbnail = thumbnail !== null && !thumbnailFailed;

  return (
    <button
      type="button"
      data-testid="bot-artifact-grid-card"
      data-artifact-id={item.id}
      onClick={() => onOpen(item)}
      // 两列窄卡里文件名必然被截断,原生 title 是把全名读出来的唯一手段
      // (iconButtonTooltips 契约对截断文本的既定豁免)。
      title={item.name}
      data-native-title="truncated-text"
      className={cn(
        'flex flex-col rounded-lg border p-2 text-left transition-colors',
        'bg-[var(--surface-chip)] hover:bg-[var(--surface-hover)]',
        highlighted ? 'border-[var(--focus-ring)]' : 'border-[var(--border-default)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
    >
      <span className="mb-1.5 flex h-[52px] items-center justify-center overflow-hidden rounded-lg bg-[var(--surface-hover)] text-[var(--text-secondary)]">
        {showThumbnail ? (
          <img
            src={thumbnail}
            alt=""
            onError={() => setThumbnailFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <Icon size={17} aria-hidden="true" />
        )}
      </span>
      <span className="truncate text-11 text-[var(--text-primary)]">{item.name}</span>
      <span className="mt-0.5 truncate text-10 text-[var(--text-tertiary)]">
        {`${t(botArtifactCategoryKey(item.category))} · ${timeText(item.createdAt)}`}
      </span>
    </button>
  );
}

export function BotArtifactsBody({ state, ctx, active = true, shellVisible = true }: Props) {
  const { t } = useTranslation();
  const visible = active && shellVisible;
  // 归属未解析(undefined)时按远程 fail closed —— 本机-only 能力不得在冷启动
  // 竞态里把远端会话当本机处理。
  const remoteUnavailable = ctx.deviceLinkDeviceId !== null || Boolean(ctx.remoteHostId);
  const [items, setItems] = useState<BotArtifactItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { openArtifact, artifactLightboxes } = useBotArtifactOpen();
  const filter = normalizeFilter(state.filter);

  const load = useCallback(async () => {
    const owner = getDataOwnerGeneration();
    setLoading(true);
    try {
      const result = await window.electronAPI.localDb.bots.artifacts({ sessionId: ctx.sessionId });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      setItems(result.items);
      setTruncated(result.truncated);
      setError(null);
    } catch (loadError) {
      if (isDataOwnerGenerationCurrent(owner)) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    } finally {
      if (isDataOwnerGenerationCurrent(owner)) setLoading(false);
    }
  }, [ctx.sessionId]);

  useEffect(() => {
    if (!visible || remoteUnavailable) return;
    void load();
    const offs: Array<() => void> = [];
    const onDelegation = window.electronAPI.maker?.onBotDelegationChanged;
    if (typeof onDelegation === 'function') {
      offs.push(
        onDelegation((_payload: unknown, ownerStamp?: unknown) => {
          if (!isDataOwnerPushCurrent(ownerStamp)) return;
          void load();
        }),
      );
    }
    const onCreated = window.electronAPI.localDb?.messages?.onCreated;
    if (typeof onCreated === 'function') {
      offs.push(
        onCreated((payload: unknown, ownerStamp?: unknown) => {
          if (!isDataOwnerPushCurrent(ownerStamp)) return;
          if ((payload as { sessionId?: unknown } | null)?.sessionId !== ctx.sessionId) return;
          void load();
        }),
      );
    }
    return () => {
      for (const off of offs) off();
    };
  }, [ctx.sessionId, load, remoteUnavailable, visible]);

  const counts = useMemo(() => countBotArtifactsByCategory(items), [items]);
  const shown = useMemo(() => filterBotArtifacts(items, filter), [items, filter]);

  const header = (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-4">
      <Package size={15} className="text-[var(--text-secondary)]" aria-hidden="true" />
      <h2 className="text-13 font-medium text-[var(--text-primary)]">
        {t('rightSidebar.tabs.kinds.botArtifacts')}
      </h2>
      <span className="text-11 text-[var(--text-tertiary)]">{items.length}</span>
    </div>
  );

  if (remoteUnavailable) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
          <Package size={20} className="text-[var(--text-tertiary)]" aria-hidden="true" />
          <p className="mt-3 text-12 leading-5 text-[var(--text-tertiary)]">
            {t('bots.artifacts.remoteUnavailable')}
          </p>
        </div>
      </div>
    );
  }

  if (loading && items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1 items-center justify-center text-[var(--text-tertiary)]">
          <span className="inline-flex animate-spin motion-reduce:animate-none">
            <LoaderCircle size={20} />
          </span>
        </div>
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
          <AlertCircle size={20} className="text-[var(--status-danger)]" aria-hidden="true" />
          <p className="mt-3 text-12 text-[var(--text-secondary)]">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-[var(--border-default)] px-3 text-12 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
          >
            <RefreshCw size={13} />
            {t('bots.artifacts.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <p className="px-4 pt-2.5 text-11 text-[var(--text-tertiary)]">
        {t('bots.artifacts.subtitle')}
      </p>
      <div className="flex flex-wrap gap-1.5 px-4 py-2.5">
        {BOT_ARTIFACT_FILTERS.map((candidate) => {
          const disabled = candidate !== 'all' && counts[candidate] === 0;
          return (
            <button
              key={candidate}
              type="button"
              disabled={disabled}
              onClick={() => ctx.patchState({ filter: candidate })}
              aria-pressed={filter === candidate}
              className={cn(
                'rounded-full border px-2.5 py-[3px] text-11 transition-colors',
                filter === candidate
                  ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-[var(--surface)]'
                  : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                disabled && 'opacity-40',
              )}
            >
              {t(botArtifactCategoryKey(candidate))}
            </button>
          );
        })}
      </div>
      {shown.length === 0 ? (
        <div className="px-4 pb-4 text-12 leading-6 text-[var(--text-tertiary)]">
          {items.length > 0 ? t('bots.artifacts.emptyFiltered') : t('bots.artifacts.empty')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="grid grid-cols-2 gap-2.5">
            {shown.map((item) => (
              <ArtifactGridCard
                key={item.id}
                item={item}
                highlighted={state.focusArtifactId === item.id}
                onOpen={(target) => void openArtifact(target)}
              />
            ))}
          </div>
          {truncated ? (
            <p className="mt-3 text-10 text-[var(--text-tertiary)]">
              {t('bots.artifacts.truncated')}
            </p>
          ) : null}
        </div>
      )}
      {artifactLightboxes}
    </div>
  );
}
