import type { PluginOauthCallback, PluginDeviceOpened } from '@cindy/device-link';
import type { PluginOauthDeviceCodeClose, PluginOauthDeviceCodePrompt } from '../shared/pluginOauthDeviceCode.js';
/** Transport-independent UI adapters. Only a validated Host transaction supplies an offer. */
export interface AuthorizationAdapterDeps {
  openExternal(url: string): Promise<void>;
  copyDeviceCode?(code: string): () => void;
  presentBrowserAuthorization?(
    expiresAt: number,
    reopen: () => Promise<void>,
  ): PluginOauthDeviceCodeClose;
  presentDeviceCode?(
    prompt: PluginOauthDeviceCodePrompt,
    clear: () => void,
  ): PluginOauthDeviceCodeClose;
  deliver(callback: PluginOauthCallback | PluginDeviceOpened): Promise<void>;
  assertCurrent(): void;
  failed(): void;
  deadline: number;
  now?: () => number;
  signal?: AbortSignal;
}
export interface AuthorizationAdapterHandle {
  close(phase?: 'completed' | 'expired' | 'ended'): void;
}
