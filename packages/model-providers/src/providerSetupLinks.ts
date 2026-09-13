import type { ProviderPreset } from './types.js';
import { sourceProviderForPreset } from './providerPresetIdentity.js';

export interface ProviderSetupLink {
  url: string;
  kind: 'apiKey' | 'account' | 'setup';
}

// Official account destinations, checked 2026-09-13. Never derive an account URL
// from an inference endpoint. Region and subscription products have distinct keys.
const key = (url: string): ProviderSetupLink => ({ url, kind: 'apiKey' });
const account = (url: string): ProviderSetupLink => ({ url, kind: 'account' });
const links: Record<string, ProviderSetupLink> = {
  anthropic: key('https://console.anthropic.com/settings/keys'),
  openai: key('https://platform.openai.com/api-keys'),
  xai: key('https://console.x.ai/team/default/api-keys'),
  openrouter: key('https://openrouter.ai/settings/keys'),
  deepseek: key('https://platform.deepseek.com/api_keys'),
  'zhipu-glm-cn': key('https://bigmodel.cn/usercenter/proj-mgmt/apikeys'),
  'zhipu-glm-global': key('https://z.ai/manage-apikey/apikey-list'),
  'zai-coding-cn': key('https://bigmodel.cn/usercenter/proj-mgmt/apikeys'),
  zai: key('https://z.ai/manage-apikey/apikey-list'),
  moonshotai: key('https://platform.kimi.ai/console/api-keys'),
  'moonshotai-cn': key('https://platform.moonshot.cn/console/api-keys'),
  'kimi-coding': account('https://www.kimi.com/code/console'),
  minimax: key('https://platform.minimax.io/user-center/basic-information/interface-key'),
  'minimax-cn': key('https://platform.minimaxi.com/user-center/basic-information/interface-key'),
  google: key('https://aistudio.google.com/apikey'),
  'aliyun-bailian-coding': key('https://bailian.console.aliyun.com/cn-beijing/?tab=plan#/efm/subscription/coding-plan'),
  'qwen-token-plan-cn': key('https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal'),
  'aliyun-bailian-token-plan-team-cn': key('https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/enterprise'),
  'qwen-token-plan': account('https://modelstudio.console.alibabacloud.com/'),
  'qwen-token-plan-individual': account('https://modelstudio.console.alibabacloud.com/'),
  xiaomi: account('https://platform.xiaomimimo.com/'),
  'xiaomi-token-plan-cn': key('https://platform.xiaomimimo.com/token-plan'),
  'xiaomi-token-plan-ams': key('https://platform.xiaomimimo.com/token-plan'),
  'xiaomi-token-plan-sgp': key('https://platform.xiaomimimo.com/token-plan'),
  longcat: key('https://longcat.chat/platform/api_keys'),
  'volcengine-agent-plan': account('https://console.volcengine.com/ark/'),
  'volcengine-coding-plan': account('https://console.volcengine.com/ark/'),
  'tencentcloud-coding-plan': account('https://console.cloud.tencent.com/'),
  opencode: account('https://opencode.ai/auth'),
  'opencode-go': account('https://opencode.ai/auth'),
  'vercel-ai-gateway': key('https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys'),
  'amazon-bedrock': account('https://console.aws.amazon.com/bedrock/'),
  'azure-openai-responses': account('https://ai.azure.com/'),
  'google-vertex': account('https://console.cloud.google.com/vertex-ai'),
  'cloudflare-ai-gateway': account('https://dash.cloudflare.com/'),
  'cloudflare-workers-ai': key('https://dash.cloudflare.com/profile/api-tokens'),
  'github-copilot': account('https://github.com/settings/copilot'),
  'ant-ling': account('https://chat.ant-ling.com/open'),
  baseten: key('https://app.baseten.co/settings/api_keys'),
  cerebras: account('https://cloud.cerebras.ai/'),
  fireworks: key('https://app.fireworks.ai/settings/users/api-keys'),
  groq: key('https://console.groq.com/keys'),
  huggingface: key('https://huggingface.co/settings/tokens'),
  nvidia: account('https://build.nvidia.com/'),
  together: key('https://api.together.ai/settings/projects/~current/api-keys'),
  mistral: key('https://console.mistral.ai/api-keys'),
  nous: account('https://portal.nousresearch.com/'),
};

/** Shared by local and remote settings; old catalogs inherit the maintained links. */
export function providerSetupLink(preset: Pick<ProviderPreset, 'id' | 'docsUrl' | 'authMethod'>): ProviderSetupLink | undefined {
  const link = links[sourceProviderForPreset(preset.id)];
  if (link) return link;
  // Local servers have no provider account. Keep their setup help without asking for a cloud key.
  if (['litellm', 'lmstudio', 'llamacpp', 'vllm'].includes(preset.id) && preset.docsUrl) {
    return { url: preset.docsUrl, kind: 'setup' };
  }
  return undefined;
}
