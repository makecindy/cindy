/**
 * 「创建 Worker」偏好记忆(与桌面 renderer workerCreationPrefs 同一套规则):
 *  - 记住上次选的 Agent,以及每个 Agent 各自的模型 / 推理强度 / Fast;
 *  - 记住 Worker 权限;初始任务不记(避免把旧任务带到下一次创建);
 *  - 没有记忆时用共享首次默认值(Codex `codex/gpt-5.5`、high、完全访问)。
 *
 * 与桌面控制端一样存在发起创建的这一端(手机本地,按登录账号隔离),不读写被控端的偏好。
 * 手动提交的完整模型选择按任务所在电脑隔离，远程模型不覆盖旧版逐 Agent 记忆。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_ORCA_WORKER_AGENT,
  DEFAULT_ORCA_WORKER_EFFORT,
  DEFAULT_ORCA_WORKER_MODELS,
  DEFAULT_ORCA_WORKER_PERMISSION_MODE,
  parseOrcaPermissionMode,
  type OrcaWorkerAgentKind,
  type OrcaWorkerPermissionMode,
} from '@cindy/maker-shared/orca-team';

const STORAGE_KEY_PREFIX = 'cindy:orcaWorkerCreationPrefs:v1';
const AGENTS: readonly OrcaWorkerAgentKind[] = ['codex', 'claude-code', 'pi'];

export interface OrcaWorkerAgentPrefs {
  model: string;
  effort: string;
  fast: boolean | 'ultrafast';
}

export interface OrcaWorkerModelSelection {
  agent: OrcaWorkerAgentKind;
  agentDeviceId: string | null;
  model: { id: string; providerId: string | null; effort: string | null; fast: boolean | 'ultrafast' };
}

export interface OrcaWorkerCreationPrefs {
  modelSelectionByHost?: Record<string, OrcaWorkerModelSelection>;
  lastAgent: OrcaWorkerAgentKind;
  agents: Record<OrcaWorkerAgentKind, OrcaWorkerAgentPrefs>;
  workerPermissionMode: OrcaWorkerPermissionMode;
}

export function defaultOrcaWorkerCreationPrefs(): OrcaWorkerCreationPrefs {
  return {
    lastAgent: DEFAULT_ORCA_WORKER_AGENT,
    agents: {
      codex: { model: DEFAULT_ORCA_WORKER_MODELS.codex, effort: DEFAULT_ORCA_WORKER_EFFORT, fast: false },
      'claude-code': { model: DEFAULT_ORCA_WORKER_MODELS['claude-code'], effort: DEFAULT_ORCA_WORKER_EFFORT, fast: false },
      pi: { model: DEFAULT_ORCA_WORKER_MODELS.pi, effort: DEFAULT_ORCA_WORKER_EFFORT, fast: false },
    },
    workerPermissionMode: DEFAULT_ORCA_WORKER_PERMISSION_MODE,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 损坏 / 缺字段的记忆逐项回落首次默认值,不整体丢弃。 */
export function sanitizeOrcaWorkerCreationPrefs(value: unknown): OrcaWorkerCreationPrefs {
  const defaults = defaultOrcaWorkerCreationPrefs();
  const raw = record(value);
  if (!raw) return defaults;
  const agents = record(raw.agents);
  const agentPrefs = (agent: OrcaWorkerAgentKind): OrcaWorkerAgentPrefs => {
    const item = record(agents?.[agent]);
    const fallback = defaults.agents[agent];
    return {
      model: typeof item?.model === 'string' && item.model.trim() ? item.model.trim() : fallback.model,
      effort: typeof item?.effort === 'string' && item.effort.trim() ? item.effort.trim() : fallback.effort,
      fast: (item?.fast === 'ultrafast' ? 'ultrafast' : item?.fast === true),
    };
  };
  const selections = record(raw.modelSelectionByHost);
  const modelSelectionByHost = Object.fromEntries(Object.entries(selections ?? {}).flatMap(([host, value]) => {
    const item = record(value);
    const model = record(item?.model);
    if (!item || !model || !AGENTS.includes(item.agent as OrcaWorkerAgentKind)
      || (item.agentDeviceId !== null && (typeof item.agentDeviceId !== 'string' || !item.agentDeviceId.trim()))
      || typeof model.id !== 'string' || !model.id.trim()
      || (model.providerId !== null && (typeof model.providerId !== 'string' || !model.providerId.trim()))
      || (model.effort !== null && typeof model.effort !== 'string')) return [];
    return [[host, { agent: item.agent as OrcaWorkerAgentKind, agentDeviceId: item.agentDeviceId,
      model: { id: model.id, providerId: model.providerId, effort: model.effort, fast: (model.fast === 'ultrafast' ? 'ultrafast' : model.fast === true) } }]];
  })) as Record<string, OrcaWorkerModelSelection>;
  return {
    ...(selections ? { modelSelectionByHost } : {}),
    lastAgent: AGENTS.includes(raw.lastAgent as OrcaWorkerAgentKind)
      ? raw.lastAgent as OrcaWorkerAgentKind
      : defaults.lastAgent,
    agents: { codex: agentPrefs('codex'), 'claude-code': agentPrefs('claude-code'), pi: agentPrefs('pi') },
    workerPermissionMode: parseOrcaPermissionMode(raw.workerPermissionMode) ?? defaults.workerPermissionMode,
  };
}

