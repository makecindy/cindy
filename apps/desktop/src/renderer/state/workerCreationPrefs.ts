import type { Effort } from '@/lib/userPreferences.types';
import {
  DEFAULT_ORCA_WORKER_AGENT,
  DEFAULT_ORCA_WORKER_EFFORT,
  DEFAULT_ORCA_WORKER_MODELS,
} from '@cindy/maker-shared/orca-team';

import {
  DEFAULT_ORCA_WORKER_PERMISSION_MODE,
  resolveOrcaWorkerPermissionMode,
  type OrcaWorkerPermissionMode,
} from '../../shared/orca-worker-permission-mode';

const STORAGE_KEY = 'workerCreationPrefs';
const CHANGE_EVENT = 'cindy:worker-creation-prefs-changed';

export type WorkerAgentKind = 'codex' | 'claude-code' | 'pi';

export interface WorkerAgentPrefs {
  model: string;
  effort: Effort;
  fast: boolean;
  /** 上次显式选定的模型来源；null = 未显式选择，跟随默认路由解析。 */
  providerId: string | null;
}

export interface WorkerCreationPrefs {
  lastAgent: WorkerAgentKind;
  codex: WorkerAgentPrefs;
  'claude-code': WorkerAgentPrefs;
  pi: WorkerAgentPrefs;
  /** 新 Worker 的默认权限；UI 与 Orca tool 共用。 */
  workerPermissionMode: OrcaWorkerPermissionMode;
}

// 首次默认值与手机端共用(@cindy/maker-shared/orca-team),两端「创建 Worker」同一套规则。
export const DEFAULT_WORKER_CREATION_PREFS: WorkerCreationPrefs = {
  lastAgent: DEFAULT_ORCA_WORKER_AGENT,
  codex: { model: DEFAULT_ORCA_WORKER_MODELS.codex, effort: DEFAULT_ORCA_WORKER_EFFORT as Effort, fast: false, providerId: null },
  'claude-code': { model: DEFAULT_ORCA_WORKER_MODELS['claude-code'], effort: DEFAULT_ORCA_WORKER_EFFORT as Effort, fast: false, providerId: null },
  pi: { model: DEFAULT_ORCA_WORKER_MODELS.pi, effort: DEFAULT_ORCA_WORKER_EFFORT as Effort, fast: false, providerId: null },
  workerPermissionMode: DEFAULT_ORCA_WORKER_PERMISSION_MODE,
};

function defaultPrefs(): WorkerCreationPrefs {
  return {
    ...DEFAULT_WORKER_CREATION_PREFS,
    codex: { ...DEFAULT_WORKER_CREATION_PREFS.codex },
    'claude-code': { ...DEFAULT_WORKER_CREATION_PREFS['claude-code'] },
    pi: { ...DEFAULT_WORKER_CREATION_PREFS.pi },
  };
}

export function readWorkerCreationPrefs(): WorkerCreationPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<WorkerCreationPrefs>;
    const agentPrefs = (agent: WorkerAgentKind): WorkerAgentPrefs => {
      const fallback = DEFAULT_WORKER_CREATION_PREFS[agent];
      const value = parsed[agent];
      return {
        ...fallback,
        ...(value ?? {}),
        fast: value?.fast === true,
        providerId:
          typeof value?.providerId === 'string' && value.providerId.trim()
            ? value.providerId.trim()
            : null,
      };
    };
    return {
      lastAgent:
        parsed.lastAgent === 'claude-code'
          ? 'claude-code'
          : parsed.lastAgent === 'pi'
            ? 'pi'
            : 'codex',
      codex: agentPrefs('codex'),
      'claude-code': agentPrefs('claude-code'),
      pi: agentPrefs('pi'),
      workerPermissionMode: resolveOrcaWorkerPermissionMode(parsed.workerPermissionMode),
    };
  } catch {
    return defaultPrefs();
  }
}

export function writeWorkerCreationPrefs(prefs: WorkerCreationPrefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    window.dispatchEvent(new Event(CHANGE_EVENT));
  } catch {
    // localStorage 在受限上下文中可能不可用；偏好保存是 best-effort。
  }
}

export function setWorkerPermissionModePreference(mode: OrcaWorkerPermissionMode): void {
  const prefs = readWorkerCreationPrefs();
  if (prefs.workerPermissionMode === mode) return;
  writeWorkerCreationPrefs({ ...prefs, workerPermissionMode: mode });
}

export function subscribeWorkerCreationPrefs(listener: () => void): () => void {
  const onCustomChange = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener(CHANGE_EVENT, onCustomChange);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustomChange);
    window.removeEventListener('storage', onStorage);
  };
}
