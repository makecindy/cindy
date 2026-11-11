/**
 * Cindy 视觉桥（agent-vision-toolkit 式）设置。
 *
 * 两个清单：
 *  - targetModels：启用视觉桥的模型（即纯文本模型）。用户在设置页勾选；已知无视觉的
 *    模型默认勾选，已知有视觉 / 未知默认不勾但允许手动勾（用户可故意让视觉模型也走
 *    视觉桥，如用更廉价的描述节省 token）。
 *  - primary / fallback：视觉后端模型（把图转文字的多模态模型），最多两个，第二可空
 *    （无灾备）。
 *
 * 语义对齐 docs/vision-bridge-design.md 六、配置设计。
 */

/** 视觉后端引用：复用设置页里已配好的 provider + 其中一个多模态模型。 */
export interface VisionBackendRef {
  providerId: string;
  modelId: string;
}

export interface VisionBridgeSettings {
  /** 总开关。false = 三层全部不生效（零干扰）。 */
  enabled: boolean;
  /** 启用视觉桥的模型 id 集合（纯文本模型）。 */
  targetModels: string[];
  /** 主视觉后端（必选，启用后生效）。 */
  primary: VisionBackendRef | null;
  /** fallback 视觉后端（可选）。 */
  fallback: VisionBackendRef | null;
}

export type VisionBridgeSettingsPatch = Partial<VisionBridgeSettings>;

export interface VisionBridgeSettingsState extends VisionBridgeSettings {
  isCustomized: boolean;
  customizedKeys: string[];
  defaults: VisionBridgeSettings;
}

export const VISION_BRIDGE_SETTINGS_DEFAULTS: VisionBridgeSettings = {
  enabled: false,
  targetModels: [],
  primary: null,
  fallback: null,
};
