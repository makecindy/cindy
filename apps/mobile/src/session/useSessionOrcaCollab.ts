/**
 * 手机端协同(Orca)页面状态。
 *
 *  - useOrcaWorkerForm:「开启协同 / 创建新 Worker」表单状态(会话页与新建任务页共用),含
 *    完全访问确认与 Worker 模型选择器的开合编排。
 *  - useSessionOrcaCollab:会话页 + 面板「协同模式」二级视图、团队操作与 Lead / Worker 导航。
 *
 * 真身在被控端;所有写操作完成后以被控端列表为准(整表重拉),本地只在开启 / 结束协同时
 * 乐观改 orcaRole,权威值随 sessions 推送回流。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';
import type { ProviderView } from '@cindy/model-providers/registry';
import type { AgentKind } from '@cindy/model-providers/types';
import type { MobileModelOption } from '@/session/agentCapabilities';
import { confirmFullAccessChange } from '@/session/fullAccessConfirmation';
import {
  buildOrcaEnableOptions,
  convergeOrcaWorkerModel,
  createOrcaWorker,
  describeOrcaError,
  isOrcaAmbiguousTimeout,
  narrowOrcaWorkerProvider,
  enableOrcaTeam,
  isOrcaCollabEligible,
  orcaAgentKindForSession,
  orcaCollabEntryHint,
  orcaWorkerFormFromPrefs,
  orcaWorkerDisplayName,
  orcaWorkerStatusLabel,
  readOrcaCollabEntryStatus,
  type OrcaCollabEntryStatus,
  type OrcaTeamWorker,
  type OrcaWorkerAgentKind,
  type OrcaWorkerFormValue,
  type OrcaWorkerPermissionMode,
} from '@/session/orcaTeam';
import {
  parseOrcaCollaborationSettings,
  parseOrcaTeamWorkers,
  readOrcaTeamLeadSessionId,
  type OrcaCollaborationSettings,
} from '@cindy/maker-shared/orca-team';
import { subscribeRemoteOrcaWorkerChanged } from '@/device-link/DeviceLinkContext';
import { canSubmitOrcaWorkerForm, isPredefinedOrcaRole } from '@/session/ContextSheetCollabView';
import { normalizeMobileAgentCapabilities } from '@/session/agentCapabilities';
import {
  defaultOrcaWorkerCreationPrefs,
  hasLoadedOrcaWorkerCreationPrefs,
  mergeOrcaWorkerChoice,
  readOrcaWorkerCreationPrefs,
  rememberOrcaWorkerChoice,
  type OrcaWorkerCreationPrefs,
} from '@/session/orcaWorkerPrefs';
import { remoteSessionStore } from '@/session/remoteSessionStore';
import { i18n } from '@/i18n';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { MobileModelConfiguration } from '@/session/unifiedMobileModels';
import type { RemoteSession } from '@/session/types';

export type CollabSheetView = 'collab' | 'collab-create';

const ALL_AGENTS: readonly OrcaWorkerAgentKind[] = ['claude-code', 'codex', 'pi'];
const EMPTY_MODEL_OPTIONS: readonly MobileModelOption[] = [];

// ─── 团队状态 ────────────────────────────────────────────────────────────────

export interface OrcaTeamSnapshot {
  workers: OrcaTeamWorker[];
  /**
   * 被控端的协同设置(只读权威值)。null = 还没读到;读取失败时保留上一次读到的值,
   * 不用默认值冒充——否则会误判名额上限,错误地禁用或放行创建。
   */
  settings: OrcaCollaborationSettings | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_TEAM: OrcaTeamSnapshot = {
  workers: [],
  settings: null,
  loading: false,
  error: null,
};

/**
 * Lead 任务的 Worker 列表 + 协同设置。`leadSessionId` 为 null 时不拉取。被控端推送
 * worker-changed(需会话页持有 `session:<leadId>` topic)或调用 refresh 时整表重拉;
 * 旧请求的迟到结果按请求代次丢弃。
 */
