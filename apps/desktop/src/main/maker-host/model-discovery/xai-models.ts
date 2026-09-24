/** Pure xAI discovery parsing, shared by runtime refresh and the sync CLI. */
import { effortRank, type Effort, type CatalogModel } from '@cindy/model-providers';

export interface XaiDiscoveredModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  contextWindowVerified?: boolean;
  maxOutput?: number;
  efforts?: CatalogModel['efforts'];
  nativeApi?: CatalogModel['nativeApi'];
  defaultEffort?: CatalogModel['defaultEffort'];
}

const VALID_EFFORTS: ReadonlySet<string> = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function positiveIntegerField(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

function effort(value: unknown): Effort | undefined {
  return typeof value === 'string' && VALID_EFFORTS.has(value) ? (value as Effort) : undefined;
}

/**
 * 档位数组一律**规范升序**(低 → 高)。x.ai 的 `/v1/models` 下发的是**降序**
 * (Chris 2026-08-19 实测:`['high','medium','low']`),而全仓消费端(EffortSlider 的
 * 按下标画轴、`efforts[0]`=最低 / `efforts.at(-1)`=最高的取值点)契约都是升序 ——
 * 原序透传出去,Grok 4.5 的滑杆整条轴反向,用户以为在拉高、实际每次都写 low。
 * 顺序是**表示细节**,在入库这一点归一,payload / 磁盘缓存怎么排都不再泄漏到下游;
 * `parseCachedXaiModels` 复用本函数,已落盘的降序缓存下次读取即被纠正,不必等刷新。
 */
function canonicalEffortOrder(list: readonly Effort[]): Effort[] {
  return [...list].sort((a, b) => effortRank(a) - effortRank(b));
}

function parseReasoningEfforts(raw: unknown): { efforts?: Effort[]; declaredDefault?: Effort } {
  if (!Array.isArray(raw)) return {};
  const efforts: Effort[] = [];
  let declaredDefault: Effort | undefined;
  for (const item of raw) {
    const value = effort(typeof item === 'string' ? item : isRecord(item) ? item.value : undefined);
    if (!value || efforts.includes(value)) continue;
    efforts.push(value);
    if (isRecord(item) && item.default === true) declaredDefault = value;
  }
  return { efforts: canonicalEffortOrder(efforts), declaredDefault };
}

function canonicalModelId(raw: string): string {
  return raw.startsWith('xai/') ? raw : `xai/${raw}`;
}

/** Parse membership without guessing missing capability fields. */
export function parseXaiAccountModels(payload: unknown): XaiDiscoveredModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new Error('xAI account model discovery returned an invalid models payload');
  }
  const seen = new Set<string>();
  const models: XaiDiscoveredModel[] = [];
  for (const value of payload.data) {
    if (!isRecord(value)) continue;
    const meta = isRecord(value._meta) ? value._meta : {};
    if (value.hidden === true || meta.hidden === true) continue;
    const rawId =
      stringField(value, 'model', 'modelId', 'id') ?? stringField(meta, 'model', 'modelId');
    if (!rawId) continue;
    const id = canonicalModelId(rawId);
    if (seen.has(id)) continue;
    seen.add(id);
    const contextWindow =
      positiveIntegerField(value, 'contextWindow', 'context_window') ??
      positiveIntegerField(meta, 'contextWindow', 'totalContextTokens');
    const maxOutput = positiveIntegerField(value, 'maxCompletionTokens', 'max_completion_tokens');
    const parsedEfforts = parseReasoningEfforts(
      value.reasoningEfforts ?? value.reasoning_efforts ?? meta.reasoningEfforts,
    );
    const declaredDefault =
      parsedEfforts.declaredDefault ??
      effort(value.reasoningEffort ?? value.reasoning_effort ?? meta.reasoningEffort);
    let efforts = parsedEfforts.efforts;
    if (value.supportsReasoningEffort === false || value.supports_reasoning_effort === false) {
      efforts = [];
    } else if (efforts === undefined && declaredDefault) {
      efforts = [declaredDefault];
    } else if (efforts && declaredDefault && !efforts.includes(declaredDefault)) {
      // 追加后重排:declaredDefault 直接 push 到尾部会破坏 parseReasoningEfforts
      // 已经建立的规范升序(见 canonicalEffortOrder)。
      efforts = canonicalEffortOrder([...efforts, declaredDefault]);
    }
    const name = stringField(value, 'name');
    const description = stringField(value, 'description');
    models.push({
      id,
      ...(value.api_backend === 'responses' ? { nativeApi: 'openai-responses' as const } : {}),
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      ...(contextWindow !== undefined ? { contextWindow, contextWindowVerified: true } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(declaredDefault !== undefined ? { defaultEffort: declaredDefault } : {}),
    });
  }
  return models;
}

export function parseCachedXaiModels(payload: unknown): XaiDiscoveredModel[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return null;
  const out: XaiDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const value of payload.models) {
    if (!isRecord(value) || typeof value.id !== 'string') return null;
    const id = canonicalModelId(value.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const efforts =
      value.efforts === undefined ? undefined : parseReasoningEfforts(value.efforts).efforts;
    const defaultEffort = effort(value.defaultEffort);
    if (value.efforts !== undefined && efforts === undefined) return null;
    out.push({
      id,
      ...(value.nativeApi === 'openai-responses' ? { nativeApi: value.nativeApi } : {}),
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.description === 'string' ? { description: value.description } : {}),
      ...(positiveIntegerField(value, 'contextWindow') !== undefined
        ? {
            contextWindow: positiveIntegerField(value, 'contextWindow'),
            ...(value.contextWindowVerified === true ? { contextWindowVerified: true } : {}),
          }
        : {}),
      ...(positiveIntegerField(value, 'maxOutput') !== undefined
        ? { maxOutput: positiveIntegerField(value, 'maxOutput') }
        : {}),
      ...(efforts !== undefined ? { efforts } : {}),
      ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    });
  }
  return out;
}
