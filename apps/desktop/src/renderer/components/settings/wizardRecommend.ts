import type { LocalCliId } from '../../../shared/localCliDetect';

export type WizardRecommendReason =
  | 'has-local-models'
  | 'machine-capable'
  | 'cli-logged-in'
  | 'cli-installed'
  | 'subscription';

export type WizardRecommend =
  | { kind: 'ollama'; reason: 'has-local-models' | 'machine-capable' }
  | { kind: 'oauth'; providerId: string; reason: 'subscription' }
  | {
      kind: 'oauth';
      providerId: string;
      reason: 'cli-logged-in' | 'cli-installed';
      cli: LocalCliId;
    };

export type WizardCliCandidate = {
  providerId: string;
  loggedIn: boolean;
  cli: LocalCliId;
};

const LOCAL_MEMORY_FLOOR_GB = 16;
const MAX_RECOMMENDATIONS = 3;

function pickOllamaRecommend(input: {
  ollamaAlreadyAdded: boolean;
  ollamaAppInstalled: boolean;
  installedLocalModelCount: number;
  memoryGb: number;
}): Extract<WizardRecommend, { kind: 'ollama' }> | null {
  if (input.ollamaAlreadyAdded) return null;
  if (input.installedLocalModelCount > 0) {
    return { kind: 'ollama', reason: 'has-local-models' };
  }
  if (input.memoryGb >= LOCAL_MEMORY_FLOOR_GB) {
    return { kind: 'ollama', reason: 'machine-capable' };
  }
  if (input.memoryGb <= 0 && input.ollamaAppInstalled) {
    return { kind: 'ollama', reason: 'machine-capable' };
  }
  return null;
}

/**
 * 向导「推荐」短列表：本机模型优先，其次本机已装且未连接的官方 CLI 授权，
 * 都没有才回落第一个未连接订阅。最多 3 条，已添加的供应商不再出现。
 */
export function pickWizardRecommend(input: {
  ollamaAlreadyAdded: boolean;
  ollamaAppInstalled: boolean;
  installedLocalModelCount: number;
  memoryGb: number;
  connectedProviderIds?: readonly string[];
  cliCandidates?: readonly WizardCliCandidate[];
  fallbackOauthProviderId?: string | null;
}): WizardRecommend[] {
  const connected = new Set(input.connectedProviderIds ?? []);
  const items: WizardRecommend[] = [];

  const ollama = pickOllamaRecommend(input);
  if (ollama) items.push(ollama);

  for (const cli of input.cliCandidates ?? []) {
    if (items.length >= MAX_RECOMMENDATIONS) break;
    if (!cli.providerId || connected.has(cli.providerId)) continue;
    if (items.some((item) => item.kind === 'oauth' && item.providerId === cli.providerId)) {
      continue;
    }
    items.push({
      kind: 'oauth',
      providerId: cli.providerId,
      reason: cli.loggedIn ? 'cli-logged-in' : 'cli-installed',
      cli: cli.cli,
    });
  }

  if (
    items.length === 0 &&
    input.fallbackOauthProviderId &&
    !connected.has(input.fallbackOauthProviderId)
  ) {
    items.push({
      kind: 'oauth',
      providerId: input.fallbackOauthProviderId,
      reason: 'subscription',
    });
  }

  return items;
}
