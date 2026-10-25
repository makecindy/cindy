import path from 'node:path';
import { isOpenAiSubscriptionProvider, providerCatalogId } from '@cindy/model-providers';
import type { TerminalDurableSecrets } from '../contracts.js';
import type { runNative } from '../engines/native.js';
import type { TerminalModelConfig } from './config.js';
import { TerminalNativeAccounts } from './native-accounts.js';
import { TerminalGrokLogin } from './grok-login.js';

/** Each account entry has its own encrypted secrets, native-login staging,
 * refresh queue and discovery cache. The original default paths stay valid. */
export class TerminalSubscriptions {
  private closed = false;
  private readonly openai = new Map<string, TerminalNativeAccounts>();
  private readonly grok = new Map<string, TerminalGrokLogin>();
  constructor(private readonly options: {
    root: string;
    models: TerminalModelConfig;
    secrets: Pick<TerminalDurableSecrets, 'getSync' | 'setSync' | 'deleteSync'>;
    binary(): Promise<string | null>;
    version?(): Promise<string | null>;
    assertCurrent(): void;
    changed(providerId: string): void;
    fetch?: typeof fetch;
    run?: typeof runNative;
  }) {
    options.models.connectSubscriptions(this);
  }
  private scope(id: string, family: 'openai' | 'xai') {
    if (!/^[a-z0-9_-]{1,80}$/.test(id)) throw new Error('INVALID_PROVIDER_ID');
    const assertCurrent = () => {
      if (this.closed) throw new Error('OWNER_CHANGED');
      this.options.assertCurrent();
      const provider = this.options.models.activeCatalog().providers.find(p => p.id === id);
      if (!provider || provider.auth.method !== 'oauth' || providerCatalogId(provider) !== family)
        throw new Error('PROVIDER_AUTHORIZATION_CHANGED');
    };
    assertCurrent();
    const prefix = id === family ? '' : `terminal:subscription:${id}:`;
    const secrets = this.options.secrets;
    return {
      ...this.options,
      root: id === family ? this.options.root : path.join(this.options.root, 'provider-accounts', id),
      providerId: id,
      changed: () => this.options.changed(id),
      assertCurrent,
      secrets: {
        getSync: (key: string) => secrets.getSync(prefix + key),
        setSync: (key: string, value: string) => secrets.setSync(prefix + key, value),
        deleteSync: (key: string) => secrets.deleteSync(prefix + key),
      },
    };
  }
  openAiAccount(id = 'openai') {
    const provider = this.options.models.activeCatalog().providers.find(p => p.id === id);
    if (!isOpenAiSubscriptionProvider(provider)) return undefined;
    const scope = this.scope(id, 'openai');
    let account = this.openai.get(id);
    if (!account) {
      account = new TerminalNativeAccounts(scope);
      this.openai.set(id, account);
    }
    return account;
  }
  grokAccount(id = 'xai') {
    const provider = this.options.models.activeCatalog().providers.find(p => p.id === id);
    if (!provider || provider.auth.method !== 'oauth' || providerCatalogId(provider) !== 'xai') return undefined;
    const scope = this.scope(id, 'xai');
    let account = this.grok.get(id);
    if (!account) {
      account = new TerminalGrokLogin(scope);
      this.grok.set(id, account);
    }
    return account;
  }
  connection(id: string) { return this.openAiAccount(id) ?? this.grokAccount(id); }
  utilityConnections() {
    const chatgpt = async (id?: string) => {
      const account = this.openAiAccount(id);
      if (!account) throw new Error('PROVIDER_LOGIN_REQUIRED');
      return account.credential();
    };
    return {
      getChatgptBridgeAuth: chatgpt,
      getChatgptBridgeAuthForDispatch: chatgpt,
      getGrokAccessToken: async (id?: string) => {
        const account = this.grokAccount(id);
        if (!account) throw new Error('PROVIDER_LOGIN_REQUIRED');
        return (await account.credential()).accessToken;
      },
      getGrokOAuthCredentialGeneration: (id?: string) => this.grokAccount(id)?.generation() ?? -1,
    };
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.openai.values(), ...this.grok.values()].map(account => account.close()));
    this.openai.clear();
    this.grok.clear();
  }
}
