import type { DialogueDeviceTarget } from './dialogueCreateTarget';

export interface NewMakerDialogueTargetRequest {
  requestId: string;
  deviceId: string | null;
  deviceName: string | null;
  /** 通用新建只继承电脑；同机时保留草稿项目及用户选择。 */
  preserveWorkspaceIfSameDevice?: boolean;
}

export interface NewMakerFolderPickerRequest {
  requestId: string;
}

/**
 * 新建任务时当前任务正在用的模型(Harness / 来源 / 模型 / 深度 / Fast / Agent 所在电脑)。
 * 只在新任务建在同一台任务电脑上时套用(本机、同一台被控电脑或同一台 SSH 主机);
 * 模型目录与来源都按电脑划分，换了电脑就沿用那边原有默认。
 */
export interface NewMakerModelInheritanceRequest {
  requestId: string;
  vendor: 'cc' | 'codex' | 'pi';
  model: string;
  /** null = 跟随默认路由。 */
  providerId: string | null;
  effort: string | null;
  fastMode: boolean | 'ultrafast';
  /** Agent 在另一台电脑运行时那台电脑;null = 任务所在电脑。 */
  agentDeviceId: string | null;
  /** 任务所在的被控电脑;null = 本机或 SSH。 */
  taskDeviceId: string | null;
  /** 任务所在的 SSH 主机;null = 非 SSH。 */
  remoteHostId: string | null;
}

export interface NewMakerRouteState {
  workspacePrompt: 'generic' | 'dialogue';
  dialogueTargetRequest?: NewMakerDialogueTargetRequest;
  folderPickerRequest?: NewMakerFolderPickerRequest;
  modelInheritanceRequest?: NewMakerModelInheritanceRequest;
}

let dialogueTargetRequestSequence = 0;
let folderPickerRequestSequence = 0;

/** These requests select local/device-link execution, never an SSH workspace. */
export function isSameNewMakerDevice(
  deviceId: string | null,
  draft: { deviceLinkDeviceId?: string | null; remoteHostId?: string | null },
): boolean {
  return !draft.remoteHostId && deviceId === (draft.deviceLinkDeviceId ?? null);
}

/**
 * “对话”分组每次点击都生成新 requestId。同路由重复 navigate 不会 remount 创建页，
 * 但 location.state 会更新，创建页可据此再次执行完整 target transition。
 */
export function makeDialogueNewMakerRouteState(
  target: DialogueDeviceTarget | null,
): NewMakerRouteState & { dialogueTargetRequest: NewMakerDialogueTargetRequest } {
  dialogueTargetRequestSequence += 1;
  return {
    workspacePrompt: 'dialogue',
    dialogueTargetRequest: {
      requestId: `${Date.now()}-${dialogueTargetRequestSequence}`,
      deviceId: target?.deviceId ?? null,
      deviceName: target?.deviceName ?? null,
    },
  };
}

function nullableNonEmptyString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function readNewMakerModelInheritanceRequest(
  state: unknown,
): NewMakerModelInheritanceRequest | null {
  if (!state || typeof state !== 'object') return null;
  const request = (state as Record<string, unknown>).modelInheritanceRequest;
  if (!request || typeof request !== 'object') return null;
  const record = request as Record<string, unknown>;
  const { requestId, vendor, model, fastMode } = record;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  if (vendor !== 'cc' && vendor !== 'codex' && vendor !== 'pi') return null;
  if (typeof model !== 'string' || model.length === 0) return null;
  if (typeof fastMode !== 'boolean' && fastMode !== 'ultrafast') return null;
  const providerId = nullableNonEmptyString(record.providerId);
  const effort = nullableNonEmptyString(record.effort);
  const agentDeviceId = nullableNonEmptyString(record.agentDeviceId);
  const taskDeviceId = nullableNonEmptyString(record.taskDeviceId);
  const remoteHostId = nullableNonEmptyString(record.remoteHostId);
  if (
    providerId === undefined ||
    effort === undefined ||
    agentDeviceId === undefined ||
    taskDeviceId === undefined ||
    remoteHostId === undefined
  ) {
    return null;
  }
  return {
    requestId,
    vendor,
    model,
    providerId,
    effort,
    fastMode,
    agentDeviceId,
    taskDeviceId,
    remoteHostId,
  };
}

/** 与 dialogueTargetRequest 同理:一次性指令，应用后从 history entry 移除，后退不重放。 */
export function consumeNewMakerModelInheritanceRequest(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'modelInheritanceRequest')) return state;
  const { modelInheritanceRequest: _consumed, ...remainingState } = state as Record<
    string,
    unknown
  >;
  return remainingState;
}

/** 草稿此刻所在的任务电脑是否就是来源任务的那台(本机 / 同一台被控电脑 / 同一台 SSH 主机)。 */
export function isSameNewMakerTaskComputer(
  request: Pick<NewMakerModelInheritanceRequest, 'taskDeviceId' | 'remoteHostId'>,
  draft: { deviceLinkDeviceId?: string | null; remoteHostId?: string | null },
): boolean {
  return (
    (request.taskDeviceId ?? null) === (draft.deviceLinkDeviceId ?? null) &&
    (request.remoteHostId ?? null) === (draft.remoteHostId ?? null)
  );
}

