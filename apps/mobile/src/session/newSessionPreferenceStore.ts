import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  normalizeNewSessionAgentKind,
  type NewSessionAgentKind,
  type NewSessionDeviceOption,
  type NewSessionStoredPreferences,
  type NewSessionWorkspaceKind,
} from '@/session/newSession';

const STORAGE_KEY = 'xdt-maker.mobile.new-session.preferences.v1';

export interface NewSessionPreferencePatch {
  agentKind?: NewSessionAgentKind;
  device?: NewSessionDeviceOption;
  workspaceKind?: NewSessionWorkspaceKind;
  /** 记住某 agent 在新建页选的权限档(单键合并进 permissionModeByAgent;'plan' 被忽略)。 */
  permissionModeForAgent?: { agentKind: NewSessionAgentKind; mode: string };
}

export async function readNewSessionPreferences(): Promise<NewSessionStoredPreferences> {
  // 刚选完就重新打开新建页时，也要看到已提交但尚未落盘的选择。
  await writeChain;
  return loadNewSessionPreferences();
}

async function loadNewSessionPreferences(): Promise<NewSessionStoredPreferences> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  if (!raw) return emptyPreferences();
  try {
    return normalizeStoredPreferences(JSON.parse(raw));
  } catch {
    return emptyPreferences();
  }
}

// 与首页偏好存储一致：连续选择不同字段时，读改写必须按操作顺序执行。
let writeChain: Promise<void> = Promise.resolve();

export function saveNewSessionPreferences(patch: NewSessionPreferencePatch): Promise<void> {
  const next = writeChain.then(() => writeNewSessionPreferences(patch));
  writeChain = next.catch(() => undefined);
  return next;
}

async function writeNewSessionPreferences(patch: NewSessionPreferencePatch): Promise<void> {
  const current = await loadNewSessionPreferences();
  const permissionPatch = patch.permissionModeForAgent;
  const next: NewSessionStoredPreferences = {
    agentKind: patch.agentKind ?? current.agentKind,
    workspaceKind: patch.workspaceKind ?? current.workspaceKind,
    device: patch.device
      ? normalizeDeviceOption(patch.device)
      : current.device,
    permissionModeByAgent:
      permissionPatch && isRememberablePermissionMode(permissionPatch.mode)
        ? { ...current.permissionModeByAgent, [permissionPatch.agentKind]: permissionPatch.mode }
        : current.permissionModeByAgent,
  };
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(serializePreferences(next))).catch(() => undefined);
}

export function clearNewSessionPreferences(): Promise<void> {
  const next = writeChain.then(() => AsyncStorage.removeItem(STORAGE_KEY));
  writeChain = next.catch(() => undefined);
  return writeChain;
}

function emptyPreferences(): NewSessionStoredPreferences {
  return {
    agentKind: null,
    workspaceKind: null,
    device: null,
    permissionModeByAgent: {},
  };
}

// 'plan' 是计划模式的实现细节(老被控端兼容路径),不是用户可记忆的权限档。
function isRememberablePermissionMode(mode: string): boolean {
  return mode.trim().length > 0 && mode !== 'plan';
}

function normalizePermissionModeByAgent(value: unknown): Partial<Record<NewSessionAgentKind, string>> {
  const record = readRecord(value);
  if (!record) return {};
  const out: Partial<Record<NewSessionAgentKind, string>> = {};
  for (const agent of ['claude-code', 'codex', 'pi'] as const) {
    const mode = readString(record[agent]);
    if (mode && isRememberablePermissionMode(mode)) {
      out[agent] = mode;
    }
  }
  return out;
}

function normalizeStoredPreferences(value: unknown): NewSessionStoredPreferences {
  const record = readRecord(value);
  if (!record) return emptyPreferences();
  const deviceId = readString(record.deviceId);
  const deviceName = readString(record.deviceName);
  return {
    agentKind: normalizeNewSessionAgentKind(record.agentKind),
    workspaceKind: record.workspaceKind === 'project' || record.workspaceKind === 'dialogue'
      ? record.workspaceKind
      : null,
    device: deviceId
      ? { deviceId, name: deviceName || deviceId }
      : null,
    permissionModeByAgent: normalizePermissionModeByAgent(record.permissionModeByAgent),
  };
}

function normalizeDeviceOption(option: NewSessionDeviceOption): NewSessionDeviceOption | null {
  const deviceId = option.deviceId.trim();
  if (!deviceId) return null;
  return {
    deviceId,
    name: option.name.trim() || deviceId,
  };
}

function serializePreferences(
  preferences: NewSessionStoredPreferences,
): Record<string, string | Record<string, string>> {
  const permissionEntries = Object.entries(preferences.permissionModeByAgent).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return {
    ...(preferences.agentKind ? { agentKind: preferences.agentKind } : {}),
    ...(preferences.workspaceKind ? { workspaceKind: preferences.workspaceKind } : {}),
    ...(preferences.device
      ? {
          deviceId: preferences.device.deviceId,
          deviceName: preferences.device.name,
        }
      : {}),
    ...(permissionEntries.length > 0
      ? { permissionModeByAgent: Object.fromEntries(permissionEntries) }
      : {}),
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export const __testing = {
  storageKey: STORAGE_KEY,
};
