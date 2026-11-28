import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { storedCustomProviderId, type CustomProviderConfig } from '@cindy/model-providers';

import { Button } from '@/components/ui/button';
import { OAuthBrowserLink, OAuthDeviceCodeCard } from '@/components/settings/OAuthDeviceCodeCard';
import { SettingsTextInput } from '@/components/settings/SettingsTextInput';
import type { ProviderSetupSource } from '@/components/settings/providerSetupSource';
import type { ManagementItem, ManagementResult } from '../../../shared/settingsManagement';
import {
  CLOUD_PROVIDER_SETUP_ITEM,
  type CloudProviderSetupKind,
  type CloudProviderSetupSecrets,
  type CloudProviderSettingsWriteReceipt,
} from '../../../shared/cloudProviderSettings';
import type { CloudProviderWrite } from './cloudProviderCatalog';
import type { useCloudAuthorization } from './useCloudAuthorization';
import { CloudAuthProgress } from './CloudAuthProgress';

type Auth = ReturnType<typeof useCloudAuthorization>;
type Phase = Extract<ManagementResult, { kind: 'operation' }>['phase'];
type Agent = 'claude-code' | 'codex' | 'pi';
const AGENTS: Agent[] = ['claude-code', 'codex', 'pi'];

const hasHeaders = (headers: unknown) =>
  !!headers && typeof headers === 'object' && Object.keys(headers).length > 0;

/** Request headers move from the configuration into the secrets; keys never stay inline. */
export function splitProviderSecrets(
  config: CustomProviderConfig,
  keys: Partial<Record<Agent, string>> = {},
): { config: CustomProviderConfig; secrets: CloudProviderSetupSecrets | null } {
  const runtimes = { ...config.runtimes };
  const runtimeHeaders: CloudProviderSetupSecrets['runtimeHeaders'] = {};
  for (const agent of AGENTS) {
    const runtime = runtimes[agent];
    if (!runtime || !hasHeaders(runtime.headers)) continue;
    const { headers, ...rest } = runtime;
    runtimeHeaders[agent] = headers;
    runtimes[agent] = rest;
  }
  const filledKeys = Object.fromEntries(
    Object.entries(keys).filter((entry): entry is [Agent, string] => !!entry[1]),
  );
  const secret = Object.keys(runtimeHeaders).length > 0 || Object.keys(filledKeys).length > 0;
  return {
    config: { ...config, runtimes },
    secrets: secret
      ? {
          ...(Object.keys(filledKeys).length ? { keys: filledKeys } : {}),
          ...(Object.keys(runtimeHeaders).length ? { runtimeHeaders } : {}),
        }
      : null,
  };
}

/** API key and request headers of a probe; the rest is staged in the clear. */
function splitProbe<T extends { apiKey?: string | null; headers?: Record<string, string> }>(
  input: T,
): { request: Omit<T, 'apiKey' | 'headers'>; secrets: CloudProviderSetupSecrets | null } {
  const { apiKey, headers, ...request } = input;
  const secrets = {
    ...(apiKey ? { apiKey } : {}),
    ...(headers && hasHeaders(headers) ? { headers } : {}),
  };
  return { request, secrets: Object.keys(secrets).length ? secrets : null };
}

/**
 * The cloud instance as the wizard's and connection form's setup source. Steps without
 * secrets use the private channel; API keys, request headers and sign-ins run on the
 * instance's setup ticket, whose sign-in prompt the wizard shows.
 */
