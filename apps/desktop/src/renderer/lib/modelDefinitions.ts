/**
 * 兼容层 —— 历史代码用 `getModelById` / `getDefaultModelForVendor` 同步查模型,
 * 数据现在的 SSoT 在 maker-core (通过 useAgentCapabilities hook 异步拉取并缓存)。
 *
 * 本文件不再持有任何模型数据, 只把缓存里的 ModelDescriptor 适配成历史调用方
 * 期待的形状 (label / vendorKey 等)。
 *
 * 在 callback / 同步逻辑里使用; render 路径请直接用 useAgentCapabilities。
 */

import { getCachedCapabilities, type ModelDescriptor } from '@/hooks/useAgentCapabilities';
import type { Effort } from '@/lib/userPreferences.types';

export interface ModelDefinition {
  id: string;
  label: string;
  description: string;
  efforts: readonly Effort[];
  defaultEffort: Effort | null;
  vendorKey: 'cc' | 'codex' | 'pi';
  contextWindow?: number;
  supportsFastMode?: boolean;
  /** 目录展示排序;缺省排末尾(见 getDefaultModelForVendor)。 */
  sortOrder?: number;
  /** 选择器里默认是否可见;缺省 ⇒ 可见(见 getDefaultModelForVendor)。 */
  defaultEnabled?: boolean;
  /**
   * 该模型是哪些 wire agent 的**新对话默认种子**(源自目录 newSessionDefault,与 sortOrder
   * 解耦)。缺省 = 不作为默认。getDefaultModelForVendor / newSessionDefaultModelId 据它选默认;
   * pi 按 'claude-code' 口径判定(见 wireAgentForVendor)。
   */
  newSessionDefault?: ('claude-code' | 'codex')[];
}

function toLegacy(m: ModelDescriptor, vendorKey: 'cc' | 'codex' | 'pi'): ModelDefinition {
  return {
    id: m.id,
    label: m.displayName,
    description: m.description ?? '',
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
    vendorKey,
    contextWindow: m.contextWindow,
    supportsFastMode: m.supportsFastMode,
    sortOrder: m.sortOrder,
    defaultEnabled: m.defaultEnabled,
    newSessionDefault: m.newSessionDefault,
  };
}

// device-link「以被控端为准」:可选 deviceId 决定读哪份能力缓存。省略 = 本机缓存(行为不变);
// 传 deviceId = 该被控端的缓存(远程会话的模型/effort/contextWindow 必须来自被控端,模型 id
// 跨设备不唯一,绝不能用本地缓存替代)。
function allCachedModels(deviceId?: string): ModelDefinition[] {
  const cc = getCachedCapabilities('claude-code', deviceId);
  const codex = getCachedCapabilities('codex', deviceId);
  return [
    ...(cc?.availableModels ?? []).map((m) => toLegacy(m, 'cc')),
    ...(codex?.availableModels ?? []).map((m) => toLegacy(m, 'codex')),
  ];
}

/**
 * 老调用方期待的"全模型列表" —— 用 getter 形式确保每次访问都是最新缓存,
 * 而不是 module load 时的一次性快照。
 */
export const MODELS = new Proxy([] as ModelDefinition[], {
  get(_t, prop) {
    const arr = allCachedModels();
    // @ts-expect-error proxy index forward
    return arr[prop];
  },
}) as readonly ModelDefinition[];

export function getEffortsForModel(modelId: string, deviceId?: string): readonly Effort[] {
  return getModelById(modelId, deviceId)?.efforts ?? [];
}

export function downgradeEffort(
  currentEffort: Effort,
  newModelId: string,
  deviceId?: string,
): Effort | null {
  const allowed = getEffortsForModel(newModelId, deviceId);
  if (allowed.length === 0) return null;
  if (allowed.includes(currentEffort)) return currentEffort;
  return allowed[allowed.length - 1];
}

/**
 * 按 ID 找模型; 兼容 'gpt-5-codex' 老 ID (DB 存量)。
 * 新代码尽量直接遍历 capabilities; 这里只给老调用方收口。
 */
export function getModelById(modelId: string, deviceId?: string): ModelDefinition | undefined {
  const all = allCachedModels(deviceId);
  if (modelId === 'gpt-5-codex') {
    return all.find((m) => m.id === 'gpt-5.5');
  }
  // 兼容长 ID Haiku 老存量数据
  if (modelId === 'claude-haiku-4-5-20251001') {
    return all.find((m) => m.id === 'claude-haiku-4-5');
  }
  return all.find((m) => m.id === modelId);
}

/** vendor → capabilities 缓存的 agent 键(pi 有自己的能力清单)。 */
function agentKindForVendor(vendorKey: 'cc' | 'codex' | 'pi'): 'claude-code' | 'codex' | 'pi' {
  return vendorKey === 'codex' ? 'codex' : vendorKey === 'pi' ? 'pi' : 'claude-code';
}

export function getModelsForVendor(
  vendorKey: 'cc' | 'codex' | 'pi',
  deviceId?: string,
): readonly ModelDefinition[] {
  // 直接读该 vendor 对应 agent 的能力缓存 —— 不经 allCachedModels(后者只聚合 cc/codex 供
  // getModelById / MODELS 等旧调用方用)。pi 有自己的能力清单,默认判定必须读它,否则 pi 恒空。
  const caps = getCachedCapabilities(agentKindForVendor(vendorKey), deviceId);
  return (caps?.availableModels ?? []).map((m) => toLegacy(m, vendorKey));
}