export function useOrcaTeam(params: {
  maker: MobileMakerTransport;
  deviceId: string | null;
  leadSessionId: string | null;
  /** 隧道重连代次:断线期间可能漏掉 worker-changed 推送,重连后整表重拉一次。 */
  connectionEpoch?: number;
}): OrcaTeamSnapshot & { refresh(): Promise<void> } {
  const { maker, deviceId, leadSessionId, connectionEpoch } = params;
  const [snapshot, setSnapshot] = useState<OrcaTeamSnapshot>(EMPTY_TEAM);
  const generationRef = useRef(0);
  const makerRef = useRef(maker);
  makerRef.current = maker;

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!leadSessionId) {
      setSnapshot(EMPTY_TEAM);
      return;
    }
    setSnapshot((current) => ({ ...current, loading: true }));
    try {
      const [workers, settings] = await Promise.all([
        makerRef.current.orca.listWorkers(leadSessionId),
        makerRef.current.orca.getCollaborationSettings().catch(() => null),
      ]);
      if (generation !== generationRef.current) return;
      setSnapshot((current) => ({
        workers: parseOrcaTeamWorkers(workers),
        settings: settings === null ? current.settings : parseOrcaCollaborationSettings(settings),
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (generation !== generationRef.current) return;
      setSnapshot((current) => ({
        ...current,
        loading: false,
        error: describeOrcaError(error, 'session.collab.errors.loadFailed'),
      }));
    }
  }, [leadSessionId]);

  useEffect(() => {
    setSnapshot(EMPTY_TEAM);
    void refresh();
    return () => { generationRef.current += 1; };
  }, [deviceId, refresh]);

  const seenEpochRef = useRef(connectionEpoch);
  useEffect(() => {
    if (seenEpochRef.current === connectionEpoch) return;
    seenEpochRef.current = connectionEpoch;
    void refresh();
  }, [connectionEpoch, refresh]);

  useEffect(() => {
    if (!deviceId || !leadSessionId) return undefined;
    return subscribeRemoteOrcaWorkerChanged((pushDeviceId, pushLeadSessionId) => {
      if (pushDeviceId === deviceId && pushLeadSessionId === leadSessionId) void refresh();
    });
  }, [deviceId, leadSessionId, refresh]);

  return { ...snapshot, refresh };
}

