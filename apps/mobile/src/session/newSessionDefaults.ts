/**
 * 新建任务的默认电脑与默认工作区（Android「新建任务默认」弹窗）。
 *
 * 两层：应用内新建、桌面小组件新建各一份档案；每份档案里的电脑 / 工作区分别可选
 * 「跟随上次」「跟随应用内默认」（仅组件档案）或一个具体值。显式默认优先，未设置时
 * 完全沿用新建页原有的「记住上次选择」逻辑（`pickNewSessionDefaultDevice` /
 * `pickInitialNewSessionWorkspace`）。
 *
 * 纯函数、不读 React / 存储，便于单测。持久化见 `newSessionDefaultsStore.ts`，
 * 页面接线见 `app/sessions/new.tsx`。
 */
import {
  pickNewSessionDefaultDevice,
  type NewSessionDeviceOption,
  type NewSessionWorkspaceKind,
  type RecentWorkspaceOption,
} from './newSession';
import type { NewSessionOrigin } from './newSessionOrigin';

export type NewSessionDefaultProfileKey = 'app' | 'widget';

export const newSessionDefaultProfileForOrigin = (origin: NewSessionOrigin): NewSessionDefaultProfileKey =>
  origin === 'widget' ? 'widget' : 'app';

export type NewSessionDefaultDevice =
  | { kind: 'follow-app' }
  | { kind: 'follow-last' }
  | { kind: 'device'; deviceId: string; name: string };

export type NewSessionDefaultWorkspace =
  | { kind: 'follow-app' }
  | { kind: 'follow-last' }
  | { kind: 'dialogue' }
  | { kind: 'project'; deviceId: string; workingDir: string };

export interface NewSessionDefaultProfile {
  device: NewSessionDefaultDevice;
  workspace: NewSessionDefaultWorkspace;
}

export interface NewSessionDefaults {
  app: NewSessionDefaultProfile;
  widget: NewSessionDefaultProfile;
}

/** 未配置时的初始值：应用内沿用原来的「记住上次」，组件跟随应用内。 */
export function createDefaultNewSessionDefaults(): NewSessionDefaults {
  return {
    app: {
      device: { kind: 'follow-last' },
      workspace: { kind: 'follow-last' },
    },
    widget: {
      device: { kind: 'follow-app' },
      workspace: { kind: 'follow-app' },
    },
  };
}

export const DEFAULT_NEW_SESSION_DEFAULTS: NewSessionDefaults = createDefaultNewSessionDefaults();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeDevice(
  value: unknown,
  fallback: NewSessionDefaultDevice,
  allowFollowApp: boolean,
): NewSessionDefaultDevice {
  if (!isRecord(value)) return fallback;
  if (value.kind === 'follow-last') return { kind: 'follow-last' };
  if (value.kind === 'follow-app' && allowFollowApp) return { kind: 'follow-app' };
  if (value.kind === 'device') {
    const deviceId = readString(value.deviceId).trim();
    if (deviceId) {
      return { kind: 'device', deviceId, name: readString(value.name).trim() || deviceId };
    }
  }
  return fallback;
}

function normalizeWorkspace(
  value: unknown,
  fallback: NewSessionDefaultWorkspace,
  allowFollowApp: boolean,
): NewSessionDefaultWorkspace {
  if (!isRecord(value)) return fallback;
  if (value.kind === 'follow-last') return { kind: 'follow-last' };
  if (value.kind === 'follow-app' && allowFollowApp) return { kind: 'follow-app' };
  if (value.kind === 'dialogue') return { kind: 'dialogue' };
  if (value.kind === 'project') {
    const deviceId = readString(value.deviceId).trim();
    // 目录原样保留（首尾空格可能是路径的一部分），只用 trim 判空。
    const workingDir = readString(value.workingDir);
    if (deviceId && workingDir.trim()) return { kind: 'project', deviceId, workingDir };
  }
  return fallback;
}

/** 存储 / 旧数据归一：组件档案允许 follow-app，应用内档案不允许。 */
export function normalizeNewSessionDefaults(value: unknown): NewSessionDefaults {
  const fallback = createDefaultNewSessionDefaults();
  if (!isRecord(value)) return fallback;
  const app = isRecord(value.app) ? value.app : {};
  const widget = isRecord(value.widget) ? value.widget : {};
  return {
    app: {
      device: normalizeDevice(app.device, fallback.app.device, false),
      workspace: normalizeWorkspace(app.workspace, fallback.app.workspace, false),
    },
    widget: {
      device: normalizeDevice(widget.device, fallback.widget.device, true),
      workspace: normalizeWorkspace(widget.workspace, fallback.widget.workspace, true),
    },
  };
}