export type NewMakerModelInheritanceStep =
  /** 先只把 Agent 换到请求那台电脑；请求留着，等那台目录播种后再套用。 */
  | { kind: 'switch-agent-device'; agentDeviceId: string | null }
  /** 依赖还没就绪(目录未播种、本机来源未加载):请求留着，下次渲染再判。 */
  | { kind: 'wait' }
  | { kind: 'apply' }
  /** 不适用(换了任务电脑、正在发送、Harness 不可用、用户已改选):直接消费掉。 */
  | { kind: 'skip' };

/**
 * 创建页套用「沿用当前任务模型」请求的下一步。
 *
 * 换 Agent 所在电脑必须先单独提交：同一次提交里目录播种 effect 仍按旧目录运行，会把刚写进的
 * 选择清空或按那台的默认重播种。目录播种后再按同一台电脑上的手动选择套用。
 */
export function nextNewMakerModelInheritanceStep(
  request: Pick<
    NewMakerModelInheritanceRequest,
    'vendor' | 'providerId' | 'agentDeviceId' | 'taskDeviceId' | 'remoteHostId'
  >,
  page: {
    draft: {
      deviceLinkDeviceId?: string | null;
      remoteHostId?: string | null;
      agentDeviceId?: string | null;
    };
    sendInFlight: boolean;
    usesDeviceCatalog: boolean;
    /** 草稿已按当前目录那台的默认播种。 */
    deviceCatalogSeeded: boolean;
    /** 播种后控制端已手动改过远程运行配置。 */
    deviceSelectionTouched: boolean;
    availableAgentsLoaded: boolean;
    vendorAvailable: boolean;
    localProvidersLoading: boolean;
  },
): NewMakerModelInheritanceStep {
  if (!isSameNewMakerTaskComputer(request, page.draft) || page.sendInFlight) return { kind: 'skip' };
  // 按草稿字段判断：草稿已记着这台、只是此处不生效(如被控电脑不支持远程 Agent)时不再反复写入。
  if (!request.remoteHostId && request.agentDeviceId !== (page.draft.agentDeviceId ?? null)) {
    return { kind: 'switch-agent-device', agentDeviceId: request.agentDeviceId };
  }
  // 目录播种完才判引擎可用：换电脑后的头几帧里引擎清单可能还没换成目标电脑的。
  if (page.usesDeviceCatalog && !page.deviceCatalogSeeded) return { kind: 'wait' };
  if (page.availableAgentsLoaded && !page.vendorAvailable) return { kind: 'skip' };
  if (page.usesDeviceCatalog) {
    return page.deviceSelectionTouched ? { kind: 'skip' } : { kind: 'apply' };
  }
  const localCatalogTarget =
    !request.agentDeviceId &&
    !request.taskDeviceId &&
    !(request.remoteHostId && request.vendor === 'codex');
  if (request.providerId === null && localCatalogTarget && page.localProvidersLoading) {
    return { kind: 'wait' };
  }
  return { kind: 'apply' };
}

export function makeFolderPickerNewMakerRouteState(): NewMakerRouteState {
  folderPickerRequestSequence += 1;
  return {
    workspacePrompt: 'generic',
    folderPickerRequest: {
      requestId: `${Date.now()}-${folderPickerRequestSequence}`,
    },
  };
}

export function readNewMakerFolderPickerRequest(
  state: unknown,
): NewMakerFolderPickerRequest | null {
  if (!state || typeof state !== 'object') return null;
  const request = (state as Record<string, unknown>).folderPickerRequest;
  if (!request || typeof request !== 'object') return null;
  const requestId = (request as Record<string, unknown>).requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) return null;
  return { requestId };
}

export function consumeNewMakerFolderPickerRequest(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'folderPickerRequest')) return state;
  const { folderPickerRequest: _consumed, ...remainingState } = state as Record<string, unknown>;
  return remainingState;
}

export function readNewMakerDialogueTargetRequest(
  state: unknown,
): NewMakerDialogueTargetRequest | null {
  if (!state || typeof state !== 'object') return null;
  const request = (state as Record<string, unknown>).dialogueTargetRequest;
  if (!request || typeof request !== 'object') return null;
  const record = request as Record<string, unknown>;
  if (typeof record.requestId !== 'string' || record.requestId.length === 0) return null;
  const deviceId = record.deviceId;
  const deviceName = record.deviceName;
  if (deviceId !== null && (typeof deviceId !== 'string' || deviceId.length === 0)) return null;
  if (deviceName !== null && typeof deviceName !== 'string') return null;
  if (deviceId === null && deviceName !== null) return null;
  return {
    requestId: record.requestId,
    deviceId,
    deviceName,
    ...(record.preserveWorkspaceIfSameDevice === true
      ? { preserveWorkspaceIfSameDevice: true }
      : {}),
  };
}

/**
 * dialogueTargetRequest 是一次性导航指令。首次应用后从当前 history entry 移除，避免用户
 * 浏览器后退到旧的 /cc-agent/new 记录时再次迁移草稿目标；其它 route state 必须原样保留。
 */
export function consumeNewMakerDialogueTargetRequest(state: unknown): unknown {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  if (!Object.prototype.hasOwnProperty.call(state, 'dialogueTargetRequest')) return state;
  const { dialogueTargetRequest: _consumed, ...remainingState } = state as Record<string, unknown>;
  return remainingState;
}
