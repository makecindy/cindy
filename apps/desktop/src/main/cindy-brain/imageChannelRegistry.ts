/**
 * imageChannelRegistry.ts — 图像执行通道的 per-provider 注册表(2026-07 图像多来源)。
 * [PROTOCOL]: 变更时更新此头部,然后检查 CLAUDE.md
 *
 * 背景:出图执行通道此前只有 XD 网关一条(gatewayImageClient 单例),目录里
 * 却允许任何供应商声明 imageModels——数据先行、通道缺席时,新模型会被原样发到
 * XD 网关打出确定性 4xx。本注册表把「哪个来源的模型由哪条通道、用哪份凭证执行」
 * 收口成单点:
 *
 *   - `ready()`:该来源的执行凭证是否就绪(xd = 网关能力,BYO key = key 已存)。
 *     cindyMediaCatalog 的白名单派生用它过滤——凭证未就绪的来源整段不进白名单,
 *     清单里绝不长出「可选但必失败」的型号。
 *   - `backend`:该来源的图像客户端(generate / edit)。派发端按白名单条目的
 *     providerId 归属取通道;**未注册的 providerId 视为不就绪**——即使目录数据
 *     先于通道代码合入(多 PR 乱序),新模型也只是不出现,不会错发到别家通道。
 *
 * 注册发生在 host 装配期(cindy-brain/index.ts);本模块零 IO、零 electron 依赖
 * (规则 14),单测直测。
 */

import type { GhostImageAspectRatio } from '../../shared/ghost.js';
import { sniffMediaMime } from '../cindy-media/sniffMediaMime.js';

/** 通道适配层的出参(decodeImageResponse 的入参:字节 base64;声明格式仅作参考)。 */
export interface ImageChannelResult {
  data: Array<{ b64_json?: string }>;
  output_format?: string;
}

/**
 * 图片通道响应 → 字节 + mime(所有来源 gen / edit 的统一解码口径)。
 * mime 由字节魔数(sniffMediaMime)决定,不信任上游声明的 output_format:
 * 上游或出站代理返回非图片字节时在此拒绝,不落 cindy-media、不挂作品账本
 * (媒体规则:自报格式不能单独作为可信依据)。
 */
export function decodeImageResponse(res: ImageChannelResult): { buffer: Buffer; mimeType: string } {
  const first = res.data[0];
  if (!first?.b64_json) throw new Error('图片通道返回为空');
  const buffer = Buffer.from(first.b64_json, 'base64');
  const sniffed = sniffMediaMime(buffer);
  if (!sniffed || !sniffed.startsWith('image/')) {
    throw new Error('图片通道返回的数据不是有效图片,本次生成已取消');
  }
  return { buffer, mimeType: sniffed };
}

/**
 * 单条图像执行通道。参数面收敛为「意识意图」级(aspectRatio 而非具体尺寸):
 * 意图 → 各家 wire 参数(gpt-image 的 size 枚举 / Gemini 的 imageConfig.aspectRatio)
 * 的翻译是通道自己的知识,不外泄给派发端。
 */
export interface ImageChannel {
  /** 执行凭证是否就绪。false ⇒ 该来源整段不进 cindy 白名单。 */
  ready(): boolean;
  /**
   * 该来源是否支持图像编辑(editImage)。
   * 省略视为 true;仅生成来源(xAI 等)显式设为 false 以从编辑清单排除,
   * 改图派发路径在出网前早失效。
   */
  supportsEdit?: boolean;
  generateImage(params: {
    model: string;
    prompt: string;
    aspectRatio?: GhostImageAspectRatio;
  }): Promise<ImageChannelResult>;
  editImage(params: {
    model: string;
    prompt: string;
    imagePaths: string[];
    aspectRatio?: GhostImageAspectRatio;
  }): Promise<ImageChannelResult>;
}

export class ImageChannelRegistry {
  private channels = new Map<string, ImageChannel>();

  register(providerId: string, channel: ImageChannel): void {
    if (this.channels.has(providerId)) {
      throw new Error(`image channel already registered for provider ${providerId}`);
    }
    this.channels.set(providerId, channel);
  }

  /** 白名单派生用:未注册 = 不就绪(目录数据先行时的乱序安全兜底)。 */
  isProviderReady(providerId: string): boolean {
    return this.channels.get(providerId)?.ready() === true;
  }

  /** 编辑操作清单派生用:就绪且 supportsEdit !== false。 */
  isProviderEditReady(providerId: string): boolean {
    const ch = this.channels.get(providerId);
    return ch?.ready() === true && ch.supportsEdit !== false;
  }

  /**
   * 派发用:取该来源的通道。未注册/未就绪时抛人话错——正常流程走不到这里
   * (白名单派生已过滤),走到即说明白名单与派发窗口之间凭证被移除。
   */
  resolve(providerId: string): ImageChannel {
    const channel = this.channels.get(providerId);
    if (!channel) {
      throw new Error(`图像来源 ${providerId} 没有可用的执行通道`);
    }
    if (!channel.ready()) {
      throw new Error(`图像来源 ${providerId} 的凭证未就绪,请先在设置中完成配置`);
    }
    return channel;
  }
}