export interface ResolvedNewSessionDefaultDevice {
  device: NewSessionDeviceOption | null;
  source: 'entry' | 'default' | 'last';
  /** 配置了默认电脑、这次用不了时带出，供新建页显示一行说明；不改写已保存的默认。 */
  unavailable: { deviceId: string; name: string } | null;
}

export interface NewSessionDefaultDeviceInput {
  defaults: NewSessionDefaults;
  profile: NewSessionDefaultProfileKey;
  deviceOptions: readonly NewSessionDeviceOption[];
  rememberedDeviceId?: string | null;
  routeDevice?: NewSessionDeviceOption | null;
  routeDeviceExplicit: boolean;
}

function findUsableDevice(
  deviceOptions: readonly NewSessionDeviceOption[],
  deviceId: string,
): NewSessionDeviceOption | null {
  return deviceOptions.find((option) => option.deviceId === deviceId) ?? null;
}

function followLastDevice(input: NewSessionDefaultDeviceInput): ResolvedNewSessionDefaultDevice {
  return {
    device: pickNewSessionDefaultDevice({
      deviceOptions: input.deviceOptions,
      preferredDeviceId: input.rememberedDeviceId ?? null,
      routeDevice: input.routeDevice ?? null,
      routeDeviceExplicit: false,
    }),
    source: 'last',
    unavailable: null,
  };
}

/**
 * 解析一份档案的默认电脑。入口明确指定的电脑永远优先（项目＋、任务页新建、
 * 首页正筛选某台电脑）；组件档案的「跟随应用内默认」递归到应用内档案。
 */
export function resolveNewSessionDefaultDevice(
  input: NewSessionDefaultDeviceInput,
): ResolvedNewSessionDefaultDevice {
  if (input.routeDeviceExplicit && input.routeDevice) {
    return { device: input.routeDevice, source: 'entry', unavailable: null };
  }

  const resolveApp = (): ResolvedNewSessionDefaultDevice => {
    const field = input.defaults.app.device;
    if (field.kind !== 'device') return followLastDevice(input);
    const found = findUsableDevice(input.deviceOptions, field.deviceId);
    if (found) return { device: found, source: 'default', unavailable: null };
    const last = followLastDevice(input);
    // 回退链最终仍落在这台电脑上时不算「用不了」，避免提示里前后是同一台。
    if (last.device?.deviceId === field.deviceId) {
      return { ...last, source: 'default', unavailable: null };
    }
    return { ...last, unavailable: { deviceId: field.deviceId, name: field.name || field.deviceId } };
  };

  const resolveProfile = (profile: NewSessionDefaultProfileKey): ResolvedNewSessionDefaultDevice => {
    const field = input.defaults[profile].device;
    if (field.kind === 'follow-app') return resolveApp();
    if (field.kind === 'follow-last') return followLastDevice(input);
    const found = findUsableDevice(input.deviceOptions, field.deviceId);
    if (found) return { device: found, source: 'default', unavailable: null };
    const last = followLastDevice(input);
    if (last.device?.deviceId === field.deviceId) {
      return { ...last, source: 'default', unavailable: null };
    }
    return { ...last, unavailable: { deviceId: field.deviceId, name: field.name || field.deviceId } };
  };

  return resolveProfile(input.profile);
}

export interface ResolvedNewSessionDefaultWorkspace {
  kind: NewSessionWorkspaceKind;
  workingDir: string;
  source: 'entry' | 'default' | 'last';
  /** 跟随上次时没有可用的目录：调用方应打开远程目录浏览器让用户选。 */
  needsBrowse: boolean;
  /** 配置的项目默认属于另一台电脑 / 当前没有电脑，这次用不了。 */
  unavailableDefault: boolean;
}

export interface NewSessionDefaultWorkspaceInput {
  defaults: NewSessionDefaults;
  profile: NewSessionDefaultProfileKey;
  deviceId: string;
  initialWorkingDir?: string | null;
  followLastKind?: NewSessionWorkspaceKind | null;
  /** 没有任何「上次」模式时，打开新建页时的初始模式（无入口目录 = 对话）。 */
  initialKind?: NewSessionWorkspaceKind;
  rememberedWorkingDir?: string | null;
  recentWorkspaces: readonly RecentWorkspaceOption[];
}

