/**
 * OrcaSplitView — doc 模式 chat rail 内的 Lead / Worker toggle。
 *
 * 当前唯一 consumer 是 WorkdirBrowseRoute。普通协同工作区已经收敛为 Lead 主视图
 * + 右侧栏「协同」tab,这里不再承载宽屏 split / resize / maximize 逻辑。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { VendorIcon } from '@/components/sidebar/VendorIcon';
import { useCCSessions } from '@/hooks/useCCSessions';
import { useRemoteProjectSessions } from '@/features/device-link/remoteProjectsStore';
import { cn } from '@/lib/utils';
import { CCAgentSessionView } from './CCAgentSessionView';
import { isAgentIslandSupported } from '@/hooks/useAgentIslandSettings';
import { useStopOrcaCollabWithoutNavigation } from './hooks/useStopOrcaCollab';
import {
  clearWorkerAttention,
  useWorkerAttentionSnapshot,
} from './lib/workerAttentionStore';
import {
  normalizeOrcaDisplayAgentKind,
  orcaAgentLabel,
  orcaVendorForAgentKind,
} from './lib/orcaAgentDisplay';
import { useOrcaWorkerSelection } from './hooks/useOrcaWorkerSelection';
import { mergeSessionSources } from './lib/mergeSessionSources';

type TogglePane = 'lead' | 'worker';

export interface OrcaSplitViewProps {
  /** Lead session id. 调用方负责保证存在; 找不到时本组件渲染 "lead not found" 占位。 */
  leadSessionId: string;
  /**
   * 找不到 Worker session 时占位文案。默认 'Waiting for worker'(英文)。doc 模式
   * 可传 i18n 翻译, 但通常协同启动后 worker 立刻被创建, 这个占位很少看到。
   */
  workerEmptyLabel?: string;
  /** 当前 OrcaSplitView 是否应代表屏幕可见内容上报给 Agent Island。 */
  reportAgentIslandVisibility?: boolean;
}

export function OrcaSplitView({
  leadSessionId,
  workerEmptyLabel,
  reportAgentIslandVisibility = true,
}: OrcaSplitViewProps) {
  const { t } = useTranslation();
  const [togglePane, setTogglePane] = useState<TogglePane>('lead');
  const { sessions: localSessions } = useCCSessions();
  const remoteSessions = useRemoteProjectSessions();
  const sessions = useMemo(
    () => mergeSessionSources(localSessions, remoteSessions),
    [localSessions, remoteSessions],
  );
  const { requestStop: requestStopCollab } = useStopOrcaCollabWithoutNavigation({
    leadSessionId,
  });
  const {
    selectedWorkerRecord,
    selectedWorkerId,
    workerSessionId,
  } = useOrcaWorkerSelection({
    leadSessionId,
    viewVisible: togglePane === 'worker' && reportAgentIslandVisibility,
  });
  const leadSession = useMemo(
    () => sessions.find((s) => s.id === leadSessionId) ?? null,
    [leadSessionId, sessions],
  );
  const workerSession = useMemo(
    () => (workerSessionId ? sessions.find((s) => s.id === workerSessionId) ?? null : null),
    [sessions, workerSessionId],
  );

  const leadAgentKind = normalizeOrcaDisplayAgentKind(leadSession?.agentKind);
  const leadVendor = orcaVendorForAgentKind(leadAgentKind);
  const leadPaneLabel = t('orca.split.leadLabel', {
    agent: orcaAgentLabel(leadAgentKind),
  });
  const leadPaneIcon = (
    <VendorIcon
      vendor={leadVendor}
      size={leadVendor === 'cc' ? 14 : 13}
      className="text-current"
    />
  );
  const workerAgentKind = normalizeOrcaDisplayAgentKind(
    selectedWorkerRecord?.agent ?? workerSession?.agentKind,
  );
  const workerPaneLabel = t('orca.split.workerLabel', {
    agent: orcaAgentLabel(workerAgentKind),
  });
  const attention = useWorkerAttentionSnapshot();
  const agentIslandVisibleSessionIds = useMemo(() => {
    if (!reportAgentIslandVisibility) return null;
    return togglePane === 'worker' ? (workerSession?.id ?? null) : leadSessionId;
  }, [leadSessionId, reportAgentIslandVisibility, togglePane, workerSession?.id]);

  const syncAgentIslandVisibleSession = useCallback(() => {
    if (!isAgentIslandSupported()) return;
    if (!document.hasFocus()) return;
    void window.electronAPI.agentIsland?.setVisibleSession?.(agentIslandVisibleSessionIds);
  }, [agentIslandVisibleSessionIds]);

  useEffect(() => {
    syncAgentIslandVisibleSession();
    window.addEventListener('focus', syncAgentIslandVisibleSession);
    return () => window.removeEventListener('focus', syncAgentIslandVisibleSession);
  }, [syncAgentIslandVisibleSession]);

  useLayoutEffect(() => {
    if (
      togglePane === 'worker' &&
      reportAgentIslandVisibility &&
      selectedWorkerId &&
      selectedWorkerRecord?.status !== 'done'
    ) {
      clearWorkerAttention(selectedWorkerId);
    }
  }, [
    attention,
    reportAgentIslandVisibility,
    selectedWorkerId,
    selectedWorkerRecord?.status,
    togglePane,
  ]);

  const activePane = togglePane;
  const tabBase = 'inline-flex items-center gap-1.5 text-xs leading-none transition-colors outline-none';
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-content-area">
      <div className="flex h-10 shrink-0 items-center border-b border-border/40 px-3">
        <div
          role="tablist"
          aria-label={t('newChat.collaboration.modeLabel')}
          className="flex items-center gap-3"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activePane === 'lead'}
            className={cn(
              tabBase,
              activePane === 'lead'
                ? 'font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setTogglePane('lead')}
          >
            {leadPaneIcon}
            <span>{leadPaneLabel}</span>
          </button>
          <span aria-hidden className="select-none text-xs leading-none text-muted-foreground/40">·</span>
          <div className="group/worker inline-flex items-center gap-1.5">
            <button
              type="button"
              role="tab"
              aria-selected={activePane === 'worker'}
              className={cn(
                tabBase,
                activePane === 'worker'
                  ? 'font-medium text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setTogglePane('worker')}
            >
              {workerPaneLabel}
            </button>
            {activePane === 'worker' && (
              <button
                type="button"
                aria-label={t('newChat.collaboration.stopAria')}
                className="inline-flex h-4 w-4 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-muted/70 hover:text-foreground group-hover/worker:opacity-100 focus-visible:opacity-100"
                onClick={() => {
                  void requestStopCollab();
                }}
              >
                <X size={11} />
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="chat-rail-compact min-h-0 flex-1">
        {activePane === 'lead' ? (
          leadSession ? (
            <CCAgentSessionView
              sessionIdProp={leadSessionId}
              compact
              orcaMode
              showRsbToggle
              viewVisible={reportAgentIslandVisibility}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t('orca.split.leadNotFound')}
            </div>
          )
        ) : workerSession ? (
          <CCAgentSessionView
            key={workerSession.id}
            sessionIdProp={workerSession.id}
            compact
            orcaMode
            showRsbToggle
            viewVisible={reportAgentIslandVisibility}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {workerEmptyLabel ?? t('orca.split.waitingForWorker')}
          </div>
        )}
      </div>
    </div>
  );
}