const memory = new Map<string, OrcaWorkerCreationPrefs>();

function storageKey(scope: string): string {
  return `${STORAGE_KEY_PREFIX}:${scope}`;
}

export async function readOrcaWorkerCreationPrefs(scope: string): Promise<OrcaWorkerCreationPrefs> {
  const cached = memory.get(scope);
  if (cached) return cached;
  let readFailed = false;
  const raw = await AsyncStorage.getItem(storageKey(scope)).catch(() => {
    readFailed = true;
    return null;
  });
  let prefs = defaultOrcaWorkerCreationPrefs();
  if (raw) {
    try {
      prefs = sanitizeOrcaWorkerCreationPrefs(JSON.parse(raw));
    } catch {
      // 损坏的记忆按首次默认值处理。
    }
  }
  // 读取期间用户已提交并写回了新选择:以刚保存的为准,不让这次迟到的旧值覆盖。
  const saved = memory.get(scope);
  if (saved) return saved;
  // 读取失败 ≠ 没有记忆:这次先用默认值,但不缓存,下次打开再读,不把默认值当成已读到的记忆。
  if (readFailed) return prefs;
  memory.set(scope, prefs);
  return prefs;
}

/** 这个账号的记忆是否已确实读到(或本次会话写过);读取失败时为 false,下次打开再读。 */
export function hasLoadedOrcaWorkerCreationPrefs(scope: string): boolean {
  return memory.has(scope);
}

/** 创建成功(或新建任务确认协同草稿)后写回:与桌面一样只在提交时记忆。 */
export function saveOrcaWorkerCreationPrefs(scope: string, prefs: OrcaWorkerCreationPrefs): void {
  memory.set(scope, prefs);
  void AsyncStorage.setItem(storageKey(scope), JSON.stringify(prefs)).catch(() => undefined);
}

/** 一次提交里需要记住的部分(Agent、该 Agent 的模型 / 推理强度 / Fast、权限;初始任务不记)。 */
export interface OrcaWorkerSubmittedChoice {
  agent: OrcaWorkerAgentKind;
  permissionMode: OrcaWorkerPermissionMode;
  /** 普通任务的提交可更新该 host 的完整路线；SSH / 运行设备不传。 */
  taskHostDeviceId?: string;
  /** null = 本次提交改用逐 Agent 默认，删除该 host 的旧完整路线；缺省 = 不改。 */
  selection?: OrcaWorkerModelSelection | null;
  model: { id: string; effort: string | null; fast: boolean | 'ultrafast' } | null;
}

/** 把一次提交合并进已有记忆(纯函数)。 */
export function mergeOrcaWorkerChoice(
  previous: OrcaWorkerCreationPrefs,
  submitted: OrcaWorkerSubmittedChoice,
): OrcaWorkerCreationPrefs {
  let modelSelectionByHost = previous.modelSelectionByHost;
  if (submitted.taskHostDeviceId && submitted.selection !== undefined) {
    modelSelectionByHost = { ...modelSelectionByHost };
    if (submitted.selection) modelSelectionByHost[submitted.taskHostDeviceId] = submitted.selection;
    else delete modelSelectionByHost[submitted.taskHostDeviceId];
  }
  return {
    ...previous,
    ...(modelSelectionByHost ? { modelSelectionByHost } : {}),
    lastAgent: submitted.agent,
    workerPermissionMode: submitted.permissionMode,
    agents: submitted.model
      ? {
        ...previous.agents,
        [submitted.agent]: {
          model: submitted.model.id,
          effort: submitted.model.effort ?? previous.agents[submitted.agent].effort,
          fast: submitted.model.fast,
        },
      }
      : previous.agents,
  };
}

/**
 * 记住一次提交:先读到这个账号的记忆(已在内存就直接用),再合并写回。读—合并—写在一处完成,
 * 不依赖调用方的预读是否已经完成。存储读取失败时不写回,避免用默认值拼出的整份记忆覆盖
 * 用户原先存的其它选择。
 */
export async function rememberOrcaWorkerChoice(
  scope: string,
  submitted: OrcaWorkerSubmittedChoice,
): Promise<OrcaWorkerCreationPrefs> {
  const previous = await readOrcaWorkerCreationPrefs(scope);
  const next = mergeOrcaWorkerChoice(previous, submitted);
  if (hasLoadedOrcaWorkerCreationPrefs(scope)) saveOrcaWorkerCreationPrefs(scope, next);
  return next;
}

/** 测试用:清空内存缓存。 */
export function resetOrcaWorkerCreationPrefsMemory(): void {
  memory.clear();
}
