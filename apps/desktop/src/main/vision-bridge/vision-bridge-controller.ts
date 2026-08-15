/**
 * vision-bridge-controller —— 视觉桥能力的可变引用（层 A proxy transform 用）。
 *
 * proxy 在 splash 阶段先于 Maker 创建，而视觉桥能力（配置判定 + 描述）在 Maker 创建时
 * 才装配。用「可变 controller + setter 注入」桥接两者：
 *  - proxy host 创建 proxy 时，transform 链里加 buildVisionBridgeProxyTransform()；
 *  - 未注入（视觉桥未装配）→ shouldBridge 恒 false → transform 短路透传（零干扰）；
 *  - Maker 创建时 setVisionBridgeController(createVisionBridge(...)) 激活。
 *
 * 对齐 maker-host 里 setClaudeProxyGatewayKeyReader 的注入套路。
 */
import { createVisionBridgeTransform, type ProxyLogger, type RequestTransform } from '@cindy/anthropic-compat-proxy';

/** 视觉桥 transform 所需的两个能力（对应 createVisionBridge 的 isTargetModel / describeImage）。 */
export interface VisionBridgeController {
  shouldBridge(model: string): boolean;
  /**
   * 描述一张图。imageUrl（data:/http(s): URL）与 imagePath（本地绝对路径）二选一；
   * 供层 A proxy transform（imageUrl 形态）与 ghost 工具结果描述（imagePath 形态）复用。
   * signal 可选：调用方取消（如工具结果描述的总预算超时）时中止未完成的视觉请求。
   */
  describeImage(input: {
    imageUrl?: string;
    imagePath?: string;
    prompt: string;
    signal?: AbortSignal;
  }): Promise<string>;
}

let _controller: VisionBridgeController | null = null;

/** Maker 装配时注入。重复调用以最后一次为准。 */
export function setVisionBridgeController(controller: VisionBridgeController | null): void {
  _controller = controller;
}

/** 返回当前 controller（未注入 = null）。 */
export function getVisionBridgeController(): VisionBridgeController | null {
  return _controller;
}

/**
 * 构建一个始终有效的视觉桥 RequestTransform。controller 未注入时 shouldBridge 恒 false，
 * transform 短路返回 null（字节透传）。用于 proxy host 装配 transformRequest 链。
 */
export function buildVisionBridgeProxyTransform(logger?: ProxyLogger): RequestTransform {
  return createVisionBridgeTransform({
    shouldBridge: (model) => _controller?.shouldBridge(model) ?? false,
    describeImage: (input) => {
      if (!_controller) {
        return Promise.reject(new Error('vision bridge not configured'));
      }
      return _controller.describeImage(input);
    },
    // 传入 proxy logger：transform 失败时记 warn 到 cc-proxy / codex proxy 日志
    // （之前未注入 → 失败静默无日志）。
    logger,
  });
}
