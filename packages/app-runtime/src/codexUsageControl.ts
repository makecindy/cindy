import {createCodexRateLimitResetService} from './codexRateLimitReset.js';
import {CodexResetAutoUse,parseCodexResetAutoUse} from './codexResetAutoUse.js';
import {codexResetAccountKey} from './codexResetAutoUseStore.js';
import type {MobileCodexRateLimitsResult,CodexResetAutoUseSettings} from '@cindy/maker-shared/device-link-contract';
import type {Maker,AuthState} from '@cindy/maker-core';
type CodexRateLimitsReader=(providerId?:string)=>Promise<MobileCodexRateLimitsResult>;
export function createCodexUsageControl(host:{
 maker:Pick<Maker,'readAgentAccountRateLimits'|'consumeAgentAccountRateLimitResetCredit'>;
 activeOwnerScopeKey():string;isAppSessionBoundaryPending():boolean;
 normalizeCodexUsageProvider(id?:string):string|undefined;
 desktopCodexAuthAdapter:{getState(options:{providerId?:string}):Promise<AuthState>;getAccountId(id?:string):Promise<string|null>;verifyRecoveryWithAccountRpc<T>(operation:()=>Promise<T>):Promise<T>};
 recordCodexAccountUsageSnapshot:ReturnType<typeof import('./usageBroadcaster.js').createUsageBroadcaster>['recordCodexAccountUsageSnapshot'];
 readCodexAccountUsageSnapshotWithWebRefresh(id?:string,options?:{fresh?:boolean}):Promise<unknown>;
 codexResetAutoUseStore:ReturnType<typeof import('./codexResetAutoUseStore.js').createCodexResetAutoUseStore>;
 resetRestoredListeners:Set<(id:string)=>Promise<void>>;
 observeUsageChanges:ReturnType<typeof import('./usageBroadcaster.js').createUsageBroadcaster>['observeUsageChanges'];
 onResume?(listener:()=>void):()=>void;
 log:Pick<import('@cindy/maker-core').Logger,'warn'>;
}) {
 const {maker,activeOwnerScopeKey,isAppSessionBoundaryPending,normalizeCodexUsageProvider,desktopCodexAuthAdapter,recordCodexAccountUsageSnapshot,readCodexAccountUsageSnapshotWithWebRefresh,codexResetAutoUseStore,resetRestoredListeners,observeUsageChanges,onResume,log}=host;
  const resetServices = new Map<string, ReturnType<typeof createCodexRateLimitResetService>>();
  let resetServicesOwner = '';
  function getResetService(providerId?: string) {
    providerId = normalizeCodexUsageProvider(providerId);
    const scope = activeOwnerScopeKey();
    if (scope !== resetServicesOwner) { resetServices.clear(); resetServicesOwner = scope; }
    const key = providerId ?? 'openai';
    const existing = resetServices.get(key);
    if (existing) return existing;
    const assertScope = () => {
      if (isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throw new Error('PRECONDITION_FAILED: Account scope changed');
    };
  const service = createCodexRateLimitResetService({
    readRateLimits: async () => { assertScope(); const result = await maker.readAgentAccountRateLimits('codex', providerId); assertScope(); return result; },
    consumeResetCredit: async (params) => { assertScope(); const result = await maker.consumeAgentAccountRateLimitResetCredit('codex', params, providerId); assertScope(); return result; },
    readAccountIdentity: async () => {
      assertScope();
      const state = await desktopCodexAuthAdapter.getState({ providerId });
      assertScope();
      const accountId =
        state.authSource === 'oauth' ? await desktopCodexAuthAdapter.getAccountId(providerId) : null;
      const identity =
        state.authSource === 'oauth' && state.identity?.includes('@') ? state.identity : null;
      assertScope();
      return { email: identity, accountId };
    },
    recordRateLimitSnapshot: (snapshot) => scope === activeOwnerScopeKey() ? recordCodexAccountUsageSnapshot(snapshot, providerId) : Promise.resolve(),
  });

    resetServices.set(key, service);
    return service;
  }

  async function accountKeyFor(providerId?: string): Promise<string> {
    const scope = activeOwnerScopeKey();
    const id = normalizeCodexUsageProvider(providerId);
    const state = await desktopCodexAuthAdapter.getState({ providerId: id });
    const accountId = state.authSource === 'oauth' ? await desktopCodexAuthAdapter.getAccountId(id) : null;
    if (scope !== activeOwnerScopeKey() || isAppSessionBoundaryPending()) throw new Error('Account scope changed');
    return codexResetAccountKey(state.authSource === 'oauth' ? state.identity ?? null : null, accountId);
  }

  // Bind recovery confirmation to the exact owner, marker and OAuth credential observed before
  // this account-level RPC. A stale response still returns its usage payload but cannot consume a
  // newer recovery state.
  const readCodexRateLimits: CodexRateLimitsReader = async (providerId) => {
    const scope = activeOwnerScopeKey();
    const accountKey = await accountKeyFor(providerId);
    const service = getResetService(providerId);
    const result = providerId && providerId !== 'openai'
      ? await service.read()
      : await desktopCodexAuthAdapter.verifyRecoveryWithAccountRpc(() => service.read());
    if (scope !== activeOwnerScopeKey()) throw new Error('PRECONDITION_FAILED: Account scope changed');
    if (accountKey !== await accountKeyFor(providerId)) throw new Error('ChatGPT account changed');
    return { ...result, providerId: providerId ?? 'openai', autoUse: codexResetAutoUseStore.read(providerId ?? 'openai', accountKey) };
  };


  const automatic = new CodexResetAutoUse({
    scope: activeOwnerScopeKey, now: Date.now, read: readCodexRateLimits,
    authorized: (providerId, snapshot) => {
      if (isAppSessionBoundaryPending() || !snapshot.autoUse?.accountKey) return false;
      const current = codexResetAutoUseStore.read(providerId, snapshot.autoUse.accountKey);
      return current.settings.enabled && JSON.stringify(current.settings) === JSON.stringify(snapshot.autoUse.settings);
    },
    consume: (providerId, key, authorized) => getResetService(providerId).consume(key, authorized),
    record: (providerId, snapshot, at) => codexResetAutoUseStore.record(providerId, snapshot.autoUse!.accountKey, at),
    refreshWeb: async (providerId) => { await readCodexAccountUsageSnapshotWithWebRefresh(providerId, { fresh: true }); },
    restored: async (providerId) => {
      for (const listener of resetRestoredListeners) await listener(providerId);
    },
    warn: () => log.warn('Codex automatic reset check could not complete'),
  });
  const checkEnabled = () => {
    if (isAppSessionBoundaryPending()) return;
    for (const providerId of codexResetAutoUseStore.providers()) void automatic.check(providerId);
  };
  // Checks run on the execution computer even with no renderer or remote phone connected.
  const timer = setInterval(checkEnabled, 60_000);
  timer.unref();
  const unobserve = observeUsageChanges(kind => { if (kind === 'codex') checkEnabled(); });
  const unlisten=onResume?.(checkEnabled);
  checkEnabled();


 const setCodexResetAutoUse:NonNullable<import('./usageHandlers.js').MakerUsageHandlerDeps['setCodexResetAutoUse']>=async (patch, expectedAccountKey, providerId = 'openai') => {
      const scope = activeOwnerScopeKey();
      const key = await accountKeyFor(providerId);
      if (!key || key !== expectedAccountKey) throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
      if (patch !== null) parseCodexResetAutoUse({ ...codexResetAutoUseStore.read(providerId, key).settings, ...patch });
      await codexResetAutoUseStore.write(providerId, key, patch as Partial<CodexResetAutoUseSettings> | null);
      if (scope !== activeOwnerScopeKey() || key !== await accountKeyFor(providerId)) throw new Error('PRECONDITION_FAILED: Account changed');
      checkEnabled();
      return readCodexRateLimits(providerId);
    };
 const consumeCodexRateLimitReset:import('./usageHandlers.js').MakerUsageHandlerDeps['consumeCodexRateLimitReset']=async (key, providerId) => {
      const scope = activeOwnerScopeKey();
      const accountKey = await accountKeyFor(providerId);
      const result = await getResetService(providerId).consume(key);
      if (scope !== activeOwnerScopeKey()) throw new Error('PRECONDITION_FAILED: Account scope changed');
      if (accountKey !== await accountKeyFor(providerId)) throw new Error('PRECONDITION_FAILED: ChatGPT account changed');
      return { ...result, providerId: providerId ?? 'openai',
        rateLimits: result.rateLimits ? { ...result.rateLimits, providerId: providerId ?? 'openai',
          autoUse: codexResetAutoUseStore.read(providerId ?? 'openai', accountKey) } : null };
    };
 return {readCodexRateLimits,setCodexResetAutoUse,consumeCodexRateLimitReset,checkEnabled,close(){clearInterval(timer);unobserve();unlisten?.();resetServices.clear();}};
}
