/**
 * Static assembly seam for the ChatGPT subscription image channel.
 *
 * cindy-brain must not runtime-import the full maker-host auth graph: Rollup would
 * emit a lazy chunk that can re-enter the Desktop Main bundle. bootstrap-electron
 * wires these callbacks from its existing static maker-host imports before IPC
 * registration, while tests can exercise the image channel without that graph.
 */

import { createCodexImageChannel, type CreateCodexImageChannelOptions } from './codexImageClient.js';
import type { ImageChannel } from './imageChannelRegistry.js';

interface CodexImageRequestAuth {
  getAuth: CodexImageAuthBinding['getAuth'];
  assertDispatchable(): void;
  onAuthFailure: CodexImageAuthBinding['onAuthFailure'];
  release(): void;
}

export interface CodexImageAuthBinding {
  acquireRemoteAuth?(providerId: string, modelId: string): Promise<CodexImageRequestAuth>;
  acquirePoolAuth?(providerId: string, modelId: string): Promise<CodexImageRequestAuth>;
  hasPoolAuth?(providerId: string): boolean;
  hasAuth?(providerId: string): boolean;
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

export function createPooledCodexImageChannel(
  providerId: string,
  options: Pick<CreateCodexImageChannelOptions, 'beforeDispatch' | 'fetchImplementation'>,
): ImageChannel {
  const ready = () => getCodexImageAuthBinding().hasPoolAuth?.(providerId) === true;
  const run = async (
    params: Parameters<ImageChannel['generateImage']>[0],
    invoke: (channel: ImageChannel) => ReturnType<ImageChannel['generateImage']>,
  ) => {
    params.signal?.throwIfAborted();
    options.beforeDispatch?.(params.model);
    const auth = await getCodexImageAuthBinding().acquirePoolAuth?.(providerId, params.model);
    if (!auth) throw new Error('OpenAI subscription image account is unavailable');
    try {
      return await invoke(createCodexImageChannel({
        ...options,
        providerId,
        hasOAuthLogin: ready,
        getAuth: auth.getAuth,
        onAuthFailure: async failure => { await auth.onAuthFailure(failure); },
        beforeDispatch: model => {
          options.beforeDispatch?.(model);
          auth.assertDispatchable();
        },
      }));
    } finally {
      auth.release();
    }
  };
  return {
    imageProtocol: 'openai',
    ready,
    generateImage: params => run(params, channel => channel.generateImage(params)),
    editImage: params => run(params, channel => channel.editImage(params)),
  };
}
