import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react-native';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { Text, TextInput } from '@/components/AppText';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ConnectionBanner } from '@/components/ConnectionBanner';
import { goBackGuarded } from '@/utils/backGuard';
import {
  MainWindowActionButton,
  MainWindowActionGroup,
  MainWindowCardButton,
  MainWindowEmptyState,
  MainWindowMetric,
  MainWindowOptionButton,
  MainWindowRowButton,
  RemoteListSyncingPlaceholder,
  ScreenHeader,
  SummaryStrip,
} from '@/components/MobilePrimitives';
import { buildMainWindowLayout } from '@/components/mainWindowLayout';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { formatRemoteError } from '@/device-link/remoteStatus';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { useRemoteSyncTask } from '@/device-link/remoteSyncTask';
import { useMobileMakerTransport } from '@/device-link/useMobileMakerTransport';
import {
  DELETE_PREVIEW_RUN_LIMIT,
  buildGeneratedSessionDispositionPatch,
  buildScheduleDeletePreview,
  buildScheduleDeleteTarget,
  describeScheduleDeletePreview,
  isProjectAutomationSchedule,
  type ScheduleDeleteTarget,
  type ScheduleGeneratedSessionDisposition,
} from '@/scheduler/scheduleDelete';
import {
  displayRunsForMobile,
  buildSchedulePauseConfirmation,
  normalizeScheduleList,
  normalizeScheduleRuns,
  normalizeScheduleInflightCount,
  sortSchedulesForMobile,
  summarizeAutomationOverview,
  summarizeRun,
  summarizeSchedule,
} from '@/scheduler/scheduleModel';
import { shouldRefreshRunsForSchedule } from '@cindy/maker-shared/schedule-events';
import {
  applyMobileTemplateParams,
  applyTemplateToMobileScheduleDraft,
  buildMobileScheduleInput,
  createMobileScheduleDraft,
  createTemplateParamDefaults,
  deriveMobileScheduleSessionMode,
  hasMobileScheduleRealBinding,
  MOBILE_SCHEDULE_PENDING_SESSION_ID,
  updateDraftAgentKind,
  updateDraftBoundSessionId,
  updateDraftRunMode,
  updateDraftSessionMode,
  updateDraftWorkspaceKind,
  validateTemplateParamValues,
  validateMobileScheduleDraft,
  type MobileScheduleDraft,
} from '@/scheduler/scheduleFormModel';
import { useRemoteScheduleEventSnapshot } from '@/scheduler/remoteScheduleEvents';
import type {
  RemoteSchedule,
  RemoteScheduleRun,
  RemoteScheduleTemplate,
  RemoteTemplateParameter,
} from '@/scheduler/types';
import { remoteSessionStore, useRemoteSessions } from '@/session/remoteSessionStore';
import { shouldSuppressRemoteListEmptyState } from '@/session/sessionEmptyState';
import type { RemoteSession } from '@/session/types';
import { fontWeight, lineHeight, useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, radius, spacing, typeScale } from '@/theme/tokens';

const RUN_LIMIT = 50;

interface DeleteScheduleState {
  schedule: RemoteSchedule;
  target: ScheduleDeleteTarget;
  disposition: ScheduleGeneratedSessionDisposition;
  sessionIds: string[] | null;
  inflightCount: number | null;
  loading: boolean;
  error: string | null;
}

interface PauseScheduleState {
  schedule: RemoteSchedule;
  inflightCount: number;
  error: string | null;
}

interface DeleteRunState {
  run: RemoteScheduleRun;
  error: string | null;
}