const dialogueDecision = (
  source: ResolvedNewSessionDefaultWorkspace['source'],
): ResolvedNewSessionDefaultWorkspace => ({
  kind: 'dialogue',
  workingDir: '',
  source,
  needsBrowse: false,
  unavailableDefault: false,
});

const projectDecision = (
  workingDir: string,
  source: ResolvedNewSessionDefaultWorkspace['source'],
): ResolvedNewSessionDefaultWorkspace => ({
  kind: 'project',
  workingDir,
  source,
  needsBrowse: false,
  unavailableDefault: false,
});

/**
 * 解析一份档案的默认工作区。入口明确带的项目目录永远优先；具体项目只在它绑定的
 * 电脑就是这次解析出的电脑时适用，否则按「跟随上次」回退。
 */
export function resolveNewSessionDefaultWorkspace(
  input: NewSessionDefaultWorkspaceInput,
): ResolvedNewSessionDefaultWorkspace {
  const entryWorkingDir = input.initialWorkingDir?.trim() ? input.initialWorkingDir : '';
  if (entryWorkingDir) return projectDecision(entryWorkingDir, 'entry');

  const followLast = (): ResolvedNewSessionDefaultWorkspace => {
    const kind = input.followLastKind ?? input.initialKind ?? 'project';
    if (kind === 'dialogue') return dialogueDecision('last');
    const remembered = input.rememberedWorkingDir?.trim()
      ? input.rememberedWorkingDir
      : '';
    const recent = input.recentWorkspaces[0]?.workingDir ?? '';
    const workingDir = remembered || recent;
    return {
      kind: 'project',
      workingDir,
      source: 'last',
      needsBrowse: !workingDir,
      unavailableDefault: false,
    };
  };

  const resolveProject = (
    deviceId: string,
    workingDir: string,
  ): ResolvedNewSessionDefaultWorkspace => {
    if (input.deviceId && deviceId === input.deviceId) return projectDecision(workingDir, 'default');
    return { ...followLast(), unavailableDefault: true };
  };

  const resolveApp = (): ResolvedNewSessionDefaultWorkspace => {
    const field = input.defaults.app.workspace;
    if (field.kind === 'dialogue') return dialogueDecision('default');
    if (field.kind === 'project') return resolveProject(field.deviceId, field.workingDir);
    return followLast();
  };

  const resolveProfile = (profile: NewSessionDefaultProfileKey): ResolvedNewSessionDefaultWorkspace => {
    const field = input.defaults[profile].workspace;
    if (field.kind === 'follow-app') return resolveApp();
    if (field.kind === 'follow-last') return followLast();
    if (field.kind === 'dialogue') return dialogueDecision('default');
    return resolveProject(field.deviceId, field.workingDir);
  };

  return resolveProfile(input.profile);
}

/** 换默认电脑：具体项目若不在新电脑上，回到「跟随上次」。 */
export function withNewSessionDefaultDevice(
  defaults: NewSessionDefaults,
  profile: NewSessionDefaultProfileKey,
  device: NewSessionDefaultDevice,
): NewSessionDefaults {
  const current = defaults[profile];
  const workspace = current.workspace.kind === 'project'
    && !(device.kind === 'device' && device.deviceId === current.workspace.deviceId)
    ? { kind: 'follow-last' as const }
    : current.workspace;
  return {
    ...defaults,
    [profile]: {
      device,
      workspace,
    },
  };
}

/** 换默认工作区：选具体项目时把该档案的电脑钉到项目所在电脑。 */
export function withNewSessionDefaultWorkspace(
  defaults: NewSessionDefaults,
  profile: NewSessionDefaultProfileKey,
  workspace: NewSessionDefaultWorkspace,
  projectDevice?: NewSessionDeviceOption | null,
): NewSessionDefaults {
  const device = workspace.kind === 'project' && projectDevice
    ? {
        kind: 'device' as const,
        deviceId: projectDevice.deviceId,
        name: projectDevice.name.trim() || projectDevice.deviceId,
      }
    : defaults[profile].device;
  return {
    ...defaults,
    [profile]: { device, workspace },
  };
}

export function withNewSessionDefaultProject(
  defaults: NewSessionDefaults,
  profile: NewSessionDefaultProfileKey,
  device: NewSessionDeviceOption,
  workingDir: string,
): NewSessionDefaults {
  return withNewSessionDefaultWorkspace(
    defaults,
    profile,
    { kind: 'project', deviceId: device.deviceId, workingDir },
    device,
  );
}

/** 默认项目在设置行里的短名（目录最后一段）。 */
export function newSessionDefaultProjectName(workingDir: string): string {
  const trimmed = workingDir.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workingDir;
}
