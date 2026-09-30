import type { RecoveryRule } from './types.js';

/**
 * 自定义 Anthropic 兼容网关拒绝当前推理档位时的 400 文本(#5032 实测,与 Codex 侧
 * vLLM Responses 规则命中的是同一族网关;那边改写的是 Responses 的 `reasoning.effort`,
 * 这里只处理 Anthropic Messages 的 `output_config.effort`)。只匹配这一精确形态,
 * 官方 Claude / 订阅直连不会返回该文本,字节保持不变。
 */
const UNSUPPORTED_REASONING_EFFORT_RE =
  /Unexpected reasoning effort [\w-]+\. Supported types are /i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 从 Anthropic Messages 请求体里省略 `output_config.effort`,其它字段原样保留。
 *
 * 能力未声明的自定义模型不该收到客户端偏好(#4860 出站不变量):Claude Code 子进程在
 * Cindy 不下发档位时会沿用自身默认 `high`,兼容网关只认 xhigh/medium/low 之类集合就会
 * 400。重试时把偏好省掉,让网关按自己的默认档执行,而不是猜一个它可能也不认的值。
 * 非 Messages 形态(无 `messages` 数组,例如 Responses)不处理,交给对应规则。
 */
export function omitUnsupportedAnthropicEffort(body: unknown): object | null {
  if (!isRecord(body) || !Array.isArray(body.messages)) return null;
  const outputConfig = body.output_config;
  if (!isRecord(outputConfig) || typeof outputConfig.effort !== 'string') return null;
  const { effort: _rejected, ...rest } = outputConfig;
  const next: Record<string, unknown> = { ...body };
  if (Object.keys(rest).length > 0) next.output_config = rest;
  else delete next.output_config;
  return next;
}

export function createAnthropicEffortCompatibilityRule(): RecoveryRule {
  return {
    id: 'anthropic_effort_compat',
    enabled: () => true,
    matches: (errorText) => UNSUPPORTED_REASONING_EFFORT_RE.test(errorText),
    strip: (body) => {
      try {
        const next = omitUnsupportedAnthropicEffort(JSON.parse(body.toString('utf8')));
        return next ? Buffer.from(JSON.stringify(next), 'utf8') : null;
      } catch {
        return null;
      }
    },
    // 语义绑在特定网关的拒绝文本上,别的 400 重试时不能顺手删掉用户档位。
    applyOnUnmatchedRetry: false,
    // 网关只拒绝了档位:本规则作主匹配时不叠加 encrypted_content 等其它清理,
    // 否则重试会顺手改写工具调用历史里网关并未拒绝的字段(review P1)。
    allowExtraRules: false,
  };
}
