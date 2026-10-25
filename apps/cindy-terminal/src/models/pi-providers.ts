import type { AgentDeps, PiNativeProvidersResult, PiNativeProviderSpec } from '@cindy/maker-core';
import { buildRegistry, resolveRoute, storedCustomProviderId, type CustomProviderConfig } from '@cindy/model-providers';
import { buildPiNativeProvidersFromConfigs, buildPiSubscriptionNativeProviders, mergePiNativeProviderResults, readPiBundledModels } from '@cindy/app-runtime/piNativeProviders';
import { mergeByokNativeConfigs } from '@cindy/app-runtime/byokNativeConfigs';
import type { BridgeSessionPrefs } from '@cindy/anthropic-responses-bridge';
import type { RuntimeInput } from './runtime.js';
import { createProviderProxy } from './proxy.js';
import { createChatgptProxy, createGrokProxy } from './subscription-proxy.js';

type Proxy = Awaited<ReturnType<typeof createProviderProxy>>;
type RouteLease = { proxy: Proxy; url: string; forward?: PiNativeProviderSpec['hostProxyForward']; close(): Promise<void> };

/** Platform I/O around the original Pi catalog/projection. Every refresh reads
 * the current owner catalog; a startup selection is never the provider list. */
export function createTerminalPiProviders(input: RuntimeInput, preferences: (model: string) => BridgeSessionPrefs) {
  const {models, logger} = input;
  const leases = new Map<string, Promise<RouteLease>>();
  let closed = false;
  const lease = (id: string, catalog: ReturnType<typeof models.activeCatalog>, revision: number): Promise<RouteLease> => {
    const key = `${revision}:${id}`;
    const current = leases.get(key);
    if (current) return current;
    const work = (async () => {
      const provider = catalog.providers.find(item => item.id === id)!;
      const model = provider.models.pi?.[0];
      if (!model) throw new Error('PI_PROVIDER_MODELS_UNAVAILABLE');
      const route = resolveRoute(buildRegistry(catalog, {}), id, model.id, 'pi');
      if (!route) throw new Error('PI_PROVIDER_ROUTE_UNAVAILABLE');
      const openai = models.openAiAccount(id), grok = models.grokAccount(id);
      const proxy = grok ? await createGrokProxy({route, kind: 'pi', taskId: input.taskId, accounts: grok, authorize: input.authorizeRequest, preferences})
        : openai ? await createChatgptProxy({route, kind: 'pi', taskId: input.taskId, accounts: openai, authorize: input.authorizeRequest, preferences})
        : await createProviderProxy(route, 'pi', await models.credential(id, 'pi'), await models.headers(id, 'pi'), input.authorizeRequest,
          id === 'xd' ? key => models.reportGatewayRejection(key) : undefined,
          provider.auth.oauth ? () => models.credential(id, 'pi') : undefined, preferences, input.proxyObservation);
      try {
        const forward = input.remoteHostId ? await input.ssh!.forwardRuntimeEndpoint(input.remoteHostId, proxy.url) : undefined;
        if (closed) { await forward?.close(); throw new Error('PI_PROVIDER_RUNTIME_CLOSED'); }
        return {proxy, url: forward?.url ?? proxy.url, forward: forward?.hostProxyForward,
          async close() {try {await forward?.close();} finally {await proxy.close();}}};
      } catch(error) {await proxy.close(); throw error;}
    })();
    leases.set(key, work);
    void work.catch(() => {if (leases.get(key) === work) leases.delete(key);});
    return work;
  };
  const resolve: NonNullable<AgentDeps['resolvePiNativeProviders']> = async context => {
    if (closed) throw new Error('PI_PROVIDER_RUNTIME_CLOSED');
    if (context.purpose !== 'preview' && context.providerId) await models.prepareLocalModel(context.providerId);
    const revision = models.revision(), catalog = models.activeCatalog();
    const bundled = context.remoteHostId ? undefined : await readPiBundledModels(context.runtimeBinaryPath ?? input.binaryPath, {cachedOnly: context.purpose === 'preview', logger}) ?? undefined;
    const configs = mergeByokNativeConfigs(models.snapshot().providers, catalog.providers);
    const keys = new Map<string, string | null>();
    for (const config of configs) {
      if (!config.runtimes.pi) continue;
      config.runtimes.pi.headers = {...config.runtimes.pi.headers, ...await models.headers(config.id, 'pi')};
      keys.set(config.id, await models.credential(config.id, 'pi'));
    }
    // Gateway membership and metadata are still supplied by the original active
    // catalog. The same native builder materializes its explicit mixed APIs.
    const gateway = catalog.providers.find(provider => provider.id === 'xd');
    if (gateway?.routing.pi && gateway.models.pi?.length && await models.credential('xd', 'pi')) {
      const runtime = gateway.routing.pi;
      configs.push({id: gateway.id, name: gateway.name, auth: {method: 'apiKey'}, runtimes: {pi: {
        baseUrl: runtime.upstream, wireProtocol: runtime.wireProtocol,
        models: gateway.models.pi.map(model => ({id: model.id, name: model.name, contextWindow: model.contextWindow,
          piApi: model.piApi, api: model.api, route: model.route, supportsImageInput: model.supportsImageInput,
          reasoning: model.efforts.length > 0, reasoningEfforts: model.efforts.filter(effort => effort !== 'ultra')})),
      }}} satisfies CustomProviderConfig);
      keys.set('xd', await models.credential('xd', 'pi'));
    }
    const custom = buildPiNativeProvidersFromConfigs(configs, id => keys.get(id) ?? null,
      (id, reason) => logger.warn('Pi provider skipped', {id, reason}), bundled, catalog,
      // Only a marker during projection; every OAuth spec receives its own
      // authenticated route below before models.json or a native process sees it.
      'http://127.0.0.1');
    const subscriptions: PiNativeProvidersResult = {providers: [], env: {}};
    for (const provider of catalog.providers) {
      if (!provider.models.pi?.length || !(models.openAiAccount(provider.id)?.connected() || models.grokAccount(provider.id)?.connected())) continue;
      const projected = buildPiSubscriptionNativeProviders({...catalog, providers: [provider]}, 'http://127.0.0.1', bundled);
      subscriptions.providers.push(...projected.providers); Object.assign(subscriptions.env, projected.env);
    }
    const result = mergePiNativeProviderResults(subscriptions, custom);
    const proxyEnv: Record<string, string> = {};
    for (const spec of result.providers) {
      const source = storedCustomProviderId(spec.sourceProviderId ?? spec.id);
      const config = configs.find(item => item.id === source);
      // Preview only validates the original catalog. It must not start proxy or
      // SSH listeners; commit/startup owns those resources and their credentials.
      if (context.purpose === 'preview') continue;
      const route = await lease(source, catalog, revision);
      const envName = `CINDY_PI_HOST_PROXY_${Buffer.from(spec.id).toString('hex').toUpperCase()}`;
      spec.sourceProviderId = source;
      spec.apiKeyEnvVar = envName;
      proxyEnv[envName] = route.proxy.token;
      spec.baseUrl = route.url;
      spec.headers = undefined;
      if (route.forward) spec.hostProxyForward = route.forward;
      spec.models = spec.models.map(model => ({...model, baseUrl: route.url,
        // Real upstream headers stay inside the authenticated host proxy.
        headers: undefined,
        ...(config?.auth?.method === 'oauth' ? {cacheIdentityBaseUrl: config.runtimes.pi!.baseUrl} : {}),
      }));
    }
    if (context.purpose !== 'preview') result.env = proxyEnv;
    if (closed || revision !== models.revision()) throw new Error('MODEL_CONFIGURATION_CHANGED');
    return result;
  };
  return {resolve, async close() {
    closed = true;
    const results = await Promise.allSettled([...leases.values()].map(async work => (await work).close()));
    leases.clear();
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Pi provider transports did not close');
  }};
}
