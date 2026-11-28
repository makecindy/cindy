import { isOpenAiSubscriptionProvider, type Provider } from '@cindy/model-providers';
import type { ProviderErrorCode } from './providerErrors.js';
import type { ProviderBillingCode } from '@cindy/maker-shared/error-redaction';
import type { ProviderGroupConfig } from './providerGroup.js';

export function isOpenAiApiEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === 'https://api.openai.com' && /^\/v1\/?$/.test(url.pathname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function openAiAccountGroupKind(provider: Provider): 'subscription' | 'apiKey' | undefined {
  if (isOpenAiSubscriptionProvider(provider)) return 'subscription';
  if (provider.source === 'user' && provider.auth.method === 'apiKey'
    && Object.values(provider.routing).some(route => route.authStrategy === 'api-key-header' && !route.disabled
      && isOpenAiApiEndpoint(route.upstream))) return 'apiKey';
}

export interface OpenAiGroupProbeResult {
  ok: boolean;
  code?: ProviderErrorCode | 'NO_TEST_MODEL';
  billingCode?: ProviderBillingCode;
}

/** `ok` is membership persistence, not authentication or billing readiness. */
export interface OpenAiGroupMergeResult {
  ok: boolean;
  code?: OpenAiGroupProbeResult['code'];
  billingCode?: ProviderBillingCode;
  /** A saved membership may still have a confirmed billing refusal. */
  probe?: OpenAiGroupProbeResult;
}

export type OpenAiGroupApiAgent = 'codex' | 'pi';

export interface OpenAiGroupAccount {
  id: string;
  name: string;
  kind: 'subscription' | 'apiKey';
  included: boolean;
  connected: boolean;
  groupName?: string;
  mergeTarget?: true;
  checks?: { agent: OpenAiGroupApiAgent; result?: OpenAiGroupProbeResult; blocked?: true }[];
}

export interface OpenAiGroupAccountDetail {
  /** Candidates scoped to the connection from which the user opened settings. */
  accounts: OpenAiGroupAccount[];
  /** The allocation target and its rows come from the same local snapshot. */
  group?: { providerId: string; config: ProviderGroupConfig; members: OpenAiGroupAccount[] };
  /** No implicit choice when a member belongs to several target groups. */
  targets?: { id: string; name: string }[];
}
