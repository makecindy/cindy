/**
 * 将 Agent 最终 Markdown 中引用的图片安全转成 IM 可上传的绝对路径。
 *
 * 路径与图片校验由 cindy-media/markdownImages 统一实现；本适配器只选择
 * “正文移除图片语法、图片作为附件发送”的 IM 展示形态。
 */

import {
  materializeMarkdownImages,
  type MarkdownImageMaterializeDeps,
} from '../../cindy-media/markdownImages';

export interface MaterializedLocalMarkdownImages {
  /** 已成功物化的媒体仓绝对路径，供 IM 渠道上传。 */
  absPaths: string[];
  /** 成功物化的图片语法替换为 alt，避免把本机路径发到聊天。 */
  text: string;
}

export async function materializeLocalMarkdownImages(
  params: {
    text: string;
    workingDir: string;
    sessionId: string;
    maxImages?: number;
    maxImageBytes?: number;
    /** 已由 tool_result side-channel 收集的图片；参与总数限制与去重。 */
    existingAbsPaths?: string[];
  },
  deps?: MarkdownImageMaterializeDeps,
): Promise<MaterializedLocalMarkdownImages> {
  const materialized = await materializeMarkdownImages(params, deps);
  return {
    absPaths: materialized.absPaths,
    text: materialized.textWithoutImages,
  };
}