/**
 * 按目录排序挑第一个默认可见的模型（同 sortOrder 取先出现者；无 sortOrder 排末尾）。
 *
 * 「排序第一」= 用户在选择器里看到的第一个，也就是产品认定最好的那个 —— 换代时只改目录
 * 排序即生效，不需要动代码。**默认收起的模型不参与**：它们在清单里根本不显示，选中了等于
 * 让用户面对一个自己找不到的默认模型（这正是旧代码写死 `gpt-5.5` / `gpt-5.4` 的实际后果 ——
 * 两个值不一致，而且都是目录里 `defaultEnabled: false` 的条目）。全都收起时退回纯排序第一，
 * 总比返回空好。
 */
function firstByCatalogOrder(models: readonly ModelDefinition[]): ModelDefinition | undefined {
  const byOrder = (a: ModelDefinition, b: ModelDefinition): number =>
    (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY);
  const visible = models.filter((m) => m.defaultEnabled !== false);
  // slice() 后再 sort：sort 原地改数组，直接排会打乱调用方（capabilities 缓存）的清单顺序。
  const pool = visible.length > 0 ? visible : models;
  return pool.slice().sort(byOrder)[0];
}

/** vendor → 新对话默认所依据的 wire agent(pi 镜像 claude-code —— pi 不是 wire agent)。 */
function wireAgentForVendor(vendorKey: 'cc' | 'codex' | 'pi'): 'claude-code' | 'codex' {
  return vendorKey === 'codex' ? 'codex' : 'claude-code';
}

/**
 * 该 vendor 被目录**显式标记**为新对话默认种子(newSessionDefault)、且当前可用且默认可见的
 * 模型 id;没有标记则返回 null。多个被标记时按 sortOrder 决胜。与 sortOrder / defaultEnabled
 * 解耦 —— 标记本身表达「这是默认」,sortOrder 只管选择器陈列顺序。pi 按 claude-code 口径判定
 * (pi 的模型宇宙是 cc-compatible 模型的镜像,由 host 投影进 pi tab)。
 *
 * 生产环境该标记对 XD 网关模型由服务端 GET /models 按区域下发(见 shared/modelAccess
 * ModelAccessGatewayModel.newSessionDefault);bundled 目录默认不标记,故服务端未下发时
 * 本函数返回 null、默认行为不变。
 */
export function newSessionDefaultModelId(
  vendorKey: 'cc' | 'codex' | 'pi',
  deviceId?: string,
): string | null {
  const agent = wireAgentForVendor(vendorKey);
  const flagged = getModelsForVendor(vendorKey, deviceId).filter(
    (m) => m.defaultEnabled !== false && (m.newSessionDefault?.includes(agent) ?? false),
  );
  return firstByCatalogOrder(flagged)?.id ?? null;
}

/**
 * 该 vendor 的**对话场景**默认模型。
 *
 * 优先级:目录显式标记的新对话默认(newSessionDefault,与 sortOrder 解耦)> 排序第一的默认
 * 可见模型 > capabilities 未到位时的冷启动占位。**没有任何模型被标记时,与「排序第一可见」
 * 逐字节一致**(非破坏性)。这里刻意不写死 id。
 *
 * 注意它只是**种子**：真正落点由 `calibrateDraftModel` 在供应商清单到位后决定(「可用的里面
 * 选,供应商优先订阅」,见 draftModelCalibration)。自动化任务(scheduler)默认故意不同,走
 * useScheduleForm.ts getScheduleDefaultModel,不要把这里的默认接到 scheduler 上。
 */
export function getDefaultModelForVendor(
  vendorKey: 'cc' | 'codex' | 'pi',
  deviceId?: string,
): ModelDefinition {
  const list = getModelsForVendor(vendorKey, deviceId);
  // capabilities 还没拉到时退化到一个静态 placeholder, 让调用方拿到非 undefined。
  // 调用方真正需要值时通常已经在 useEffect 后, capabilities 已就绪。
  if (list.length === 0) {
    return {
      id: coldStartModelIdForVendor(vendorKey),
      label: coldStartLabelForVendor(vendorKey),
      description: '',
      efforts: [],
      defaultEffort: null,
      vendorKey,
    };
  }
  // 显式标记优先(与 sortOrder 解耦);没有标记才回退排序第一 —— 即今天的行为。
  const flaggedId = newSessionDefaultModelId(vendorKey, deviceId);
  const flagged = flaggedId ? list.find((m) => m.id === flaggedId) : undefined;
  return flagged ?? firstByCatalogOrder(list) ?? list[0];
}

/**
 * capabilities 还没拉到时的占位 id。**它们不是另一份产品默认值**，只是目录还没到位时的同值
 * 影子：cc/codex 必须与 bundled 目录里「排序第一且默认可见」的那个一致（订阅口径，即不取网关
 * 折扣组），否则冷启动首帧会闪一个随后被换掉的模型名。pi 复用其历史中档默认(XD 网关 Sonnet)。
 * 由 modelDefinitionsDefaults 测试锁住。
 */
const COLD_START_CC_MODEL_ID = 'claude-opus-5';
const COLD_START_CODEX_MODEL_ID = 'gpt-5.6-sol';
const COLD_START_PI_MODEL_ID = 'claude-sonnet-5';

/** 冷启动占位 id 的只读导出（newMakerDraft 的种子默认复用，避免另一处写死）。 */
export function coldStartModelIdForVendor(vendorKey: 'cc' | 'codex' | 'pi'): string {
  return vendorKey === 'codex'
    ? COLD_START_CODEX_MODEL_ID
    : vendorKey === 'pi'
      ? COLD_START_PI_MODEL_ID
      : COLD_START_CC_MODEL_ID;
}

/** 冷启动占位的展示名(与占位 id 同源,仅首帧短暂可见)。 */
function coldStartLabelForVendor(vendorKey: 'cc' | 'codex' | 'pi'): string {
  return vendorKey === 'codex' ? 'GPT-5.6-Sol' : vendorKey === 'pi' ? 'Sonnet 5' : 'Opus 5';
}
