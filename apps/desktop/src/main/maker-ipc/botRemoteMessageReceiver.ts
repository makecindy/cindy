import type { BotDirectMessageService } from './botDirectMessageService.js';

/** Late-bound adapter keeps the resource provider independent of Maker initialization order. */
let service: Pick<BotDirectMessageService, 'receiveRemote' | 'verifyRemoteMessage' | 'readRemoteReceipt'> | null = null;
export function setBotRemoteMessageService(next: Pick<BotDirectMessageService, 'receiveRemote' | 'verifyRemoteMessage' | 'readRemoteReceipt'>): void { service = next; }
export function getBotRemoteMessageService(): Pick<BotDirectMessageService, 'receiveRemote' | 'verifyRemoteMessage' | 'readRemoteReceipt'> | null { return service; }