/** Worker 任务 → 所属 Lead(被控端团队记录为准;查不到 = null,「返回 Lead」入口不出现)。 */
export function useOrcaWorkerLeadSessionId(params: {
  maker: MobileMakerTransport;
  workerSessionId: string | null;
  /** 隧道重连代次:首次查询赶上断线 / 瞬时失败时,重连后再查一次。 */
  connectionEpoch?: number;
}): string | null {
  const { maker, workerSessionId, connectionEpoch } = params;
  const [leadSessionId, setLeadSessionId] = useState<string | null>(null);
  const makerRef = useRef(maker);
  makerRef.current = maker;
  useEffect(() => {
    setLeadSessionId(null);
  }, [workerSessionId]);
  useEffect(() => {
    if (!workerSessionId) return undefined;
    let cancelled = false;
    makerRef.current.orca.getTeamByWorkerSession(workerSessionId)
      .then((team) => { if (!cancelled) setLeadSessionId(readOrcaTeamLeadSessionId(team)); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [workerSessionId, connectionEpoch]);
  return leadSessionId;
}


/**
 * Worker 表单状态(与桌面 CreateWorkerPopover 同一套记忆规则,见 orcaWorkerPrefs):
 * 打开表单时恢复上次的 Agent 与该 Agent 的模型 / 推理强度 / Fast、权限;切 Agent 时带出
 * 该 Agent 上次的选择;提交成功后调用 remember() 写回。记住的模型在当前电脑上不可用时
 * 回落「默认」(交给被控端解析)。
 *
 * 模型选择器与 + 面板是两个 sheet(iOS 原生 sheet 不能叠开):选模型前收起面板,
 * 选择器完全收起后再展开面板回到表单。
 */
export function useOrcaWorkerForm(params: {
  maker: MobileMakerTransport;
  /** 记忆按登录账号隔离;null = 未登录,不读写记忆(用首次默认值)。 */
  prefsScope: string | null;
  active: boolean;
  setSheetOpen(open: boolean): void;
  /** 隧道重连代次:断线时 Agent 列表 / 模型能力读失败,重连后在打开的表单上重读一次。 */
  connectionEpoch?: number;
}) {
  const { maker, prefsScope, active, setSheetOpen, connectionEpoch } = params;
  const [form, setForm] = useState<OrcaWorkerFormValue>(() => {
    const defaults = defaultOrcaWorkerCreationPrefs();
    return orcaWorkerFormFromPrefs(defaults, defaults.lastAgent);
  });
  const [customRoleMode, setCustomRoleMode] = useState(false);
  const [agents, setAgents] = useState<readonly OrcaWorkerAgentKind[]>(ALL_AGENTS);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelsByAgent, setModelsByAgent] = useState<Partial<Record<OrcaWorkerAgentKind, readonly MobileModelOption[]>>>({});
  const makerRef = useRef(maker);
  makerRef.current = maker;
  const formRef = useRef(form);
  formRef.current = form;
  const prefsRef = useRef<OrcaWorkerCreationPrefs>(defaultOrcaWorkerCreationPrefs());
  const prefsLoadedRef = useRef(false);
  /** 本次复位后用户是否动过表单:动过就不再让迟到的记忆 / 能力结果覆盖用户的选择。 */
  const touchedRef = useRef(false);
  /** 本次打开后用户是否明确选过 Agent(切 Agent / 选择器选模型 / 恢复草稿)。 */
  const agentChosenRef = useRef(false);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  // 两个代次各管一条不变量,互不推进:
  //  - formEpochRef:当前这次「打开表单」(复位 / 恢复草稿 / 换账号各开一次)。迟到的记忆
  //    只在同一次打开、且用户还没动过表单时补用;Agent 列表、能力这类非用户事件不推进它。
  //  - convergeGenRef:只让最近一次模型收敛请求的结果生效;用户手选模型也作废在途收敛。
  const formEpochRef = useRef(0);
  const convergeGenRef = useRef(0);

  const prefsScopeRef = useRef(prefsScope);
  prefsScopeRef.current = prefsScope;

  // 挂载 / 换账号时预读记忆,复位时即可同步恢复,不在用户操作期间异步覆盖表单。
  // 换账号时推进代次:上一个账号还在路上的读取 / 能力收敛一律作废,不写进新账号的表单。
  useEffect(() => {
    formEpochRef.current += 1;
    convergeGenRef.current += 1;
    prefsLoadedRef.current = false;
    prefsRef.current = defaultOrcaWorkerCreationPrefs();
    if (!prefsScope) {
      prefsLoadedRef.current = true;
      return undefined;
    }
    let cancelled = false;
    const scope = prefsScope;
    void readOrcaWorkerCreationPrefs(scope).then((prefs) => {
      if (cancelled) return;
      prefsRef.current = prefs;
      // 读取失败时仍按默认值展示,但不算「已读到」:复位时再读一次。
      prefsLoadedRef.current = hasLoadedOrcaWorkerCreationPrefs(scope);
    });
    return () => { cancelled = true; };
  }, [prefsScope]);


  /**
   * 按被控端能力收敛模型选择;能力读不到时保留原选择(提交时由被控端裁决)。
   * 只改模型字段,且只有最近一次请求的结果生效(期间又收敛 / 用户又改了模型则丢弃)。
   */
  const converge = useCallback((agent: OrcaWorkerAgentKind) => {
    const generation = ++convergeGenRef.current;
    const source = makerRef.current;
    source.getCapabilities(agent)
      .then((raw) => {
        const capabilities = normalizeMobileAgentCapabilities(raw);
        // 能力按 Agent 缓存,供老被控端(没有来源目录)时模型选择器的扁平回退列表使用。
        // 只缓存当前这台电脑的结果:换电脑后迟到的上一台响应不写入。
        if (capabilities && makerRef.current === source) {
          setModelsByAgent((current) => ({ ...current, [agent]: capabilities.availableModels }));
        }
        if (generation !== convergeGenRef.current) return;
        setForm((current) => (current.agent === agent
          ? { ...current, model: convergeOrcaWorkerModel(current.model, capabilities) }
          : current));
      })
      .catch(() => undefined);
  }, []);

  // 换了被控电脑(新建任务页切设备):上一台的 Agent 列表作废,回到乐观全集等这台的结果,
  // 不让复位按上一台的列表挑 Agent。
  const rosterMakerRef = useRef(maker);
  useEffect(() => {
    if (rosterMakerRef.current === maker) return;
    rosterMakerRef.current = maker;
    agentsRef.current = ALL_AGENTS;
    setAgents(ALL_AGENTS);
    setModelsByAgent({});
  }, [maker]);

  // 读被控端实际注册的 Agent。复位时列表可能还是乐观的三个:结果回来后,当前 Agent 不在这台
  // 电脑上就切到第一个可用 Agent 并带出它的模型记忆(不论用户是否改过其它字段——角色、任务、
  // 权限原样保留),避免表单停在一个必然提交失败的 Agent 上。当前 Agent 可用时也按能力再收敛
  // 一次模型:重连后重跑本 effect 时,断线期间没能完成的收敛在这里补上。
  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    makerRef.current.listAvailableAgents()
      .then((available) => {
        if (cancelled) return;
        const next = ALL_AGENTS.filter((agent) => available.includes(agent));
        if (next.length === 0) return;
        agentsRef.current = next;
        setAgents(next);
        // 目标 Agent:用户明确选过就尊重其选择;否则按记忆的上次 Agent(复位时可能因列表
        // 还是乐观 / 上一台电脑的而落在别的 Agent 上)。不在这台电脑上时取第一个可用。
        const current = formRef.current.agent;
        const remembered = prefsRef.current.lastAgent;
        const wanted = !agentChosenRef.current && next.includes(remembered) ? remembered : current;
        if (wanted === current && next.includes(current)) {
          converge(current);
          return;
        }
        const switched = next.includes(wanted) ? wanted : next[0]!;
        const agentPrefs = prefsRef.current.agents[switched];
        setForm((value) => ({
          ...value,
          agent: switched,
          model: { id: agentPrefs.model, providerId: null, effort: agentPrefs.effort, fast: agentPrefs.fast },
        }));
        converge(switched);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, connectionEpoch, converge, maker]);

  /** 重新打开已确认的表单(新建任务的协同草稿):角色模式跟随保存的角色,不沿用上次未提交的编辑。 */
  const restore = useCallback((value: OrcaWorkerFormValue) => {
    formEpochRef.current += 1;
    agentChosenRef.current = true;
    convergeGenRef.current += 1;
    touchedRef.current = true;
    setCustomRoleMode(!isPredefinedOrcaRole(value.role.trim().toLowerCase()));
    setForm(value);
  }, []);

  /** 恢复记忆(上次的 Agent 不在当前电脑上时取第一个可用 Agent)。初始任务不记忆。 */
  const reset = useCallback(() => {
    const epoch = ++formEpochRef.current;
    touchedRef.current = false;
    agentChosenRef.current = false;
    setCustomRoleMode(false);
    const apply = (prefs: OrcaWorkerCreationPrefs) => {
      const available = agentsRef.current;
      const agent = available.includes(prefs.lastAgent) ? prefs.lastAgent : available[0] ?? prefs.lastAgent;
      setForm(orcaWorkerFormFromPrefs(prefs, agent));
      converge(agent);
    };
    apply(prefsRef.current);
    // 预读尚未完成(极少见:刚登录就打开表单):读完后仅在用户还没动过这张表单时补一次。
    if (!prefsLoadedRef.current && prefsScope) {
      const scope = prefsScope;
      void readOrcaWorkerCreationPrefs(scope).then((prefs) => {
        if (prefsScopeRef.current !== scope) return;
        prefsRef.current = prefs;
        prefsLoadedRef.current = hasLoadedOrcaWorkerCreationPrefs(scope);
        if (epoch !== formEpochRef.current || touchedRef.current) return;
        apply(prefs);
      });
    }
  }, [converge, prefsScope]);

  /** 切 Agent:带出该 Agent 上次的模型 / 推理强度 / Fast(对齐桌面)。 */
  const changeAgent = useCallback((agent: OrcaWorkerAgentKind) => {
    touchedRef.current = true;
    agentChosenRef.current = true;
    const remembered = prefsRef.current.agents[agent];
    setForm((current) => ({
      ...current,
      agent,
      model: { id: remembered.model, providerId: null, effort: remembered.effort, fast: remembered.fast },
    }));
    converge(agent);
  }, [converge]);

  /** 提交成功后写回记忆(与桌面一样只在提交时记);读—合并—写由 rememberOrcaWorkerChoice 一处完成。 */
  const remember = useCallback((submitted: OrcaWorkerFormValue) => {
    prefsRef.current = mergeOrcaWorkerChoice(prefsRef.current, submitted);
    if (!prefsScope) return;
    const scope = prefsScope;
    void rememberOrcaWorkerChoice(scope, submitted).then((next) => {
      if (prefsScopeRef.current !== scope) return;
      prefsRef.current = next;
      prefsLoadedRef.current = hasLoadedOrcaWorkerCreationPrefs(scope);
    });
  }, [prefsScope]);

  const patch = useCallback((next: Partial<OrcaWorkerFormValue>) => {
    touchedRef.current = true;
    setForm((current) => ({ ...current, ...next }));
  }, []);

  const changePermission = useCallback(async (mode: OrcaWorkerPermissionMode) => {
    touchedRef.current = true;
    if (!await confirmFullAccessChange(form.permissionMode, mode)) return;
    setForm((current) => ({ ...current, permissionMode: mode }));
  }, [form.permissionMode]);

  const openPicker = useCallback(() => {
    setSheetOpen(false);
    setModelPickerOpen(true);
  }, [setSheetOpen]);
  const close = useCallback(() => setModelPickerOpen(false), []);
  const closed = useCallback(() => setSheetOpen(true), [setSheetOpen]);
  const select = useCallback(async (config: MobileModelConfiguration): Promise<boolean> => {
    if (!ALL_AGENTS.includes(config.agent as OrcaWorkerAgentKind)) return false;
    touchedRef.current = true;
    agentChosenRef.current = true;
    convergeGenRef.current += 1;
    setForm((current) => ({
      ...current,
      agent: config.agent as OrcaWorkerAgentKind,
      model: {
        id: config.modelId,
        providerId: config.providerId || null,
        effort: config.effort || null,
        fast: !!config.fast,
      },
    }));
    return true;
  }, []);

  const pickerAgents = useMemo<AgentKind[]>(() => [...agents], [agents]);

  /**
   * 老被控端没有 `maker:provider:list` 时,模型选择器走扁平列表:用当前 Agent 的能力模型,
   * 选中后按「不指定来源」写回表单(提交前再按实际来源对账 effort / Fast)。
   */
  const flatModelOptions = modelsByAgent[form.agent] ?? EMPTY_MODEL_OPTIONS;
  const selectFlatModel = useCallback((option: MobileModelOption) => {
    setModelPickerOpen(false);
    void select({
      agent: formRef.current.agent,
      modelId: option.id,
      providerId: '',
      effort: option.defaultEffort ?? '',
      fast: false,
    });
  }, [select]);

  return {
    form,
    restore,
    customRoleMode,
    setCustomRoleMode,
    patch,
    changeAgent,
    changePermission,
    agents,
    pickerAgents,
    valid: canSubmitOrcaWorkerForm(form, customRoleMode),
    reset,
    remember,
    modelPicker: { open: modelPickerOpen, openPicker, close, closed, select, flatModelOptions, selectFlatModel },
  };
}

export function useSessionOrcaCollab(params: {
  maker: MobileMakerTransport;
  deviceId: string | null;
  sessionId: string;
  session: RemoteSession | null;
  /** Worker 创建偏好的记忆范围(按区域限定的账号键 accountKey);null = 不记忆。 */
  prefsScope: string | null;
  /** 隧道重连代次(会话页的 connectionEpoch):重连后补拉团队与 Worker 所属 Lead。 */
  connectionEpoch?: number;
  /** 提交时读被控端来源目录(未就绪 = null),用于收窄已失效的显式来源。 */
  getProviders?: () => readonly ProviderView[] | null;
  /** 共享任务访客 / 宿主托管任务不提供协同编排(不拉团队、不挂入口)。 */
  enabled: boolean;
  /** + 面板当前是否展示协同视图。 */
  sheetView: CollabSheetView | null;
  sheetOpen: boolean;
  setSheetView(view: 'main' | CollabSheetView): void;
  setSheetOpen(open: boolean): void;
  openSession(sessionId: string): void;
}) {
  const { maker, deviceId, sessionId, session, prefsScope, connectionEpoch, getProviders, enabled, sheetView, sheetOpen, setSheetView, setSheetOpen, openSession } = params;
  const role = enabled ? session?.orcaRole ?? null : null;
  const isLead = role === 'lead';
  const isWorker = role === 'worker';
  const eligible = enabled && (isLead || isOrcaCollabEligible(session));
  const team = useOrcaTeam({ maker, deviceId, leadSessionId: isLead ? sessionId : null, connectionEpoch });
  const workerLeadSessionId = useOrcaWorkerLeadSessionId({
    maker,
    workerSessionId: isWorker ? sessionId : null,
    connectionEpoch,
  });
  // Worker 任务自己在团队里的记录(焦点 / workerId),供详情菜单的 Worker 操作使用。
  const workerTeam = useOrcaTeam({
    maker,
    deviceId,
    leadSessionId: isWorker ? workerLeadSessionId : null,
    connectionEpoch,
  });
  const workerSelf = isWorker
    ? workerTeam.workers.find((worker) => worker.sessionId === sessionId) ?? null
    : null;
  const workerForm = useOrcaWorkerForm({
    maker,
    prefsScope,
    active: sheetOpen && sheetView !== null,
    setSheetOpen,
    connectionEpoch,
  });

  const [entryStatus, setEntryStatus] = useState<OrcaCollabEntryStatus>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const makerRef = useRef(maker);
  makerRef.current = maker;
  const sessionRef = useRef(session);
  sessionRef.current = session;

  // 换任务:错误与入口状态都属于上一个任务,整体复位。
  useEffect(() => {
    setEntryStatus('loading');
    setError(null);
    setBusy(false);
  }, [sessionId, deviceId]);

  // 打开 + 面板时读一次入口状态(能力 + 协同插件开关);Lead 只需确认能力。
  // 重连后重读:断线时读失败会落成「不可用」,不能让已打开的表单一直卡住。
  useEffect(() => {
    const current = sessionRef.current;
    if (!sheetOpen || !eligible || !current) return undefined;
    let cancelled = false;
    setEntryStatus('loading');
    void readOrcaCollabEntryStatus(makerRef.current, current, orcaAgentKindForSession(current))
      .then((status) => { if (!cancelled) setEntryStatus(status); });
    return () => { cancelled = true; };
  }, [sheetOpen, eligible, sessionId, role, connectionEpoch]);

  // 协同视图展示中时顺带刷新一次团队(推送之外的兜底)。
  const refreshTeam = team.refresh;
  useEffect(() => {
    if (sheetOpen && sheetView === 'collab' && isLead) void refreshTeam();
  }, [sheetOpen, sheetView, isLead, refreshTeam]);

  const resetWorkerForm = workerForm.reset;
  const rememberWorkerForm = workerForm.remember;
  /** + 面板主视图的「协同模式」行:Lead 进团队面板,其它进开启表单。 */
  const openFromMain = useCallback(() => {
    setError(null);
    if (!isLead) resetWorkerForm();
    setSheetView('collab');
  }, [isLead, resetWorkerForm, setSheetView]);

  const openCreateWorker = useCallback(() => {
    setError(null);
    resetWorkerForm();
    setSheetView('collab-create');
  }, [resetWorkerForm, setSheetView]);

  const form = workerForm.form;
  const formValid = workerForm.valid;
  const getProvidersRef = useRef(getProviders);
  getProvidersRef.current = getProviders;

  const submitEnable = useCallback(async () => {
    if (!deviceId || !formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = narrowOrcaWorkerProvider(form, getProvidersRef.current?.() ?? null);
      await enableOrcaTeam(makerRef.current, sessionId, buildOrcaEnableOptions(submitted, submitted.initialTask));
      rememberWorkerForm(submitted);
      remoteSessionStore.applySessionPatch(deviceId, sessionId, { orcaRole: 'lead' });
      setSheetView('collab');
      void refreshTeam();
    } catch (err) {
      setError(describeOrcaError(err, 'session.collab.errors.startFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, deviceId, form, formValid, refreshTeam, rememberWorkerForm, sessionId, setSheetView]);

  const submitCreate = useCallback(async () => {
    if (!formValid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = narrowOrcaWorkerProvider(form, getProvidersRef.current?.() ?? null);
      await createOrcaWorker(makerRef.current, sessionId, submitted, team.workers);
      rememberWorkerForm(submitted);
      setSheetView('collab');
      void refreshTeam();
    } catch (err) {
      setError(describeOrcaError(err, 'session.collab.errors.createFailed'));
    } finally {
      setBusy(false);
    }
  }, [busy, form, formValid, refreshTeam, rememberWorkerForm, sessionId, setSheetView, team.workers]);

  const runTeamAction = useCallback(async (action: () => Promise<unknown>, fallbackKey: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      void refreshTeam();
      return true;
    } catch (err) {
      // 超时不当作失败:主机可能仍在执行(结束协同会逐个关闭 Worker)。只读回查团队,提示以列表为准。
      setError(describeOrcaError(
        isOrcaAmbiguousTimeout(err) ? new Error('[ORCA_ACTION_UNCONFIRMED] timed out') : err,
        fallbackKey,
      ));
      void refreshTeam();
      return false;
    } finally {
      setBusy(false);
    }
  }, [refreshTeam]);

  const openWorker = useCallback((worker: OrcaTeamWorker) => {
    setSheetOpen(false);
    // 看到「已完成」即确认(对齐桌面:可见的 done Worker 自动 acknowledge);状态已变则忽略。
    if (worker.status === 'done') {
      void makerRef.current.orca.acknowledgeDone(sessionId, worker.workerId).catch(() => undefined);
    }
    openSession(worker.sessionId);
  }, [openSession, sessionId, setSheetOpen]);

  const confirmArchive = useCallback((worker: OrcaTeamWorker) => {
    Alert.alert(
      i18n.t('session.collab.archiveConfirmTitle', { name: orcaWorkerDisplayName(worker) }),
      i18n.t('session.collab.archiveConfirmDesc'),
      [
        { text: i18n.t('session.collab.cancel'), style: 'cancel' },
        {
          text: i18n.t('session.collab.archiveConfirm'),
          style: 'destructive',
          onPress: () => {
            void runTeamAction(
              () => makerRef.current.orca.archiveWorker(sessionId, worker.workerId),
              'session.collab.errors.archiveFailed',
            );
          },
        },
      ],
    );
  }, [runTeamAction, sessionId]);

  /**
   * 长按 Worker 行:管理操作(点按直接打开 Worker,不弹窗)。手机上只提供归档;「焦点」只决定
   * 电脑端协同面板展开哪个 Worker,手机上不提供切换。
   */
  const showWorkerActions = useCallback((worker: OrcaTeamWorker) => {
    Alert.alert(orcaWorkerDisplayName(worker), orcaWorkerStatusLabel(worker.status), [
      {
        text: i18n.t('session.collab.archive'),
        style: 'destructive',
        onPress: () => confirmArchive(worker),
      },
      { text: i18n.t('session.collab.cancel'), style: 'cancel' },
    ]);
  }, [confirmArchive]);

  const confirmEndTeam = useCallback(() => {
    Alert.alert(
      i18n.t('session.collab.stopConfirmTitle'),
      i18n.t('session.collab.stopConfirmDesc'),
      [
        { text: i18n.t('session.collab.cancel'), style: 'cancel' },
        {
          text: i18n.t('session.collab.stop'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const ok = await runTeamAction(
                () => makerRef.current.orca.disable(sessionId),
                'session.collab.errors.stopFailed',
              );
              if (!ok || !deviceId) return;
              remoteSessionStore.applySessionPatch(deviceId, sessionId, { orcaRole: null });
              setSheetView('main');
              setSheetOpen(false);
            })();
          },
        },
      ],
    );
  }, [deviceId, runTeamAction, sessionId, setSheetOpen, setSheetView]);

  const openLead = useCallback(() => {
    if (workerLeadSessionId) openSession(workerLeadSessionId);
  }, [openSession, workerLeadSessionId]);

  // ─── Worker 任务自身的操作(详情菜单) ─────────────────────────────────────
  const refreshWorkerTeam = workerTeam.refresh;

  /** 归档自身:确认弹窗在调用方的面板上直接弹出;用户确认后先调 onConfirmed(如收起详情面板)再归档。 */
  const confirmArchiveSelf = useCallback((onConfirmed?: () => void) => {
    if (!workerLeadSessionId || !workerSelf) return;
    const leadId = workerLeadSessionId;
    const worker = workerSelf;
    Alert.alert(
      i18n.t('session.collab.archiveConfirmTitle', { name: orcaWorkerDisplayName(worker) }),
      i18n.t('session.collab.archiveConfirmDesc'),
      [
        { text: i18n.t('session.collab.cancel'), style: 'cancel' },
        {
          text: i18n.t('session.collab.archiveConfirm'),
          style: 'destructive',
          onPress: () => {
            onConfirmed?.();
            void (async () => {
              try {
                await makerRef.current.orca.archiveWorker(leadId, worker.workerId);
                // 归档后这个 Worker 任务不再可用,回到 Lead。
                openSession(leadId);
              } catch (err) {
                if (isOrcaAmbiguousTimeout(err)) {
                  // 超时不是权威失败:只读回查一次,Worker 已不在团队里就说明归档已生效,照样回到 Lead。
                  const archived = await makerRef.current.orca.listWorkers(leadId)
                    .then((raw) => !parseOrcaTeamWorkers(raw).some((item) => item.workerId === worker.workerId))
                    .catch(() => false);
                  if (archived) {
                    openSession(leadId);
                    return;
                  }
                }
                Alert.alert(describeOrcaError(
                  isOrcaAmbiguousTimeout(err) ? new Error('[ORCA_ACTION_UNCONFIRMED] timed out') : err,
                  'session.collab.errors.archiveFailed',
                ));
                void refreshWorkerTeam();
              }
            })();
          },
        },
      ],
    );
  }, [openSession, refreshWorkerTeam, workerLeadSessionId, workerSelf]);

  return {
    eligible,
    isLead,
    isWorker,
    entryHint: isLead ? null : orcaCollabEntryHint(entryStatus),
    entryBlocked: !isLead && entryStatus !== 'ready',
    team,
    workerLeadSessionId,
    openLead,
    /** Worker 任务自身在团队里的记录;查不到(老被控端 / 读取中)为 null,Worker 操作不出现。 */
    workerSelf,
    refreshWorkerSelf: refreshWorkerTeam,
    confirmArchiveSelf,
    workerForm,
    busy,
    error,
    canSubmit: workerForm.valid && !busy,
    openFromMain,
    openCreateWorker,
    submitEnable,
    submitCreate,
    openWorker,
    showWorkerActions,
    confirmEndTeam,
  };
}
