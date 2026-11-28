/**
 * Pi native provider 模型的 `input` 声明。
 *
 * Pi 的 models.json 里 `input` 决定该模型能不能收图片。缺省一直是乐观的 `['text','image']`
 * （「没声明 ≠ 不能看图」，避免新发现的视觉模型被误禁），但已知纯文本型号走这条缺省会
 * 把图片送到明确拒图的端点：智谱 v4 对 `glm-5.3` 的 `content[].type = "image_url"` 直接
 * 回 400（code 1210），图片进历史后每轮重放、会话永久死锁（#11296）。
 *
 * 语义：显式声明（模型自带 `input`）永远优先；缺省时用 visionCapability 的保守名单兜底。
 */
import { isKnownNoVisionModel } from '@cindy/model-providers/vision-capability';

export type PiModelInputModality = 'text' | 'image';

export interface PiNativeModelInputSource {
  id: string;
  wireId?: string;
  input?: readonly PiModelInputModality[];
}

/** 该模型在 Pi models.json 里的 `input` 取值。 */
export function piNativeModelInput(model: PiNativeModelInputSource): PiModelInputModality[] {
  if (model.input && model.input.length > 0) return [...model.input];
  // 目录与请求体都用 wireId 形态发请求，按它判定才能命中实际上游型号。
  return isKnownNoVisionModel(model.wireId ?? model.id) ? ['text'] : ['text', 'image'];
}
