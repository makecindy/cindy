/**
 * modelConfigCopy —— 「配置副本」的公共归一化与身份规则:收藏(modelFavorites)与
 * 最近使用(recentModels)共用的那一份定义。
 *
 * 副本 = 模型身份 + 引擎 + 深度 + Fast 的完整组合。两个 store 都按同一套语义存取:
 *   - providerId 拒绝 providerModelMemory 的保留位 `'*'`(MODEL_PRESET_SLOT_ID);
 *   - agent 非法 → **整条丢弃**(副本缺引擎无法表达任何配置);合法值域是选择器 / 草稿
 *     链路的 vendor 口径(`SelectableVendor`);
 *   - effort 存 canonical key(`'high'` / `'low'`…),显示文案不回灌;非法值只丢该字段,
 *     缺省语义 = 跟随该 (模型, 引擎) 的推荐档;
 *   - fast 只在**开启**时存 `true`(关闭即缺省,不落「等于默认」的快照);
 *   - 身份(去重 / 星标匹配) = providerId + modelId + agent + effort + fast,缺省字段参与,
 *     与「跟随推荐」区分。
 *
 * 为什么单点:收藏的「重复添加去重」与最近的「同一模型不同配置各占一行」「星标按完全一致的
 * 副本匹配」必须用同一套判等 —— 各写一遍必然漂移成两套身份(收藏存的 effort 是 key、
 * 最近存的却是显示文案之类)。
 */

import { EFFORT_VALUES } from '@cindy/model-providers';

import { isSelectableVendor } from '@/lib/agentVendors';
import type { Effort } from '@/lib/userPreferences.types';

import type { ModelEngine } from './modelEnginePrefs';

/**
 * v2 记忆 schema 内的保留来源 id:同一 agent 下跨真实 provider 共享的模型级预设槽。
 *
 * 定义放在这里(配置副本的身份空间):两个副本 store 的归一化都要拒绝它,而它们是
 * **纯模块**——保留位反向 import providerModelMemory 会把整个 store(含 React 与
 * 存储订阅)拖进纯逻辑层的依赖图。providerModelMemory 原样 re-export 给既有消费方,
 * 常量仍然只有一份定义。
 */
export const MODEL_PRESET_SLOT_ID = '*';

/** 一份配置副本的完整描述(不含各 store 自己的锚点 / 时间戳)。 */
export interface ModelConfigCopy {
  providerId: string;
  modelId: string;
  agent: ModelEngine;
  /** 思考深度**档位 key**('low' | 'high' | …);缺省 = 跟随该 (模型, 引擎) 的推荐档。 */
  effort?: Effort;
  /** Fast(插队加速)。**只在开启时存 true**,关闭即缺省 —— 不落「等于默认」的快照。 */
  fast?: true;
}

/**
 * `'*'` 是 providerModelMemory v2 的保留来源 id(跨来源模型预设槽),真实来源不可能等于它
 * (规格 §4「偏好/记忆」的防撞要求)。
 */
export function isUsableModelProviderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value !== MODEL_PRESET_SLOT_ID;
}

export function isCanonicalModelEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_VALUES as readonly string[]).includes(value);
}

/**
 * 归一化配置字段(收藏 / 最近的 add / update / sanitize 共用);模型身份或引擎不合法 → null。
 * `effort` 非法只丢该字段(不是丢整条):缺省有明确语义「跟随推荐档」。
 */
export function normalizeModelConfigCopy(raw: {
  providerId?: unknown;
  modelId?: unknown;
  agent?: unknown;
  effort?: unknown;
  fast?: unknown;
}): ModelConfigCopy | null {
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  if (!isUsableModelProviderId(providerId) || !modelId) return null;
  // agent 非法 → **丢整条**:副本的必要组成部分,缺了它这条记录无法表达任何配置。
  if (!isSelectableVendor(raw.agent)) return null;
  const config: ModelConfigCopy = { providerId, modelId, agent: raw.agent };
  if (isCanonicalModelEffort(raw.effort)) config.effort = raw.effort;
  if (raw.fast === true) config.fast = true;
  return config;
}

/**
 * 去重 / 匹配身份:providerId + modelId + agent + effort + fast(缺省字段参与,与「跟随推荐」区分)。
 * 分隔符用空格而不是 NUL:源码里嵌一个裸 `\0` 会让整个文件被 git / rg / grep 判成二进制
 * (diff 显示 `Bin`、搜不到任何符号),代价远大于它能防的那点分隔符冲突 —— provider id 与
 * model id 都是 slug 形态,不含空格(与 unifiedSelection.entryKey 同一取舍)。
 */
export function modelConfigCopyIdentity(config: ModelConfigCopy): string {
  return [
    config.providerId,
    config.modelId,
    config.agent,
    config.effort ?? '',
    config.fast === true ? '1' : '0',
  ].join(' ');
}