export default function AutomationsScreen() {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ deviceId: string; name?: string }>();
  const deviceId = String(params.deviceId ?? '');
  const deviceName = String(params.name ?? deviceId);
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();
  const { connectionIssue, openLink, status, subscribe, unsubscribe } = useDeviceLink();
  const maker = useMobileMakerTransport(deviceId);
  const scheduleEventSnapshot = useRemoteScheduleEventSnapshot(deviceId);
  const remoteSessions = useRemoteSessions();
  const [schedules, setSchedules] = useState<RemoteSchedule[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runsBySchedule, setRunsBySchedule] = useState<Map<string, RemoteScheduleRun[]>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [runsLoading, setRunsLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [openingRunId, setOpeningRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [formMode, setFormMode] = useState<'create' | 'edit' | null>(null);
  const [formDraft, setFormDraft] = useState<MobileScheduleDraft | null>(null);
  const [formScheduleId, setFormScheduleId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<RemoteScheduleTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<RemoteScheduleTemplate | null>(null);
  const [templateParamValues, setTemplateParamValues] = useState<Record<string, string>>({});
  const [templatePromptDirty, setTemplatePromptDirty] = useState(false);
  const [deleteState, setDeleteState] = useState<DeleteScheduleState | null>(null);
  const [pauseState, setPauseState] = useState<PauseScheduleState | null>(null);
  const [deleteRunState, setDeleteRunState] = useState<DeleteRunState | null>(null);

  const selectedSchedule = useMemo(
    () => schedules.find((item) => item.id === selectedId) ?? schedules[0] ?? null,
    [schedules, selectedId],
  );
  const selectedScheduleId = selectedSchedule?.id ?? null;
  const selectedRuns = selectedSchedule ? (runsBySchedule.get(selectedSchedule.id) ?? []) : [];
  const displayedRuns = useMemo(() => displayRunsForMobile(selectedRuns), [selectedRuns]);
  const overview = useMemo(
    () => summarizeAutomationOverview(schedules, runsBySchedule),
    [runsBySchedule, schedules],
  );
  const bindableSessions = useMemo(
    () => selectBindableSessions(remoteSessions, deviceId),
    [deviceId, remoteSessions],
  );
  const windowLayout = buildMainWindowLayout({
    actionCount: 1,
    kind: 'detail',
    metricCount: 3,
    screenWidth,
  });

  const syncSchedules = useCallback(async () => {
    if (!deviceId) return;
    setLoading(true);
    setError(null);
    try {
      const list = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
        return maker.schedule.list();
      });
      const next = sortSchedulesForMobile(normalizeScheduleList(list));
      setSchedules(next);
      setSelectedId((prev) => {
        if (prev && next.some((item) => item.id === prev)) return prev;
        return next[0]?.id ?? null;
      });
      setLastSyncedAt(Date.now());
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setLoading(false);
    }
  }, [deviceId, maker, openLink, subscribe]);
  const loadSchedules = useRemoteSyncTask(syncSchedules);

  const syncRuns = useCallback(async (scheduleId: string, options: { markRead?: boolean } = {}) => {
    if (!deviceId || !scheduleId) return;
    setRunsLoading(true);
    setError(null);
    try {
      const list = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
        return maker.schedule.listRuns(scheduleId, RUN_LIMIT);
      });
      const normalized = normalizeScheduleRuns(list);
      let nextRuns = normalized;
      if (options.markRead !== false) {
        await maker.schedule.markScheduleRunsRead(scheduleId).catch(() => undefined);
        nextRuns = markRunsReadLocally(normalized);
      }
      setRunsBySchedule((prev) => {
        const next = new Map(prev);
        next.set(scheduleId, nextRuns);
        return next;
      });
      setLastSyncedAt(Date.now());
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setRunsLoading(false);
    }
  }, [deviceId, maker, openLink, subscribe]);

  useEffect(() => {
    void loadSchedules();
    return () => {
      // Only drop our subscription. The device link is a shared resource (Home / session screens
      // rely on it); closing it here tore it down out from under them. It's reaped on
      // presence-offline / disconnect instead.
      void unsubscribe(`automations:${deviceId}`, deviceId, ['sessions']).catch(() => undefined);
    };
  }, [deviceId, loadSchedules, unsubscribe]);

  useEffect(() => {
    if (status === 'online') void loadSchedules();
  }, [loadSchedules, status]);

  useEffect(() => {
    if (selectedScheduleId) void syncRuns(selectedScheduleId);
  }, [selectedScheduleId, syncRuns]);

  useEffect(() => {
    if (scheduleEventSnapshot.scheduleListVersion === 0) return;
    void loadSchedules();
  }, [loadSchedules, scheduleEventSnapshot.scheduleListVersion]);

  useEffect(() => {
    if (scheduleEventSnapshot.runsVersion === 0 || !selectedScheduleId) return;
    const intent = scheduleEventSnapshot.lastProjection?.refresh.runRefresh ?? { mode: 'all' };
    if (shouldRefreshRunsForSchedule(intent, selectedScheduleId)) {
      void syncRuns(selectedScheduleId);
    }
  }, [
    scheduleEventSnapshot.lastProjection,
    scheduleEventSnapshot.runsVersion,
    selectedScheduleId,
    syncRuns,
  ]);

  const refreshAll = useCallback(async () => {
    await loadSchedules();
    if (selectedSchedule) await syncRuns(selectedSchedule.id);
  }, [loadSchedules, selectedSchedule, syncRuns]);

  const loadTemplates = useCallback(async () => {
    if (!deviceId) return;
    setTemplatesLoading(true);
    setTemplateError(null);
    try {
      const list = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
        return maker.schedule.listTemplates();
      });
      setTemplates(sortTemplatesForMobile(list));
    } catch (err) {
      setTemplateError(formatRemoteError(err));
    } finally {
      setTemplatesLoading(false);
    }
  }, [deviceId, maker, openLink, subscribe]);

  const startCreateSchedule = useCallback(() => {
    setFormMode('create');
    setFormScheduleId(null);
    setFormError(null);
    setSelectedTemplate(null);
    setTemplateParamValues({});
    setTemplatePromptDirty(false);
    setFormDraft(createMobileScheduleDraft(null, {
      fallbackWorkingDir: selectedSchedule?.workingDir ?? null,
    }));
    void loadTemplates();
  }, [loadTemplates, selectedSchedule]);

  const startEditSchedule = useCallback((schedule: RemoteSchedule) => {
    setFormMode('edit');
    setFormScheduleId(schedule.id);
    setFormError(null);
    setSelectedTemplate(null);
    setTemplateParamValues({});
    setTemplatePromptDirty(false);
    setFormDraft(createMobileScheduleDraft(schedule));
  }, []);

  const closeScheduleForm = useCallback(() => {
    setFormMode(null);
    setFormScheduleId(null);
    setFormDraft(null);
    setFormError(null);
    setSelectedTemplate(null);
    setTemplateParamValues({});
    setTemplatePromptDirty(false);
  }, []);

  const selectTemplate = useCallback((template: RemoteScheduleTemplate) => {
    const defaults = createTemplateParamDefaults(template);
    setSelectedTemplate(template);
    setTemplateParamValues(defaults);
    setTemplatePromptDirty(false);
    setFormError(null);
    setFormDraft((prev) => {
      const base = prev ?? createMobileScheduleDraft(null, {
        fallbackWorkingDir: selectedSchedule?.workingDir ?? null,
      });
      try {
        return applyTemplateToMobileScheduleDraft(base, template, defaults);
      } catch {
        return {
          ...applyTemplateToMobileScheduleDraft(base, { ...template, prompt: '' }, defaults),
          prompt: template.prompt ?? '',
        };
      }
    });
  }, [selectedSchedule]);

  const updateTemplateParam = useCallback((key: string, value: string) => {
    const nextValues = { ...templateParamValues, [key]: value };
    setTemplateParamValues(nextValues);
    if (!selectedTemplate || templatePromptDirty) return;
    setFormDraft((prev) => {
      if (!prev) return prev;
      try {
        return {
          ...prev,
          prompt: applyMobileTemplateParams(
            selectedTemplate.prompt ?? '',
            nextValues,
            selectedTemplate.parameters,
          ),
        };
      } catch {
        return prev;
      }
    });
  }, [selectedTemplate, templateParamValues, templatePromptDirty]);

  const submitScheduleForm = useCallback(async () => {
    if (!formDraft || busyAction) return;
    const validation = validateMobileScheduleDraft(formDraft);
    if (validation) {
      setFormError(validation.message);
      return;
    }
    if (formMode === 'create' && selectedTemplate && !templatePromptDirty) {
      const paramError = validateTemplateParamValues(selectedTemplate, templateParamValues);
      if (paramError) {
        setFormError(paramError);
        return;
      }
    }
    const input = buildMobileScheduleInput(formDraft);
    const actionKey = formMode === 'edit' ? `edit:${formScheduleId}` : 'create';
    setBusyAction(actionKey);
    setError(null);
    setFormError(null);
    try {
      // Retry only the idempotent connection setup. update() is keyed by id so it is also safe to
      // retry, but create()/createFromTemplate() run exactly once: a transient retry after the
      // desktop already persisted the schedule (invoke result lost) would create a duplicate.
      await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
      });
      const saved = await (async () => {
        if (formMode === 'edit' && formScheduleId) {
          return withTransientRemoteRetry(() => maker.schedule.update(formScheduleId, input));
        }
        if (selectedTemplate && !templatePromptDirty) {
          const { prompt: _templatePrompt, ...overrides } = input;
          return maker.schedule.createFromTemplate({
            templateId: selectedTemplate.id,
            paramValues: templateParamValues,
            overrides,
          });
        }
        return maker.schedule.create(input);
      })();
      closeScheduleForm();
      if (saved?.id) {
        setSelectedId(saved.id);
        setSchedules((prev) => sortSchedulesForMobile([
          ...prev.filter((item) => item.id !== saved.id),
          saved,
        ]));
        await syncRuns(saved.id, { markRead: false }).catch(() => undefined);
      }
      await loadSchedules().catch(() => undefined);
    } catch (err) {
      setFormError(formatRemoteError(err));
    } finally {
      setBusyAction(null);
    }
  }, [
    busyAction,
    closeScheduleForm,
    deviceId,
    formDraft,
    formMode,
    formScheduleId,
    loadSchedules,
    maker,
    openLink,
    selectedTemplate,
    subscribe,
    syncRuns,
    templateParamValues,
    templatePromptDirty,
  ]);

  const runScheduleAction = useCallback(async (
    actionKey: string,
    schedule: RemoteSchedule,
    action: () => Promise<void | RemoteSchedule>,
  ) => {
    if (busyAction) return;
    setBusyAction(actionKey);
    setError(null);
    try {
      const updated = await action();
      if (updated && typeof updated === 'object') {
        setSchedules((prev) => sortSchedulesForMobile(prev.map((item) =>
          item.id === schedule.id ? { ...item, ...updated } : item,
        )));
      }
      // Best-effort post-success refresh: the action already succeeded, so a resync blip must
      // not surface as if the action itself failed.
      await syncRuns(schedule.id, { markRead: false }).catch(() => undefined);
      await loadSchedules().catch(() => undefined);
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, loadSchedules, syncRuns]);

  const pauseScheduleNow = useCallback(async (schedule: RemoteSchedule) => {
    setBusyAction(`pause:${schedule.id}`);
    setError(null);
    try {
      const updated = await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
        return maker.schedule.pause(schedule.id);
      });
      setSchedules((prev) => sortSchedulesForMobile(prev.map((item) =>
        item.id === schedule.id ? { ...item, ...updated } : item,
      )));
      setPauseState(null);
      await syncRuns(schedule.id, { markRead: false }).catch(() => undefined);
      await loadSchedules().catch(() => undefined);
    } catch (err) {
      const message = formatRemoteError(err);
      setPauseState((prev) => (
        prev && prev.schedule.id === schedule.id ? { ...prev, error: message } : prev
      ));
      setError(message);
    } finally {
      setBusyAction(null);
    }
  }, [deviceId, loadSchedules, maker, openLink, subscribe, syncRuns]);

  const requestPauseSchedule = useCallback((schedule: RemoteSchedule) => {
    if (busyAction || schedule.status === 'paused' || schedule.status === 'expired') return;
    setBusyAction(`pause-check:${schedule.id}`);
    setError(null);
    setPauseState(null);
    void (async () => {
      try {
        const inflightCount = await withTransientRemoteRetry(async () => {
          await openLink(deviceId);
          await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
          return maker.schedule.getInflightCount(schedule.id).catch(() => 0);
        });
        const count = normalizeScheduleInflightCount(inflightCount);
        if (count > 0) {
          setPauseState({ schedule, inflightCount: count, error: null });
          return;
        }
        await pauseScheduleNow(schedule);
      } catch (err) {
        setError(formatRemoteError(err));
      } finally {
        setBusyAction((current) => (current === `pause-check:${schedule.id}` ? null : current));
      }
    })();
  }, [busyAction, deviceId, maker, openLink, pauseScheduleNow, subscribe]);

  const runDeleteSchedule = useCallback(async (schedule: RemoteSchedule) => {
    if (busyAction || !deleteState) return;
    setBusyAction(`delete:${schedule.id}`);
    setError(null);
    const target = deleteState.target;
    const disposition = deleteState.disposition;
    const sessionIds = deleteState.sessionIds ?? [];
    const failedSessionIds: string[] = [];
    try {
      if (target.source === 'project') {
        if (!isProjectAutomationSchedule(target)) {
          throw new Error(t('devices.automations.error.projectMissingConfig'));
        }
        await maker.projectAutomation.removeSchedule({
          workingDir: target.workingDir!,
          id: target.projectConfigId!,
        });
      } else {
        await maker.schedule.delete(schedule.id);
      }
      const patch = buildGeneratedSessionDispositionPatch(disposition);
      if (patch) {
        for (const sessionId of sessionIds) {
          try {
            await maker.patchSessionMeta(sessionId, patch);
            remoteSessionStore.applySessionPatch(deviceId, sessionId, patch);
          } catch {
            failedSessionIds.push(sessionId);
          }
        }
      }
      setRunsBySchedule((prev) => {
        const next = new Map(prev);
        next.delete(schedule.id);
        return next;
      });
      setSchedules((prev) => sortSchedulesForMobile(prev.filter((item) => item.id !== schedule.id)));
      setSelectedId((prev) => (prev === schedule.id ? null : prev));
      setDeleteState(null);
      if (failedSessionIds.length > 0) {
        setError(t('devices.automations.error.deletePartial', { count: failedSessionIds.length }));
      }
      await loadSchedules();
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, deleteState, deviceId, loadSchedules, maker, t]);

  const requestDeleteSchedule = useCallback((schedule: RemoteSchedule) => {
    if (busyAction) return;
    const target = buildScheduleDeleteTarget(schedule);
    // 透传 schedule.targetSessionId 作为 excludeSessionId —— 手绑的用户既有会话必须
    // 从预览/处置集合里排除,否则 runDeleteSchedule 的 patchSessionMeta 会误软删它
    // (与桌面端收集层 isAutomationGeneratedSession 首选 + targetSessionId 保底同口径)。
    const cachedPreview = buildScheduleDeletePreview(
      runsBySchedule.get(schedule.id) ?? [],
      0,
      [],
      schedule.targetSessionId,
    );
    setDeleteState({
      schedule,
      target,
      disposition: 'keep',
      sessionIds: cachedPreview.sessionIds,
      inflightCount: null,
      loading: true,
      error: null,
    });
    void (async () => {
      try {
        const [runs, inflight] = await withTransientRemoteRetry(async () => {
          await openLink(deviceId);
          await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
          return Promise.all([
            maker.schedule.listRuns(schedule.id, DELETE_PREVIEW_RUN_LIMIT),
            maker.schedule.getInflightCount(schedule.id).catch(() => 0),
          ]);
        });
        const preview = buildScheduleDeletePreview(
          normalizeScheduleRuns(runs),
          inflight,
          [],
          schedule.targetSessionId,
        );
        setDeleteState((prev) => {
          if (!prev || prev.schedule.id !== schedule.id) return prev;
          return {
            ...prev,
            sessionIds: preview.sessionIds,
            inflightCount: preview.inflightCount,
            loading: false,
            error: null,
          };
        });
      } catch (err) {
        setDeleteState((prev) => {
          if (!prev || prev.schedule.id !== schedule.id) return prev;
          return {
            ...prev,
            inflightCount: cachedPreview.inflightCount,
            loading: false,
            error: formatRemoteError(err),
          };
        });
      }
    })();
  }, [busyAction, deviceId, maker, openLink, runsBySchedule, subscribe]);

  const openRunSession = useCallback(async (run: RemoteScheduleRun) => {
    if (!run.sessionId || openingRunId) return;
    setOpeningRunId(run.id);
    setError(null);
    try {
      const session = await maker.getSession(run.sessionId) as RemoteSession;
      remoteSessionStore.upsertDeviceSession(deviceId, deviceName, session);
      await maker.schedule.markRunRead(run.id).catch(() => undefined);
      setRunsBySchedule((prev) => {
        const next = new Map(prev);
        next.set(run.scheduleId, markRunReadLocally(prev.get(run.scheduleId) ?? [], run.id));
        return next;
      });
      router.push({
        pathname: '/sessions/[sessionId]',
        params: { sessionId: run.sessionId, deviceId, deviceName },
      });
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setOpeningRunId(null);
    }
  }, [deviceId, deviceName, maker, openingRunId, router]);

  const markSingleRunRead = useCallback(async (run: RemoteScheduleRun) => {
    if (busyAction) return;
    const key = `run-read:${run.id}`;
    setBusyAction(key);
    setError(null);
    try {
      await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
        return maker.schedule.markRunRead(run.id);
      });
      setRunsBySchedule((prev) => {
        const next = new Map(prev);
        next.set(run.scheduleId, markRunReadLocally(prev.get(run.scheduleId) ?? [], run.id));
        return next;
      });
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setBusyAction((current) => (current === key ? null : current));
    }
  }, [busyAction, deviceId, maker, openLink, subscribe]);

  const restartRun = useCallback(async (run: RemoteScheduleRun) => {
    if (busyAction) return;
    const key = `run-restart:${run.id}`;
    setBusyAction(key);
    setError(null);
    try {
      // runNow is non-idempotent (each call fires a run), so it must not be inside the retry —
      // retry only the link/subscribe setup; runNow runs exactly once.
      await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
      });
      await maker.schedule.runNow(run.scheduleId);
      await syncRuns(run.scheduleId, { markRead: false }).catch(() => undefined);
      await loadSchedules().catch(() => undefined);
    } catch (err) {
      setError(formatRemoteError(err));
    } finally {
      setBusyAction((current) => (current === key ? null : current));
    }
  }, [busyAction, deviceId, loadSchedules, maker, openLink, subscribe, syncRuns]);

  const requestDeleteRun = useCallback((run: RemoteScheduleRun) => {
    if (busyAction || run.status === 'running') return;
    setDeleteRunState({ run, error: null });
  }, [busyAction]);

  const deleteRunNow = useCallback(async (run: RemoteScheduleRun) => {
    if (busyAction) return;
    const key = `run-delete:${run.id}`;
    setBusyAction(key);
    setError(null);
    try {
      // deleteRun runs exactly once: retry only the idempotent link/subscribe setup. A transient
      // retry after the desktop already deleted the run (but the invoke result was lost) would
      // re-send deleteRun, which the scheduler rejects as "run not found" → a false failure.
      await withTransientRemoteRetry(async () => {
        await openLink(deviceId);
        await subscribe(`automations:${deviceId}`, deviceId, ['sessions']);
      });
      await maker.schedule.deleteRun(run.id);
      setRunsBySchedule((prev) => {
        const next = new Map(prev);
        next.set(run.scheduleId, (prev.get(run.scheduleId) ?? []).filter((item) => item.id !== run.id));
        return next;
      });
      setDeleteRunState(null);
      await syncRuns(run.scheduleId, { markRead: false }).catch(() => undefined);
    } catch (err) {
      const message = formatRemoteError(err);
      setDeleteRunState((prev) => (
        prev && prev.run.id === run.id ? { ...prev, error: message } : prev
      ));
      setError(message);
    } finally {
      setBusyAction((current) => (current === key ? null : current));
    }
  }, [busyAction, deviceId, maker, openLink, subscribe, syncRuns]);

  return (
    <SafeAreaView style={styles.safeArea} testID="automations.screen">
      <ScreenHeader
        action={{
          label: t('devices.common.create'),
          onPress: busyAction ? undefined : startCreateSchedule,
          testID: 'automations.createButton',
        }}
        backTestID="automations.backButton"
        eyebrow="Remote Automations"
        onBack={() => goBackGuarded(router)}
        subtitle={t('devices.automations.subtitle', { active: overview.activeCount, total: overview.totalCount })}
        title={deviceName}
        titleTestID="automations.title"
      />

      <ConnectionBanner
        error={error}
        issue={connectionIssue}
        lastSyncedAt={lastSyncedAt}
        loading={loading || runsLoading}
        onSync={() => void refreshAll()}
        status={status}
      />

      <SummaryStrip
        style={{
          gap: windowLayout.summaryGap,
          paddingHorizontal: windowLayout.contentPaddingHorizontal,
          paddingVertical: windowLayout.contentPaddingVertical,
        }}
        testID="automations.summary"
      >
        <View style={[styles.summaryTopRow, { gap: windowLayout.metricGap }]}>
          <MainWindowMetric
            label={t('devices.automations.metric.running')}
            style={{ minHeight: windowLayout.metricMinHeight, minWidth: windowLayout.metricMinWidth }}
            value={overview.activeCount}
            valueSize="large"
          />
          <MainWindowMetric
            label={t('devices.automations.metric.unreadResults')}
            style={{ minHeight: windowLayout.metricMinHeight, minWidth: windowLayout.metricMinWidth }}
            urgent={overview.unreadRunCount > 0}
            value={overview.unreadRunCount}
            valueSize="large"
          />
          <MainWindowMetric
            label={t('devices.automations.metric.executing')}
            style={{ minHeight: windowLayout.metricMinHeight, minWidth: windowLayout.metricMinWidth }}
            urgent={overview.runningRunCount > 0}
            value={overview.runningRunCount}
            valueSize="large"
          />
        </View>
        <Text style={styles.summaryCopy} numberOfLines={2}>
          {overview.pausedCount > 0
            ? t('devices.automations.summary.paused', { count: overview.pausedCount })
            : t('devices.automations.summary.default')}
        </Text>
      </SummaryStrip>

      <ScrollView
        refreshControl={<RefreshControl refreshing={loading || runsLoading} onRefresh={refreshAll} />}
        contentContainerStyle={[
          styles.content,
          {
            gap: windowLayout.contentGap,
            paddingHorizontal: windowLayout.contentPaddingHorizontal,
            paddingVertical: windowLayout.contentPaddingVertical,
          },
        ]}
        testID="automations.scroll"
      >
        {formDraft && (
          <ScheduleFormCard
            busy={busyAction === 'create' || busyAction === `edit:${formScheduleId}`}
            draft={formDraft}
            error={formError}
            mode={formMode ?? 'create'}
            onCancel={closeScheduleForm}
            onChange={setFormDraft}
            onPromptChange={(value) => {
              setTemplatePromptDirty(!!selectedTemplate);
              setFormDraft((prev) => (prev ? { ...prev, prompt: value } : prev));
            }}
            onReloadTemplates={() => void loadTemplates()}
            onSubmit={() => void submitScheduleForm()}
            onSelectTemplate={selectTemplate}
            onTemplateParamChange={updateTemplateParam}
            selectedTemplateId={selectedTemplate?.id ?? null}
            templateError={templateError}
            templateParamValues={templateParamValues}
            templates={templates}
            templatesLoading={templatesLoading}
            sessions={bindableSessions}
          />
        )}

        {deleteState ? (
          <ScheduleDeleteCard
            busy={busyAction === `delete:${deleteState.schedule.id}`}
            state={deleteState}
            onCancel={() => setDeleteState(null)}
            onConfirm={() => void runDeleteSchedule(deleteState.schedule)}
            onDispositionChange={(disposition) => {
              setDeleteState((prev) => (prev ? { ...prev, disposition } : prev));
            }}
          />
        ) : null}

        {pauseState ? (
          <SchedulePauseCard
            busy={busyAction === `pause:${pauseState.schedule.id}`}
            state={pauseState}
            onCancel={() => setPauseState(null)}
            onConfirm={() => void pauseScheduleNow(pauseState.schedule)}
          />
        ) : null}

        {deleteRunState ? (
          <RunDeleteCard
            busy={busyAction === `run-delete:${deleteRunState.run.id}`}
            state={deleteRunState}
            onCancel={() => setDeleteRunState(null)}
            onConfirm={() => void deleteRunNow(deleteRunState.run)}
          />
        ) : null}

        {schedules.length === 0 ? (
          // 首同步完成前(lastSyncedAt === null)抑制"暂无自动化"空状态,避免冷进先闪空态再跳成真列表
          // (规则 7:不闪空白/不跳变)。同步失败时 ConnectionBanner 已有错误 + 重试入口,同样不谎报"暂无"。
          // 抑制期渲染 RemoteListSyncingPlaceholder(800ms 内空白,超时浮现「正在同步」),慢链路下不再无限期纯白。
          shouldSuppressRemoteListEmptyState({
            itemCount: schedules.length,
            hasSyncedThisOpen: lastSyncedAt !== null,
          }) ? (
            <RemoteListSyncingPlaceholder testID="automations.syncing" />
          ) : (
          <MainWindowEmptyState
            copy={t('devices.automations.empty.copy')}
            style={{
              minHeight: windowLayout.emptyMinHeight,
              padding: windowLayout.emptyPadding,
            }}
            testID="automations.empty"
            title={t('devices.automations.empty.title')}
          >
            <MainWindowActionGroup
              primaryActions={[
                {
                  accessibilityLabel: t('devices.automations.createAutomation'),
                  disabled: !!busyAction,
                  label: t('devices.automations.createAutomation'),
                  onPress: startCreateSchedule,
                  testID: 'automations.emptyCreateButton',
                  tone: 'primary',
                },
              ]}
              testID="automations.emptyActions"
            />
          </MainWindowEmptyState>
          )
        ) : (
          <>
            <View style={styles.scheduleList} testID="automations.scheduleList">
              {schedules.map((schedule) => (
                <ScheduleRow
                  key={schedule.id}
                  runs={runsBySchedule.get(schedule.id) ?? []}
                  schedule={schedule}
                  selected={schedule.id === selectedSchedule?.id}
                  onPress={() => setSelectedId(schedule.id)}
                />
              ))}
            </View>

            {selectedSchedule && (
              <View style={styles.detail} testID="automations.detail">
                <ScheduleDetail
                  busyAction={busyAction}
                  onPause={() => requestPauseSchedule(selectedSchedule)}
                  onResume={() => void runScheduleAction(
                    `resume:${selectedSchedule.id}`,
                    selectedSchedule,
                    () => maker.schedule.resume(selectedSchedule.id),
                  )}
                  onRunNow={() => void runScheduleAction(
                    `run:${selectedSchedule.id}`,
                    selectedSchedule,
                    () => maker.schedule.runNow(selectedSchedule.id),
                  )}
                  onEdit={() => startEditSchedule(selectedSchedule)}
                  onDelete={() => requestDeleteSchedule(selectedSchedule)}
                  runs={displayedRuns}
                  runsLoading={runsLoading}
                  schedule={selectedSchedule}
                />

                <View style={styles.runsHeader}>
                  <Text style={styles.sectionTitle}>{t('devices.automations.recentRuns')}</Text>
                  {runsLoading ? <ActivityIndicator color={colors.textSecondary} /> : null}
                </View>
                {displayedRuns.length === 0 ? (
                  <MainWindowEmptyState
                    copy={t('devices.automations.runs.emptyCopy')}
                    style={styles.emptyInline}
                    title={t('devices.automations.runs.emptyTitle')}
                  />
                ) : (
                  <View style={styles.runList} testID="automations.runList">
                    {displayedRuns.map((run) => (
                      <RunRow
                        busyAction={busyAction}
                        key={run.id}
                        opening={openingRunId === run.id}
                        onDelete={() => requestDeleteRun(run)}
                        onMarkRead={() => void markSingleRunRead(run)}
                        onOpenSession={() => void openRunSession(run)}
                        onRestart={() => void restartRun(run)}
                        run={run}
                      />
                    ))}
                  </View>
                )}
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function ScheduleFormCard({
  busy,
  draft,
  error,
  mode,
  onCancel,
  onChange,
  onPromptChange,
  onReloadTemplates,
  onSelectTemplate,
  onSubmit,
  onTemplateParamChange,
  selectedTemplateId,
  templateError,
  templateParamValues,
  templates,
  templatesLoading,
  sessions,
}: {
  busy: boolean;
  draft: MobileScheduleDraft;
  error: string | null;
  mode: 'create' | 'edit';
  onCancel: () => void;
  onChange: (draft: MobileScheduleDraft) => void;
  onPromptChange: (value: string) => void;
  onReloadTemplates: () => void;
  onSelectTemplate: (template: RemoteScheduleTemplate) => void;
  onSubmit: () => void;
  onTemplateParamChange: (key: string, value: string) => void;
  selectedTemplateId: string | null;
  templateError: string | null;
  templateParamValues: Record<string, string>;
  templates: readonly RemoteScheduleTemplate[];
  templatesLoading: boolean;
  sessions: readonly RemoteSession[];
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const setField = <K extends keyof MobileScheduleDraft>(key: K, value: MobileScheduleDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };
  const sessionMode = deriveMobileScheduleSessionMode(draft);
  const hasRealBinding = hasMobileScheduleRealBinding(draft);
  const hideWorkspaceFields = sessionMode === 'bound' || hasRealBinding;
  // 仅运行脚本任务(桌面端创建):会话模式/工作区切换/worktree/Agent/模型等
  // agent-only 控件全部隐藏——引擎对 script 模式拒绝这些组合,留着控件等于
  // 给用户一个"点了就保存失败"的开关(codex review 发现)。buildMobileScheduleInput
  // 同时在序列化层把这些字段钉回 script 合法值,双保险。
  const isScriptTask = draft.executionMode === 'script';
  const boundSessionInputValue = draft.targetSessionId.trim() === MOBILE_SCHEDULE_PENDING_SESSION_ID
    ? ''
    : draft.targetSessionId;
  const boundSessionOptions = useMemo(
    () => buildBoundSessionOptions(sessions, boundSessionInputValue),
    [boundSessionInputValue, sessions],
  );
  const sessionModeCopy = sessionMode === 'bound'
    ? t('devices.automations.form.sessionMode.bound')
    : sessionMode === 'persistent'
      ? t('devices.automations.form.sessionMode.persistent')
      : t('devices.automations.form.sessionMode.fresh');

  return (
    <View style={styles.formCard} testID="automations.form">
      <View style={styles.formHeader}>
        <View>
          <Text style={styles.sectionTitle}>{mode === 'edit' ? 'Edit Automation' : 'New Automation'}</Text>
          <Text style={styles.formTitle}>{mode === 'edit' ? t('devices.automations.form.title.edit') : t('devices.automations.form.title.create')}</Text>
        </View>
        {busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>

      {error ? <Text style={styles.formError}>{error}</Text> : null}

      {mode === 'create' ? (
        <TemplatePicker
          busy={busy}
          error={templateError}
          loading={templatesLoading}
          onParamChange={onTemplateParamChange}
          onReload={onReloadTemplates}
          onSelect={onSelectTemplate}
          paramValues={templateParamValues}
          selectedTemplateId={selectedTemplateId}
          templates={templates}
        />
      ) : null}

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.name')}</Text>
        <TextInput
          autoCapitalize="none"
          editable={!busy}
          onChangeText={(value) => setField('name', value)}
          placeholder={t('devices.automations.form.namePlaceholder')}
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          testID="automations.form.nameInput"
          value={draft.name}
        />
      </View>

      {draft.executionMode === 'script' ? (
        <Text style={styles.fieldHint} testID="automations.form.scriptModeHint">
          {t('devices.automations.form.scriptHint')}
        </Text>
      ) : (
        <View style={styles.fieldGroup}>
          <Text style={styles.fieldLabel}>{t('devices.automations.form.field.prompt')}</Text>
          <TextInput
            editable={!busy}
            multiline
            onChangeText={onPromptChange}
            placeholder={t('devices.automations.form.promptPlaceholder')}
            placeholderTextColor={colors.textTertiary}
            style={[styles.input, styles.textArea]}
            testID="automations.form.promptInput"
            textAlignVertical="top"
            value={draft.prompt}
          />
        </View>
      )}

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.trigger')}</Text>
        <View style={styles.segmentRow}>
          <SegmentButton
            active={draft.runMode === 'recurring'}
            disabled={busy}
            label={t('devices.automations.form.trigger.recurring')}
            onPress={() => onChange(updateDraftRunMode(draft, 'recurring'))}
            testID="automations.form.runModeRecurring"
          />
          <SegmentButton
            active={draft.runMode === 'manual'}
            disabled={busy}
            label={t('devices.automations.form.trigger.manual')}
            onPress={() => onChange(updateDraftRunMode(draft, 'manual'))}
            testID="automations.form.runModeManual"
          />
        </View>
      </View>

      {!isScriptTask ? (
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.runSession')}</Text>
        <View style={styles.segmentRow} testID="automations.form.sessionMode">
          <SegmentButton
            active={sessionMode === 'fresh'}
            disabled={busy}
            label={t('devices.automations.form.session.fresh')}
            onPress={() => onChange(updateDraftSessionMode(draft, 'fresh'))}
            testID="automations.form.sessionModeFresh"
          />
          <SegmentButton
            active={sessionMode === 'persistent'}
            disabled={busy}
            label={t('devices.automations.form.session.persistent')}
            onPress={() => onChange(updateDraftSessionMode(draft, 'persistent'))}
            testID="automations.form.sessionModePersistent"
          />
          <SegmentButton
            active={sessionMode === 'bound'}
            disabled={busy}
            label={t('devices.automations.form.session.bound')}
            onPress={() => onChange(updateDraftSessionMode(draft, 'bound'))}
            testID="automations.form.sessionModeBound"
          />
        </View>
        <Text style={styles.fieldHint} testID="automations.form.sessionModeHint">
          {sessionModeCopy}
        </Text>
      </View>
      ) : null}

      {!isScriptTask && sessionMode === 'bound' ? (
        <View style={styles.fieldGroup} testID="automations.form.boundSession">
          <Text style={styles.fieldLabel}>{t('devices.automations.form.field.boundSession')}</Text>
          {boundSessionOptions.length ? (
            <View style={styles.boundSessionOptions} testID="automations.form.boundSessionOptions">
              {boundSessionOptions.map((session) => (
                <MainWindowRowButton
                  accessibilityLabel={t('devices.automations.form.boundSessionA11y', { name: session.title || session.id })}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: session.id === boundSessionInputValue.trim() }}
                  disabled={busy}
                  key={session.id}
                  onPress={() => onChange(updateDraftBoundSessionId(draft, session.id))}
                  selected={session.id === boundSessionInputValue.trim()}
                  style={styles.boundSessionOption}
                  testID="automations.form.boundSessionOption"
                >
                  <View style={styles.boundSessionOptionText}>
                    <Text style={styles.boundSessionTitle} numberOfLines={1}>
                      {session.title || session.workingDir || session.id}
                    </Text>
                    <Text style={styles.boundSessionMeta} numberOfLines={1}>
                      {formatSessionOptionMeta(session)}
                    </Text>
                  </View>
                </MainWindowRowButton>
              ))}
            </View>
          ) : null}
          <TextInput
            autoCapitalize="none"
            editable={!busy}
            onChangeText={(value) => onChange(updateDraftBoundSessionId(draft, value))}
            placeholder="session id"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            testID="automations.form.targetSessionInput"
            value={boundSessionInputValue}
          />
        </View>
      ) : null}

      {draft.runMode === 'recurring' ? (
        <>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t('devices.automations.form.field.intervalMinutes')}</Text>
            <TextInput
              editable={!busy}
              keyboardType="number-pad"
              onChangeText={(value) => setField('intervalMinutes', value)}
              placeholder={t('devices.automations.form.intervalPlaceholder')}
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
              testID="automations.form.intervalInput"
              value={draft.intervalMinutes}
            />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Cron</Text>
            <TextInput
              autoCapitalize="none"
              editable={!busy}
              onChangeText={(value) => setField('cronExpr', value)}
              placeholder="0 9 * * *"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
              testID="automations.form.cronInput"
              value={draft.cronExpr}
            />
          </View>
        </>
      ) : null}

      {!isScriptTask ? (
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.workspace')}</Text>
        <View style={styles.segmentRow}>
          <SegmentButton
            active={draft.workspaceKind === 'project'}
            disabled={busy}
            label={t('devices.automations.form.workspace.project')}
            onPress={() => onChange(updateDraftWorkspaceKind(draft, 'project'))}
            testID="automations.form.workspaceProject"
          />
          <SegmentButton
            active={draft.workspaceKind === 'dialogue'}
            disabled={busy}
            label={t('devices.automations.form.workspace.dialogue')}
            onPress={() => onChange(updateDraftWorkspaceKind(draft, 'dialogue'))}
            testID="automations.form.workspaceDialogue"
          />
        </View>
      </View>
      ) : null}

      {(isScriptTask || draft.workspaceKind === 'project') && !hideWorkspaceFields ? (
        <>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t('devices.automations.form.field.projectDir')}</Text>
            <TextInput
              autoCapitalize="none"
              editable={!busy}
              onChangeText={(value) => setField('workingDir', value)}
              placeholder="/Users/name/Code/project"
              placeholderTextColor={colors.textTertiary}
              style={styles.input}
              testID="automations.form.workingDirInput"
              value={draft.workingDir}
            />
          </View>
          {!isScriptTask ? (
          <ToggleRow
            active={draft.useWorktree}
            disabled={busy}
            label={t('devices.automations.form.useWorktree')}
            onPress={() => setField('useWorktree', !draft.useWorktree)}
            testID="automations.form.worktreeToggle"
          />
          ) : null}
        </>
      ) : null}

      {!isScriptTask ? (
      <>
      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>Agent</Text>
        <View style={styles.segmentRow}>
          <SegmentButton
            active={draft.agentKind === 'claude-code'}
            disabled={busy || hasRealBinding}
            label="Claude"
            onPress={() => onChange(updateDraftAgentKind(draft, 'claude-code'))}
            testID="automations.form.agentClaude"
          />
          <SegmentButton
            active={draft.agentKind === 'codex'}
            disabled={busy || hasRealBinding}
            label="Codex"
            onPress={() => onChange(updateDraftAgentKind(draft, 'codex'))}
            testID="automations.form.agentCodex"
          />
        </View>
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.model')}</Text>
        <TextInput
          autoCapitalize="none"
          editable={!busy}
          onChangeText={(value) => setField('model', value)}
          placeholder={hasRealBinding ? t('devices.automations.form.modelPlaceholderBound') : draft.agentKind === 'codex' ? 'gpt-5.5' : 'claude-sonnet-4-6'}
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          testID="automations.form.modelInput"
          value={draft.model}
        />
      </View>

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.effort')}</Text>
        <TextInput
          autoCapitalize="none"
          editable={!busy}
          onChangeText={(value) => setField('effort', value)}
          placeholder="minimal / low / medium / high / xhigh / max / ultra"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          testID="automations.form.effortInput"
          value={draft.effort}
        />
      </View>

      {draft.agentKind === 'codex' && !hideWorkspaceFields ? (
        <ToggleRow
          active={draft.fastMode}
          disabled={busy}
          label={t('devices.automations.form.fastMode')}
          onPress={() => setField('fastMode', !draft.fastMode)}
          testID="automations.form.fastModeToggle"
        />
      ) : null}
      </>
      ) : null}

      <View style={styles.fieldGroup}>
        <Text style={styles.fieldLabel}>{t('devices.automations.form.field.timezone')}</Text>
        <TextInput
          autoCapitalize="none"
          editable={!busy}
          onChangeText={(value) => setField('timezone', value)}
          placeholder="Asia/Shanghai"
          placeholderTextColor={colors.textTertiary}
          style={styles.input}
          testID="automations.form.timezoneInput"
          value={draft.timezone}
        />
      </View>

      <ToggleRow
        active={draft.notifyDesktop}
        disabled={busy}
        label={t('devices.automations.form.notifyDesktop')}
        onPress={() => setField('notifyDesktop', !draft.notifyDesktop)}
        testID="automations.form.notifyDesktopToggle"
      />

      <ToggleRow
        active={draft.notifyFeishu}
        disabled={busy}
        label={t('devices.automations.form.notifyFeishu')}
        onPress={() => setField('notifyFeishu', !draft.notifyFeishu)}
        testID="automations.form.notifyFeishuToggle"
      />

      <MainWindowActionGroup
        primaryActions={[
          {
            accessibilityLabel: busy ? t('devices.automations.form.savingA11y') : t('devices.automations.form.saveA11y'),
            disabled: busy,
            label: busy ? t('devices.common.saving') : t('devices.common.save'),
            onPress: onSubmit,
            testID: 'automations.form.saveButton',
            tone: 'primary',
          },
        ]}
        cancelAction={{
          accessibilityLabel: t('devices.automations.form.cancelA11y'),
          disabled: busy,
          label: t('devices.common.cancel'),
          onPress: onCancel,
          testID: 'automations.form.cancelButton',
        }}
        testID="automations.form.actions"
      />
    </View>
  );
}

function ScheduleDeleteCard({
  busy,
  onCancel,
  onConfirm,
  onDispositionChange,
  state,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onDispositionChange: (value: ScheduleGeneratedSessionDisposition) => void;
  state: DeleteScheduleState;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const previewText = state.loading
    ? t('devices.automations.delete.counting')
    : describeScheduleDeletePreview({
        sessionIds: state.sessionIds ?? [],
        sessionCount: state.sessionIds?.length ?? 0,
        inflightCount: state.inflightCount ?? 0,
      });
  const confirmText = state.disposition === 'delete'
    ? t('devices.automations.delete.confirmDeleteBoth')
    : state.disposition === 'archive'
      ? t('devices.automations.delete.confirmArchive')
      : t('devices.automations.delete.confirmTaskOnly');

  return (
    <View style={styles.deleteCard} testID="automations.deleteDialog">
      <View style={styles.deleteHeader}>
        <View style={styles.deleteHeaderText}>
          <Text style={styles.sectionTitle}>Delete Automation</Text>
          <Text style={styles.deleteTitle} numberOfLines={2}>{t('devices.automations.delete.title', { name: state.schedule.name })}</Text>
        </View>
        {state.loading || busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>
      <Text style={styles.deleteCopy}>
        {t('devices.automations.delete.copy')}
      </Text>
      <Text style={styles.deletePreview} testID="automations.delete.preview">
        {previewText}
      </Text>
      {state.error ? <Text style={styles.formError}>{state.error}</Text> : null}
      <View
        accessibilityLabel={t('devices.automations.delete.optionsA11y')}
        accessibilityRole="radiogroup"
        style={styles.deleteOptions}
        testID="automations.delete.options"
      >
        <DeleteDispositionOption
          description={t('devices.automations.delete.keepDesc')}
          disabled={busy}
          label={t('devices.automations.delete.keepLabel')}
          onPress={() => onDispositionChange('keep')}
          selected={state.disposition === 'keep'}
          testID="automations.delete.option.keep"
        />
        <DeleteDispositionOption
          description={t('devices.automations.delete.archiveDesc')}
          disabled={busy}
          label={t('devices.automations.delete.archiveLabel')}
          onPress={() => onDispositionChange('archive')}
          selected={state.disposition === 'archive'}
          testID="automations.delete.option.archive"
        />
        <DeleteDispositionOption
          description={t('devices.automations.delete.deleteDesc')}
          disabled={busy}
          label={t('devices.automations.delete.deleteLabel')}
          onPress={() => onDispositionChange('delete')}
          selected={state.disposition === 'delete'}
          testID="automations.delete.option.delete"
        />
      </View>
      <MainWindowActionGroup
        cancelAction={{
          accessibilityLabel: t('devices.automations.delete.cancelA11y'),
          disabled: busy,
          label: t('devices.common.cancel'),
          onPress: onCancel,
          testID: 'automations.delete.cancelButton',
        }}
        dangerActions={[
          {
            accessibilityLabel: t('devices.automations.delete.confirmA11y'),
            disabled: busy || state.loading,
            label: busy ? t('devices.common.deleting') : confirmText,
            onPress: onConfirm,
            testID: 'automations.delete.confirmButton',
            tone: 'danger',
          },
        ]}
        testID="automations.delete.actions"
      />
    </View>
  );
}

function SchedulePauseCard({
  busy,
  onCancel,
  onConfirm,
  state,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  state: PauseScheduleState;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const confirmation = buildSchedulePauseConfirmation(state.schedule, state.inflightCount);
  return (
    <View style={styles.pauseCard} testID="automations.pauseDialog">
      <View style={styles.deleteHeader}>
        <View style={styles.deleteHeaderText}>
          <Text style={styles.sectionTitle}>Pause Automation</Text>
          <Text style={styles.deleteTitle} numberOfLines={2}>
            {confirmation?.title ?? t('devices.automations.pause.title', { name: state.schedule.name || state.schedule.id })}
          </Text>
        </View>
        {busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>
      <Text style={styles.deleteCopy}>
        {confirmation?.detail ?? t('devices.automations.pause.detailFallback')}
      </Text>
      <Text style={styles.deletePreview} testID="automations.pause.preview">
        {confirmation?.preview ?? t('devices.automations.pause.previewFallback')}
      </Text>
      {state.error ? <Text style={styles.formError}>{state.error}</Text> : null}
      <MainWindowActionGroup
        primaryActions={[
          {
            accessibilityLabel: t('devices.automations.pause.confirmA11y'),
            disabled: busy,
            label: busy ? t('devices.automations.pause.pausing') : t('devices.automations.pause.confirm'),
            onPress: onConfirm,
            testID: 'automations.pause.confirmButton',
            tone: 'primary',
          },
        ]}
        cancelAction={{
          accessibilityLabel: t('devices.automations.pause.cancelA11y'),
          disabled: busy,
          label: t('devices.common.cancel'),
          onPress: onCancel,
          testID: 'automations.pause.cancelButton',
        }}
        testID="automations.pause.actions"
      />
    </View>
  );
}

function RunDeleteCard({
  busy,
  onCancel,
  onConfirm,
  state,
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  state: DeleteRunState;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const summary = summarizeRun(state.run);
  return (
    <View style={styles.pauseCard} testID="automations.runDeleteDialog">
      <View style={styles.deleteHeader}>
        <View style={styles.deleteHeaderText}>
          <Text style={styles.sectionTitle}>Delete Run</Text>
          <Text style={styles.deleteTitle} numberOfLines={2}>
            {t('devices.automations.runDelete.title')}
          </Text>
        </View>
        {busy ? <ActivityIndicator color={colors.textSecondary} /> : null}
      </View>
      <Text style={styles.deleteCopy}>
        {t('devices.automations.runDelete.copy')}
      </Text>
      <Text style={styles.deletePreview} testID="automations.runDelete.preview">
        {summary.title} · {summary.subtitle}
      </Text>
      {state.error ? <Text style={styles.formError}>{state.error}</Text> : null}
      <MainWindowActionGroup
        dangerActions={[
          {
            accessibilityLabel: t('devices.automations.runDelete.confirmA11y'),
            disabled: busy,
            label: busy ? t('devices.common.deleting') : t('devices.automations.runDelete.confirm'),
            onPress: onConfirm,
            testID: 'automations.runDelete.confirmButton',
            tone: 'danger',
          },
        ]}
        cancelAction={{
          accessibilityLabel: t('devices.automations.runDelete.cancelA11y'),
          disabled: busy,
          label: t('devices.common.cancel'),
          onPress: onCancel,
          testID: 'automations.runDelete.cancelButton',
        }}
        testID="automations.runDelete.actions"
      />
    </View>
  );
}

function DeleteDispositionOption({
  description,
  disabled,
  label,
  onPress,
  selected,
  testID,
}: {
  description: string;
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <MainWindowCardButton
      accessibilityLabel={label}
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      disabled={disabled}
      onPress={onPress}
      selected={selected}
      style={styles.deleteOption}
      testID={testID}
    >
      <View style={[styles.radioMark, selected && styles.radioMarkSelected]}>
        {selected ? <View style={styles.radioMarkDot} /> : null}
      </View>
      <View style={styles.deleteOptionText}>
        <Text style={styles.deleteOptionTitle}>{label}</Text>
        <Text style={styles.deleteOptionDescription}>{description}</Text>
      </View>
    </MainWindowCardButton>
  );
}

function TemplatePicker({
  busy,
  error,
  loading,
  onParamChange,
  onReload,
  onSelect,
  paramValues,
  selectedTemplateId,
  templates,
}: {
  busy: boolean;
  error: string | null;
  loading: boolean;
  onParamChange: (key: string, value: string) => void;
  onReload: () => void;
  onSelect: (template: RemoteScheduleTemplate) => void;
  paramValues: Record<string, string>;
  selectedTemplateId: string | null;
  templates: readonly RemoteScheduleTemplate[];
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const selected = templates.find((template) => template.id === selectedTemplateId) ?? null;
  return (
    <View style={styles.templateSection} testID="automations.templateSection">
      <View style={styles.templateHeader}>
        <Text style={styles.fieldLabel}>{t('devices.automations.template.label')}</Text>
        <MainWindowActionButton
          action={{
            accessibilityLabel: loading ? t('devices.automations.template.loadingA11y') : t('devices.automations.template.refreshA11y'),
            disabled: busy || loading,
            label: loading ? t('devices.automations.template.loading') : t('devices.automations.template.refresh'),
            onPress: onReload,
            testID: 'automations.templateReloadButton',
          }}
          density="compact"
          style={styles.templateReloadButton}
        />
      </View>
      {error ? <Text style={styles.templateError}>{error}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.templateList}
        testID="automations.templateList"
      >
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            disabled={busy}
            onPress={() => onSelect(template)}
            selected={template.id === selectedTemplateId}
            template={template}
          />
        ))}
      </ScrollView>
      {selected?.parameters?.length ? (
        <View style={styles.templateParams} testID="automations.templateParams">
          {selected.parameters.map((parameter) => (
            <TemplateParamControl
              key={parameter.key}
              disabled={busy}
              onChange={(value) => onParamChange(parameter.key, value)}
              parameter={parameter}
              value={paramValues[parameter.key] ?? ''}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function TemplateCard({
  disabled,
  onPress,
  selected,
  template,
}: {
  disabled: boolean;
  onPress: () => void;
  selected: boolean;
  template: RemoteScheduleTemplate;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  return (
    <MainWindowCardButton
      accessibilityLabel={t('devices.automations.template.cardA11y', { name: template.name })}
      disabled={disabled}
      onPress={onPress}
      selected={selected}
      style={styles.templateCard}
      testID="automations.templateCard"
    >
      <Text style={styles.templateName} numberOfLines={1}>{template.name}</Text>
      <Text style={styles.templateDescription} numberOfLines={3}>{template.description}</Text>
      <Text style={styles.templateMeta} numberOfLines={1}>
        {template.cronExpr ? template.cronExpr : t('devices.automations.template.manualConfig')}
      </Text>
    </MainWindowCardButton>
  );
}

function TemplateParamControl({
  disabled,
  onChange,
  parameter,
  value,
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  parameter: RemoteTemplateParameter;
  value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  if (parameter.type === 'boolean') {
    return (
      <ToggleRow
        active={value === 'true'}
        disabled={disabled}
        label={parameter.label}
        onPress={() => onChange(value === 'true' ? 'false' : 'true')}
        testID="automations.templateParamToggle"
      />
    );
  }
  if (parameter.type === 'select') {
    return (
      <View style={styles.fieldGroup} testID="automations.templateParamSelect">
        <Text style={styles.fieldLabel}>{parameter.label}</Text>
        <View style={styles.segmentRow}>
          {(parameter.options ?? []).map((option) => (
            <SegmentButton
              key={option}
              active={value === option}
              disabled={disabled}
              label={option}
              onPress={() => onChange(option)}
              testID="automations.templateParamOption"
            />
          ))}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>
        {parameter.label}{parameter.required ? ' *' : ''}
      </Text>
      <TextInput
        autoCapitalize="none"
        editable={!disabled}
        keyboardType={parameter.type === 'number' ? 'number-pad' : 'default'}
        onChangeText={onChange}
        placeholder={parameter.placeholder ?? parameter.default ?? ''}
        placeholderTextColor={colors.textTertiary}
        style={styles.input}
        testID="automations.templateParamInput"
        value={value}
      />
    </View>
  );
}

function SegmentButton({
  active,
  disabled,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <MainWindowOptionButton
      density="default"
      disabled={disabled}
      label={label}
      onPress={onPress}
      selected={active}
      style={styles.segmentButton}
      testID={testID}
      variant="segmented"
    />
  );
}

function ToggleRow({
  active,
  disabled,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  disabled: boolean;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return (
    <MainWindowRowButton
      accessibilityLabel={label}
      accessibilityRole="switch"
      accessibilityState={{ checked: active }}
      disabled={disabled}
      onPress={onPress}
      style={styles.toggleRow}
      testID={testID}
    >
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={[styles.togglePill, active && styles.togglePillActive]}>
        <View style={[styles.toggleKnob, active && styles.toggleKnobActive]} />
      </View>
    </MainWindowRowButton>
  );
}

function ScheduleRow({
  runs,
  schedule,
  selected,
  onPress,
}: {
  runs: readonly RemoteScheduleRun[];
  schedule: RemoteSchedule;
  selected: boolean;
  onPress: () => void;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t } = useTranslation();
  const summary = summarizeSchedule(schedule, runs);
  return (
    <MainWindowRowButton
      accessibilityLabel={t('devices.automations.scheduleRowA11y', { title: summary.title })}
      onPress={onPress}
      selected={selected}
      style={styles.scheduleRow}
      testID="automations.scheduleRow"
    >
      <View style={styles.scheduleText}>
        <View style={styles.scheduleTitleRow}>
          {summary.unreadCount > 0 ? <View style={styles.unreadDot} /> : null}
          <Text style={styles.scheduleTitle} numberOfLines={1}>{summary.title}</Text>
          <Text style={styles.scheduleStatus}>{summary.statusLabel}</Text>
        </View>
        <Text style={styles.scheduleSubtitle} numberOfLines={1}>{summary.subtitle}</Text>
        <Text style={styles.scheduleDetail} numberOfLines={1}>{summary.detail}</Text>
      </View>
      <ChevronRight color={colors.textTertiary} size={iconSize.xl} strokeWidth={iconStroke.regular} />
    </MainWindowRowButton>
  );
}

function ScheduleDetail({
  busyAction,
  onPause,
  onResume,
  onDelete,
  onEdit,
  onRunNow,
  runs,
  runsLoading,
  schedule,
}: {
  busyAction: string | null;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onRunNow: () => void;
  runs: readonly RemoteScheduleRun[];
  runsLoading: boolean;
  schedule: RemoteSchedule;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const summary = summarizeSchedule(schedule, runs);
  const paused = schedule.status === 'paused';
  const actionBusy = !!busyAction || runsLoading;
  const pauseDisabled = actionBusy || schedule.status === 'expired';
  return (
    <View style={styles.detailCard} testID="automations.detailCard">
      <Text style={styles.detailTitle} numberOfLines={2}>{summary.title}</Text>
      <Text style={styles.detailMeta} numberOfLines={2}>{summary.detail}</Text>
      {summary.runSessionDetail ? (
        <Text style={styles.detailMeta} numberOfLines={1} testID="automations.runSessionDetail">
          {summary.runSessionDetail}
        </Text>
      ) : null}
      <Text style={styles.detailPrompt} numberOfLines={4}>
        {schedule.prompt || (schedule.executionMode === 'script' ? t('devices.automations.detail.promptScriptFallback') : t('devices.automations.detail.promptEmpty'))}
      </Text>
      <MainWindowActionGroup
        dangerActions={[{
          accessibilityLabel: t('devices.automations.detail.deleteA11y'),
          disabled: actionBusy,
          label: t('devices.common.delete'),
          onPress: onDelete,
          testID: 'automations.deleteButton',
          tone: 'danger',
        }]}
        primaryActions={[{
          accessibilityLabel: t('devices.automations.detail.runNowA11y'),
          disabled: actionBusy,
          label: busyAction === `run:${schedule.id}` ? t('devices.automations.detail.running') : 'Run now',
          onPress: onRunNow,
          testID: 'automations.runNowButton',
          tone: 'primary',
        }]}
        secondaryActions={[{
          accessibilityLabel: paused ? t('devices.automations.detail.resumeA11y') : t('devices.automations.detail.pauseA11y'),
          disabled: pauseDisabled,
          label: paused ? t('devices.automations.detail.resume') : t('devices.automations.detail.pause'),
          onPress: paused ? onResume : onPause,
          testID: paused ? 'automations.resumeButton' : 'automations.pauseButton',
          tone: 'secondary',
        }, {
          accessibilityLabel: t('devices.automations.detail.editA11y'),
          disabled: actionBusy,
          label: t('devices.automations.detail.edit'),
          onPress: onEdit,
          testID: 'automations.editButton',
          tone: 'secondary',
        }]}
        testID="automations.detailActions"
      />
    </View>
  );
}

function RunRow({
  busyAction,
  opening,
  onDelete,
  onMarkRead,
  onOpenSession,
  onRestart,
  run,
}: {
  busyAction: string | null;
  opening: boolean;
  onDelete: () => void;
  onMarkRead: () => void;
  onOpenSession: () => void;
  onRestart: () => void;
  run: RemoteScheduleRun;
}) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  const summary = summarizeRun(run);
  const actionBusy = !!busyAction || opening;
  const hasActions = summary.canOpenSession || summary.canRestart || summary.canMarkRead || summary.canDelete;
  return (
    <View style={styles.runRow} testID="automations.runRow">
      <View style={styles.runText}>
        <View style={styles.runTitleRow}>
          {summary.unread ? <View style={styles.unreadDot} /> : null}
          <Text style={styles.runTitle}>{summary.title}</Text>
          <Text style={styles.runTime}>{summary.subtitle}</Text>
        </View>
        <Text style={styles.runMeta} numberOfLines={1} testID="automations.runMeta">
          {summary.meta}
        </Text>
        {summary.detail ? (
          <Text style={styles.runDetail} numberOfLines={3}>{summary.detail}</Text>
        ) : null}
      </View>
      {hasActions ? (
        <View style={styles.runActions} testID="automations.runActions">
          {summary.canOpenSession ? (
            <MainWindowActionButton
              action={{
                accessibilityLabel: t('devices.automations.run.openSessionA11y'),
                busy: opening,
                disabled: actionBusy,
                label: opening ? t('devices.automations.run.opening') : (summary.openSessionLabel ?? t('devices.automations.run.session')),
                onPress: onOpenSession,
                testID: 'automations.openRunSessionButton',
              }}
              density="compact"
              style={styles.runActionButton}
            />
          ) : null}
          {summary.canRestart ? (
            <MainWindowActionButton
              action={{
                accessibilityLabel: t('devices.automations.run.restartA11y'),
                busy: busyAction === `run-restart:${run.id}`,
                disabled: actionBusy,
                label: busyAction === `run-restart:${run.id}` ? t('devices.automations.run.restarting') : (summary.restartLabel ?? t('devices.automations.run.restart')),
                onPress: onRestart,
                testID: 'automations.restartRunButton',
              }}
              density="compact"
              style={styles.runActionButton}
            />
          ) : null}
          {summary.canMarkRead ? (
            <MainWindowActionButton
              action={{
                accessibilityLabel: t('devices.automations.run.markReadA11y'),
                busy: busyAction === `run-read:${run.id}`,
                disabled: actionBusy,
                label: busyAction === `run-read:${run.id}` ? t('devices.automations.run.marking') : (summary.markReadLabel ?? t('devices.automations.run.markRead')),
                onPress: onMarkRead,
                testID: 'automations.markRunReadButton',
              }}
              density="compact"
              style={styles.runActionButton}
            />
          ) : null}
          {summary.canDelete ? (
            <MainWindowActionButton
              action={{
                accessibilityLabel: t('devices.automations.run.deleteA11y'),
                busy: busyAction === `run-delete:${run.id}`,
                disabled: actionBusy,
                label: busyAction === `run-delete:${run.id}` ? t('devices.common.deleting') : (summary.deleteLabel ?? t('devices.common.delete')),
                onPress: onDelete,
                testID: 'automations.deleteRunButton',
                tone: 'danger',
              }}
              density="compact"
              style={styles.runActionButton}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function markRunsReadLocally(list: readonly RemoteScheduleRun[]): RemoteScheduleRun[] {
  const readAt = Date.now();
  return list.map((run) => {
    if (run.status === 'running' || run.readAt) return run;
    return { ...run, readAt };
  });
}

function markRunReadLocally(list: readonly RemoteScheduleRun[], runId: string): RemoteScheduleRun[] {
  const readAt = Date.now();
  return list.map((run) => (run.id === runId ? { ...run, readAt } : run));
}

// 与 packages/maker-scheduler builtin-templates.ts 的 TEMPLATE_CATEGORIES order 保持一致。
const TEMPLATE_CATEGORY_RANK: Record<string, number> = {
  'dev-automation': 1,
  'info-radar': 2,
  'office-docs': 3,
};

function sortTemplatesForMobile(
  list: readonly RemoteScheduleTemplate[],
): RemoteScheduleTemplate[] {
  return [...list].sort((a, b) => {
    const rank = (TEMPLATE_CATEGORY_RANK[a.category] ?? 99) - (TEMPLATE_CATEGORY_RANK[b.category] ?? 99);
    if (rank !== 0) return rank;
    return a.name.localeCompare(b.name);
  });
}

function selectBindableSessions(
  sessions: readonly RemoteSession[],
  deviceId: string,
): RemoteSession[] {
  return sessions
    .filter((session) => session.status === 'active')
    .filter((session) => !deviceId || session.deviceLinkDeviceId === deviceId)
    .sort((a, b) => sessionActivityTime(b) - sessionActivityTime(a))
    .slice(0, 8);
}

function buildBoundSessionOptions(
  sessions: readonly RemoteSession[],
  selectedId: string,
): RemoteSession[] {
  const options = sessions.slice(0, 6);
  const selected = selectedId.trim()
    ? sessions.find((session) => session.id === selectedId.trim())
    : null;
  if (!selected || options.some((session) => session.id === selected.id)) return options;
  return [selected, ...options.slice(0, 5)];
}

function formatSessionOptionMeta(session: RemoteSession): string {
  const agent = session.agentKind === 'codex' ? 'Codex' : 'Claude';
  const workspace = session.workingDir ? lastPathSegment(session.workingDir) : 'Dialogue';
  return `${agent} · ${workspace} · ${session.id.slice(0, 8)}`;
}

function lastPathSegment(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}

function sessionActivityTime(session: RemoteSession): number {
  const time = Date.parse(session.userSendAt ?? session.updatedAt ?? session.createdAt);
  return Number.isFinite(time) ? time : 0;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  summaryTopRow: {
    alignItems: 'stretch',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  summaryCopy: {
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
  },
  content: { gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  formCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  formHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 42,
  },
  formTitle: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.medium },
  formError: {
    borderColor: colors.errorBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.errorText,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    padding: spacing.md,
  },
  fieldGroup: { gap: spacing.xs },
  fieldLabel: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  fieldHint: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    minHeight: 46,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  textArea: { minHeight: 112 },
  templateSection: { gap: spacing.sm },
  templateHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 32,
  },
  templateReloadButton: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
  },
  templateError: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  templateList: { gap: spacing.sm, paddingRight: spacing.md },
  templateCard: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    minHeight: 128,
    padding: spacing.md,
    width: 212,
  },
  templateName: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  templateDescription: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  templateMeta: { color: colors.textTertiary, fontSize: typeScale.caption, marginTop: 'auto' },
  templateParams: { gap: spacing.md },
  segmentRow: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.xs,
    padding: spacing.xs,
  },
  segmentButton: {
    borderRadius: radius.container,
    flex: 1,
    minHeight: 38,
    paddingHorizontal: spacing.sm,
  },
  toggleRow: {
    alignItems: 'center',
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 48,
    paddingHorizontal: spacing.md,
  },
  toggleLabel: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  togglePill: {
    alignItems: 'flex-start',
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 28,
    justifyContent: 'center',
    paddingHorizontal: 3,
    width: 50,
  },
  togglePillActive: { alignItems: 'flex-end', backgroundColor: colors.cta },
  toggleKnob: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    height: 22,
    width: 22,
  },
  toggleKnobActive: { backgroundColor: colors.ctaText },
  boundSessionOptions: { gap: spacing.xs },
  boundSessionOption: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: 60,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  boundSessionOptionText: { flex: 1, gap: 2, minWidth: 0 },
  boundSessionTitle: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  boundSessionMeta: { color: colors.textTertiary, fontSize: typeScale.caption },
  scheduleList: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  scheduleRow: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    flexDirection: 'row',
    minHeight: 94,
    paddingHorizontal: spacing.md,
  },
  scheduleText: { flex: 1, gap: spacing.xs, minWidth: 0, paddingRight: spacing.md },
  scheduleTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
  scheduleTitle: { color: colors.textPrimary, flex: 1, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  scheduleStatus: { color: colors.textTertiary, fontSize: typeScale.caption, fontWeight: fontWeight.medium },
  scheduleSubtitle: { color: colors.textSecondary, fontSize: typeScale.caption },
  scheduleDetail: { color: colors.textTertiary, fontSize: typeScale.caption },
  detail: { gap: spacing.md, paddingTop: spacing.lg },
  detailCard: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  detailTitle: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.medium },
  detailMeta: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  detailPrompt: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  deleteCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.errorBorder,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  pauseCard: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.lg,
  },
  deleteHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.md,
    justifyContent: 'space-between',
    minHeight: 42,
  },
  deleteHeaderText: { flex: 1, minWidth: 0 },
  deleteTitle: { color: colors.textPrimary, fontSize: typeScale.title, fontWeight: fontWeight.medium },
  deleteCopy: { color: colors.textSecondary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  deletePreview: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.textSecondary,
    fontSize: typeScale.caption,
    lineHeight: lineHeight.caption,
    padding: spacing.md,
  },
  deleteOptions: { gap: spacing.sm },
  deleteOption: {
    alignItems: 'flex-start',
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 78,
    padding: spacing.md,
  },
  radioMark: {
    alignItems: 'center',
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: 22,
    justifyContent: 'center',
    marginTop: 2,
    width: 22,
  },
  radioMarkSelected: { backgroundColor: colors.cta, borderColor: colors.cta },
  radioMarkDot: {
    backgroundColor: colors.ctaText,
    borderRadius: radius.pill,
    height: 8,
    width: 8,
  },
  deleteOptionText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  deleteOptionTitle: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  deleteOptionDescription: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  runsHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 28,
  },
  sectionTitle: {
    color: colors.textTertiary,
    fontSize: typeScale.caption,
    fontWeight: fontWeight.medium,
    textTransform: 'uppercase',
  },
  runList: { gap: spacing.sm },
  runRow: {
    alignItems: 'stretch',
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.md,
    padding: spacing.md,
  },
  runText: { flex: 1, gap: spacing.xs, minWidth: 0 },
  runTitleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm, minWidth: 0 },
  runTitle: { color: colors.textPrimary, fontSize: typeScale.body, fontWeight: fontWeight.medium },
  runTime: { color: colors.textTertiary, flex: 1, fontSize: typeScale.caption, textAlign: 'right' },
  runMeta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  runDetail: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  runActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  runActionButton: { minHeight: 36, minWidth: 76 },
  unreadDot: { backgroundColor: colors.textPrimary, borderRadius: radius.pill, height: 7, width: 7 },
  emptyInline: {
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.lg,
  },
});
