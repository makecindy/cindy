/**
 * tool-result-image-descriptor —— ghost 工具结果图片 → 视觉桥文字描述（工厂，可测）。
 *
 * 背景：纯文本模型（deepseek 等）调 ghost 插件工具（如 xd-feishu 读飞书群）返回的
 * 图片以 cindy-media:// URL 文本进上下文，读不到图会幻觉编造内容。host 在 ghost_call
 * 收口处读本地 blob 调视觉桥转成描述，附加为 xdt_media_descriptions。
 *
 * 本模块把 maker-host 里那段 fail-closed 判定闭包抽成独立工厂：视觉桥未启用 / session
 * 缺失或旧实例 / 模型不命中 / blob 解析失败 → 返回 null（静默跳过），工具调用永不阻塞。
 * maker-host 只装配依赖，不再内联不可测的判定链。
 */
import { DEFAULT_VISION_PROMPT } from './vision-channel.js';
import type { VisionBridgeController } from './vision-bridge-controller.js';

/** 工厂依赖：可访问当前 session 的运行时真相（与 getLiveSessionGrantState 同源）。 */
export interface ToolResultImageDescriptorDeps {
  getController: () => VisionBridgeController | null;
  getSession: (sessionId: string) => { model: string; instanceId: string } | undefined;
  resolveBlobPath: (imageUrl: string) => string;
  /** 描述 prompt。缺省 = 视觉通道 DEFAULT_VISION_PROMPT(同源,不复制)。 */
  defaultPrompt?: string;
}

/**
 * 判定 + 描述链。每步 fail closed 不抛、不阻塞;返回结构区分「有意跳过」与
 * 「真正尝试但失败」:
 *  - skipped:true = 视觉桥未启用 / session 缺失或旧实例 / 模型不命中 / blob 解析失败,
 *    调用方不计 attemptedCount、不告警「不可用」(功能没开不是故障);
 *  - skipped:false + description:null = 真正尝试了视觉后端但失败(错误 / 后端不可用),
 *    调用方据此计数并告警。
 */
export function createToolResultImageDescriptor(deps: ToolResultImageDescriptorDeps): (
  input: { imageUrl: string; sessionId: string | null; sessionInstanceId: string | null; signal?: AbortSignal },
) => Promise<{ skipped: boolean; description: string | null }> {
  const prompt = deps.defaultPrompt ?? DEFAULT_VISION_PROMPT;
  return async (input) => {
    const controller = deps.getController();
    if (!controller) return { skipped: true, description: null };
    const { imageUrl, sessionId, sessionInstanceId, signal } = input;
    // 定位并校验当前 session:缺失/旧实例必须 fail closed(与 getLiveSessionGrantState
    // 同口径),避免对已拆离 session 发视觉调用。均属「有意跳过」,不告警。
    if (!sessionId || !sessionInstanceId) return { skipped: true, description: null };
    const session = deps.getSession(sessionId);
    if (!session || session.instanceId !== sessionInstanceId) return { skipped: true, description: null };
    const model = session.model;
    if (!model || !controller.shouldBridge(model)) return { skipped: true, description: null };
    let absPath: string;
    try {
      // cindy-media://blobs/<hash>.<ext> → 本地绝对路径(严格校验,非 blob 抛错)。
      absPath = deps.resolveBlobPath(imageUrl);
    } catch {
      return { skipped: true, description: null };
    }
    try {
      const description = await controller.describeImage({ imagePath: absPath, prompt, signal });
      return { skipped: false, description };
    } catch {
      // 视觉后端失败 / 预算 abort → 静默跳过,不阻塞工具结果。真实尝试过,
      // 调用方计入 attemptedCount,用于「有图但全失败」时告警不可用。
      return { skipped: false, description: null };
    }
  };
}
