
import type {Catalog} from '@cindy/model-providers';
export interface TurnUsageContextHost {
 getActiveCatalog():Catalog;
 getSessionProvider(sessionId:string):string|null;
 isUserProviderSession(sessionId:string):boolean;
 getSessionFastMode(sessionId:string):boolean|'ultrafast';
 isOpenAiSubscriptionProviderId(providerId?:string|null):boolean;
 isClaudeSubscriptionProviderId(providerId?:string|null):boolean;
 isXaiSubscriptionProviderId(providerId?:string|null):boolean;
 }

export type TurnUsageContext = ReturnType<ReturnType<typeof createTurnUsageContext>['captureTurnUsageContext']>;
export function createTurnUsageContext(host: TurnUsageContextHost) {
const {getActiveCatalog,getSessionProvider,isUserProviderSession,getSessionFastMode,isOpenAiSubscriptionProviderId,isClaudeSubscriptionProviderId,isXaiSubscriptionProviderId} = host;



/** Non-secret billing identity captured with the existing product-turn metadata.
 * Deleting or editing a connection must not reclassify requests already sent.
 */
function captureTurnUsageContext(sessionId: string) {
  const providerId = getSessionProvider(sessionId);
  const accessKind = providerId
    ? getActiveCatalog().providers.find(provider => provider.id === providerId)?.access?.kind
    : undefined;
  return {
    providerId,
    accessKind,
    isUserProviderRoute: isUserProviderSession(sessionId),
    subscriptionKind: isOpenAiSubscriptionProviderId(providerId) ? 'codex' as const
      : isClaudeSubscriptionProviderId(providerId) ? 'claude' as const
        : isXaiSubscriptionProviderId(providerId) ? 'xai' as const : null,
    piFastMode: getSessionFastMode(sessionId),
  };
}
return {
  captureTurnUsageContext
};
}
