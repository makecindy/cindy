import {
  modelWithInterface,
  providerModelRecord,
  resolveRouteVisionCapability,
  type AgentKind,
  type CatalogModel,
  type ModelInterfaceSnapshot,
  type ProviderView,
  type VisionCapability,
} from '@cindy/model-providers';

export interface VisionRouteCapabilityOptions {
  upstream?: string;
  wireProtocol?: string;
  modelInterface?: ModelInterfaceSnapshot;
  /**
   * Codex `openai-chat` 线路是否经过了发送层原图白名单校验（如 chatBridgeCapabilitiesForRoute）。
   * 未传入时（如设置页静态视图），若为 user 自定义无 modelInterface 的 openai-chat 线路则保守视为 false。
   */
  codexChatImageForwardingAllowed?: boolean;
}

export function resolveEffectiveRouteModel(
  catalogModel: CatalogModel,
  modelInterface?: ModelInterfaceSnapshot,
): CatalogModel {
  return modelWithInterface(catalogModel, modelInterface ?? catalogModel.selectedInterface);
}

/**
 * 判断「未显式声明图片能力（metadata-free）」时，当前发送层线路是否允许原图转发。
 * 只有确认当前线路允许原图转发时才返回 true（允许走 id 兜底）；否则返回 false（保留视觉桥）。
 */
export function routeAllowsUnverifiedImageForwarding(
  provider: Pick<ProviderView, 'source' | 'routing'>,
  agent: AgentKind,
  catalogModel: CatalogModel,
  opts?: VisionRouteCapabilityOptions,
): boolean {
  const model = resolveEffectiveRouteModel(catalogModel, opts?.modelInterface);
  const baseRouting = provider.routing[agent];
  const upstream = opts?.upstream ?? catalogModel.route?.baseUrl ?? baseRouting?.upstream ?? '';
  const wireProtocol = opts?.wireProtocol ?? catalogModel.route?.wireProtocol ?? baseRouting?.wireProtocol;

  if (agent === 'claude-code') {
    // 与 attachClaudeProviderBridge 保持同源：
    // 进入 Claude provider bridge 且最终走 translateResponsesRequestWithContext（无 nativeFetch row 且为 openai-chat）时，
    // 发送层只有显式声明 supportsImageInput 才会开启 imageInput: 'image_url'；metadata-free 线路必须保留视觉桥。
    const entersBridge =
      provider.source === 'user' &&
      (wireProtocol === 'openai-chat' ||
        wireProtocol === 'openai-responses' ||
        (Boolean(model.api) && model.api !== 'anthropic-messages'));
    if (entersBridge) {
      const protocol = wireProtocol === 'openai-responses' ? 'openai-responses' : 'openai-chat';
      const hasNativeRow = Boolean(model.api || providerModelRecord(model.id, upstream, protocol));
      if (protocol === 'openai-chat' && !hasNativeRow) {
        return false;
      }
    }
    return true;
  }

  if (agent === 'codex') {
    if (wireProtocol === 'openai-chat' && !model.api) {
      if (opts?.codexChatImageForwardingAllowed !== undefined) {
        return opts.codexChatImageForwardingAllowed;
      }
      const selected = opts?.modelInterface ?? catalogModel.selectedInterface;
      if (selected) {
        return (
          selected.api === 'openai-completions' &&
          selected.compatibility.includes('chat-image-v1') &&
          selected.defaults.supportsImageInput === true
        );
      }
      return provider.source !== 'user';
    }
    return true;
  }

  return true;
}

/**
 * 统一判定一条 `(provider, agent, catalogModel)` 线路的视觉能力（设置页与发送层/视觉桥共用）。
 */
export function resolveProviderRouteVisionCapability(
  provider: Pick<ProviderView, 'source' | 'routing'>,
  agent: AgentKind,
  catalogModel: CatalogModel,
  opts?: VisionRouteCapabilityOptions,
): VisionCapability {
  const model = resolveEffectiveRouteModel(catalogModel, opts?.modelInterface);
  return resolveRouteVisionCapability(model, {
    allowsUnverifiedImageForwarding: routeAllowsUnverifiedImageForwarding(
      provider,
      agent,
      catalogModel,
      opts,
    ),
  });
}

/**
 * 跨线路聚合同一 modelId 的视觉能力：只要有任意有效线路不支持原图转发（no-vision），
 * 聚合结果即保留 'no-vision'，确保未自定义时默认勾选并在首次 toggleTarget 时 seed 进去。
 */
export function mergeVisionCapabilities(
  current: VisionCapability | undefined,
  next: VisionCapability,
): VisionCapability {
  if (!current) return next;
  if (current === 'no-vision' || next === 'no-vision') return 'no-vision';
  if (current === 'vision' || next === 'vision') return 'vision';
  return 'unknown';
}
