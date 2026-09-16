// Pre-migration UI behavior fixture only. Production presets come from the server.
import type { ProviderPreset } from '@cindy/model-providers';

const ANTHROPIC_API_MODELS = [
  { id: 'claude-opus-5', defaultEnabled: true, name: 'Claude Opus 5', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', defaultEnabled: true, name: 'Claude Sonnet 5', contextWindow: 1_000_000 },
  { id: 'claude-haiku-4-5', defaultEnabled: true, name: 'Claude Haiku 4.5', contextWindow: 200_000 },
];
const OPENAI_API_MODELS = [
  { id: 'gpt-5.5', defaultEnabled: true, name: 'GPT-5.5' },
  { id: 'gpt-5.4-mini', defaultEnabled: true, name: 'GPT-5.4 mini' },
];
const XAI_API_MODELS = [
  { id: 'grok-4.6', defaultEnabled: true, name: 'Grok 4.6', contextWindow: 500_000 },
  { id: 'grok-4.5', defaultEnabled: true, name: 'Grok 4.5', contextWindow: 500_000 },
  { id: 'grok-4.3', defaultEnabled: true, name: 'Grok 4.3', contextWindow: 1_000_000 },
];

export const OFFICIAL_API_PRESETS: Record<string, ProviderPreset> = {
  anthropic: {
    id: 'anthropic-api',
    name: 'Anthropic API',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    runtimes: {
      'claude-code': {
        baseUrl: 'https://api.anthropic.com',
        // contextWindow 必须与目录(providers.json)一致:保存时它是窗口的唯一来源
        // (拉取的模型列表不带窗口),缺省会落 200k 默认 → toSdkModelString 剥掉
        // 1M 模型的 [1m] 路由,用户拿到 1/5 窗口。
        models: ANTHROPIC_API_MODELS,
      },
      // Codex 通过 Responses → Anthropic Messages 本地桥接访问同一官方 API。
      // 这不是 Claude.ai OAuth 路由：API key 由该 runtime 独立存储，出站只使用
      // x-api-key，Codex 自带的 OpenAI Authorization 永不透传到 Anthropic。
      codex: {
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: ANTHROPIC_API_MODELS,
      },
      pi: {
        wireProtocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        models: ANTHROPIC_API_MODELS,
      },
    },
  },
  openai: {
    id: 'openai-api',
    name: 'OpenAI API',
    docsUrl: 'https://platform.openai.com/api-keys',
    runtimes: {
      codex: {
        baseUrl: 'https://api.openai.com/v1',
        models: OPENAI_API_MODELS,
      },
      pi: {
        baseUrl: 'https://api.openai.com/v1',
        wireProtocol: 'openai-responses',
        models: OPENAI_API_MODELS,
      },
    },
  },
  xai: {
    id: 'xai-api',
    name: 'xAI API',
    docsUrl: 'https://console.x.ai',
    runtimes: {
      codex: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-chat',
        // contextWindow 必须与目录一致:拉取失败时 handleFinish 只读预设窗口,
        // 缺省会落 toCatalogModel 的 200k 默认。
        models: XAI_API_MODELS,
      },
      pi: {
        baseUrl: 'https://api.x.ai/v1',
        wireProtocol: 'openai-chat',
        models: XAI_API_MODELS,
      },
    },
  },
};
