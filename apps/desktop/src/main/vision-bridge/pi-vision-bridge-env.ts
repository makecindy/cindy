/**
 * pi-vision-bridge-env —— 层 C：把视觉桥后端解析成注入 pi 子进程的 env。
 *
 * cindy-bridge 跑在 pi 子进程（自包含，不能 import 任何 Cindy 模块），视觉 API 凭证
 * 只能经 env 传递。本模块在 host 侧解析视觉桥配置（主/fallback 后端 → 三协议端点 +
 * model + key + wireProtocol），序列化成单个 JSON env（`CINDY_PI_VISION_BRIDGE`），
 * PiAgent 把它注入 spawnEnv 并纳入 piSecretEnvNames 剥离面（防获批 bash 读到 API key）。
 *
 * 对齐 docs/vision-bridge-design.md 层 C + 五、视觉通道。
 */
import { readVisionBridgeSettings } from './vision-bridge-settings-store.js';
import { getVisionBridgeController } from './vision-bridge-controller.js';
import {
  resolveVisionBackendEndpoint,
  VisionBackendError,
  type VisionChannelDeps,
} from './vision-channel.js';

/** cindy-bridge 读取的 env 键名（含 API key，须进 piSecretEnvNames）。 */
export const PI_VISION_BRIDGE_ENV = 'CINDY_PI_VISION_BRIDGE';

export interface PiVisionBackendSpec {
  baseUrl: string;
  requestPath: string;
  model: string;
  /** Authorization 头值（Bearer <key>），无鉴权为 null。 */
  authorization: string | null;
  /** 路由指定额外头（headerOverride 去客户端凭证头），pi 子进程请求须合并，
   *  否则 anthropic-version / x-api-key / 自定义 provider 头丢失被后端拒。 */
  headers: Record<string, string>;
  /** wire 协议（决定 pi 子进程请求体/响应解析形态）。 */
  wireProtocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
}

export interface PiVisionBridgeEnvPayload {
  enabled: boolean;
  primary: PiVisionBackendSpec | null;
  fallback: PiVisionBackendSpec | null;
}

function resolveSpec(
  providerId: string,
  modelId: string,
  deps: VisionChannelDeps,
): PiVisionBackendSpec | null {
  try {
    const ep = resolveVisionBackendEndpoint(providerId, modelId, deps);
    return {
      baseUrl: ep.upstream,
      requestPath: ep.requestPath,
      model: ep.model,
      authorization: ep.authorization,
      headers: ep.headers,
      wireProtocol: ep.wireProtocol,
    };
  } catch (err) {
    if (err instanceof VisionBackendError) return null;
    return null;
  }
}

/**
 * 解析当前视觉桥配置 → pi 子进程 env。未启用 / 无主后端 / 主后端不可解析 /
 * 当前模型未命中视觉桥目标（controller.shouldBridge）→ 返回 null
 * （bridge 不注册 vision 工具，零干扰——非目标 Pi 模型不因别的模型配置了视觉桥
 * 而改变工具面）。
 */
export function buildPiVisionBridgeEnv(
  deps: VisionChannelDeps,
  model: string,
): Record<string, string> | null {
  const settings = readVisionBridgeSettings();
  if (!settings.enabled) return null;
  if (!settings.primary) return null;
  // 按 session model 判定（与层 B / 层 A 同源 shouldBridge）：未命中目标模型
  // 不注入 env、不注册 vision 工具（codex P1 零干扰要求）。
  if (!getVisionBridgeController()?.shouldBridge(model)) return null;
  const primary = resolveSpec(settings.primary.providerId, settings.primary.modelId, deps);
  if (!primary) return null;
  const fallback = settings.fallback
    ? resolveSpec(settings.fallback.providerId, settings.fallback.modelId, deps)
    : null;
  const payload: PiVisionBridgeEnvPayload = {
    enabled: true,
    primary,
    fallback,
  };
  return { [PI_VISION_BRIDGE_ENV]: JSON.stringify(payload) };
}
