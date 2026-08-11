/**
 * @cindy/slack-hook-protocol
 * ---------------------------------------------------------------------------
 * hook server <-> desktop 双工任务协议: 类型 + 运行时校验 + 构造器。
 * desktop(hook-control)与 hook server 两端共用, 协议单一来源。
 */

export * from './types';
export { parseHookMessage, isHookMessageType } from './parse';
export {
  makeHello,
  makeWelcome,
  makePing,
  makePong,
  makeTaskDispatch,
  makeTaskAck,
  makeTurnEnd,
  makeTurnDelivery,
  makeTurnProgress,
  makeMessageOp,
  makeMessageOpResult,
  makeTurnReopen,
  makeBindStart,
  makeBindUpdate,
  makeBindRevoke,
  makeBindState,
  makeProviderBindStart,
  makeProviderBindCancel,
  makeProviderBindRevoke,
  makeProviderBindUpdate,
  makeProviderBindState,
  makeQueryRequest,
  makeQueryResponse,
  makeTaskCancel,
  makeSessionArchive,
  makeInteractionRequest,
  makeInteractionDecision,
  makeInteractionCancel,
  makePrefsGet,
  makePrefsSet,
  makePrefsState,
  makeProviderPrefsGet,
  makeProviderPrefsSet,
  makeProviderPrefsState,
  makeProviderBehaviorGet,
  makeProviderBehaviorSet,
  makeProviderBehaviorState,
  makeToolRequest,
  makeToolResponse,
  makeGroupMessage,
  makeLifecyclePreference,
  serializeHookMessage,
  type HelloInput,
} from './build';
