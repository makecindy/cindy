import type { BotDeliveryDiagnostic } from './botDeliveryDiagnostic';

export const BOT_DELIVERY_STATUSES = [
  'pending',
  'sending',
  'suspended',
  'delivered',
  'failed',
  'dead-letter',
  'cancelled',
] as const;

export type BotDeliveryStatus = (typeof BOT_DELIVERY_STATUSES)[number];

export interface BotDeliveryView {
  id: string;
  botId: string;
  channelId: string | null;
  channelKind: string | null;
  routeId: string | null;
  routeKey: string | null;
  routeStatus: string | null;
  sessionId: string | null;
  payloadKind: string;
  ownerGeneration: number;
  attempts: number;
  status: BotDeliveryStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  deliveredAt: number | null;
  diagnostic?: BotDeliveryDiagnostic;
}

export interface BotDeliveryChangedPayload {
  botId: string;
  deliveryId?: string;
}
