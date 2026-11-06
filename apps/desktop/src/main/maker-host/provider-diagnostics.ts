/**
 * provider-diagnostics —— 供应商「测试连接」探测（设置页 / 自定义供应商表单消费）。
 *
 * 设计要点：
 *   - **探测与真实会话同路由口径**：saved 模式从 active-catalog 取该供应商的 RoutingDescriptor
 *     （upstream / headerOverride）+ safeStorage 里的 per-runtime API key，与 provider-route.ts
 *     的 `api-key-header` 分支构造相同的 header 组合（cc 同时覆盖 x-api-key + authorization，
 *     codex 只覆盖 authorization）——测通了 = 真实请求也走得通，比裸 HEAD 探测可信。
 *   - **adhoc 模式**支持表单未保存值直接测（baseUrl / modelId / key 内存透传，不落任何盘）。
 *   - 最小探测请求：cc wire = `POST /v1/messages`（max_tokens=1）；codex wire = `POST /responses`
 *     （max_output_tokens=16, stream=false）。10s 超时。
 *   - 结果判定走 shared/providerErrors 的结构化分类器（与 Phase 2 会话内上游错误同一套口径）。
 *   - fetch 可注入（单测不联网）；key 读取器可注入（不直接 import safeStorage，模式同
 *     provider-route.setCustomProviderKeyReader，host 在 register 时接通）。
 */

import {
  appendProviderRequestPath,
  providerModelRecord,
  providerPresetModelRecord,
  providerWireProtocolForApi,
  type PiModelApi,
  type ProviderModelRecord,
  isAgentSelectableModel,
  isLoopbackProviderUrl,
  type AgentKind,
  type ProviderWireProtocol,
} from '@cindy/model-providers';
import { joinAnthropicMessagesUrl } from '@cindy/responses-anthropic-bridge';

import {
  classifyProviderError,
  type ProviderErrorClassification,
  type ProviderErrorCode,
} from '../../shared/providerErrors.js';
import { getActiveCatalog } from './active-catalog.js';
import { withOpenCodeGoSessionHeader } from './opencode-go-session.js';
import { withProviderAppAttribution } from './provider-app-attribution.js';
import { createMakerLogger } from './logger-adapter.js';
import { outboundFetch } from './outbound-fetch.js';
import { hostCredentialEndpointAllowed, invocationModelRecord, probePiProvider, requiresNativeProviderAuth } from './pi-provider-transport.js';
import { buildRouteDecision, providerRoutingForModel } from './provider-route.js';

import type { ProviderConnectionTestInput, ProviderConnectionTestResult } from '../../shared/providerConnectionTest.js';
import { probeProviderProtocols } from './provider-protocol-probe.js';

const log = createMakerLogger('provider-probe');

/** 探测请求超时。 */
const PROBE_TIMEOUT_MS = 10_000;
/** 失败响应体最多读取的字节数（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;
/**
 * 「测试连接」探针的 system 载荷（#9000）。少数第三方中转在 /v1/messages 上静默丢弃
 * `system`：请求照常 200、流也正常结束，但 agent 的指令与工具规范全部没生效，长任务
 * 会表现为反复无效调用。探针因此自带一段固定长度的填充，再用响应 usage 反证它是否
 * 真的计入了输入 token —— 一次用户主动触发的测试，不进入正常会话启动路径。
 */
const PROBE_SYSTEM_FILLER_CHARS = 3_600;
function buildProbeSystemFiller(targetChars: number): string {
  const words = ['probe', 'system', 'prefix', 'relay', 'budget', 'window', 'stream', 'token'];
  let filler = '';
  for (let index = 0; filler.length < targetChars; index += 1) {
    filler += `${words[index % words.length]}${index % 97} `;
  }
  return filler.trim();
}
/** 探针 body 里 system 的完整文本（填充 + 一句可验证指令）。 */
export const PROBE_SYSTEM_TEXT = `Reply with the single word: pong. ${buildProbeSystemFiller(PROBE_SYSTEM_FILLER_CHARS)}`;
/**
 * system 生效时 input_tokens 至少应有的下限。英文约 1 token / 4 字符，这里只取 1/10 留足
 * 余量：正常上游约 900+，丢弃 system 的上游只剩 ping 的个位数到几十。
 */
export const PROBE_SYSTEM_MIN_INPUT_TOKENS = Math.floor(PROBE_SYSTEM_TEXT.length / 10);
