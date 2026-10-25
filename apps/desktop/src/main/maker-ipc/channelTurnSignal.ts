import { createChannelTurnSignals } from '@cindy/im-runtime/channelTurnSignal';
import { createLogger } from '../logger';
export { type ChannelTurnSource, isRelayedChannelTurnSource, type ChannelTurnPhase } from '@cindy/im-runtime/channelTurnSignal';
export const { onChannelTurn, publishChannelTurn, publishProviderInitiatedTurn, channelTurnSourceFor, noteChannelTurnSource, withChannelTurnSource } = createChannelTurnSignals(createLogger('channel-turn'));