export function useCloudProviderSetup({
  supported,
  send,
  auth,
}: {
  supported: boolean;
  send: (request: CloudProviderWrite) => Promise<CloudProviderSettingsWriteReceipt>;
  auth: Auth;
}): {
  source: ProviderSetupSource | null;
  /** The instance's own Claude Code, Codex or Grok sign-in (the detail header's button). */
  nativeLogin(
    agent: 'claude' | 'codex' | 'xai',
    method?: 'browser' | 'device',
  ): Promise<{ ok: boolean; reason?: string }>;
} {
  const sendRef = useRef(send);
  sendRef.current = send;
  const authRef = useRef(auth);
  authRef.current = auth;
  // A ticket runs once; a used one is replaced by listing again.
  const used = useRef(new Set<string>());
  const value = async <T,>(request: CloudProviderWrite): Promise<T> =>
    (await sendRef.current(request)).value as T;
  // The instance runs one ticket operation at a time and refuses an overlapping one, while
  // the local form freely saves during a detection. Queue them and wait until it is idle.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const detectTurn = useRef(0);
  const idle = async () => {
    for (const until = Date.now() + 60_000; Date.now() < until;) {
      if (!authRef.current.requesting && !authRef.current.busy) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('SETUP_BUSY');
  };

  /** Resolves undefined when `wanted` says a newer request superseded it before its turn. */
  const apply = (
    kind: CloudProviderSetupKind,
    request: Record<string, unknown>,
    secrets: CloudProviderSetupSecrets | null = null,
    wanted: () => boolean = () => true,
  ): Promise<unknown> => {
    const next = queue.current.then(() =>
      wanted() ? applyNow(kind, request, secrets) : undefined,
    );
    queue.current = next.catch(() => undefined);
    return next;
  };
  const applyNow = async (
    kind: CloudProviderSetupKind,
    request: Record<string, unknown>,
    secrets: CloudProviderSetupSecrets | null,
  ): Promise<unknown> => {
    const { stageId } = await value<{ stageId: string }>({ op: 'setup-stage', kind, request });
    await idle();
    const find = (items: ManagementItem[] | undefined) =>
      items?.find((item) => item.id === CLOUD_PROVIDER_SETUP_ITEM);
    let item = find(authRef.current.items);
    // Tickets expire after a few minutes and run once; list again for a fresh one.
    const stale = (candidate: ManagementItem | undefined) =>
      !candidate?.actions[0] ||
      used.current.has(candidate.actions[0].id) ||
      candidate.actions[0].expiresAt <= Date.now() + 30_000;
    if (stale(item)) item = find(await authRef.current.load());
    const action = item?.actions[0];
    if (!item || !action || stale(item)) throw new Error('SETUP_UNAVAILABLE');
    used.current.add(action.id);
    const phase = await new Promise<Phase>(
      (resolve) =>
        void authRef.current.run(
          item!,
          action,
          { stage: stageId, ...(secrets ? { secrets: JSON.stringify(secrets) } : {}) },
          { confirmed: true, settled: resolve },
        ),
    );
    if (phase !== 'succeeded') throw new Error(`SETUP_${phase.toUpperCase()}`);
    const result = await value<{ status: string; value?: unknown }>({
      op: 'setup-result',
      stageId,
    });
    if (result.status !== 'done') throw new Error('SETUP_FAILED');
    return result.value;
  };
  const nativeLogin = async (
    agent: 'claude' | 'codex' | 'xai',
    method?: 'browser' | 'device',
  ): Promise<{ ok: boolean; reason?: string }> => {
    const result = (await apply('native-login', {
      agent,
      ...(method ? { method } : {}),
    })) as { ok?: boolean; authenticated?: boolean; reason?: string } | null;
    return {
      ok: result?.ok === true || result?.authenticated === true,
      ...(result?.reason ? { reason: result.reason } : {}),
    };
  };
  const cancel = () => {
    const current = authRef.current;
    if (current.operationItem === CLOUD_PROVIDER_SETUP_ITEM && current.busy)
      void current.operate('cancel');
  };

  const methods = useMemo<Omit<ProviderSetupSource, 'loginPrompt'>>(
    () => ({
      localRuntimes: false,
      listProviderPresets: () => value({ op: 'presets' }),
      scanLocalCli: () => value({ op: 'cli-scan' }),
      readProvider: (providerId) => value({ op: 'provider-view', providerId }),
      async fetchProviderModels(input) {
        const { request, secrets } = splitProbe(input);
        return (
          secrets
            ? apply('models-fetch', request, secrets)
            : value({ op: 'models-fetch', request: input })
        ) as never;
      },
      async detectProvider(input) {
        // A started remote detection cannot be withdrawn; the form ignores a superseded result.
        // Withdrawing still skips a keyed detection that is queued and has not started.
        if ('cancel' in input) {
          detectTurn.current++;
          return { candidates: [], reason: 'insufficient_evidence' };
        }
        const { request, secrets } = splitProbe(input);
        if (!secrets) return value({ op: 'detect', request: input }) as never;
        // Only the latest keyed detection spends a ticket; queued older ones are skipped.
        const turn = ++detectTurn.current;
        return ((await apply('detect', request, secrets, () => turn === detectTurn.current)) ?? {
          candidates: [],
          reason: 'insufficient_evidence',
        }) as never;
      },
      async testProviderConnection(input) {
        if (input.kind === 'cancel')
          return { ok: false, latencyMs: 0, decision: 'cancelled' as const };
        if (input.kind === 'adhoc') {
          const { request: spec, secrets } = splitProbe(input.spec);
          if (secrets) return apply('test-connection', { ...input, spec }, secrets) as never;
        }
        return value({ op: 'test-connection', request: input as never }) as never;
      },
      async builtinApiKeyStore(providerId, apiKey) {
        await apply('builtin-key', { providerId }, { apiKey });
      },
      async createCustomProvider(config, keys, options) {
        const split = splitProviderSecrets(config, keys);
        return (
          split.secrets
            ? apply('custom-create', { config: split.config, options }, split.secrets)
            : value({ op: 'custom-create', config: config as never, options })
        ) as never;
      },
      async updateCustomProvider(config, keys, options) {
        const stored = { ...config, id: storedCustomProviderId(config.id) };
        const split = splitProviderSecrets(stored, keys);
        return (
          split.secrets
            ? apply('custom-update', { config: split.config, options }, split.secrets)
            : value({ op: 'custom-update', config: stored as never, options })
        ) as never;
      },
      deleteCustomProvider: (providerId) =>
        value({ op: 'custom-delete', providerId: storedCustomProviderId(providerId) }),
      async readCustomProviderKey() {
        // Saved keys stay on the instance; the form asks again only when an endpoint changes.
        throw new Error('KEY_ON_INSTANCE');
      },
      async providerOAuthLogin(providerId, options) {
        try {
          return (await apply('oauth-login', {
            providerId,
            ...(options?.method ? { method: options.method } : {}),
          })) as { ok: boolean; reason?: string };
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'SETUP_FAILED') throw error;
          // The sign-in did not finish: a real failure, which the shared wizard says in its own
          // words, 「X 登录失败，请重试」.
          return { ok: false, reason: 'login_failed' };
        }
      },
      async providerOAuthCancel() {
        cancel();
        return { ok: true as const };
      },
      localAccountLogin: (kind) => nativeLogin(kind),
      cancelLocalAccountLogin: cancel,
    }),
    // Methods read the latest catalog and tickets through refs.
    [],
  );

  return {
    source: supported
      ? {
          ...methods,
          loginPrompt:
            auth.operationItem === CLOUD_PROVIDER_SETUP_ITEM ? (
              <CloudLoginPrompt auth={auth} />
            ) : null,
        }
      : null,
    nativeLogin,
  };
}

