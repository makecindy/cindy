/**
 * Static assembly seam for the ChatGPT subscription image channel.
 *
 * cindy-brain must not runtime-import the full maker-host auth graph: Rollup would
 * emit a lazy chunk that can re-enter the Desktop Main bundle. bootstrap-electron
 * wires these callbacks from its existing static maker-host imports before IPC
 * registration, while tests can exercise the image channel without that graph.
 */
import { isOpenAiSubscriptionProvider, isOrganizationManagedProvider, type Provider } from '@cindy/model-providers';
import { subscriptionImageModelId } from '../cindy-media/sharedSubscriptionImage.js';
import { createCodexImageChannel, type CreateCodexImageChannelOptions } from './codexImageClient.js';
import type { ImageChannel, ImageChannelResult } from './imageChannelRegistry.js';
import type { resolveSubscriptionPoolProvider } from '../subscription-accounts/placement.js';
import type { acquireSubscriptionAccount } from '../subscription-accounts/runtime.js';
import type { getChatgptBridgeAuthForDispatch, invalidateChatgptBridgeAuth } from '../maker-host/anthropic-responses-bridge-host.js';

export interface CodexImageAuthBinding {
  acquireAuth?(providerId: string, modelId: string, remote: boolean): Promise<{
    getAuth: CodexImageAuthBinding['getAuth'];
    assertDispatchable(): void;
    onAuthFailure: CodexImageAuthBinding['onAuthFailure'];
    release(): void;
  }>;
  hasAuth?(providerId: string): boolean;
  hasPoolImageAuth?(providerId: string): boolean;
  getAuth(providerId?: string): Promise<{ accessToken: string; accountId: string | null }>;
  onAuthFailure(failure: {
    status: number;
    body: string;
    failedAccessToken: string;
  }, providerId?: string): unknown | Promise<unknown>;
}

let binding: CodexImageAuthBinding | null = null;

export function setCodexImageAuthBinding(next: CodexImageAuthBinding | null): void {
  binding = next;
}

export function getCodexImageAuthBinding(): CodexImageAuthBinding {
  if (!binding) {
    throw new Error('Codex image auth binding is not configured');
  }
  return binding;
}

export function createCodexImageAuthAcquirer(ports: {
  resolveSubscriptionPoolProvider: typeof resolveSubscriptionPoolProvider;
  acquireSubscriptionAccount: typeof acquireSubscriptionAccount;
  getChatgptBridgeAuthForDispatch: typeof getChatgptBridgeAuthForDispatch;
  invalidateChatgptBridgeAuth: typeof invalidateChatgptBridgeAuth;
}): NonNullable<CodexImageAuthBinding['acquireAuth']> {
  return async (providerId, modelId, remote) => {
    const ref = ports.resolveSubscriptionPoolProvider(providerId);
    const created = ref?.kind === 'openai' && ref.created;
    if (remote === created) throw new Error('OpenAI image account is unavailable');
    const lease = await ports.acquireSubscriptionAccount(providerId, modelId, [], false, { remote, capability: 'image.generate' });
    if (created && !lease) throw new Error('OpenAI image account is unavailable');
    let proof: (() => boolean) | undefined;
    return {
      async getAuth() {
        if (created) lease?.assertDispatchable();
        // For a created pool, `openai` identifies the OAuth family to the bridge.
        // The required lease is the only credential source; no built-in login lookup.
        const auth = await ports.getChatgptBridgeAuthForDispatch(created ? 'openai' : providerId, lease?.account);
        if (created && (!auth.accessToken.trim() || !auth.accountId?.trim()))
          throw new Error('OpenAI image account credentials are unavailable');
        proof = auth.canDispatch;
        return auth;
      },
      assertDispatchable() {
        lease?.assertDispatchable();
        if (proof && !proof()) throw new Error('OpenAI authorization changed before dispatch');
      },
      async onAuthFailure(failure) {
        lease?.observeFailure({ errorStatus: failure.status, message: failure.body }, modelId, 'run');
        await ports.invalidateChatgptBridgeAuth(failure, providerId, lease?.account);
      },
      release() { lease?.release(); },
    };
  };
}

export function codexImageAccountKind(provider: Provider | undefined): 'pool' | 'legacy' | undefined {
  if (!provider || provider.id === 'openai' || isOrganizationManagedProvider(provider) ||
    !isOpenAiSubscriptionProvider(provider)) return undefined;
  if (provider.subscriptionPool === 'openai') return 'pool';
  if (provider.auth.native === 'codex') return 'legacy';
}

/** Keep the catalog model unchanged; only the standalone Images serializer chooses its wire ID. */
export function createAccountCodexImageChannel(
  providerId: string,
  getProvider: () => Provider | undefined,
  options: Pick<CreateCodexImageChannelOptions, 'fetchImplementation' | 'beforeDispatch'>,
): ImageChannel {
  const modelId = subscriptionImageModelId(providerId);
  const kind = () => codexImageAccountKind(getProvider());
  const assertKind = (expected: 'pool' | 'legacy') => {
    if (kind() !== expected) throw new Error('OpenAI image source changed before dispatch');
  };
  const legacy = createCodexImageChannel({
    ...options,
    providerId,
    hasOAuthLogin: () => binding?.hasAuth?.(providerId) === true,
    getAuth: () => getCodexImageAuthBinding().getAuth(providerId),
    onAuthFailure: async failure => { await getCodexImageAuthBinding().onAuthFailure(failure, providerId); },
    beforeDispatch: model => { assertKind('legacy'); options.beforeDispatch?.(model); },
  });
  const run = async (
    { model, signal }: { model: string; signal?: AbortSignal },
    invoke: (channel: ImageChannel) => Promise<ImageChannelResult>,
  ) => {
    signal?.throwIfAborted();
    const current = kind();
    if (current === 'legacy') return invoke(legacy);
    if (current !== 'pool' || model !== modelId) throw new Error('OpenAI image source or model is unavailable');
    options.beforeDispatch?.(model);
    const lease = await getCodexImageAuthBinding().acquireAuth?.(providerId, model, false);
    if (!lease) throw new Error('OpenAI image account is unavailable');
    try {
      return await invoke(createCodexImageChannel({
        ...options,
        providerId,
        hasOAuthLogin: () => true, // An exact account is already leased for this invocation.
        getAuth: lease.getAuth,
        onAuthFailure: async failure => { await lease.onAuthFailure(failure); },
        beforeDispatch: model => {
          assertKind('pool');
          options.beforeDispatch?.(model);
          lease.assertDispatchable();
        },
      }));
    } finally {
      lease.release();
    }
  };
  return {
    imageProtocol: legacy.imageProtocol,
    ready: () => {
      const current = kind();
      return current === 'pool' ? binding?.hasPoolImageAuth?.(providerId) === true
        : current === 'legacy' && legacy.ready();
    },
    isModelReady: model => model === modelId || kind() === 'legacy',
    generateImage: params => run(params, channel => channel.generateImage(params)),
    editImage: params => run(params, channel => channel.editImage(params)),
  };
}