/** A running sign-in on the instance: device code, browser link, or the callback form. */
export function CloudLoginPrompt({ auth, disabled = false }: { auth: Auth; disabled?: boolean }) {
  const { t } = useTranslation();
  const prompt = auth.prompt;
  if (prompt?.kind === 'device' && prompt.userCode)
    return (
      <OAuthDeviceCodeCard
        deviceCode={{
          verificationUrl: prompt.url,
          userCode: prompt.userCode,
          expiresAt: prompt.expiresAt,
        }}
        onOpen={auth.open}
      />
    );
  if (prompt)
    return (
      <div className="flex flex-col gap-2">
        <OAuthBrowserLink url={prompt.url} onOpen={auth.open} />
        {prompt.kind === 'callback' && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (auth.callback.trim()) void auth.operate('respond');
            }}
          >
            <SettingsTextInput
              aria-label={t('cloudSettings.authCallback')}
              type="password"
              autoComplete="off"
              value={auth.callback}
              onChange={auth.setCallback}
              disabled={disabled}
            />
            <div>
              <Button
                type="submit"
                variant="secondary"
                size="md"
                disabled={disabled || !auth.callback.trim()}
              >
                {t('cloudSettings.authContinue')}
              </Button>
            </div>
          </form>
        )}
      </div>
    );
  // Progress read back after an unknown result: what it is doing, or that it cannot be read.
  if (auth.settling)
    return (
      <CloudAuthProgress
        text={auth.phaseText}
        checking={auth.checking}
        unreadable={auth.progressUnreadable}
        disabled={disabled}
      />
    );
  return null;
}
